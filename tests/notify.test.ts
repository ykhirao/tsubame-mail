import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, schema } from "@/db/client";
import { eq } from "drizzle-orm";
import { handleScheduled, processNotify } from "@/services/notify";
import { generateVapidKeys, toBase64Url } from "@/services/webpush";
import type { NotifyMessage } from "@/services/queue";
import { freshHarness, seedDomain, type Harness } from "../e2e/harness";
import { newId } from "@/lib/id";

type SendLog = { url: string; method: string; headers: Headers };

const fakeCtx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

async function validSub(): Promise<{ pub: string; auth: string }> {
	const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
	const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
	return { pub: toBase64Url(pub), auth: toBase64Url(crypto.getRandomValues(new Uint8Array(16))) };
}

async function enableVapid(h: Harness, status = 201): Promise<SendLog[]> {
	const keys = await generateVapidKeys();
	(h.env as { VAPID_PRIVATE_KEY?: string; VAPID_SUBJECT?: string }).VAPID_PRIVATE_KEY = JSON.stringify(
		keys.privateKey,
	);
	(h.env as { VAPID_SUBJECT?: string }).VAPID_SUBJECT = "mailto:push@tsubame.example";
	const sends: SendLog[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
		sends.push({ url: String(url), method: (init as RequestInit)?.method ?? "GET", headers: new Headers((init as RequestInit)?.headers) });
		return new Response(null, { status });
	});
	return sends;
}

async function addUser(
	h: Harness,
	opts: { userId: string; role: "owner" | "member" | "agent"; addressId?: string; level?: "read" | "write" },
): Promise<void> {
	const db = getDb(h.env);
	await db.insert(schema.users).values({
		id: opts.userId,
		email: `${opts.userId}@tsubame.test`,
		name: opts.userId,
		role: opts.role,
		status: "active",
	});
	if (opts.addressId && opts.level) {
		await db.insert(schema.addressGrants).values({ userId: opts.userId, addressId: opts.addressId, level: opts.level });
	}
}

async function addThread(h: Harness, addressId: string): Promise<string> {
	const db = getDb(h.env);
	const threadId = newId("thread");
	await db.insert(schema.threads).values({
		id: threadId,
		addressId,
		lastMessageAt: new Date(),
		messageCount: 1,
		unreadCount: 1,
	});
	return threadId;
}

async function addMessage(
	h: Harness,
	opts: { threadId?: string; addressId: string; sentByUserId?: string | null; envelopeTo?: string | null; subject?: string },
): Promise<string> {
	const db = getDb(h.env);
	const messageId = newId("message");
	await db.insert(schema.messages).values({
		id: messageId,
		threadId: opts.threadId ?? null,
		addressId: opts.addressId,
		direction: "inbound",
		status: "received",
		fromAddr: "taro@example.com",
		fromName: "山田 太郎",
		toAddr: "info@example.com",
		subject: opts.subject ?? "お知らせ",
		textBody: "こんにちは、世界。これは通知のテストです。",
		hasAttachments: false,
		isRead: false,
		sentByUserId: opts.sentByUserId ?? null,
		envelopeTo: opts.envelopeTo ?? null,
		receivedAt: new Date(),
	});
	return messageId;
}

async function addDevice(
	h: Harness,
	userId: string,
	opts: { enabled?: boolean; endpoint?: string } = {},
): Promise<string> {
	const db = getDb(h.env);
	const deviceId = newId("device");
	const sub = await validSub();
	await db.insert(schema.pushDevices).values({
		id: deviceId,
		userId,
		endpoint: opts.endpoint ?? `https://fcm.googleapis.com/fcm/send/p/${crypto.randomUUID()}`,
		p256dh: sub.pub,
		auth: sub.auth,
		name: "iPhone",
		platform: "ios",
		enabled: opts.enabled ?? true,
	});
	return deviceId;
}

async function countDevices(h: Harness, userId: string): Promise<number> {
	const db = getDb(h.env);
	return (await db.select({ id: schema.pushDevices.id }).from(schema.pushDevices).where(eq(schema.pushDevices.userId, userId)).all()).length;
}

async function drainOutbound(h: Harness): Promise<void> {
	for (const item of [...h.pending]) {
		item.body.kind === "notify" ? await processNotify(item.body, h.env, fakeCtx) : void 0;
	}
	h.pending = [];
}

let h: Harness;
beforeEach(async () => {
	h = await freshHarness();
});
afterEach(() => {
	vi.restoreAllMocks();
});

describe("processNotify", () => {
	it("userId の無い受信を利用者ごとに分け、判定と送信まで通して POST を 1 回行う", async () => {
		const db = getDb(h.env);
		const addressId = (await seedDomain(h, { addresses: ["info"] })).addressIds["info"]!
		const userId = "usr_member";
		await addUser(h, { userId, role: "member", addressId, level: "read" });
		const threadId = await addThread(h, addressId);
		const messageId = await addMessage(h, { threadId, addressId });
		await addDevice(h, userId);
		const sends = await enableVapid(h);

		await processNotify({ kind: "notify", event: "received", messageId }, h.env, fakeCtx);
		// 利用者ごとの NotifyMessage に分けられている。
		expect(h.pending).toHaveLength(1);
		expect(h.pending[0]!.body).toEqual({ kind: "notify", event: "received", messageId, userId });

		await drainOutbound(h);

		expect(sends).toHaveLength(1);
		expect(sends[0]!.method).toBe("POST");
		expect(sends[0]!.headers.get("Content-Encoding")).toBe("aes128gcm");
		expect(sends[0]!.headers.get("TTL")).toBe("86400");
		expect(sends[0]!.headers.get("Topic")).toBe(threadId);
		expect(sends[0]!.headers.get("Authorization")).toMatch(/^vapid t=/);

		const log = await db.select().from(schema.notificationLog).where(eq(schema.notificationLog.userId, userId)).get();
		expect(log?.decision).toBe("sent");
		expect(log?.deviceCount).toBe(1);
	});

	it("冪等: 同じ利用者メッセージを二度処理しても POST は 1 回だけ", async () => {
		const addressId = (await seedDomain(h, { addresses: ["info"] })).addressIds["info"]!
		const userId = "usr_member";
		await addUser(h, { userId, role: "member", addressId, level: "read" });
		const messageId = await addMessage(h, { addressId });
		await addDevice(h, userId);
		const sends = await enableVapid(h);

		const msg: NotifyMessage = { kind: "notify", event: "received", messageId };
		await processNotify(msg, h.env, fakeCtx);
		h.pending = [];
		await processNotify({ ...msg, userId }, h.env, fakeCtx);
		await processNotify({ ...msg, userId }, h.env, fakeCtx);
		expect(sends).toHaveLength(1);
	});

	it("410 gone でその端末を消す", async () => {
		const addressId = (await seedDomain(h, { addresses: ["info"] })).addressIds["info"]!
		const userId = "usr_member";
		await addUser(h, { userId, role: "member", addressId, level: "read" });
		const messageId = await addMessage(h, { addressId });
		const deviceId = await addDevice(h, userId);
		expect(await countDevices(h, userId)).toBe(1);
		await enableVapid(h, 410);

		await processNotify({ kind: "notify", event: "received", messageId, userId }, h.env, fakeCtx);
		expect(await countDevices(h, userId)).toBe(0);
		expect(
			(await getDb(h.env).select().from(schema.pushDevices).where(eq(schema.pushDevices.id, deviceId)).get()),
		).toBeUndefined();
	});

	it("VAPID 未設定なら POST せず notification_log に送信済みとして残す", async () => {
		const addressId = (await seedDomain(h, { addresses: ["info"] })).addressIds["info"]!
		const userId = "usr_member";
		await addUser(h, { userId, role: "member", addressId, level: "read" });
		const messageId = await addMessage(h, { addressId });
		await addDevice(h, userId);
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		await processNotify({ kind: "notify", event: "received", messageId, userId }, h.env, fakeCtx);
		expect(fetchSpy).not.toHaveBeenCalled();
		const log = await getDb(h.env)
			.select()
			.from(schema.notificationLog)
			.where(eq(schema.notificationLog.userId, userId))
			.get();
		expect(log?.decision).toBe("sent");
	});

	it("送信失敗は送った本人（sentByUserId）にだけ届く", async () => {
		const db = getDb(h.env);
		const addressId = (await seedDomain(h, { addresses: ["info"] })).addressIds["info"]!
		const sender = "usr_sender";
		const other = "usr_other";
		await addUser(h, { userId: sender, role: "member", addressId, level: "write" });
		await addUser(h, { userId: other, role: "member", addressId, level: "write" });
		const messageId = await addMessage(h, { addressId, sentByUserId: sender });
		await addDevice(h, sender);
		await addDevice(h, other);
		const sends = await enableVapid(h);

		await processNotify({ kind: "notify", event: "send_failed", messageId }, h.env, fakeCtx);
		expect(h.pending.map((p) => (p.body as { userId?: string }).userId)).toEqual([sender]);
		h.pending = [];
		await processNotify({ kind: "notify", event: "send_failed", messageId, userId: sender }, h.env, fakeCtx);
		expect(sends).toHaveLength(1);
		expect((sends[0]!.url).startsWith("https://fcm.googleapis.com/fcm/send/")).toBe(true);
	});

	it("おやすみ中（digest）は POST せず notification_digests に積む", async () => {
		const db = getDb(h.env);
		const addressId = (await seedDomain(h, { addresses: ["info"] })).addressIds["info"]!
		const userId = "usr_member";
		await addUser(h, { userId, role: "member", addressId, level: "read" });
		const messageId = await addMessage(h, { addressId });
		await addDevice(h, userId);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 201 }));
		await db.insert(schema.notificationPrefs).values({
			userId,
			quiet: { tz: "UTC", mode: "digest", ranges: [{ days: [], start: "00:00", end: "23:59" }] },
		});

		await processNotify({ kind: "notify", event: "received", messageId, userId }, h.env, fakeCtx);
		expect(fetchSpy).not.toHaveBeenCalled();
		const digest = await db
			.select()
			.from(schema.notificationDigests)
			.where(eq(schema.notificationDigests.userId, userId))
			.get();
		expect(digest?.messageIds).toEqual([messageId]);
		const log = await db.select().from(schema.notificationLog).where(eq(schema.notificationLog.userId, userId)).get();
		expect(log?.decision).toBe("digest");
	});

	it("test イベントはその端末にだけテスト通知を送る", async () => {
		const db = getDb(h.env);
		const userId = "usr_member";
		await addUser(h, { userId, role: "member" });
		const deviceId = await addDevice(h, userId);
		const sends = await enableVapid(h);

		await processNotify({ kind: "notify", event: "test", deviceId, userId }, h.env, fakeCtx);
		expect(sends).toHaveLength(1);
		const log = await db.select().from(schema.notificationLog).where(eq(schema.notificationLog.userId, userId)).all();
		expect(log).toHaveLength(0);
	});
});

describe("handleScheduled", () => {
	it("期限の来た digest を 1 通にまとめて送り、行を消し、古い掃除をする", async () => {
		const db = getDb(h.env);
		const addressId = (await seedDomain(h, { addresses: ["info"] })).addressIds["info"]!
		const userId = "usr_member";
		await addUser(h, { userId, role: "member", addressId, level: "read" });
		await addDevice(h, userId);
		const m1 = await addMessage(h, { addressId });
		const m2 = await addMessage(h, { addressId });
		const sends = await enableVapid(h);
		const digestId = newId("digest");
		await db.insert(schema.notificationDigests).values({
			id: digestId,
			userId,
			dueAt: new Date(Date.now() - 1000),
			messageIds: [m1, m2],
		});
		// 掃除対象: 30 日より古い履歴。
		const oldLogId = newId("notification");
		await db.insert(schema.notificationLog).values({
			id: oldLogId,
			userId,
			messageId: m1,
			kind: "received",
			decision: "sent",
			reason: "mailbox_level",
			createdAt: new Date(Date.now() - 40 * 86400000),
		});

		await handleScheduled({ scheduledTime: Date.now() } as unknown as ScheduledController, h.env, fakeCtx);

		expect(sends).toHaveLength(1);
		expect((await getDb(h.env).select().from(schema.notificationDigests).where(eq(schema.notificationDigests.id, digestId)).get())).toBeUndefined();
		expect((await getDb(h.env).select().from(schema.notificationLog).where(eq(schema.notificationLog.id, oldLogId)).get())).toBeUndefined();
	});

	it("90 日使われていない端末を消す", async () => {
		const db = getDb(h.env);
		const userId = "usr_member";
		await addUser(h, { userId, role: "member" });
		const deviceId = newId("device");
		const sub = await validSub();
		await db.insert(schema.pushDevices).values({
			id: deviceId,
			userId,
			endpoint: `https://fcm.googleapis.com/fcm/send/p/deprecated`,
			p256dh: sub.pub,
			auth: sub.auth,
			name: "iPhone",
			platform: "ios",
			enabled: true,
			lastSeenAt: new Date(Date.now() - 100 * 86400000),
		});
		await handleScheduled({ scheduledTime: Date.now() } as unknown as ScheduledController, h.env, fakeCtx);
		expect((await getDb(h.env).select().from(schema.pushDevices).where(eq(schema.pushDevices.id, deviceId)).get())).toBeUndefined();
	});
});
