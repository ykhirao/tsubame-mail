/**
 * `CF_API_TOKEN` の Zone リソースは、ドメインを増やすたびに広げ直す必要がある。
 * 権限不足の Cloudflare エラー（HTTP 403 / code 10000・9109 など）は
 * `tokenScopeMessage()` で日本語の対処方法に変換している。
 */
import { z } from "zod";
import { ApiError } from "@/shared/errors";

/** 生成された `CloudflareEnv` に宣言が無くても渡せるよう、すべて optional にしてある。 */
export type CloudflareApiEnv = {
	CF_API_TOKEN?: string;
	CF_ACCOUNT_ID?: string;
};

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type CloudflareApiOptions = {
	fetch?: FetchLike;
	baseUrl?: string;
	timeoutMs?: number;
	pageDeadlineMs?: number;
};

export const CF_API_BASE = "https://api.cloudflare.com/client/v4";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_PAGE_DEADLINE_MS = 30_000;

export const cfEndpoints = {
	zones: () => "/zones",
	dnsRecords: (zoneId: string) => `/zones/${zoneId}/dns_records`,
	dnsRecord: (zoneId: string, recordId: string) => `/zones/${zoneId}/dns_records/${recordId}`,

	emailRoutingEnable: (zoneId: string) => `/zones/${zoneId}/email/routing/enable`,
	emailRoutingDisable: (zoneId: string) => `/zones/${zoneId}/email/routing/disable`,
	/** body の `name` を省くと apex に作られる。 */
	emailRoutingDns: (zoneId: string) => `/zones/${zoneId}/email/routing/dns`,
	emailRoutingRules: (zoneId: string) => `/zones/${zoneId}/email/routing/rules`,
	emailRoutingRule: (zoneId: string, ruleId: string) =>
		`/zones/${zoneId}/email/routing/rules/${ruleId}`,
	/** catch-all はゾーン単位なので既定で触らない。 */
	emailRoutingCatchAll: (zoneId: string) => `/zones/${zoneId}/email/routing/rules/catch_all`,

	// Email Sending 側は実機未確認。仕様が違っていたらここだけ直す。
	// Email Sending に enable/disable のエンドポイントは無い。ゾーン配下の
	// subdomain リソースを作る／消すことが、そのまま有効化／無効化にあたる。
	emailSendingSubdomains: (zoneId: string) => `/zones/${zoneId}/email/sending/subdomains`,
	emailSendingSubdomain: (zoneId: string, subdomainId: string) =>
		`/zones/${zoneId}/email/sending/subdomains/${subdomainId}`,
	emailSendingSubdomainDns: (zoneId: string, subdomainId: string) =>
		`/zones/${zoneId}/email/sending/subdomains/${subdomainId}/dns`,
} as const;

const cfErrorItem = z.object({
	code: z.number().optional(),
	message: z.string().default(""),
});

const cfResultInfo = z.object({
	page: z.number().optional(),
	per_page: z.number().optional(),
	count: z.number().optional(),
	total_count: z.number().optional(),
	total_pages: z.number().optional(),
});

const cfEnvelope = z.object({
	success: z.boolean().default(false),
	errors: z.array(cfErrorItem).default([]),
	messages: z.array(z.unknown()).default([]),
	result: z.unknown().optional(),
	result_info: cfResultInfo.optional(),
});

export const cfZone = z.object({
	id: z.string(),
	name: z.string(),
	status: z.string().optional(),
	paused: z.boolean().optional(),
	account: z.object({ id: z.string().optional(), name: z.string().optional() }).optional(),
});
export type CfZone = z.infer<typeof cfZone>;

export const cfDnsRecord = z.object({
	id: z.string(),
	type: z.string(),
	name: z.string(),
	content: z.string().default(""),
	priority: z.number().optional(),
	ttl: z.number().optional(),
	proxied: z.boolean().optional(),
	comment: z.string().nullish(),
});
export type CfDnsRecord = z.infer<typeof cfDnsRecord>;

export type CfDnsRecordInput = {
	type: string;
	name: string;
	content: string;
	priority?: number;
	ttl?: number;
	proxied?: boolean;
	comment?: string;
};

export const cfEmailRoutingMatcher = z.object({
	type: z.string(),
	field: z.string().optional(),
	value: z.string().optional(),
});
export type CfEmailRoutingMatcher = z.infer<typeof cfEmailRoutingMatcher>;

export const cfEmailRoutingAction = z.object({
	type: z.string(),
	value: z.array(z.string()).default([]),
});
export type CfEmailRoutingAction = z.infer<typeof cfEmailRoutingAction>;

export const cfEmailRoutingRule = z.object({
	tag: z.string().optional(),
	id: z.string().optional(),
	name: z.string().optional(),
	enabled: z.boolean().default(true),
	priority: z.number().optional(),
	matchers: z.array(cfEmailRoutingMatcher).default([]),
	actions: z.array(cfEmailRoutingAction).default([]),
});
export type CfEmailRoutingRule = z.infer<typeof cfEmailRoutingRule>;

export const cfEmailRoutingSettings = z.object({
	enabled: z.boolean().optional(),
	name: z.string().optional(),
	status: z.string().optional(),
	tag: z.string().optional(),
});
export type CfEmailRoutingSettings = z.infer<typeof cfEmailRoutingSettings>;

export const cfSuggestedDnsRecord = z.object({
	type: z.string(),
	name: z.string(),
	content: z.string().default(""),
	priority: z.number().optional(),
	ttl: z.number().optional(),
});
export type CfSuggestedDnsRecord = z.infer<typeof cfSuggestedDnsRecord>;

/** Cloudflare は配列で返す場合と `{ records: [...] }` で返す場合がある。 */
const cfSuggestedDnsResult = z.preprocess((value) => {
	if (Array.isArray(value)) return value;
	if (value && typeof value === "object" && Array.isArray((value as { records?: unknown }).records)) {
		return (value as { records: unknown[] }).records;
	}
	return [];
}, z.array(cfSuggestedDnsRecord));

export const cfEmailSendingSettings = z.object({
	id: z.string().optional(),
	enabled: z.boolean().optional(),
	name: z.string().optional(),
	status: z.string().optional(),
	dkim_status: z.string().optional(),
	spf_status: z.string().optional(),
	dmarc_status: z.string().optional(),
});
export type CfEmailSendingSettings = z.infer<typeof cfEmailSendingSettings>;

const TOKEN_SCOPE_ERROR_CODES = new Set([10000, 9109, 9106, 9103, 6003]);

export function isTokenScopeError(status: number, codes: number[]): boolean {
	if (status === 403) return true;
	return codes.some((c) => TOKEN_SCOPE_ERROR_CODES.has(c));
}

export function tokenScopeMessage(zoneName: string | undefined, detail: string): string {
	const target = zoneName ? `ゾーン「${zoneName}」` : "対象のゾーン";
	return (
		`Cloudflare API の権限が足りません。CF_API_TOKEN のスコープに${target}を追加してください。` +
		`（トークンの Zone リソースはドメインを増やすたびに広げ直す必要があります。` +
		`必要な権限: ゾーン:読み取り / DNS:編集 / Email Routing ルール:編集、` +
		`アカウントに Email Routing アドレス:編集 と Email Sending:編集）` +
		`／Cloudflare の応答: ${detail}`
	);
}

export function missingTokenError(): ApiError {
	return new ApiError(
		"internal",
		"CF_API_TOKEN が設定されていません。`wrangler secret put CF_API_TOKEN` で投入してください。",
	);
}

export function missingAccountError(): ApiError {
	return new ApiError(
		"internal",
		"CF_ACCOUNT_ID が設定されていません。`wrangler secret put CF_ACCOUNT_ID` で投入してください。",
	);
}

type RequestSpec = {
	method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	path: string;
	query?: Record<string, string | number | boolean | undefined>;
	body?: unknown;
	zoneName?: string;
	allowNotFound?: boolean;
	signal?: AbortSignal;
};

export type ZoneRef = { id: string; name?: string };

export class CloudflareApi {
	readonly #token: string | undefined;
	readonly #accountId: string | undefined;
	readonly #baseUrl: string;
	readonly #fetch: FetchLike | undefined;
	readonly #timeoutMs: number;
	readonly #pageDeadlineMs: number;

	constructor(env: CloudflareApiEnv, options: CloudflareApiOptions = {}) {
		this.#token = env.CF_API_TOKEN;
		this.#accountId = env.CF_ACCOUNT_ID;
		this.#baseUrl = options.baseUrl ?? CF_API_BASE;
		this.#fetch = options.fetch;
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.#pageDeadlineMs = options.pageDeadlineMs ?? DEFAULT_PAGE_DEADLINE_MS;
	}

	get accountId(): string {
		if (!this.#accountId) throw missingAccountError();
		return this.#accountId;
	}

	get hasCredentials(): boolean {
		return Boolean(this.#token);
	}

	/** トークンの付与・エラー変換をここに集約している。ここ以外で fetch を呼ばないこと。 */
	async #request(spec: RequestSpec): Promise<{ result: unknown; resultInfo?: z.infer<typeof cfResultInfo> } | null> {
		if (!this.#token) throw missingTokenError();

		const url = new URL(`${this.#baseUrl}${spec.path}`);
		for (const [key, value] of Object.entries(spec.query ?? {})) {
			if (value !== undefined) url.searchParams.set(key, String(value));
		}

		const method = spec.method ?? "GET";
		const signal = spec.signal ?? AbortSignal.timeout(this.#timeoutMs);
		const init: RequestInit = {
			method,
			signal,
			headers: {
				Authorization: `Bearer ${this.#token}`,
				"Content-Type": "application/json",
				Accept: "application/json",
			},
		};
		if (spec.body !== undefined) init.body = JSON.stringify(spec.body);

		const doFetch: FetchLike = this.#fetch ?? ((i, ini) => globalThis.fetch(i, ini));
		let response: Response;
		try {
			response = await doFetch(url.toString(), init);
		} catch (cause) {
			throw new ApiError(
				"internal",
				`Cloudflare API に接続できませんでした（${method} ${spec.path}）`,
				{ cause: String(cause) },
			);
		}

		if (response.status === 404 && spec.allowNotFound) return null;

		let payload: unknown;
		const text = await response.text();
		try {
			payload = text ? JSON.parse(text) : {};
		} catch {
			throw new ApiError(
				"internal",
				`Cloudflare API が JSON ではない応答を返しました（${method} ${spec.path} / HTTP ${response.status}）`,
				{ bodySnippet: text.slice(0, 200) },
			);
		}

		const envelope = cfEnvelope.safeParse(payload);
		if (!envelope.success) {
			throw new ApiError(
				"internal",
				`Cloudflare API の応答が想定の形ではありません（${method} ${spec.path}）`,
				{ issues: z.treeifyError(envelope.error) },
			);
		}

		const { success, errors, result, result_info: resultInfo } = envelope.data;
		if (!response.ok || !success) {
			const codes = errors.map((e) => e.code).filter((c): c is number => typeof c === "number");
			const detail =
				errors.map((e) => (e.code ? `${e.code}: ${e.message}` : e.message)).join(" / ") ||
				`HTTP ${response.status}`;

			if (isTokenScopeError(response.status, codes)) {
				throw new ApiError("forbidden", tokenScopeMessage(spec.zoneName, detail), {
					kind: "token_scope",
					path: spec.path,
					codes,
				});
			}
			if (response.status === 404) {
				throw new ApiError("not_found", `Cloudflare に対象が見つかりません（${detail}）`, {
					path: spec.path,
				});
			}
			throw new ApiError(
				"internal",
				`Cloudflare API がエラーを返しました（${method} ${spec.path}）: ${detail}`,
				{ path: spec.path, codes },
			);
		}

		return { result, resultInfo };
	}

	async #call<T>(schema: z.ZodType<T>, spec: RequestSpec): Promise<T> {
		const response = await this.#request(spec);
		const parsed = schema.safeParse(response?.result ?? null);
		if (!parsed.success) {
			throw new ApiError(
				"internal",
				`Cloudflare API の result を解釈できませんでした（${spec.path}）`,
				{ issues: z.treeifyError(parsed.error) },
			);
		}
		return parsed.data;
	}

	async listZones(
		options: { name?: string; page?: number; perPage?: number; signal?: AbortSignal } = {},
	): Promise<{ zones: CfZone[]; page: number; totalPages: number }> {
		// #request がトークンを確かめるより先に account.id を query に載せるので、
		// トークンなしのときはそちらが勝たないよう先に失敗させる。
		if (!this.#token) throw missingTokenError();
		const page = options.page ?? 1;
		const response = await this.#request({
			path: cfEndpoints.zones(),
			query: {
				name: options.name,
				page,
				per_page: options.perPage ?? 50,
				"account.id": this.accountId,
			},
			signal: options.signal,
		});
		const zones = z.array(cfZone).parse(response?.result ?? []);
		return {
			zones,
			page: response?.resultInfo?.page ?? page,
			totalPages: response?.resultInfo?.total_pages ?? 1,
		};
	}

	async listAllZones(options: { name?: string; maxPages?: number } = {}): Promise<CfZone[]> {
		const maxPages = options.maxPages ?? 20;
		const all: CfZone[] = [];
		const deadline = AbortSignal.timeout(this.#pageDeadlineMs);
		for (let page = 1; page <= maxPages; page += 1) {
			const { zones, totalPages } = await this.listZones({ name: options.name, page, signal: deadline });
			all.push(...zones);
			if (zones.length === 0 || page >= totalPages) break;
		}
		return all;
	}

	async listDnsRecords(
		zone: ZoneRef,
		filter: { type?: string; name?: string } = {},
	): Promise<CfDnsRecord[]> {
		const records: CfDnsRecord[] = [];
		const deadline = AbortSignal.timeout(this.#pageDeadlineMs);
		for (let page = 1; page <= 20; page += 1) {
			const response = await this.#request({
				path: cfEndpoints.dnsRecords(zone.id),
				query: { type: filter.type, name: filter.name, page, per_page: 100 },
				zoneName: zone.name,
				signal: deadline,
			});
			const parsed = z.array(cfDnsRecord).parse(response?.result ?? []);
			records.push(...parsed);
			const totalPages = response?.resultInfo?.total_pages ?? 1;
			if (parsed.length === 0 || page >= totalPages) break;
		}
		return records;
	}

	async createDnsRecord(zone: ZoneRef, record: CfDnsRecordInput): Promise<CfDnsRecord> {
		return this.#call(cfDnsRecord, {
			method: "POST",
			path: cfEndpoints.dnsRecords(zone.id),
			body: record,
			zoneName: zone.name,
		});
	}

	async deleteDnsRecord(zone: ZoneRef, recordId: string): Promise<void> {
		await this.#request({
			method: "DELETE",
			path: cfEndpoints.dnsRecord(zone.id, recordId),
			zoneName: zone.name,
		});
	}

	/**
	 * `name` には実際にメールを受ける名前を渡す。省略すると apex に MX が作られるため、
	 * サブドメイン運用なら `mail.example.com` を渡し、apex を渡さないこと。
	 */
	async enableEmailRouting(zone: ZoneRef, name: string): Promise<CfEmailRoutingSettings> {
		return this.#call(cfEmailRoutingSettings, {
			method: "POST",
			path: cfEndpoints.emailRoutingEnable(zone.id),
			body: { name },
			zoneName: zone.name,
		});
	}

	async disableEmailRouting(zone: ZoneRef): Promise<void> {
		await this.#request({
			method: "POST",
			path: cfEndpoints.emailRoutingDisable(zone.id),
			body: {},
			zoneName: zone.name,
		});
	}

	async createEmailRoutingDns(zone: ZoneRef, name: string): Promise<CfSuggestedDnsRecord[]> {
		return this.#call(cfSuggestedDnsResult, {
			method: "POST",
			path: cfEndpoints.emailRoutingDns(zone.id),
			body: { name },
			zoneName: zone.name,
		});
	}

	async getEmailRoutingDns(zone: ZoneRef, name?: string): Promise<CfSuggestedDnsRecord[]> {
		return this.#call(cfSuggestedDnsResult, {
			path: cfEndpoints.emailRoutingDns(zone.id),
			query: { name },
			zoneName: zone.name,
		});
	}

	async listEmailRoutingRules(zone: ZoneRef): Promise<CfEmailRoutingRule[]> {
		const rules: CfEmailRoutingRule[] = [];
		const deadline = AbortSignal.timeout(this.#pageDeadlineMs);
		for (let page = 1; page <= 20; page += 1) {
			const response = await this.#request({
				path: cfEndpoints.emailRoutingRules(zone.id),
				query: { page, per_page: 50 },
				zoneName: zone.name,
				signal: deadline,
			});
			const parsed = z.array(cfEmailRoutingRule).parse(response?.result ?? []);
			rules.push(...parsed);
			const totalPages = response?.resultInfo?.total_pages ?? 1;
			if (parsed.length === 0 || page >= totalPages) break;
		}
		return rules;
	}

	async createEmailRoutingRule(
		zone: ZoneRef,
		rule: {
			name: string;
			matchers: CfEmailRoutingMatcher[];
			actions: CfEmailRoutingAction[];
			enabled?: boolean;
			priority?: number;
		},
	): Promise<CfEmailRoutingRule> {
		return this.#call(cfEmailRoutingRule, {
			method: "POST",
			path: cfEndpoints.emailRoutingRules(zone.id),
			body: { enabled: true, priority: 0, ...rule },
			zoneName: zone.name,
		});
	}

	async deleteEmailRoutingRule(zone: ZoneRef, ruleId: string): Promise<void> {
		await this.#request({
			method: "DELETE",
			path: cfEndpoints.emailRoutingRule(zone.id, ruleId),
			zoneName: zone.name,
		});
	}

	/**
	 * catch-all はゾーン単位。apex の MX を Cloudflare に向けた状態で有効にすると、
	 * そのゾーン宛の全メールがこの Worker に流れ込む。
	 */
	async getCatchAllRule(zone: ZoneRef): Promise<CfEmailRoutingRule | null> {
		const response = await this.#request({
			path: cfEndpoints.emailRoutingCatchAll(zone.id),
			zoneName: zone.name,
			allowNotFound: true,
		});
		if (!response) return null;
		return cfEmailRoutingRule.parse(response.result);
	}

	async updateCatchAllRule(
		zone: ZoneRef,
		rule: {
			enabled: boolean;
			name?: string;
			matchers?: CfEmailRoutingMatcher[];
			actions: CfEmailRoutingAction[];
		},
	): Promise<CfEmailRoutingRule> {
		return this.#call(cfEmailRoutingRule, {
			method: "PUT",
			path: cfEndpoints.emailRoutingCatchAll(zone.id),
			body: {
				name: rule.name ?? "catch-all",
				enabled: rule.enabled,
				matchers: rule.matchers ?? [{ type: "all" }],
				actions: rule.actions,
			},
			zoneName: zone.name,
		});
	}

	async listEmailSendingSubdomains(zone: ZoneRef): Promise<CfEmailSendingSettings[]> {
		return this.#call(z.array(cfEmailSendingSettings), {
			path: cfEndpoints.emailSendingSubdomains(zone.id),
			zoneName: zone.name,
		});
	}

	// 既に作られている subdomain に POST すると 409 になる。接続をやり直せるよう、
	// 既存があればそれを返して再作成しない。
	async enableEmailSending(zone: ZoneRef, name: string): Promise<CfEmailSendingSettings> {
		const existing = await this.#findEmailSendingSubdomain(zone, name);
		if (existing) return existing;
		return this.#call(cfEmailSendingSettings, {
			method: "POST",
			path: cfEndpoints.emailSendingSubdomains(zone.id),
			body: { name },
			zoneName: zone.name,
		});
	}

	async disableEmailSending(zone: ZoneRef, name: string): Promise<void> {
		const found = await this.#findEmailSendingSubdomain(zone, name);
		if (!found?.id) return;
		await this.#request({
			method: "DELETE",
			path: cfEndpoints.emailSendingSubdomain(zone.id, found.id),
			zoneName: zone.name,
		});
	}

	async getEmailSendingSettings(zone: ZoneRef, name: string): Promise<CfEmailSendingSettings> {
		return (await this.#findEmailSendingSubdomain(zone, name)) ?? { name, enabled: false };
	}

	async getEmailSendingDns(zone: ZoneRef, name: string): Promise<CfSuggestedDnsRecord[]> {
		const found = await this.#findEmailSendingSubdomain(zone, name);
		if (!found?.id) return [];
		return this.#call(cfSuggestedDnsResult, {
			path: cfEndpoints.emailSendingSubdomainDns(zone.id, found.id),
			zoneName: zone.name,
		});
	}

	async #findEmailSendingSubdomain(
		zone: ZoneRef,
		name: string,
	): Promise<CfEmailSendingSettings | null> {
		const list = await this.listEmailSendingSubdomains(zone);
		return list.find((s) => s.name?.toLowerCase() === name.toLowerCase()) ?? null;
	}
}

export function createCloudflareApi(
	env: CloudflareApiEnv,
	options: CloudflareApiOptions = {},
): CloudflareApi {
	return new CloudflareApi(env, options);
}

/** Email Routing の識別子は `tag`。古い応答に備えて `id` も見る。 */
export function routingRuleId(rule: CfEmailRoutingRule): string | null {
	return rule.tag ?? rule.id ?? null;
}

/** workerName は `wrangler.jsonc` の `name` と一致していないと受信が止まる。 */
export function workerAction(workerName: string): CfEmailRoutingAction {
	return { type: "worker", value: [workerName] };
}

export function literalToMatcher(address: string): CfEmailRoutingMatcher {
	return { type: "literal", field: "to", value: address };
}
