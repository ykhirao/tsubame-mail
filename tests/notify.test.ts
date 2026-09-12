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
	const sessionId = newId("session");
	await db.insert(schema.sessions).values({
		id: sessionId,
		userId,
		tokenHash: `h_${sessionId}`,
		expiresAt: new Date(Date.now() + 3_600_000),
	});
	const sub = await validSub();
	await db.insert(schema.pushDevices).values({
		id: deviceId,
		userId,
		sessionId,
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

async function enableVapidPerEndpoint(h: Harness, statusByEndpoint: Record<string, number>): Promise<SendLog[]> {
	const keys = await generateVapidKeys();
	(h.env as { VAPID_PRIVATE_KEY?: string; VAPID_SUBJECT?: string }).VAPID_PRIVATE_KEY = JSON.stringify(
		keys.privateKey,
	);
	(h.env as { VAPID_SUBJECT?: string }).VAPID_SUBJECT = "mailto:push@tsubame.example";
	const sends: SendLog[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
		sends.push({ url: String(url), method: (init as RequestInit)?.method ?? "GET", headers: new Headers((init as RequestInit)?.headers) });
		return new Response(null, { status: statusByEndpoint[String(url)] ?? 201 });
	});
	return sends;
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
		expect(h.pending[0]!.body).toEqual({ kind: "notify", event: "received", messageId, userId, ruleRead: false });

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

	it("判定の前に利用者が読んで既読になっていても、ルール由来でなければ送る", async () => {
		const addressId = (await seedDomain(h, { addresses: ["info"] })).addressIds["info"]!
		const userId = "usr_member";
		await addUser(h, { userId, role: "member", addressId, level: "read" });
		const messageId = await addMessage(h, { addressId });
		await getDb(h.env).update(schema.messages).set({ isRead: true }).where(eq(schema.messages.id, messageId));
		await addDevice(h, userId);
		const sends = await enableVapid(h);

		await processNotify({ kind: "notify", event: "received", messageId, userId }, h.env, fakeCtx);
		expect(sends).toHaveLength(1);

		const ruled = await addMessage(h, { addressId });
		await processNotify({ kind: "notify", event: "received", messageId: ruled, userId, ruleRead: true }, h.env, fakeCtx);
		expect(sends).toHaveLength(1);
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
	describe("#131 端末ごとの再試行", () => {
		const receivedMsg = (messageId: string, userId: string) =>
			({ kind: "notify", event: "received", messageId, userId }) as const;

		it("一部が一時失敗したら retry_device_ids に記録して throw し、成功端末を数える", async () => {
			const db = getDb(h.env);
			const addressId = (await seedDomain(h, { addresses: ["info"] })).addressIds["info"]!
			const userId = "usr_member";
			await addUser(h, { userId, role: "member", addressId, level: "read" });
			const messageId = await addMessage(h, { addressId });
			const downEndpoint = "https://push.example.net/down";
			const upEndpoint = "https://push.example.net/up";
			const downDevice = await addDevice(h, userId, { endpoint: downEndpoint });
			await addDevice(h, userId, { endpoint: upEndpoint });
			const sends = await enableVapidPerEndpoint(h, { [downEndpoint]: 500, [upEndpoint]: 201 });

			await expect(processNotify(receivedMsg(messageId, userId), h.env, fakeCtx)).rejects.toThrow(
				"push service retry",
			);

			expect(sends.map((s) => s.url)).toEqual([downEndpoint, upEndpoint]);
			const log = await db
				.select()
				.from(schema.notificationLog)
				.where(eq(schema.notificationLog.userId, userId))
				.get();
			expect(log?.decision).toBe("sent");
			// 実際に届いたのは成功端末 1 台。失敗端末は retry_device_ids に残る。
			expect(log?.deviceCount).toBe(1);
			expect(log?.retryDeviceIds).toEqual([downDevice]);
		});

		it("全台が一時失敗なら retry_device_ids に全端末を記録して throw する", async () => {
			const db = getDb(h.env);
			const addressId = (await seedDomain(h, { addresses: ["info"] })).addressIds["info"]!
			const userId = "usr_member";
			await addUser(h, { userId, role: "member", addressId, level: "read" });
			const messageId = await addMessage(h, { addressId });
			const downEndpoint = "https://push.example.net/down";
			const downDevice = await addDevice(h, userId, { endpoint: downEndpoint });
			await enableVapidPerEndpoint(h, { [downEndpoint]: 500 });

			await expect(processNotify(receivedMsg(messageId, userId), h.env, fakeCtx)).rejects.toThrow(
				"push service retry",
			);
			const log = await db
				.select()
				.from(schema.notificationLog)
				.where(eq(schema.notificationLog.userId, userId))
				.get();
			expect(log?.decision).toBe("sent");
			expect(log?.deviceCount).toBe(0);
			expect(log?.retryDeviceIds).toEqual([downDevice]);
		});

		it("再配達は失敗端末だけに送り直し、成功したら外す。成功端末へは二度送らない", async () => {
			const db = getDb(h.env);
			const addressId = (await seedDomain(h, { addresses: ["info"] })).addressIds["info"]!
			const userId = "usr_member";
			await addUser(h, { userId, role: "member", addressId, level: "read" });
			const messageId = await addMessage(h, { addressId });
			const downEndpoint = "https://push.example.net/down";
			const upEndpoint = "https://push.example.net/up";
			await addDevice(h, userId, { endpoint: downEndpoint });
			await addDevice(h, userId, { endpoint: upEndpoint });
			const statusByEndpoint: Record<string, number> = { [downEndpoint]: 500, [upEndpoint]: 201 };
			const sends = await enableVapidPerEndpoint(h, statusByEndpoint);

			await expect(processNotify(receivedMsg(messageId, userId), h.env, fakeCtx)).rejects.toThrow(
				"push service retry",
			);
			// 回復したので再配達（2 回目）で fail 端末だけに成功する。
			statusByEndpoint[downEndpoint] = 201;
			const before = sends.length;
			await processNotify(receivedMsg(messageId, userId), h.env, fakeCtx, { attempts: 2, maxRetries: 3 });

			// 再配達で POST は失敗端末 1 台だけ。成功端末（up）へは二度送らない。
			expect(sends.slice(before).map((s) => s.url)).toEqual([downEndpoint]);
			expect(sends.filter((s) => s.url === upEndpoint)).toHaveLength(1);
			const log = await db
				.select()
				.from(schema.notificationLog)
				.where(eq(schema.notificationLog.userId, userId))
				.get();
			// 全部送れたので空になり、delivered は累計 2 台。
			expect(log?.retryDeviceIds).toEqual([]);
			expect(log?.deviceCount).toBe(2);
		});

		it("再配達でも失敗が残ればその端末だけを keep して再 throw する", async () => {
			const db = getDb(h.env);
			const addressId = (await seedDomain(h, { addresses: ["info"] })).addressIds["info"]!
			const userId = "usr_member";
			await addUser(h, { userId, role: "member", addressId, level: "read" });
			const messageId = await addMessage(h, { addressId });
			const downEndpoint = "https://push.example.net/down";
			const upEndpoint = "https://push.example.net/up";
			const downDevice = await addDevice(h, userId, { endpoint: downEndpoint });
			await addDevice(h, userId, { endpoint: upEndpoint });
			const statusByEndpoint: Record<string, number> = { [downEndpoint]: 500, [upEndpoint]: 201 };
			const sends = await enableVapidPerEndpoint(h, statusByEndpoint);

			await expect(processNotify(receivedMsg(messageId, userId), h.env, fakeCtx)).rejects.toThrow(
				"push service retry",
			);
			const before = sends.length;
			await expect(
				processNotify(receivedMsg(messageId, userId), h.env, fakeCtx, { attempts: 2, maxRetries: 3 }),
			).rejects.toThrow("push service retry");

			expect(sends.slice(before).map((s) => s.url)).toEqual([downEndpoint]);
			const log = await db
				.select()
				.from(schema.notificationLog)
				.where(eq(schema.notificationLog.userId, userId))
				.get();
			expect(log?.retryDeviceIds).toEqual([downDevice]);
		});

		it("再試行の上限に達したら諦めて retry_device_ids を空にする", async () => {
			const db = getDb(h.env);
			const addressId = (await seedDomain(h, { addresses: ["info"] })).addressIds["info"]!
			const userId = "usr_member";
			await addUser(h, { userId, role: "member", addressId, level: "read" });
			const messageId = await addMessage(h, { addressId });
			const downEndpoint = "https://push.example.net/down";
			await addDevice(h, userId, { endpoint: downEndpoint });
			await enableVapidPerEndpoint(h, { [downEndpoint]: 500 });

			await expect(processNotify(receivedMsg(messageId, userId), h.env, fakeCtx)).rejects.toThrow(
				"push service retry",
			);
			// max_retries=3 なので 4 回目は retry() が効かない。諦めて throw せず空にする。
			await processNotify(receivedMsg(messageId, userId), h.env, fakeCtx, { attempts: 4, maxRetries: 3 });
			const log = await db
				.select()
				.from(schema.notificationLog)
				.where(eq(schema.notificationLog.userId, userId))
				.get();
			expect(log?.retryDeviceIds).toEqual([]);
		});

		it("恒久的 4xx は failure_count を増やし、閾値で端末を無効化する", async () => {
			const db = getDb(h.env);
			const addressId = (await seedDomain(h, { addresses: ["info"] })).addressIds["info"]!
			const userId = "usr_member";
			await addUser(h, { userId, role: "member", addressId, level: "read" });
			const badEndpoint = "https://push.example.net/bad";
			const deviceId = await addDevice(h, userId, { endpoint: badEndpoint });
			await enableVapidPerEndpoint(h, { [badEndpoint]: 400 });

			for (let i = 0; i < 3; i++) {
				const messageId = await addMessage(h, { addressId });
				await processNotify(receivedMsg(messageId, userId), h.env, fakeCtx);
			}

			const dev = await db.select().from(schema.pushDevices).where(eq(schema.pushDevices.id, deviceId)).get();
			expect(dev?.failureCount).toBe(3);
			expect(dev?.enabled).toBe(false);
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

	it("短時間に続いたら 1 通の「新着 N 件」に置き換える（PN-4-14）", async () => {
		const db = getDb(h.env);
		const addressId = (await seedDomain(h, { addresses: ["info"] })).addressIds["info"]!
		const userId = "usr_member";
		await addUser(h, { userId, role: "member", addressId, level: "read" });
		const threadId = await addThread(h, addressId);
		const firstMessage = await addMessage(h, { threadId, addressId });
		// 直前に通知済みの記録を作り、連続窓の内側にいる状態にする。
		await db.insert(schema.notificationLog).values({
			id: newId("notification"),
			userId,
			messageId: firstMessage,
			kind: "received",
			decision: "sent",
			reason: "mailbox_level",
		});
		await db.insert(schema.notificationPrefs).values({ userId, burstWindowSec: 60 });
		await addDevice(h, userId);
		const sends = await enableVapid(h);
		const nextMessage = await addMessage(h, { threadId, addressId });

		await processNotify({ kind: "notify", event: "received", messageId: nextMessage, userId }, h.env, fakeCtx);

		expect(sends).toHaveLength(1);
		// 同じ会話として置き換えるため Topic は会話 ID。
		expect(sends[0]!.headers.get("Topic")).toBe(threadId);
		const log = await db.select().from(schema.notificationLog).where(eq(schema.notificationLog.userId, userId)).all();
		expect(log.find((r) => r.messageId === nextMessage)?.reason).toBe("coalesced");
	});

	it("digest も端末ごとの受け取るメールボックスで間引く（PN-5-8）", async () => {
		const db = getDb(h.env);
		const { addressIds } = await seedDomain(h, { addresses: ["info", "news"] });
		const userId = "usr_member";
		await addUser(h, { userId, role: "member", addressId: addressIds["info"]!, level: "read" });
		// 全ボックス受け取る端末と、news だけ受け取る端末。digest は info のメッセージに入っている。
		await addDevice(h, userId, { endpoint: "https://fcm.googleapis.com/fcm/send/p/all" });
		const newsOnly = newId("device");
		const sessionId = newId("session");
		await db.insert(schema.sessions).values({
			id: sessionId,
			userId,
			tokenHash: `h_${sessionId}`,
			expiresAt: new Date(Date.now() + 3_600_000),
		});
		const sub = await validSub();
		await db.insert(schema.pushDevices).values({
			id: newsOnly,
			userId,
			sessionId,
			endpoint: "https://fcm.googleapis.com/fcm/send/p/news",
			p256dh: sub.pub,
			auth: sub.auth,
			name: "PC",
			platform: "desktop",
			enabled: true,
			addressIds: [addressIds["news"]!],
		});
		const m1 = await addMessage(h, { addressId: addressIds["info"]! });
		const sends = await enableVapid(h);
		await db.insert(schema.notificationDigests).values({
			id: newId("digest"),
			userId,
			dueAt: new Date(Date.now() - 1000),
			messageIds: [m1],
		});

		await handleScheduled({ scheduledTime: Date.now() } as unknown as ScheduledController, h.env, fakeCtx);

		// 届くのは全ボックス受け取る 1 台だけ。news 専用の端末には送らない。
		expect(sends.filter((s) => s.method === "POST")).toHaveLength(1);
		expect(sends[0]!.url).toBe("https://fcm.googleapis.com/fcm/send/p/all");
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

	// inArray は id 数だけバインド変数を積み D1 の 100 個上限を越えるので、
	// jsonIdsIn に替えて 150 件の掃除でも cron 全体を壊さないか見る（#57）。
	it("digest 150 行（利用者 150 人、各 1 件）を 1 回で空にする（VAPID 無し）", async () => {
		const db = getDb(h.env);
		const addressId = (await seedDomain(h, { addresses: ["info"] })).addressIds["info"]!;
		for (let i = 0; i < 150; i++) {
			const userId = `usr_member_${i}`;
			await addUser(h, { userId, role: "member" });
			const messageId = await addMessage(h, { addressId });
			await db.insert(schema.notificationDigests).values({
				id: `${userId}_digest`,
				userId,
				dueAt: new Date(Date.now() - 1000),
				messageIds: [messageId],
			});
		}

		await handleScheduled({ scheduledTime: Date.now() } as unknown as ScheduledController, h.env, fakeCtx);

		expect((await db.select().from(schema.notificationDigests).all())).toHaveLength(0);
	});

	it("1 人の digest に messageIds 150 件でも例外を出さず空にする", async () => {
		const db = getDb(h.env);
		const addressId = (await seedDomain(h, { addresses: ["info"] })).addressIds["info"]!;
		const userId = "usr_member";
		await addUser(h, { userId, role: "member", addressId, level: "read" });
		await addDevice(h, userId);
		const sends = await enableVapid(h);
		const messageIds: string[] = [];
		for (let i = 0; i < 150; i++) messageIds.push(await addMessage(h, { addressId }));
		await db.insert(schema.notificationDigests).values({
			id: newId("digest"),
			userId,
			dueAt: new Date(Date.now() - 1000),
			messageIds,
		});

		await handleScheduled({ scheduledTime: Date.now() } as unknown as ScheduledController, h.env, fakeCtx);

		expect(sends.filter((s) => s.method === "POST")).toHaveLength(1);
		expect((await db.select().from(schema.notificationDigests).all())).toHaveLength(0);
	});
});
