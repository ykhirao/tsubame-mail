import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { messages, threads } from "@/db/schema";
import type { Db } from "@/db/client";
import type { AppEnv } from "@/api/types";
import { invalidRequest, notFound } from "@/shared/errors";
import {
	messageListQuery,
	messagePatch,
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
	return {
		...toListItem(m),
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

	const { rows, nextCursor } = await queryMessages(db, {
		principal,
		filters: { search, addressId, direction: q.direction, status: q.status, threadId: q.thread },
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
	const id = c.req.param("id");
	const m = await getMessage(db, principal, id, true);
	if (!m) throw notFound("メッセージが見つかりません");
	return c.json(await toDetail(db, m));
});

routes.patch("/:id", async (c) => {
	const db = c.get("db");
	const principal = c.get("principal");
	const id = c.req.param("id");
	const body = messagePatch.safeParse(await c.req.json());
	if (!body.success) {
		throw invalidRequest("更新内容が不正です", zodIssues(body));
	}
	const p = body.data;

	const cur = await getMessage(db, principal, id);
	if (!cur) throw notFound("メッセージが見つかりません");

	const update: Partial<{
		isRead: boolean;
		isStarred: boolean;
		status: MessageStatus;
	}> = {};
	if (p.isRead !== undefined) update.isRead = p.isRead;
	if (p.isStarred !== undefined) update.isStarred = p.isStarred;
	if (p.status !== undefined) update.status = p.status;

	await db.update(messages).set(update).where(eq(messages.id, id)).run();

	if (p.isRead !== undefined && p.isRead !== cur.isRead && cur.threadId) {
		const delta = p.isRead ? -1 : 1;
		await db
			.update(threads)
			.set({ unreadCount: sql`max(0, unread_count + ${delta})` })
			.where(eq(threads.id, cur.threadId))
			.run();
	}

	const updated = await getMessage(db, principal, id, true);
	return c.json(updated ? await toDetail(db, updated) : undefined);
});

function zodIssues(
	result: { success: false; error: { issues?: Array<{ path?: PropertyKey[]; message?: string }> } },
): unknown {
	return result.error.issues?.map((i) => ({ path: i.path?.join("."), message: i.message })) ?? [];
}

export default routes;
