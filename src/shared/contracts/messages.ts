import { z } from "zod";
import { paginationQuery, page } from "./common";

export const messageDirection = z.enum(["inbound", "outbound"]);
export type MessageDirection = z.infer<typeof messageDirection>;

export const messageStatus = z.enum(["received", "sent", "draft", "queued", "failed", "trash"]);
export type MessageStatus = z.infer<typeof messageStatus>;

// z.coerce.boolean() は Boolean() 依存で "false" も true になるため、独自に定義する。
const boolParam = z
	.enum(["true", "false", "1", "0"])
	.transform((v) => v === "true" || v === "1")
	.optional();

export const attachmentMeta = z.object({
	id: z.string(),
	filename: z.string(),
	contentType: z.string(),
	sizeBytes: z.number(),
	isInline: z.boolean(),
});
export type AttachmentMeta = z.infer<typeof attachmentMeta>;

export const messageListItem = z.object({
	id: z.string(),
	threadId: z.string().nullable(),
	addressId: z.string(),
	direction: messageDirection,
	status: messageStatus,
	subject: z.string().nullable(),
	snippet: z.string().nullable(),
	fromAddr: z.string(),
	fromName: z.string().nullable(),
	toAddr: z.string(),
	ccAddr: z.string().nullable(),
	spamVerdict: z.string().nullable(),
	/** Unix 秒。 */
	receivedAt: z.number(),
	isRead: z.boolean(),
	isStarred: z.boolean(),
	hasAttachments: z.boolean(),
});
export type MessageListItem = z.infer<typeof messageListItem>;

export const messageDetail = messageListItem.extend({
	textBody: z.string().nullable(),
	htmlBody: z.string().nullable(),
	attachments: z.array(attachmentMeta),
});
export type MessageDetail = z.infer<typeof messageDetail>;

export const messageListResponse = page(messageListItem);
export type MessageListResponse = z.infer<typeof messageListResponse>;

/** 個別パラメータは q 内の同名条件より優先される。 */
export const messageListQuery = paginationQuery.extend({
	q: z.string().optional(),
	/** アドレス文字列（含@）か addressId。 */
	address: z.string().optional(),
	/** 以下 4 つはいずれも部分一致。 */
	from: z.string().optional(),
	to: z.string().optional(),
	subject: z.string().optional(),
	body: z.string().optional(),
	/** since / until はどちらも YYYY-MM-DD。until はその日の 23:59:59 UTC まで含む。 */
	since: z.string().optional(),
	until: z.string().optional(),
	direction: messageDirection.optional(),
	status: messageStatus.optional(),
	unread: boolParam,
	starred: boolParam,
	has_attachment: boolParam,
	thread: z.string().optional(),
	order: z.enum(["received_at", "relevance"]).default("received_at"),
});
export type MessageListQuery = z.infer<typeof messageListQuery>;

/**
 * PATCH で受け付ける status はこの 2 つだけ（ゴミ箱への移動と受信トレイへの差し戻し）。
 * `sent` / `draft` / `queued` / `failed` は送信パイプラインだけが持つ内部状態で、
 * 利用者が書き込み権限だけで inbound をそれらに変えられると一覧の意味が壊れる。
 */
export const messagePatchStatus = z.enum(["received", "trash"]);
export type MessagePatchStatus = z.infer<typeof messagePatchStatus>;

export const messagePatch = z
	.object({
		isRead: z.boolean().optional(),
		isStarred: z.boolean().optional(),
		status: messagePatchStatus.optional(),
	})
	.refine((o) => o.isRead !== undefined || o.isStarred !== undefined || o.status !== undefined, {
		message: "isRead / isStarred / status のうち少なくとも 1 つを指定してください",
	});
export type MessagePatch = z.infer<typeof messagePatch>;

export const threadListItem = z.object({
	id: z.string(),
	addressId: z.string(),
	subject: z.string().nullable(),
	lastMessageAt: z.number(),
	messageCount: z.number(),
	unreadCount: z.number(),
	address: z.string().nullable(),
	addressColor: z.string().nullable(),
	lastFromAddr: z.string().nullable(),
	lastFromName: z.string().nullable(),
	snippet: z.string().nullable(),
	hasAttachments: z.boolean(),
	isStarred: z.boolean(),
});
export type ThreadListItem = z.infer<typeof threadListItem>;

export const threadListResponse = page(threadListItem);
export type ThreadListResponse = z.infer<typeof threadListResponse>;

export const threadListQuery = paginationQuery.extend({
	address: z.string().optional(),
});
export type ThreadListQuery = z.infer<typeof threadListQuery>;

export const threadDetailResponse = z.object({
	id: z.string(),
	addressId: z.string(),
	subject: z.string().nullable(),
	messages: z.array(messageDetail),
});
export type ThreadDetailResponse = z.infer<typeof threadDetailResponse>;
