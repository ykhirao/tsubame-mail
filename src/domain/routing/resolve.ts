/**
 * 3 段階の順序（reject → 完全一致 → フォールバック）は入れ替えないこと。
 * reject を先に見ないと実在メールボックス宛の送信者を弾けず、
 * catch-all を先に見ると実在アドレスが覆い隠される。
 */
import { and, asc, desc, eq } from "drizzle-orm";
import { addresses, domains, routingRules } from "@/db/schema";
import type { Db } from "@/db/client";
import { baseAddressOf, domainOf, normalizeAddress } from "@/domain/mail/address";
import { matchRule, type Matcher } from "./rules";

export type ResolveResult =
	| { action: "deliver"; addressId: string }
	| { action: "forward"; to: string }
	| { action: "reject"; reason: string }
	| { action: "drop" };

export type ResolveInput = { from: string; to: string };

const defaultRejectReason = "宛先ドメインの受信を拒否しました";

export async function resolveIncoming(db: Db, input: ResolveInput): Promise<ResolveResult> {
	const to = normalizeAddress(input.to);
	if (!to) return { action: "reject", reason: "宛先アドレスが不正です" };
	const domainName = domainOf(to);
	if (!domainName) return { action: "reject", reason: "宛先ドメインが不正です" };

	const dom = await db.select().from(domains).where(eq(domains.name, domainName)).get();
	if (!dom) return { action: "reject", reason: "このドメインは未登録です" };

	const rules = await db
		.select()
		.from(routingRules)
		.where(and(eq(routingRules.scope, "domain"), eq(routingRules.domainId, dom.id)))
		.orderBy(desc(routingRules.priority), asc(routingRules.createdAt))
		.all();

	// 本文はまだパースしていないので、この段階で使えるのは envelope だけ。
	const envelopeMatch = { from: input.from, to };

	for (const rule of rules) {
		if (!rule.enabled || rule.action !== "reject") continue;
		if (matchRule(rule.matcher as Matcher, envelopeMatch)) {
			return { action: "reject", reason: rule.target ?? defaultRejectReason };
		}
	}

	// catch-all より先に見るので、タグ付きが catch-all に落ちることはない。
	const candidates = [to];
	const base = baseAddressOf(to);
	if (base) candidates.push(base);

	for (const candidate of candidates) {
		const hit = await db.select().from(addresses).where(eq(addresses.address, candidate)).get();
		if (!hit) continue;
		if (hit.kind === "alias") {
			if (!hit.aliasTargetId) return { action: "drop" };
			return { action: "deliver", addressId: hit.aliasTargetId };
		}
		return { action: "deliver", addressId: hit.id };
	}

	for (const rule of rules) {
		if (!rule.enabled || rule.action === "reject") continue;
		if (!matchRule(rule.matcher as Matcher, envelopeMatch)) continue;
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

	return { action: "reject", reason: "宛先のアドレスは存在しません" };
}
