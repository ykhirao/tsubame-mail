import { Hono } from "hono";
import { and, desc, eq, ne } from "drizzle-orm";
import { messages as messagesTable } from "@/db/schema";
import type { Db } from "@/db/client";
import type { AppEnv } from "@/api/types";
import { invalidRequest, notFound } from "@/shared/errors";
import {
	threadListQuery,
	detailQuery,
	type ThreadListResponse,
	type ThreadDetailResponse,
} from "@/shared/contracts/messages";
import {
	queryThreads,
	getThread,
	queryThreadMessages,
	attachmentsForMessages,
	resolveMailboxId,
	hiddenAddressIds,
	toUnix,
} from "@/domain/search/sql";
import { jsonIdsIn, requireScope } from "@/domain/access/policy";

const routes = new Hono<AppEnv>();

async function latestInboundEnvelope(db: Db, threadIds: string[]): Promise<Map<string, string | null>> {
	const map = new Map<string, string | null>();
	if (threadIds.length === 0) return map;
	const rows = await db
		.select({
			threadId: messagesTable.threadId,
			envelopeTo: messagesTable.envelopeTo,
		})
		.from(messagesTable)
		.where(and(
			jsonIdsIn(messagesTable.threadId, threadIds),
			eq(messagesTable.direction, "inbound"),
			ne(messagesTable.status, "trash"),
		))
		.orderBy(desc(messagesTable.receivedAt), desc(messagesTable.id))
		.all();
	for (const r of rows) {
		if (!r.threadId || map.has(r.threadId)) continue;
		map.set(r.threadId, r.envelopeTo ?? null);
	}
	return map;
}

routes.get("/", async (c) => {
	const db = c.get("db");
	const principal = c.get("principal");
	requireScope(principal, "read");
	const parsed = threadListQuery.safeParse(c.req.query());
	if (!parsed.success) {
		throw invalidRequest(
			"スレッド一覧のパラメータが不正です",
			parsed.error.issues?.map((i) => ({
				path: i.path?.join("."),
				message: i.message,
			})) ?? [],
		);
	}
	const q = parsed.data;

	let addressId: string | undefined;
	if (q.address) {
		const id = await resolveMailboxId(db, principal, q.address);
		if (!id) {
			const body: ThreadListResponse = { data: [], next_cursor: null };
			return c.json(body);
		}
		addressId = id;
	}
	// アドレスで名指ししていないときだけ、自分の非表示のメールボックスを既定から除く。
	const hiddenIds =
		addressId === undefined && q.includeHidden !== true
			? await hiddenAddressIds(db, principal.userId)
			: undefined;

	const { rows, nextCursor } = await queryThreads(db, {
		principal,
		addressId,
		hiddenIds,
		view: q.view,
		limit: q.limit,
		cursor: q.cursor,
	});
	const envelopeByThread = await latestInboundEnvelope(db, rows.map((t) => t.id));
	const body: ThreadListResponse = {
		data: rows.map((t) => ({
			id: t.id,
			addressId: t.addressId,
			subject: t.subject,
			lastMessageAt: toUnix(t.lastMessageAt),
			messageCount: t.messageCount,
			address: t.address,
			addressColor: t.addressColor,
			lastFromAddr: t.lastFromAddr,
			lastFromName: t.lastFromName,
			lastDirection: t.lastDirection,
			lastMessageId: t.lastMessageId,
			snippet: t.snippet,
			hasAttachments: t.hasAttachments,
			isStarred: t.isStarred,
			unreadCount: t.unreadCount,
			envelopeTo: envelopeByThread.get(t.id) ?? null,
		})),
		next_cursor: nextCursor,
	};
	return c.json(body);
});

routes.get("/:id", async (c) => {
	const db = c.get("db");
	const principal = c.get("principal");
	requireScope(principal, "read");
	const id = c.req.param("id");
	const q = detailQuery.safeParse(c.req.query());
	if (!q.success) {
		throw invalidRequest(
			"スレッド詳細のパラメータが不正です",
			q.error.issues?.map((i) => ({ path: i.path?.join("."), message: i.message })) ?? [],
		);
	}
	const includeTrash = q.data.includeTrash === true;

	const thread = await getThread(db, principal, id, includeTrash);
	if (!thread) throw notFound("スレッドが見つかりません");

	const msgs = await queryThreadMessages(db, principal, id, {
		includeTrash,
		before: q.data.before ?? undefined,
	});
	const msgIds = msgs.messages.map((m) => m.id);
	const envRows = msgIds.length
		? await db
				.select({ id: messagesTable.id, envelopeTo: messagesTable.envelopeTo })
				.from(messagesTable)
				.where(jsonIdsIn(messagesTable.id, msgIds))
				.all()
		: [];
	const envelopeById = new Map(envRows.map((r) => [r.id, r.envelopeTo ?? null]));
	const attachmentsByMessage = await attachmentsForMessages(db, msgIds);
	const messages = [];
	for (const m of msgs.messages) {
		const atts = attachmentsByMessage.get(m.id) ?? [];
		messages.push({
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
			envelopeTo: envelopeById.get(m.id) ?? null,
			textBody: m.textBody ?? null,
			htmlBody: m.htmlBody ?? null,
			attachments: atts.map((a) => ({
				id: a.id,
				filename: a.filename,
				contentType: a.contentType,
				sizeBytes: a.sizeBytes,
				isInline: a.isInline,
			})),
		});
	}

	const body: ThreadDetailResponse = {
		id: thread.id,
		addressId: thread.addressId,
		subject: thread.subject,
		messages,
		hasOlder: msgs.hasOlder,
		olderCursor: msgs.olderCursor,
		olderCount: msgs.olderCount,
	};
	return c.json(body);
});

export default routes;
