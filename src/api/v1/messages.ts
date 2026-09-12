import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { messages, outboundJobs, threads } from "@/db/schema";
import type { Db } from "@/db/client";
import type { AppEnv } from "@/api/types";
import { readJson } from "@/lib/validate";
import { forbidden, invalidRequest, notFound } from "@/shared/errors";
import { canModify, canWrite, requireScope } from "@/domain/access/policy";
import {
	messageListQuery,
	messagePatch,
	detailQuery,
	type MessageListResponse,
	type MessageListItem,
	type MessageDetail,
	type MessageListQuery,
	type MessageStatus,
} from "@/shared/contracts/messages";
import {
	parseSearchQuery,
	parseDayStart,
	parseDayEnd,
	type SearchQuery,
} from "@/domain/search/query";
import {
	queryMessages,
	getMessage,
	attachmentsForMessage,
	resolveMailboxId,
	toUnix,
	hiddenAddressIds,
	type MessageRow,
} from "@/domain/search/sql";

const routes = new Hono<AppEnv>();

function buildSearchQuery(q: MessageListQuery): SearchQuery {
	const base = parseSearchQuery(q.q);
	return {
		freeWords: base.freeWords,
		from: q.from ?? base.from,
		to: q.to ?? base.to,
		subject: q.subject ?? base.subject,
		body: q.body ?? base.body,
		since: q.since !== undefined ? parseDayStart(q.since) : base.since,
		until: q.until !== undefined ? parseDayEnd(q.until) : base.until,
		isUnread: q.unread ?? base.isUnread,
		isStarred: q.starred ?? base.isStarred,
		hasAttachment: q.has_attachment ?? base.hasAttachment,
		inAddress: base.inAddress,
	};
}

async function resolveAddressScope(
	db: Db,
	principal: Parameters<typeof resolveMailboxId>[1],
	q: MessageListQuery,
	search: SearchQuery,
): Promise<string | null | undefined> {
	let resolved: string | null | undefined;
	if (q.address) {
		resolved = await resolveMailboxId(db, principal, q.address);
		if (!resolved) return null;
	}
	if (search.inAddress) {
		const id = await resolveMailboxId(db, principal, search.inAddress);
		if (!id) return null;
		if (resolved !== undefined && resolved !== id) return null;
		resolved = id;
	}
	return resolved;
}

function toListItem(m: MessageRow): MessageListItem {
	return {
		id: m.id,
		threadId: m.threadId,
		addressId: m.addressId,
		direction: m.direction,
		status: m.status,
		subject: m.subject,
		snippet: m.snippet,
		fromAddr: m.fromAddr,
		fromName: m.fromName,
		toAddr: m.toAddr,
		ccAddr: m.ccAddr,
		spamVerdict: m.spamVerdict,
		receivedAt: toUnix(m.receivedAt),
		isRead: m.isRead,
		isStarred: m.isStarred,
		hasAttachments: m.hasAttachments,
	};
}

async function toDetail(db: Db, m: MessageRow): Promise<MessageDetail> {
	const atts = await attachmentsForMessage(db, m.id);
	const env = await db
		.select({ envelopeTo: messages.envelopeTo })
		.from(messages)
		.where(eq(messages.id, m.id))
		.get();
	return {
		...toListItem(m),
		envelopeTo: env?.envelopeTo ?? null,
		textBody: m.textBody ?? null,
		htmlBody: m.htmlBody ?? null,
		attachments: atts.map((a) => ({
			id: a.id,
			filename: a.filename,
			contentType: a.contentType,
			sizeBytes: a.sizeBytes,
			isInline: a.isInline,
		})),
	};
}

routes.get("/", async (c) => {
	const db = c.get("db");
	const principal = c.get("principal");
	requireScope(principal, "read");
	const parsed = messageListQuery.safeParse(c.req.query());
	if (!parsed.success) {
		throw invalidRequest("検索パラメータが不正です", zodIssues(parsed));
	}
	const q = parsed.data;
	const search = buildSearchQuery(q);
	const addressId = await resolveAddressScope(db, principal, q, search);
	if (addressId === null) {
		const body: MessageListResponse = { data: [], next_cursor: null };
		return c.json(body);
	}
	// アドレスで名指ししていないときだけ、自分の非表示のメールボックスを既定から除く。
	const hiddenIds =
		addressId === undefined && q.includeHidden !== true
			? await hiddenAddressIds(db, principal.userId)
			: undefined;

	const { rows, nextCursor } = await queryMessages(db, {
		principal,
		filters: { search, addressId, direction: q.direction, status: q.status, threadId: q.thread, hiddenIds },
		order: q.order,
		limit: q.limit,
		cursor: q.cursor,
	});
	const body: MessageListResponse = {
		data: rows.map(toListItem),
		next_cursor: nextCursor,
	};
	return c.json(body);
});

// 権限外の id にも not_found を返す。403 だと ID 総当たりで存在を推測されうる。
routes.get("/:id", async (c) => {
	const db = c.get("db");
	const principal = c.get("principal");
	requireScope(principal, "read");
	const q = detailQuery.safeParse(c.req.query());
	if (!q.success) throw invalidRequest("メッセージのパラメータが不正です", zodIssues(q));
	const id = c.req.param("id");
	const m = await getMessage(db, principal, id, {
		withBody: true,
		includeTrash: q.data.includeTrash === true,
	});
	if (!m) throw notFound("メッセージが見つかりません");
	return c.json(await toDetail(db, m));
});

async function outboundRestoreStatus(db: Db, messageId: string): Promise<MessageStatus> {
	const job = await db
		.select({ status: outboundJobs.status })
		.from(outboundJobs)
		.where(eq(outboundJobs.messageId, messageId))
		.get();
	if (job?.status === "failed") return "failed";
	if (job?.status === "queued" || job?.status === "sending") return "queued";
	return "sent";
}

// 既読・スターは閲覧に付随する操作なので read で通す。read 割り当ての共有メンバーでも
// スレッドを開くと既読付けが走る（ThreadDetail.tsx）ため、write を要求すると画面が壊れる。
// status の変更（ゴミ箱への移動など）だけは send スコープと書き込み権限を必要とする。
routes.patch("/:id", async (c) => {
	const db = c.get("db");
	const principal = c.get("principal");
	requireScope(principal, "read");
	const id = c.req.param("id");
	const p = await readJson(c.req, messagePatch);

	const cur = await getMessage(db, principal, id, { includeTrash: true });
	if (!cur) throw notFound("メッセージが見つかりません");
	if (!canModify(principal, cur.addressId)) {
		throw forbidden("管理者モードで読んでいるだけのメールは変更できません");
	}
	if (p.status !== undefined) {
		requireScope(principal, "send");
		if (!canWrite(principal, cur.addressId)) {
			throw forbidden("このアドレスのメッセージを移動する権限がありません");
		}
	}

	const update: Partial<{
		isRead: boolean;
		isStarred: boolean;
		status: MessageStatus;
	}> = {};
	if (p.isRead !== undefined) update.isRead = p.isRead;
	if (p.isStarred !== undefined) update.isStarred = p.isStarred;
	if (p.status !== undefined) {
		// outbound を「受信」にすると status=sent の検索から消え、送信に失敗したメールまで
		// 受信扱いになる（#68）。ゴミ箱から戻すときは送信ジョブの状態に戻す。
		update.status =
			p.status === "received" && cur.direction === "outbound" ? await outboundRestoreStatus(db, id) : p.status;
	}

	await db.update(messages).set(update).where(eq(messages.id, id)).run();

	// 会話の未読数に入るのは「未読かつゴミ箱でない」メールだけ。バッジ（`addresses.ts` が
	// ゴミ箱の会話を除いて数える）と一覧の濃淡（このカウンタ列）を一致させるため、
	// 既読化とゴミ箱への移動の両方で数え直す。片方だけ減らすと必ずドリフトする（B-33）。
	if (cur.threadId) {
		const counted = (isRead: boolean, status: MessageStatus) => !isRead && status !== "trash";
		const before = counted(cur.isRead, cur.status);
		const after = counted(update.isRead ?? cur.isRead, update.status ?? cur.status);
		if (before !== after) {
			const delta = after ? 1 : -1;
			await db
				.update(threads)
				.set({ unreadCount: sql`max(0, unread_count + ${delta})` })
				.where(eq(threads.id, cur.threadId))
				.run();
		}
	}

	const updated = await getMessage(db, principal, id, { withBody: true, includeTrash: true });
	return c.json(updated ? await toDetail(db, updated) : undefined);
});

function zodIssues(
	result: { success: false; error: { issues?: Array<{ path?: PropertyKey[]; message?: string }> } },
): unknown {
	return result.error.issues?.map((i) => ({ path: i.path?.join("."), message: i.message })) ?? [];
}

export default routes;
