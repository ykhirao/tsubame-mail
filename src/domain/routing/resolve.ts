/**
 * 3 段階の順序（reject → 完全一致 → フォールバック）は入れ替えないこと。
 * reject を先に見ないと実在メールボックス宛の送信者を弾けず、
 * catch-all を先に見ると実在アドレスが覆い隠される。
 */
import { and, asc, desc, eq } from "drizzle-orm";
import { addresses, domains, routingRules } from "@/db/schema";
import type { Db } from "@/db/client";
import { baseAddressOf, normalizeAddress } from "@/domain/mail/address";
import { matchRule, type Matcher } from "./rules";

export type ResolveResult =
	| { action: "deliver"; addressId: string }
	| { action: "forward"; to: string }
	| { action: "reject"; reason: string }
	| { action: "drop" };

export type ResolveInput = { from: string; to: string };

const defaultRejectReason = "宛先ドメインの受信を拒否しました";

const URL_SPECIAL = /[/?#:@\\%\s]/;

function toAsciiDomain(domain: string): string | null {
	const d = domain.normalize("NFC").replace(/\.$/, "");
	if (!d) return null;
	if (/^[\x00-\x7f]*$/.test(d)) return d;
	// URL に通すとパスやポートが黙って落ちるので、ホスト名以外の文字は先に弾く。
	if (URL_SPECIAL.test(d)) return null;
	try {
		const host = new URL(`http://${d}`).hostname;
		return /^[a-z0-9.-]+$/.test(host) ? host : null;
	} catch {
		return null;
	}
}

/**
 * SMTPUTF8 の有無で同じ宛先が Unicode でも punycode でも届くので、ドメインは ASCII に、
 * ローカル部は NFC に揃えてから比べる。
 */
export function canonicalAddress(input: string): string | null {
	const normalized = normalizeAddress(input);
	if (!normalized) return null;
	const at = normalized.lastIndexOf("@");
	const domain = toAsciiDomain(normalized.slice(at + 1));
	if (!domain) return null;
	return `${normalized.slice(0, at).normalize("NFC")}@${domain}`;
}

function canonicalPattern(pattern: string): string {
	const nfc = pattern.normalize("NFC");
	if (/^[\x00-\x7f]*$/.test(nfc)) return nfc;
	const at = nfc.lastIndexOf("@");
	const domainPart = nfc.slice(at + 1);
	if (!domainPart) return nfc;
	const ascii = toAsciiDomain(domainPart);
	return ascii ? `${nfc.slice(0, at + 1)}${ascii}` : nfc;
}

function canonicalMatcher(m: Matcher): Matcher {
	return {
		...m,
		...(m.from ? { from: canonicalPattern(m.from) } : {}),
		...(m.to ? { to: canonicalPattern(m.to) } : {}),
	};
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}

/**
 * 全角などの互換文字で書かれたローカル部は別アドレスとして配送されうるので、
 * ルールの照合だけは NFKC に畳んだ形でも当てる。
 */
function ruleTargets(candidates: string[]): string[] {
	return unique(candidates.flatMap((c) => [c, c.normalize("NFKC").toLowerCase()]));
}

export async function resolveIncoming(db: Db, input: ResolveInput): Promise<ResolveResult> {
	const to = canonicalAddress(input.to);
	if (!to) return { action: "reject", reason: "宛先アドレスが不正です" };
	const domainName = to.slice(to.lastIndexOf("@") + 1);

	const dom = await db.select().from(domains).where(eq(domains.name, domainName)).get();
	if (!dom) return { action: "reject", reason: "このドメインは未登録です" };

	const rules = await db
		.select()
		.from(routingRules)
		.where(and(eq(routingRules.scope, "domain"), eq(routingRules.domainId, dom.id)))
		.orderBy(desc(routingRules.priority), asc(routingRules.createdAt))
		.all();

	// 配送は `+タグ` を落とした基本アドレスにも届くので、ルールも両方に当てる。
	// リテラルだけで判定すると、1 文字足すだけで拒否をすり抜けられる。
	const candidates = [to];
	const base = baseAddressOf(to);
	if (base) candidates.push(base);

	const from = canonicalAddress(input.from) ?? input.from;
	const targets = ruleTargets(candidates);
	// 本文はまだパースしていないので、この段階で使えるのは envelope だけ。
	const matches = (matcher: Matcher) => {
		const m = canonicalMatcher(matcher);
		return targets.some((t) => matchRule(m, { from, to: t }));
	};

	for (const rule of rules) {
		if (!rule.enabled || rule.action !== "reject") continue;
		if (matches(rule.matcher as Matcher)) {
			return { action: "reject", reason: rule.target ?? defaultRejectReason };
		}
	}

	// catch-all より先に見るので、タグ付きが catch-all に落ちることはない。
	let aliasArchived = false;
	for (const candidate of candidates) {
		const hit = await db.select().from(addresses).where(eq(addresses.address, candidate)).get();
		if (!hit || hit.archivedAt) continue; // アーカイブ済みは実在しないのと同じに扱う
		if (hit.kind === "alias") {
			if (!hit.aliasTargetId) return { action: "drop" };
			// エイリアス先もアーカイブ済みなら実在しないのと同じに扱い、catch-all へ落とす（精査 #101）。
			const target = await db.select().from(addresses).where(eq(addresses.id, hit.aliasTargetId)).get();
			if (!target || target.archivedAt) {
				aliasArchived = true;
				continue;
			}
			return { action: "deliver", addressId: hit.aliasTargetId };
		}
		return { action: "deliver", addressId: hit.id };
	}

	for (const rule of rules) {
		if (!rule.enabled || rule.action === "reject") continue;
		if (!matches(rule.matcher as Matcher)) continue;
		if (rule.action === "forward" && rule.target) {
			return { action: "forward", to: rule.target };
		}
		if (rule.action === "deliver" && rule.target) {
			return { action: "deliver", addressId: rule.target };
		}
		if (rule.action === "drop") {
			return { action: "drop" };
		}
	}

	const catchAll = await db
		.select()
		.from(addresses)
		.where(and(eq(addresses.domainId, dom.id), eq(addresses.isCatchAll, true)))
		.get();
	if (catchAll) return { action: "deliver", addressId: catchAll.id };
	// エイリアスがアーカイブ済みを指して届く先が無いなら bounce を送らず黙って捨てる（精査 #101）。
	if (aliasArchived) return { action: "drop" };

	return { action: "reject", reason: "宛先のアドレスは存在しません" };
}
