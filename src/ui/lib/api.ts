import type {
	MessageDetail,
	MessageListResponse,
	MessagePatch,
	ThreadDetailResponse,
	ThreadListResponse,
} from "@/shared/contracts/messages";
import { messageListQuery, threadListQuery } from "@/shared/contracts/messages";
import { z } from "zod";

export type ThreadListParams = z.input<typeof threadListQuery>;
export type MessageListParams = z.input<typeof messageListQuery>;
import type { MyAddress } from "@/shared/contracts/addresses";
import type {
	Device,
	DeviceInput,
	DeviceUpdate,
	DryRunEntry,
	DryRunInput,
	FeedResponse,
	NotificationLevel,
	NotificationPatch,
	NotificationRule,
	NotificationRuleInput,
	NotificationRuleUpdate,
	NotificationSettings,
} from "@/shared/contracts/notifications";
import type { SessionInfo } from "@/shared/contracts/auth";
import type { UpdateMeBody } from "@/shared/contracts/users";
import type {
	ReplyInput,
	SendMessageInput,
	SendMessageResult,
} from "@/shared/contracts/send";

export const BASE_URL = "/api/v1";

export class ApiError extends Error {
	readonly code: string;
	readonly status: number;
	readonly details?: unknown;

	constructor(code: string, message: string, status: number, details?: unknown) {
		super(message);
		this.name = "ApiError";
		this.code = code;
		this.status = status;
		this.details = details;
	}
}

type RequestOptions = {
	method?: string;
	body?: unknown;
	/** 401 のときにログイン画面へ自動で飛ばすか。認証フロー自身では false にする。 */
	redirectOnUnauthorized?: boolean;
};

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
	const init: RequestInit = {
		method: opts.method ?? "GET",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
	};
	if (opts.body !== undefined) init.body = JSON.stringify(opts.body);

	const res = await fetch(BASE_URL + path, init);
	const isJson = res.headers.get("content-type")?.includes("application/json");
	const body = isJson ? await res.json().catch(() => null) : null;

	if (!res.ok) {
		const payload = body as { error?: { code?: string; message?: string; details?: unknown } };
		const code = payload?.error?.code ?? "internal";
		const message = payload?.error?.message ?? "エラーが発生しました";
		if (
			res.status === 401 &&
			opts.redirectOnUnauthorized !== false &&
			!location.pathname.startsWith("/login") &&
			!location.pathname.startsWith("/bootstrap")
		) {
			const next = encodeURIComponent(location.pathname + location.search);
			location.href = `/login?next=${next}`;
		}
		throw new ApiError(code, message, res.status, payload?.error?.details);
	}
	return body as T;
}

function qs(params: Record<string, unknown> = {}): string {
	const usp = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value === undefined || value === null || value === "") continue;
		if (typeof value === "boolean") {
			usp.set(key, value ? "true" : "false");
		} else {
			usp.set(key, String(value));
		}
	}
	const s = usp.toString();
	return s ? `?${s}` : "";
}

export type Me = {
	id: string;
	email: string;
	name: string;
	role: "owner" | "member" | "agent";
	status: string;
	/** 仮パスワードのまま。true の間は他の画面に進ませない。 */
	mustChangePassword?: boolean;
	lastLoginAt: number | null;
	via: "session" | "api_key";
	apiKeyId: string | null;
	scopes: string[];
	addressIds: string[] | "all";
	writableAddressIds: string[] | "all";
	addresses: MyAddress[];
};

export const AuthApi = {
	login: (email: string, password: string) =>
		request<{ userId: string; email: string; name: string; role: string; expiresAt: number }>(
			"/auth/login",
			{ method: "POST", body: { email, password }, redirectOnUnauthorized: false },
		),
	logout: () => request<{ ok: boolean }>("/auth/logout", { method: "POST" }),
	session: () => request<SessionInfo>("/auth/session", { redirectOnUnauthorized: false }),
	setupState: () =>
		request<{ needsSetup: boolean }>("/auth/setup-state", { redirectOnUnauthorized: false }),
	bootstrap: (email: string, name: string, password: string, secret: string) =>
		request<{ userId: string; email: string; name: string; role: string; expiresAt: number }>(
			"/auth/bootstrap",
			{ method: "POST", body: { email, name, password, secret }, redirectOnUnauthorized: false },
		),
};

export const MeApi = {
	get: () => request<Me>("/me", { redirectOnUnauthorized: false }),
	update: (body: UpdateMeBody) =>
		request<{
			id: string;
			email: string;
			name: string;
			role: string;
			passwordChanged: boolean;
			revokedApiKeys: number;
		}>("/me", { method: "PATCH", body }),
};

type AddressListPage = { data: MyAddress[]; next_cursor: string | null };

async function listAllAddresses(): Promise<AddressListPage> {
	// 101 件以上でも取りこぼさないよう next_cursor を追って全ページ読む（#81）。
	const acc: MyAddress[] = [];
	let cursor: string | null = null;
	do {
		const suffix: string = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
		const res: AddressListPage = await request<AddressListPage>(`/addresses${suffix}`);
		acc.push(...res.data);
		cursor = res.next_cursor;
	} while (cursor);
	return { data: acc, next_cursor: null };
}

export const AddressesApi = {
	list: listAllAddresses,
	updateSignature: (id: string, signature: string | null) =>
		request<{ data: { id: string; signature: string | null } }>(`/addresses/${id}/signature`, {
			method: "PATCH",
			body: { signature },
		}),
};

export const ThreadsApi = {
	list: (query: ThreadListParams = {}) =>
		request<ThreadListResponse>(`/threads${qs(query)}`),
	get: (id: string, opts: { includeTrash?: boolean; before?: string } = {}) =>
		request<ThreadDetailResponse>(`/threads/${id}${qs(opts)}`),
};

export const MessagesApi = {
	list: (query: MessageListParams = {}) =>
		request<MessageListResponse>(`/messages${qs(query)}`),
	get: (id: string, opts: { includeTrash?: boolean } = {}) =>
		request<MessageDetail>(`/messages/${id}${qs(opts)}`),
	patch: (id: string, body: MessagePatch) =>
		request<MessageDetail>(`/messages/${id}`, { method: "PATCH", body }),
	send: (input: SendMessageInput) =>
		request<SendMessageResult>("/messages", { method: "POST", body: input }),
	reply: (id: string, input: ReplyInput) =>
		request<SendMessageResult>(`/messages/${id}/reply`, { method: "POST", body: input }),
};

export const AttachmentApi = {
	url: (id: string) => `${BASE_URL}/attachments/${id}`,
	rawUrl: (id: string) => `${BASE_URL}/messages/${id}/raw`,
};

export const UsersApi = {
	/** password を送らないと仮パスワードが発行され、**このレスポンスにだけ**平文が入る。 */
	create: (input: { email: string; name: string; role: "member" | "agent" }) =>
		request<{
			id: string;
			email: string;
			name: string;
			role: string;
			temporaryPassword: string | null;
		}>("/admin/users", { method: "POST", body: input }),
};

export type MyApiKey = {
	id: string;
	name: string;
	prefix: string;
	scopes: string[];
	addressIds: string[] | null;
	expiresAt: number | null;
	revokedAt: number | null;
	lastUsedAt: number | null;
	parentKeyId: string | null;
	createdAt: number | null;
};

export const MyKeysApi = {
	list: (query: { limit?: number; cursor?: string } = {}) =>
		request<{ data: MyApiKey[]; next_cursor: string | null }>(`/me/api-keys${qs(query)}`),
	/** 発行の応答にだけ平文が入る。 */
	create: (body: {
		name: string;
		scopes: string[];
		addressIds?: string[];
		expiresAt?: number;
	}) =>
		request<MyApiKey & { token: string }>("/me/api-keys", { method: "POST", body }),
	revoke: (id: string) => request<unknown>(`/me/api-keys/${id}`, { method: "DELETE" }),
};

export const NotificationsApi = {
	get: () => request<NotificationSettings>("/me/notifications"),
	patch: (body: NotificationPatch) =>
		request<NotificationSettings>("/me/notifications", { method: "PATCH", body }),
	setMailboxLevel: (addressId: string, level: NotificationLevel) =>
		request<{ addressId: string; level: NotificationLevel }>(
			`/me/notifications/mailboxes/${addressId}`,
			{ method: "PUT", body: { level } },
		),
	listRules: () => request<{ data: NotificationRule[] }>("/me/notifications/rules"),
	createRule: (body: NotificationRuleInput) =>
		request<NotificationRule>("/me/notifications/rules", { method: "POST", body }),
	updateRule: (id: string, body: NotificationRuleUpdate) =>
		request<NotificationRule>(`/me/notifications/rules/${id}`, { method: "PATCH", body }),
	deleteRule: (id: string) => request<unknown>(`/me/notifications/rules/${id}`, { method: "DELETE" }),
	reorderRules: (ids: string[]) =>
		request<{ data: NotificationRule[] }>("/me/notifications/rules/reorder", {
			method: "POST",
			body: { ids },
		}),
	dryRun: (body: DryRunInput = {}) =>
		request<{ data: DryRunEntry[] }>("/me/notifications/dry-run", { method: "POST", body }),
	feed: (query: { limit?: number; cursor?: string; include_dropped?: 1; hold_group?: string } = {}) =>
		request<FeedResponse>(`/me/notifications/feed${qs(query)}`),
	markFeedSeen: () =>
		request<{ feed_seen_at: number; unseen_count: number }>("/me/notifications/feed/seen", {
			method: "POST",
		}),
	getThread: (threadId: string) =>
		request<{ threadId: string; mode: "follow" | "mute" | null }>(`/threads/${threadId}/notification`),
	setThread: (threadId: string, mode: "follow" | "mute") =>
		request<{ threadId: string; mode: "follow" | "mute" }>(`/threads/${threadId}/notification`, {
			method: "PUT",
			body: { mode },
		}),
	clearThread: (threadId: string) =>
		request<unknown>(`/threads/${threadId}/notification`, { method: "DELETE" }),
};

export const DevicesApi = {
	list: () => request<{ data: Device[] }>("/me/devices"),
	register: (body: DeviceInput) => request<Device>("/me/devices", { method: "POST", body }),
	update: (id: string, body: DeviceUpdate) =>
		request<Device>(`/me/devices/${id}`, { method: "PATCH", body }),
	remove: (id: string) => request<unknown>(`/me/devices/${id}`, { method: "DELETE" }),
	test: (id: string) => request<{ queued: boolean }>(`/me/devices/${id}/test`, { method: "POST" }),
	seen: (id: string) => request<unknown>(`/me/devices/${id}/seen`, { method: "POST" }),
	pushKey: () => request<{ key: string | null }>("/push/key"),
	badge: () => request<{ count: number }>("/push/badge"),
};
