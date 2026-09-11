/**
 * catch-all は既定で有効化しない。Cloudflare の catch-all はゾーン単位で、
 * apex の MX を奪った瞬間にゾーン宛の全メールを飲み込む。
 */
import { and, eq, ne } from "drizzle-orm";
import type { Db } from "@/db/client";
import { addresses, domains } from "@/db/schema";
import { newId } from "@/lib/id";
import {
	type CfDnsRecord,
	type CloudflareApi,
	type CloudflareApiEnv,
	type ZoneRef,
	literalToMatcher,
	routingRuleId,
	workerAction,
} from "@/services/cloudflare-api";
import { ApiError, conflict, invalidRequest, notFound } from "@/shared/errors";
import {
	type DnsCheckResult,
	checkDomainDns,
	inspectDnsRecords,
	isZoneApex,
	isWithinZone,
	normalizeDnsName,
} from "./dns-check";

export type ProvisionEnv = CloudflareApiEnv & {
	/** wrangler.jsonc の vars と、実際にデプロイした Worker 名が一致していること。 */
	EMAIL_WORKER_NAME?: string;
};

export const DEFAULT_WORKER_NAME = "tsubame";

export function emailWorkerName(env: ProvisionEnv): string {
	return env.EMAIL_WORKER_NAME ?? DEFAULT_WORKER_NAME;
}

export const CATCH_ALL_WARNING =
	"Cloudflare の catch-all は**ゾーン単位**です。有効にすると、そのゾーンの MX が " +
	"Cloudflare を向いている限り、実在しないアドレス宛のメールもすべてこのアプリが受け取ります。" +
	"apex の MX を Cloudflare に向けているゾーンでは、社内の全メールを飲み込む可能性があります。" +
	"実在アドレスは catch-all より先に解決されますが、それでも既定は無効です。";

export type DomainMode = "apex" | "subdomain";

export type SendingDnsState = {
	spf: boolean;
	dkim: boolean;
	dmarc: boolean;
};

export type ProvisionInput = {
	name: string;
	zoneId?: string;
	/** apex を接続するときは必須。無いと invalidRequest。 */
	confirmApex?: boolean;
	enableSending?: boolean;
	localParts?: string[];
};

export type ProvisionResult = {
	domainId: string;
	name: string;
	zoneId: string;
	zoneName: string;
	mode: DomainMode;
	routingStatus: "pending" | "active" | "error";
	sendingStatus: "disabled" | "pending" | "active" | "error";
	catchAllEnabled: boolean;
	dnsCheck: DnsCheckResult;
	sending: SendingDnsState;
	createdAddressIds: string[];
	lastError: string | null;
};

export function pickZoneForName<T extends { id: string; name: string }>(
	zones: T[],
	name: string,
): T | null {
	const target = normalizeDnsName(name);
	const candidates = zones.filter((z) => isWithinZone(target, z.name));
	if (candidates.length === 0) return null;
	return candidates.reduce((best, z) => (z.name.length > best.name.length ? z : best));
}

export async function resolveZone(
	api: CloudflareApi,
	input: { name: string; zoneId?: string },
): Promise<{ id: string; name: string }> {
	const name = normalizeDnsName(input.name);
	const zones = (await api.listAllZones()).filter((z) => z.account?.id === api.accountId);

	if (input.zoneId) {
		const zone = zones.find((z) => z.id === input.zoneId);
		if (!zone) {
			throw notFound(
				`ゾーン ${input.zoneId} がこの Cloudflare アカウントに見つかりません。` +
					"CF_API_TOKEN のスコープにこのゾーンが入っているかも確認してください。",
			);
		}
		if (!isWithinZone(name, zone.name)) {
			throw invalidRequest(`${name} はゾーン ${zone.name} の配下ではありません。`);
		}
		return { id: zone.id, name: normalizeDnsName(zone.name) };
	}

	const zone = pickZoneForName(zones, name);
	if (!zone) {
		throw notFound(
			`${name} を含む Cloudflare ゾーンが見つかりません。` +
				"ゾーンがこのアカウントにあるか、CF_API_TOKEN のスコープに含まれているかを確認してください。",
		);
	}
	return { id: zone.id, name: normalizeDnsName(zone.name) };
}

export async function previewDomain(
	api: CloudflareApi,
	input: { name: string; zoneId?: string },
): Promise<DnsCheckResult> {
	const zone = await resolveZone(api, input);
	return checkDomainDns(api, zone, input.name);
}

const DKIM_NAME_PATTERN = /(^|\.)_domainkey\./;

export function readSendingDnsState(
	records: Pick<CfDnsRecord, "type" | "name" | "content">[],
	name: string,
): SendingDnsState {
	const target = normalizeDnsName(name);
	const txt = records.filter((r) => r.type.toUpperCase() === "TXT");
	const under = (recordName: string) => {
		const n = normalizeDnsName(recordName);
		return n === target || n.endsWith(`.${target}`);
	};

	return {
		spf: txt.some((r) => normalizeDnsName(r.name) === target && /v=spf1/i.test(r.content)),
		dkim: txt.some(
			(r) => under(r.name) && DKIM_NAME_PATTERN.test(normalizeDnsName(r.name)) && /v=dkim1/i.test(r.content),
		),
		dmarc: txt.some(
			(r) => normalizeDnsName(r.name) === `_dmarc.${target}` && /v=dmarc1/i.test(r.content),
		),
	};
}

export function sendingStatusOf(state: SendingDnsState): "pending" | "active" {
	return state.spf && state.dkim ? "active" : "pending";
}

async function listRoutingRuleMap(api: CloudflareApi, zone: ZoneRef): Promise<Map<string, string>> {
	const rules = await api.listEmailRoutingRules(zone);
	const map = new Map<string, string>();
	for (const rule of rules) {
		const id = routingRuleId(rule);
		for (const m of rule.matchers) {
			if (m.field === "to" && m.value) map.set(m.value.trim().toLowerCase(), id ?? "");
		}
	}
	return map;
}

export async function ensureAddressRoutingRule(
	api: CloudflareApi,
	params: { zone: ZoneRef; address: string; workerName: string; existing?: Map<string, string> },
): Promise<string | null> {
	const address = params.address.trim().toLowerCase();
	const existing =
		params.existing ??
		new Map(
			(await api.listEmailRoutingRules(params.zone))
				.map((rule) => {
					const id = routingRuleId(rule);
					const m = rule.matchers.find((x) => x.field === "to" && x.value);
					return m && id ? ([m.value!.trim().toLowerCase(), id] as const) : null;
				})
				.filter((e): e is readonly [string, string] => e !== null),
		);
	const found = existing.get(address);
	if (found) return found;

	const created = await api.createEmailRoutingRule(params.zone, {
		name: `tsubame: ${address}`,
		matchers: [literalToMatcher(address)],
		actions: [workerAction(params.workerName)],
		enabled: true,
	});
	const id = routingRuleId(created);
	if (id) existing.set(address, id);
	return id;
}

/** 宛先 Worker が一致するルールしか消さない。他が作ったルールは残す。 */
export async function removeAddressRoutingRule(
	api: CloudflareApi,
	params: { zone: ZoneRef; address: string; workerName: string },
): Promise<boolean> {
	const address = params.address.trim().toLowerCase();
	const rules = await api.listEmailRoutingRules(params.zone);
	const target = rules.find(
		(rule) =>
			rule.actions.some(
				(a) => a.type === "worker" && a.value.includes(params.workerName),
			) &&
			rule.matchers.some(
				(m) => m.field === "to" && (m.value ?? "").trim().toLowerCase() === address,
			),
	);
	const id = target ? routingRuleId(target) : null;
	if (!id) return false;
	await api.deleteEmailRoutingRule(params.zone, id);
	return true;
}

export async function provisionDomain(params: {
	db: Db;
	api: CloudflareApi;
	env: ProvisionEnv;
	input: ProvisionInput;
}): Promise<ProvisionResult> {
	const { db, api, env, input } = params;
	const name = normalizeDnsName(input.name);
	const workerName = emailWorkerName(env);

	const existing = await db.query.domains.findFirst({ where: eq(domains.name, name) });
	if (existing) throw conflict(`${name} は既に接続されています。`);

	const zone = await resolveZone(api, { name, zoneId: input.zoneId });
	const dnsCheck = await checkDomainDns(api, zone, name);
	const mode: DomainMode = isZoneApex(name, zone.name) ? "apex" : "subdomain";

	if (mode === "apex" && input.confirmApex !== true) {
		throw invalidRequest(
			`${name} はゾーンの apex です。apex を接続すると MX が置き換わり、` +
				"このドメイン宛の全メールがこのアプリに流れ込みます。" +
				`サブドメイン運用（例: mail.${zone.name}）を推奨します。` +
				"それでも apex を接続する場合は confirmApex: true を付けてください。",
			{ warnings: dnsCheck.warnings, recommended: `mail.${zone.name}` },
		);
	}

	const domainId = newId("domain");
	await db.insert(domains).values({
		id: domainId,
		name,
		zoneId: zone.id,
		zoneName: zone.name,
		mode,
		routingStatus: "pending",
		sendingStatus: input.enableSending === false ? "disabled" : "pending",
		catchAllEnabled: false,
		lastError: null,
	});

	const createdAddressIds: string[] = [];
	let existingRules: Map<string, string> | null = null;
	let routingStatus: "pending" | "active" | "error" = "pending";
	let sendingStatus: "disabled" | "pending" | "active" | "error" =
		input.enableSending === false ? "disabled" : "pending";
	let sending: SendingDnsState = { spf: false, dkim: false, dmarc: false };
	let lastError: string | null = null;

	try {
		// apex は Cloudflare の既定なので name を渡さない。渡すと 2007 で弾かれる。
		const routingName = mode === "apex" ? undefined : name;
		await api.enableEmailRouting(zone, routingName);
		await api.createEmailRoutingDns(zone, routingName);
		routingStatus = "active";

		for (const rawLocal of input.localParts ?? []) {
			const localPart = rawLocal.trim().toLowerCase();
			if (!localPart) continue;
			const address = `${localPart}@${name}`;
			if (!existingRules) existingRules = await listRoutingRuleMap(api, zone);
			await ensureAddressRoutingRule(api, { zone, address, workerName, existing: existingRules });
			const addressId = newId("address");
			await db.insert(addresses).values({
				id: addressId,
				domainId,
				localPart,
				address,
				kind: "mailbox",
				isCatchAll: false,
			});
			createdAddressIds.push(addressId);
		}

		if (input.enableSending !== false) {
			await api.enableEmailSending(zone, name);
			// Email Sending のステータス API は当てにならないので、実際のレコードから読む。
			const records = await api.listDnsRecords(zone);
			sending = readSendingDnsState(records, name);
			sendingStatus = sendingStatusOf(sending);
		}
	} catch (err) {
		lastError = err instanceof Error ? err.message : String(err);
		if (routingStatus !== "active") routingStatus = "error";
		if (sendingStatus !== "disabled") sendingStatus = "error";
		await db
			.update(domains)
			.set({ routingStatus, sendingStatus, lastError })
			.where(eq(domains.id, domainId));
		throw err instanceof ApiError
			? err
			: new ApiError("internal", `ドメインの接続に失敗しました: ${lastError}`);
	}

	await db
		.update(domains)
		.set({ routingStatus, sendingStatus, lastError: null })
		.where(eq(domains.id, domainId));

	return {
		domainId,
		name,
		zoneId: zone.id,
		zoneName: zone.name,
		mode,
		routingStatus,
		sendingStatus,
		catchAllEnabled: false,
		dnsCheck,
		sending,
		createdAddressIds,
		lastError: null,
	};
}

export type VerifyResult = {
	domainId: string;
	name: string;
	routingStatus: "pending" | "active" | "error";
	sendingStatus: "disabled" | "pending" | "active" | "error";
	dnsCheck: DnsCheckResult;
	sending: SendingDnsState;
	lastError: string | null;
};

export async function verifyDomain(params: {
	db: Db;
	api: CloudflareApi;
	domain: { id: string; name: string; zoneId: string; zoneName: string; sendingStatus: string };
}): Promise<VerifyResult> {
	const { db, api, domain } = params;
	const zone = { id: domain.zoneId, name: domain.zoneName };

	// 接続の途中で失敗した分をここで拾い直す。読み直すだけだと、オンボーディング
	// 自体が通っていないドメインが pending のまま永久に直らない。
	let lastError: string | null = null;
	if (domain.sendingStatus !== "disabled" && domain.sendingStatus !== "active") {
		try {
			await api.enableEmailSending(zone, domain.name);
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err);
		}
	}

	const records = await api.listDnsRecords(zone);
	const dnsCheck = inspectDnsRecords({
		name: domain.name,
		zoneId: zone.id,
		zoneName: zone.name,
		records,
	});
	const sending = readSendingDnsState(records, domain.name);

	const routingStatus: "pending" | "active" | "error" = dnsCheck.hasCloudflareMx
		? "active"
		: "pending";
	const sendingStatus: "disabled" | "pending" | "active" | "error" =
		domain.sendingStatus === "disabled"
			? "disabled"
			: lastError
				? "error"
				: sendingStatusOf(sending);

	await db
		.update(domains)
		.set({ routingStatus, sendingStatus, lastError })
		.where(eq(domains.id, domain.id));

	return {
		domainId: domain.id,
		name: domain.name,
		routingStatus,
		sendingStatus,
		dnsCheck,
		sending,
		lastError,
	};
}

export type CatchAllResult = {
	domainId: string;
	enabled: boolean;
	warning: string;
	catchAllAddress: string | null;
};

/** ゾーンの catch-all を持てるのは 1 ドメインだけ。同じ zoneId で他ドメインが有効ならその名前を返す。 */
async function zoneCatchAllConflict(
	db: Db,
	params: { zoneId: string; domainId: string },
): Promise<string | null> {
	const other = await db
		.select({ name: domains.name })
		.from(domains)
		.where(
			and(
				eq(domains.zoneId, params.zoneId),
				eq(domains.catchAllEnabled, true),
				ne(domains.id, params.domainId),
			),
		)
		.limit(1);
	return other[0]?.name ?? null;
}

export async function assertZoneCatchAllSafe(
	db: Db,
	params: { zoneId: string; domainId: string },
): Promise<void> {
	const other = await zoneCatchAllConflict(db, params);
	if (other) {
		throw conflict(
			`このゾーンでは別のドメインが catch-all を有効にしています（${other}）。先に ${other} の catch-all を無効にしてください。`,
		);
	}
}

export async function setCatchAll(params: {
	db: Db;
	api: CloudflareApi;
	env: ProvisionEnv;
	domain: {
		id: string;
		name: string;
		zoneId: string;
		zoneName: string;
		mode: string;
		catchAllEnabled: boolean;
	};
	enabled: boolean;
}): Promise<CatchAllResult> {
	const { db, api, env, domain, enabled } = params;
	const zone = { id: domain.zoneId, name: domain.zoneName };
	const workerName = emailWorkerName(env);

	const catchAllAddress = await db.query.addresses.findFirst({
		where: and(eq(addresses.domainId, domain.id), eq(addresses.isCatchAll, true)),
	});

	if (enabled) {
		if (!catchAllAddress) {
			throw invalidRequest(
				"catch-all を有効にする前に、受け皿になるアドレス（isCatchAll: true）を 1 件作ってください。",
			);
		}
		await assertZoneCatchAllSafe(db, { zoneId: domain.zoneId, domainId: domain.id });
	} else if (!domain.catchAllEnabled) {
		// 自分の行が「有効」を握っていなければ、そのゾーンで他ドメインが握っている間は落とさない（#85）。
		await assertZoneCatchAllSafe(db, { zoneId: domain.zoneId, domainId: domain.id });
	} else if (await zoneCatchAllConflict(db, { zoneId: domain.zoneId, domainId: domain.id })) {
		// 修正前のデータで同じゾーンの 2 ドメインが両方「有効」になっていると、ゾーンに 1 本の CF の
		// catch-all を落とした瞬間に残った側が「有効」表示のまま届かなくなる（#85 と同じ食い違い）。
		// 残る側がいる間は CF に触らず、自分の記録だけ下ろして持ち主を 1 つに減らす（#117）。
		await db.update(domains).set({ catchAllEnabled: false }).where(eq(domains.id, domain.id));
		return {
			domainId: domain.id,
			enabled: false,
			warning: CATCH_ALL_WARNING,
			catchAllAddress: catchAllAddress?.address ?? null,
		};
	}

	await api.updateCatchAllRule(zone, {
		enabled,
		name: `tsubame catch-all (${domain.name})`,
		matchers: [{ type: "all" }],
		// 無効化のときも actions は必要。落とすのは enabled だけ。
		actions: [workerAction(workerName)],
	});

	await db.update(domains).set({ catchAllEnabled: enabled }).where(eq(domains.id, domain.id));

	return {
		domainId: domain.id,
		enabled,
		warning: CATCH_ALL_WARNING,
		catchAllAddress: catchAllAddress?.address ?? null,
	};
}
