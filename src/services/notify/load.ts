import { and, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import type { Db } from "@/db/client";
import { loadPrefs } from "./prefs";
import type {
	Mailbox,
	Message,
	NotificationPrefs,
	Thread,
	User,
} from "@/domain/notify/decide";

export type MessageContext = {
	message: Message;
	mailbox: Mailbox;
	thread: Thread;
	sentByUserId: string | null;
	envelopeTo: string | null;
};

export type LoadedUser = { user: User; prefs: NotificationPrefs };

export async function loadMessageContext(db: Db, messageId: string): Promise<MessageContext | null> {
	const m = await db.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get();
	if (!m) return null;
	const mailbox = await db.select().from(schema.addresses).where(eq(schema.addresses.id, m.addressId)).get();
	if (!mailbox) return null;

	let thread: Thread;
	if (m.threadId) {
		const tr = await db.select().from(schema.threads).where(eq(schema.threads.id, m.threadId)).get();
		if (tr) {
			// threads.message_count はこのメッセージを数えた後の値なので、前の件数は受信時刻で数える。
			const before = await db
				.select({ n: sql<number>`count(*)` })
				.from(schema.messages)
				.where(and(eq(schema.messages.threadId, tr.id), lt(schema.messages.receivedAt, m.receivedAt)))
				.get();
			const outbound = await db
				.select({ n: sql<number>`count(*)` })
				.from(schema.messages)
				.where(and(eq(schema.messages.threadId, tr.id), eq(schema.messages.direction, "outbound")))
				.get();
			thread = {
				id: tr.id,
				messageCount: Number(before?.n ?? 0),
				hasOutbound: (Number(outbound?.n) ?? 0) > 0,
				followed: false,
				muted: false,
				lastNotifiedAt: null,
			};
		} else {
			thread = { id: m.threadId, messageCount: 0, hasOutbound: false, followed: false, muted: false, lastNotifiedAt: null };
		}
	} else {
		thread = { id: "", messageCount: 0, hasOutbound: false, followed: false, muted: false, lastNotifiedAt: null };
	}

	return {
		message: {
			id: m.id,
			addressId: m.addressId,
			direction: m.direction,
			fromAddr: m.fromAddr,
			fromName: m.fromName,
			toAddr: m.toAddr,
			ccAddr: m.ccAddr,
			subject: m.subject,
			textBody: m.textBody,
			hasAttachments: m.hasAttachments,
			spamVerdict: m.spamVerdict,
			discarded: m.status === "trash",
			markedRead: false,
		},
		mailbox: { id: mailbox.id, address: mailbox.address, name: mailbox.displayName ?? mailbox.address, isCatchAll: mailbox.isCatchAll },
		thread,
		sentByUserId: m.sentByUserId,
		envelopeTo: m.envelopeTo,
	};
}

export async function loadLastNotifiedAt(db: Db, userId: string, threadId: string): Promise<number | null> {
	const row = await db
		.select({ at: sql<number | null>`max(${schema.notificationLog.createdAt})` })
		.from(schema.notificationLog)
		.innerJoin(schema.messages, eq(schema.messages.id, schema.notificationLog.messageId))
		.where(
			and(
				eq(schema.notificationLog.userId, userId),
				eq(schema.notificationLog.decision, "sent"),
				eq(schema.messages.threadId, threadId),
			),
		)
		.get();
	return row?.at == null ? null : Number(row.at) * 1000;
}

/** 1 通目の通知以降に同じ会話へ届いた件数。連続まとめ(14)の「新着 N 件」の N。 */
export async function countThreadMessagesSince(
	db: Db,
	threadId: string,
	sinceMs: number,
): Promise<number> {
	const row = await db
		.select({ n: sql<number>`count(*)` })
		.from(schema.messages)
		.where(and(eq(schema.messages.threadId, threadId), gte(schema.messages.receivedAt, new Date(sinceMs))))
		.get();
	return Number(row?.n ?? 0);
}

export async function loadThreadPref(
	db: Db,
	userId: string,
	threadId: string,
): Promise<"follow" | "mute" | null> {
	const row = await db
		.select({ mode: schema.threadNotificationPrefs.mode })
		.from(schema.threadNotificationPrefs)
		.where(
			and(
				eq(schema.threadNotificationPrefs.userId, userId),
				eq(schema.threadNotificationPrefs.threadId, threadId),
			),
		)
		.get();
	return row?.mode ?? null;
}

export async function countEnabledDevices(db: Db, userId: string): Promise<number> {
	const row = await db
		.select({ n: sql<number>`count(*)` })
		.from(schema.pushDevices)
		.where(and(eq(schema.pushDevices.userId, userId), eq(schema.pushDevices.enabled, true)))
		.get();
	return Number(row?.n ?? 0);
}

/** digest の対象メッセージが届いたメールボックスの一覧。端末フィルタ（PN-5-8）に使う。 */
export async function loadMessageAddressIds(db: Db, messageIds: string[]): Promise<string[]> {
	if (messageIds.length === 0) return [];
	const rows = await db
		.select({ addressId: schema.messages.addressId })
		.from(schema.messages)
		.where(inArray(schema.messages.id, messageIds));
	return [...new Set(rows.map((r) => r.addressId))];
}

export async function loadDevices(db: Db, userId: string) {
	const rows = await db.select().from(schema.pushDevices).where(eq(schema.pushDevices.userId, userId)).all();
	// セッションが無い・切れた端末には届かず、掃除も兼ねて消す（#130）。
	// 端末数は #133 で 10 台上限、bind 変数は 100 個以内に収まる。
	const live = new Set<string>();
	const sessionIds = [...new Set(rows.flatMap((r) => (r.sessionId ? [r.sessionId] : [])))];
	if (sessionIds.length > 0) {
		const sessions = await db
			.select({ id: schema.sessions.id, expiresAt: schema.sessions.expiresAt })
			.from(schema.sessions)
			.where(inArray(schema.sessions.id, sessionIds))
			.all();
		const now = Date.now();
		for (const s of sessions) if (s.expiresAt.getTime() > now) live.add(s.id);
	}
	const valid = rows.filter((r) => r.sessionId !== null && live.has(r.sessionId));
	const stale = rows.filter((r) => r.sessionId === null || !live.has(r.sessionId));
	if (stale.length > 0) {
		await db
			.delete(schema.pushDevices)
			.where(and(eq(schema.pushDevices.userId, userId), inArray(schema.pushDevices.id, stale.map((r) => r.id))));
	}
	return valid;
}

export async function loadUserForDecide(
	db: Db,
	userId: string,
	addressId: string,
): Promise<LoadedUser | null> {
	const u = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
	if (!u) return null;
	const grant = await db
		.select({ addressId: schema.addressGrants.addressId })
		.from(schema.addressGrants)
		.where(and(eq(schema.addressGrants.userId, userId), eq(schema.addressGrants.addressId, addressId)))
		.get();
	const deviceCount = await countEnabledDevices(db, userId);
	return {
		user: { id: u.id, role: u.role, status: u.status, deviceCount, assigned: !!grant },
		prefs: await loadPrefs(db, userId),
	};
}

export async function eligibleUserIds(db: Db, addressId: string): Promise<string[]> {
	const owners = await db
		.select({ id: schema.users.id })
		.from(schema.users)
		.where(and(eq(schema.users.role, "owner"), eq(schema.users.status, "active")))
		.all();
	const grantees = await db
		.select({ id: schema.users.id })
		.from(schema.users)
		.innerJoin(
			schema.addressGrants,
			and(
				eq(schema.addressGrants.userId, schema.users.id),
				eq(schema.addressGrants.addressId, addressId),
			),
		)
		.where(and(eq(schema.users.status, "active"), ne(schema.users.role, "agent")))
		.all();
	const ids = new Set<string>([...owners.map((o) => o.id), ...grantees.map((g) => g.id)]);
	return [...ids];
}

/** sentByUserId が null の送信失敗は、そのアドレスに write を持つ全員に知らせる。 */
export async function writeUserIds(db: Db, addressId: string): Promise<string[]> {
	const owners = await db
		.select({ id: schema.users.id })
		.from(schema.users)
		.where(and(eq(schema.users.role, "owner"), eq(schema.users.status, "active")))
		.all();
	const writers = await db
		.select({ id: schema.users.id })
		.from(schema.users)
		.innerJoin(
			schema.addressGrants,
			and(
				eq(schema.addressGrants.userId, schema.users.id),
				eq(schema.addressGrants.addressId, addressId),
				eq(schema.addressGrants.level, "write"),
			),
		)
		.where(and(eq(schema.users.status, "active"), ne(schema.users.role, "agent")))
		.all();
	const ids = new Set<string>([...owners.map((o) => o.id), ...writers.map((g) => g.id)]);
	return [...ids];
}
