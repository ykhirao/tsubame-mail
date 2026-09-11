import { Hono } from "hono";
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
	attachmentsForMessage,
	resolveMailboxId,
	toUnix,
} from "@/domain/search/sql";
import { requireScope } from "@/domain/access/policy";

const routes = new Hono<AppEnv>();

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

	const { rows, nextCursor } = await queryThreads(db, {
		principal,
		addressId,
		view: q.view,
		limit: q.limit,
		cursor: q.cursor,
	});
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
			snippet: t.snippet,
			hasAttachments: t.hasAttachments,
			isStarred: t.isStarred,
			unreadCount: t.unreadCount,
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

	const msgs = await queryThreadMessages(db, principal, id, includeTrash);
	const messages = [];
	for (const m of msgs) {
		const atts = await attachmentsForMessage(db, m.id);
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
	};
	return c.json(body);
});

export default routes;
