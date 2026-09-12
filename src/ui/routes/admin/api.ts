
export class ApiClientError extends Error {
	readonly code: string;
	readonly status: number;
	readonly details?: unknown;

	constructor(code: string, status: number, message: string, details?: unknown) {
		super(message);
		this.name = "ApiClientError";
		this.code = code;
		this.status = status;
		this.details = details;
	}
}

type ApiErrorBody = { error?: { code?: string; message?: string; details?: unknown } };

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
	const init: RequestInit = {
		method,
		credentials: "include",
		headers: body !== undefined ? { "content-type": "application/json" } : undefined,
		body: body !== undefined ? JSON.stringify(body) : undefined,
	};

	let res: Response;
	try {
		res = await fetch(path, init);
	} catch {
		throw new ApiClientError("network_error", 0, "サーバに接続できませんでした。ログイン状態を確認してください。");
	}

	if (res.status === 204) return undefined as T;

	let json: ApiErrorBody | null = null;
	try {
		json = (await res.json()) as ApiErrorBody;
	} catch {
		/* 本文が JSON でないことは想定内。json は null のまま進める。 */
	}

	if (!res.ok) {
		const e = json?.error;
		throw new ApiClientError(
			e?.code ?? "error",
			res.status,
			e?.message ?? `リクエストに失敗しました（HTTP ${res.status}）`,
			e?.details,
		);
	}

	return json as T;
}

export const api = {
	get: <T,>(path: string) => request<T>("GET", path),
	post: <T,>(path: string, body?: unknown) => request<T>("POST", path, body),
	put: <T,>(path: string, body?: unknown) => request<T>("PUT", path, body),
	patch: <T,>(path: string, body?: unknown) => request<T>("PATCH", path, body),
	del: <T,>(path: string) => request<T>("DELETE", path),
};

/** 管理画面は件数が少ない前提なので、next_cursor を辿って全件を読む。 */
export async function getAllPages<T>(path: string): Promise<T[]> {
	const out: T[] = [];
	let cursor: string | null = null;
	do {
		const sep = path.includes("?") ? "&" : "?";
		const url: string = `${path}${sep}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
		const page: Page<T> = await api.get<Page<T>>(url);
		out.push(...page.data);
		cursor = page.next_cursor;
	} while (cursor);
	return out;
}

export type Role = "owner" | "member" | "agent";
export type Scope = "read" | "send" | "admin";

export interface Me {
	id: string;
	email: string;
	name: string;
	role: Role;
	status: string;
	lastLoginAt: number | null;
	via: "session" | "api_key";
	apiKeyId: string | null;
	scopes: Scope[];
	addressIds: string[] | "all";
	writableAddressIds: string[] | "all";
	addresses: {
		id: string;
		address: string;
		localPart: string;
		displayName: string | null;
		domainId: string;
		domainName: string;
		kind: "mailbox" | "alias";
		level: "read" | "write";
		isCatchAll: boolean;
		unreadCount: number;
		archived: boolean;
	}[];
}

export interface Page<T> {
	data: T[];
	next_cursor: string | null;
}

export type DomainMode = "apex" | "subdomain";
export type RoutingStatus = "pending" | "active" | "error";
export type SendingStatus = "disabled" | "pending" | "active" | "error";

export interface DomainSummary {
	id: string;
	name: string;
	zoneId: string;
	zoneName: string;
	mode: DomainMode;
	routingStatus: RoutingStatus;
	sendingStatus: SendingStatus;
	catchAllEnabled: boolean;
	lastError: string | null;
	addressCount: number;
	createdAt: number;
}

export interface AvailableZone {
	zoneId: string;
	zoneName: string;
	status: string | null;
	connectedNames: string[];
	suggestedName: string;
}

export interface MxFinding {
	name: string;
	content: string;
	priority?: number;
	provider: "cloudflare" | "google" | "microsoft" | "other";
}

export interface DnsWarning {
	level: "danger" | "warn" | "info";
	code: string;
	message: string;
}

export interface DnsCheckResult {
	name: string;
	zoneId: string;
	zoneName: string;
	isApex: boolean;
	recommendedMode: DomainMode;
	requiresApexConfirmation: boolean;
	mx: MxFinding[];
	apexMx: MxFinding[];
	hasForeignMx: boolean;
	hasCloudflareMx: boolean;
	spf: { name: string; content: string } | null;
	dmarc: { name: string; content: string } | null;
	warnings: DnsWarning[];
}

export interface DomainDetail extends DomainSummary {
	addresses: {
		id: string;
		address: string;
		kind: "mailbox" | "alias";
		isCatchAll: boolean;
		archivedAt: number | null;
	}[];
}

export interface AdminAddress {
	id: string;
	domainId: string;
	domainName: string;
	localPart: string;
	address: string;
	displayName: string | null;
	kind: "mailbox" | "alias";
	aliasTargetId: string | null;
	aliasTargetAddress: string | null;
	isCatchAll: boolean;
	signature: string | null;
	color: string | null;
	archivedAt: number | null;
	createdAt: number;
}

/** owner は全アドレスを見られるため全員、それ以外は grants の読み書き。 */
export interface AddressViewer {
	userId: string;
	name: string;
	email: string;
	level: "owner" | "read" | "write";
}

export interface AdminUser {
	id: string;
	email: string;
	name: string;
	role: Role;
	status: "active" | "disabled";
	hasPassword: boolean;
	lastLoginAt: number | null;
	createdAt: number | null;
}

export interface Grant {
	addressId: string;
	level: "read" | "write";
	address: string | null;
}

export interface GrantInput {
	addressId: string;
	level: "read" | "write";
}

export interface AdminUserDetail extends AdminUser {
	grants: Grant[];
}

export interface ApiKeySummary {
	id: string;
	userId: string;
	name: string;
	prefix: string;
	scopes: Scope[];
	addressIds: string[] | null;
	expiresAt: number | null;
	revokedAt: number | null;
	lastUsedAt: number | null;
	createdAt: number;
}

export interface CreatedApiKey extends ApiKeySummary {
	token: string;
}

export type WebhookEvent = "message.received" | "message.sent" | "message.failed";

export interface Webhook {
	id: string;
	name: string;
	url: string;
	events: WebhookEvent[];
	addressIds: string[] | null;
	enabled: boolean;
	createdAt: number | null;
}

export interface WebhookCreate extends Webhook {
	secret: string;
}

export interface WebhookDelivery {
	id: string;
	webhookId: string;
	event: WebhookEvent;
	messageId: string | null;
	status: "pending" | "success" | "failed";
	httpStatus: number | null;
	error: string | null;
	durationMs: number | null;
	attempt: number;
	nextRetryAt: number | null;
	createdAt: number | null;
}

export type RuleScope = "domain" | "address";
export type RuleAction = "deliver" | "forward" | "reject" | "drop" | "mark";

export interface Rule {
	id: string;
	scope: RuleScope;
	domainId: string | null;
	addressId: string | null;
	name: string;
	action: RuleAction;
	matcher: { from?: string; to?: string; subject?: string; contains?: string };
	target: string | null;
	priority: number;
	enabled: boolean;
	createdAt: string | number;
}
