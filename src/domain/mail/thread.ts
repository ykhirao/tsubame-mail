// 突き合わせは必ず同じ addressId 内に閉じる。別アドレスのスレッドに混ざる。
import { and, eq, inArray, sql } from "drizzle-orm";
import { messages, threads } from "@/db/schema";
import type { Db } from "@/db/client";
import { newId } from "@/lib/id";
import { normalizeAddress, parseAddressList } from "./address";

/** D1 はバインド変数が 1 クエリ 100 個まで。山括弧あり・なしの 2 通りで引くので半分弱に抑える。 */
const MAX_REFERENCE_IDS = 40;

export type ThreadRefs = {
	addressId: string;
	inReplyTo: string | null;
	references: string | null;
	/** 新しく届いたメールの From。inbound をアンカーにしてよいかの判定に使う。 */
	fromAddr: string | null;
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

function capReferenceIds(ids: string[]): string[] {
	if (ids.length <= MAX_REFERENCE_IDS) return ids;
	// 先頭は In-Reply-To、References は古い順なので、直近の親に近い末尾を残す。
	return [ids[0]!, ...ids.slice(-(MAX_REFERENCE_IDS - 1))];
}

function addressListContains(list: string | null, target: string): boolean {
	return parseAddressList(list).some((a) => a.address === target);
}

/**
 * 受信メールの Message-ID は送信者が自由に書ける値なので、それを知っている第三者が
 * In-Reply-To に入れるだけで他人の会話に接ぎ木できてしまう。アンカーにするのは、
 * 同じ送信者の inbound か、自分が送った outbound のうち新しい送信者がその宛先
 * （To/Cc/Bcc）に含まれているものに限る。Message-ID を知るだけの第三者（Bcc 受信者・
 * 転送先・ML 経由など）は宛先に含まれないので通らない。
 */
export async function findExistingThreadId(db: Db, refs: ThreadRefs): Promise<string | null> {
	const ids = capReferenceIds(parseThreadMessageIds(refs.inReplyTo, refs.references));
	if (ids.length === 0) return null;

	// outbound は generateMessageId が山括弧付きで保存している。
	const candidates = ids.flatMap((id) => [id, `<${id}>`]);
	const rows = await db
		.select({
			threadId: messages.threadId,
			direction: messages.direction,
			fromAddr: messages.fromAddr,
			toAddr: messages.toAddr,
			ccAddr: messages.ccAddr,
			bccAddr: messages.bccAddr,
		})
		.from(messages)
		.where(and(eq(messages.addressId, refs.addressId), inArray(messages.rfcMessageId, candidates)))
		.all();

	const sender = refs.fromAddr ? normalizeAddress(refs.fromAddr) : null;
	const anchor = rows.find((r) => {
		if (r.threadId === null) return false;
		if (r.direction === "outbound") {
			return (
				sender !== null &&
				(addressListContains(r.toAddr, sender) ||
					addressListContains(r.ccAddr, sender) ||
					addressListContains(r.bccAddr, sender))
			);
		}
		return sender !== null && normalizeAddress(r.fromAddr) === sender;
	});
	return anchor?.threadId ?? null;
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

/**
 * 日付を偽装した古い返信でスレッドを沈められないよう、lastMessageAt は後退させない。
 * `integer(mode: "timestamp")` は秒で格納するので、生 SQL に混ぜる値も秒に合わせる。
 */
export async function updateThreadStats(
	db: Db,
	opts: { threadId: string; lastMessageAt: Date; unreadDelta: number },
): Promise<void> {
	const lastMessageAtSec = Math.floor(opts.lastMessageAt.getTime() / 1000);
	await db
		.update(threads)
		.set({
			lastMessageAt: sql`max(${threads.lastMessageAt}, ${lastMessageAtSec})`,
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
