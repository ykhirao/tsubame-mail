// 突き合わせは必ず同じ addressId 内に閉じる。別アドレスのスレッドに混ざる。
import { and, eq, inArray, sql } from "drizzle-orm";
import { messages, threads } from "@/db/schema";
import type { Db } from "@/db/client";
import { newId } from "@/lib/id";

export type ThreadRefs = {
	addressId: string;
	inReplyTo: string | null;
	references: string | null;
};

export function parseThreadMessageIds(inReplyTo: string | null, references: string | null): string[] {
	const ids = new Set<string>();
	for (const src of [inReplyTo, references]) {
		if (!src) continue;
		for (const token of src.split(/\s+/)) {
			const clean = token.trim().replace(/^<|>$/g, "").trim();
			if (clean) ids.add(clean);
		}
	}
	return [...ids];
}

export async function findExistingThreadId(db: Db, refs: ThreadRefs): Promise<string | null> {
	const ids = parseThreadMessageIds(refs.inReplyTo, refs.references);
	if (ids.length === 0) return null;
	const row = await db
		.select({ threadId: messages.threadId })
		.from(messages)
		.where(and(eq(messages.addressId, refs.addressId), inArray(messages.rfcMessageId, ids)))
		.get();
	return row?.threadId ?? null;
}

/** 件数 1・未読 1 で初期化するので、呼び出し側で足さないこと。 */
export async function createThread(
	db: Db,
	opts: { addressId: string; subject: string | null; lastMessageAt: Date },
): Promise<string> {
	const id = newId("thread");
	await db.insert(threads).values({
		id,
		addressId: opts.addressId,
		subject: opts.subject,
		lastMessageAt: opts.lastMessageAt,
		messageCount: 1,
		unreadCount: 1,
	});
	return id;
}

export async function updateThreadStats(
	db: Db,
	opts: { threadId: string; lastMessageAt: Date; unreadDelta: number },
): Promise<void> {
	await db
		.update(threads)
		.set({
			lastMessageAt: opts.lastMessageAt,
			messageCount: sql`${threads.messageCount} + 1`,
			unreadCount: sql`${threads.unreadCount} + ${opts.unreadDelta}`,
		})
		.where(eq(threads.id, opts.threadId));
}

/** 0 未満にはならないよう丸める。 */
export async function adjustThreadUnread(db: Db, threadId: string, delta: number): Promise<void> {
	await db
		.update(threads)
		.set({ unreadCount: sql`max(0, ${threads.unreadCount} + ${delta})` })
		.where(eq(threads.id, threadId));
}
