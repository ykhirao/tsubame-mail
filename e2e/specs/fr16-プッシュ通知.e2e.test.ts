import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "@/worker";
import { scenario } from "../registry";
import { getDb, schema } from "@/db/client";
import { eq } from "drizzle-orm";
import { newId } from "@/lib/id";
import { toBase64Url } from "@/services/webpush";
import {
	createClient,
	deliverEmail,
	drainQueues,
	enableVapid,
	freshHarness,
	loginAsOwner,
	mime,
	seedDomain,
	type Client,
	type Harness,
} from "../harness";

describe("FR-16 プッシュ通知", () => {
	let h: Harness;
	let owner: Client;

	beforeEach(async () => {
		h = await freshHarness();
		owner = await loginAsOwner(h);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function validSub(): Promise<{ p256dh: string; auth: string }> {
		const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
		const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
		return { p256dh: toBase64Url(pub), auth: toBase64Url(crypto.getRandomValues(new Uint8Array(16))) };
	}

	async function addDevice(
		client: Client,
		opts: { name?: string; endpoint?: string } = {},
	): Promise<{ id: string; endpoint: string }> {
		const sub = await validSub();
		const endpoint = opts.endpoint ?? `https://fcm.googleapis.com/fcm/send/p/${crypto.randomUUID()}`;
		const res = await client.post("/api/v1/me/devices", {
			endpoint,
			keys: sub,
			name: opts.name ?? "iPhone",
			platform: "ios",
		});
		expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
		return { id: res.body.id as string, endpoint };
	}

	async function createMember(
		email: string,
		grants: { addressId: string; level: string }[],
	): Promise<{ client: Client; id: string; email: string; password: string }> {
		const created = await owner.post("/api/v1/admin/users", { email, name: email, role: "member" });
		expect(created.status).toBe(201);
		const id = created.body.id as string;
		const temp = created.body.temporaryPassword as string;
		await owner.put(`/api/v1/admin/users/${id}/grants`, { grants });

		const c = createClient(h);
		await c.post("/api/v1/auth/login", { email, password: temp });
		const password = `${email}-own-password`;
		await c.patch("/api/v1/me", { currentPassword: temp, newPassword: password });
		await c.post("/api/v1/auth/login", { email, password });
		return { client: c, id, email, password };
	}

	async function insertMessage(
		h: Harness,
		opts: { addressId: string; sentByUserId?: string | null; spamVerdict?: "spam" | null; subject?: string },
	): Promise<string> {
		const db = getDb(h.env);
		const messageId = newId("message");
		await db.insert(schema.messages).values({
			id: messageId,
			threadId: null,
			addressId: opts.addressId,
			direction: opts.sentByUserId ? "outbound" : "inbound",
			status: "received",
			fromAddr: "taro@example.com",
			fromName: "山田 太郎",
			toAddr: "info@example.com",
			subject: opts.subject ?? "お知らせ",
			textBody: "こんにちは、世界。これは通知のテストです。",
			hasAttachments: false,
			isRead: false,
			sentByUserId: opts.sentByUserId ?? null,
			spamVerdict: opts.spamVerdict ?? null,
			receivedAt: new Date(),
		});
		return messageId;
	}

	async function countDevices(client: Client): Promise<number> {
		const res = await client.get("/api/v1/me/devices");
		return (res.body.data as Array<{ id: string }>).length;
	}

	scenario("FR-16-1", "端末は購読のための公開鍵をサーバから受け取れる", async () => {
		const { generateVapidKeys } = await import("@/services/webpush");
		const keys = await generateVapidKeys();
		(h.env as { VAPID_PRIVATE_KEY?: string }).VAPID_PRIVATE_KEY = JSON.stringify(keys.privateKey);
		const res = await owner.get("/api/v1/push/key");
		expect(res.status).toBe(200);
		expect(res.body.key).toBe(keys.publicKey);
	});

	scenario("FR-16-10", "画面を開いたときに付け直すバッジの数をサーバから受け取れる", async () => {
		const res = await owner.get("/api/v1/push/badge");
		expect(res.status).toBe(200);
		expect(typeof res.body.count).toBe("number");
	});

	scenario(
		"FR-16-1",
		"端末を登録でき、1 人が複数の端末を持てる。同じ endpoint は上書き",
		async () => {
			const a = await addDevice(owner, { name: "iPhone" });
			const b = await addDevice(owner, { name: "iPad" });

			const list = await owner.get("/api/v1/me/devices");
			expect(list.body.data).toHaveLength(2);

			const res = await owner.post("/api/v1/me/devices", {
				endpoint: a.endpoint,
				keys: await validSub(),
				name: "電話機を買い替え",
				platform: "ios",
			});
			expect(res.status).toBe(200);
			expect(res.body.id).toBe(a.id);
			expect(res.body.name).toBe("電話機を買い替え");

			const after = await owner.get("/api/v1/me/devices");
			expect(after.body.data).toHaveLength(2);
			void b;
		},
	);

		scenario(
			"FR-16-1",
			"API キーでは通知・端末の API が 403。agent も 403。他人の端末は触れない",
			async () => {
				const me = await owner.get("/api/v1/me");
				const key = await owner.post("/api/v1/admin/api-keys", {
					userId: me.body.id as string,
					name: "通知キー",
					scopes: ["read"],
					addressIds: null,
				});
				expect(key.status).toBe(201);

				owner.useKey(key.body.token as string);
				expect((await owner.get("/api/v1/me/notifications")).status).toBe(403);
				expect((await owner.get("/api/v1/me/devices")).status).toBe(403);

				owner.useKey(null);
				const agent = await owner.post("/api/v1/admin/users", {
					email: "agent@tsubame.test",
					name: "エージェント",
					role: "agent",
				});
				expect(agent.status).toBe(201);
				const agentKey = await owner.post("/api/v1/admin/api-keys", {
					userId: agent.body.id as string,
					name: "エージェントキー",
					scopes: ["read"],
					addressIds: null,
				});
				expect(agentKey.status).toBe(201);

				owner.useKey(agentKey.body.token as string);
				expect((await owner.get("/api/v1/me/notifications")).status).toBe(403);

				owner.useKey(null);
				const { client: m1 } = await createMember("m1@tsubame.test", []);
				const other = await createMember("other@tsubame.test", []);
				const d = await addDevice(m1);
				const patch = await other.client.patch(`/api/v1/me/devices/${d.id}`, { name: "乗っ取り" });
				expect(patch.status).toBe(404);
				const del = await other.client.del(`/api/v1/me/devices/${d.id}`);
				expect(del.status).toBe(404);
			},
		);

	scenario(
		["FR-16-2", "FR-16-9"],
		"受信すると割り当てられた利用者の端末に POST が飛び、割り当ての無い member には飛ばない",
		async () => {
			const seeded = await seedDomain(h, { addresses: ["ai"] });
			const ai = seeded.addressIds["ai"]!;
			const { client: worker } = await createMember("worker@tsubame.test", [{ addressId: ai, level: "read" }]);
			const { client: outsider } = await createMember("outsider@tsubame.test", []);
			const workerDev = await addDevice(worker);
			await addDevice(outsider);

			const sends = await enableVapid(h);
			await deliverEmail(h, {
				from: "a@ext.jp",
				to: "ai@mail.tsubame.test",
				raw: mime({ from: "a@ext.jp", to: "ai@mail.tsubame.test", subject: "採用連絡" }),
			});
			await drainQueues(h);

			expect(sends).toHaveLength(1);
			expect(sends[0]!.method).toBe("POST");
			expect(sends[0]!.url).toBe(workerDev.endpoint);
			expect(sends[0]!.headers.get("Content-Encoding")).toBe("aes128gcm");
		},
	);

	scenario("FR-16-2", "送信失敗はそのメールを送った本人にだけ通知される", async () => {
		const seeded = await seedDomain(h, { addresses: ["ai"] });
		const ai = seeded.addressIds["ai"]!;
		const sender = await createMember("sender@tsubame.test", [{ addressId: ai, level: "write" }]);
		const bystander = await createMember("bystander@tsubame.test", [{ addressId: ai, level: "write" }]);
		const senderDev = await addDevice(sender.client);
		await addDevice(bystander.client);

		const sends = await enableVapid(h);
		const messageId = await insertMessage(h, { addressId: ai, sentByUserId: sender.id });
		h.pending.push({ queue: "outbound", body: { kind: "notify", event: "send_failed", messageId } });
		await drainQueues(h);

		expect(sends).toHaveLength(1);
		expect(sends[0]!.url).toBe(senderDev.endpoint);
	});

	scenario(["FR-16-4", "FR-16-3"], "一時停止中の受信は送られず、通知欄に束で残る", async () => {
		const seeded = await seedDomain(h, { addresses: ["pause"] });
		const pause = seeded.addressIds["pause"]!;
		const { client: m } = await createMember("pause@tsubame.test", [{ addressId: pause, level: "read" }]);
		await addDevice(m);

		const future = Math.floor(Date.now() / 1000) + 3600;
		const patched = await m.patch("/api/v1/me/notifications", { paused_until: future });
		expect(patched.status).toBe(200);

		const sends = await enableVapid(h);
		await deliverEmail(h, {
			from: "a@ext.jp",
			to: "pause@mail.tsubame.test",
			raw: mime({ from: "a@ext.jp", to: "pause@mail.tsubame.test", subject: "休みの知らせ" }),
		});
		await drainQueues(h);

		expect(sends).toHaveLength(0);

		const feed = await m.get("/api/v1/me/notifications/feed");
		expect(feed.status).toBe(200);
		expect(feed.body.data.length).toBeGreaterThan(0);
		const bundle = feed.body.data[0];
		expect(bundle.type).toBe("bundle");
		expect(bundle.decision).toBe("held");
		expect(bundle.reason).toBe("paused");
		expect(bundle.count).toBeGreaterThan(0);

		// hold_group 指定で束の残りを平坦に引け、差出人・件名が入る
		const rest = await m.get(`/api/v1/me/notifications/feed?hold_group=${bundle.id}`);
		expect(rest.status).toBe(200);
		expect(rest.body.data.length).toBe(bundle.count);
		expect(rest.body.next_cursor).toBeNull();
		const first = rest.body.data[0];
		expect(first.type).toBe("entry");
		expect(first.fromAddr).toBe("a@ext.jp");
		expect(first.subject).toBe("休みの知らせ");
		expect(first.mailboxAddress).not.toBe("");
	});

	scenario("FR-16-5", "アドレスの割り当てを外すと、次の 1 通から通知が来ない", async () => {
		const seeded = await seedDomain(h, { addresses: ["churn"] });
		const churn = seeded.addressIds["churn"]!;
		const { client: m, id } = await createMember("churn@tsubame.test", [
			{ addressId: churn, level: "read" },
		]);
		await addDevice(m);

		const sends = await enableVapid(h);
		await deliverEmail(h, {
			from: "a@ext.jp",
			to: "churn@mail.tsubame.test",
			raw: mime({ from: "a@ext.jp", to: "churn@mail.tsubame.test", subject: "最初" }),
		});
		await drainQueues(h);
		expect(sends).toHaveLength(1);
		expect(JSON.stringify((await m.get("/api/v1/me/notifications/feed")).body)).toContain("最初");

		await owner.put(`/api/v1/admin/users/${id}/grants`, { grants: [] });
		// 通知の履歴は残るが、見られなくなったアドレスのメールの件名は通知欄に出さない。
		expect(JSON.stringify((await m.get("/api/v1/me/notifications/feed")).body)).not.toContain("最初");

		await deliverEmail(h, {
			from: "a@ext.jp",
			to: "churn@mail.tsubame.test",
			raw: mime({ from: "a@ext.jp", to: "churn@mail.tsubame.test", subject: "二通目" }),
		});
		await drainQueues(h);
		expect(sends).toHaveLength(1);
	});

	scenario(
		"FR-16-6",
		"パスワードを変えると全端末の購読が消え、ログアウトするとその端末の購読が消える",
		async () => {
			const { client: m, email, password } = await createMember("dev@tsubame.test", []);
			await addDevice(m);
			await addDevice(m);
			expect(await countDevices(m)).toBe(2);

			const newPassword = `${email}-renewed`;
			await m.patch("/api/v1/me", { currentPassword: password, newPassword });

			const fresh = createClient(h);
			await fresh.post("/api/v1/auth/login", { email, password: newPassword });
			expect(await countDevices(fresh)).toBe(0);

			await addDevice(fresh);
			expect(await countDevices(fresh)).toBe(1);
			await fresh.post("/api/v1/auth/logout");
			const afterLogout = createClient(h);
			await afterLogout.post("/api/v1/auth/login", { email, password: newPassword });
			expect(await countDevices(afterLogout)).toBe(0);
		},
	);

	scenario("FR-16-11", "push サービスが 410 を返したらその端末を消す", async () => {
		const seeded = await seedDomain(h, { addresses: ["gone"] });
		const gone = seeded.addressIds["gone"]!;
		const { client: m } = await createMember("gone@tsubame.test", [{ addressId: gone, level: "read" }]);
		await addDevice(m);
		expect(await countDevices(m)).toBe(1);

		const sends = await enableVapid(h, 410);
		await deliverEmail(h, {
			from: "a@ext.jp",
			to: "gone@mail.tsubame.test",
			raw: mime({ from: "a@ext.jp", to: "gone@mail.tsubame.test", subject: "買い替え" }),
		});
		await drainQueues(h);

		expect(sends.length).toBeGreaterThan(0);
		expect(await countDevices(m)).toBe(0);
	});

	scenario("FR-16-7", "設定の行が無くても既定値で通知が来る", async () => {
		const seeded = await seedDomain(h, { addresses: ["pref"] });
		const pref = seeded.addressIds["pref"]!;
		const { client: m } = await createMember("pref@tsubame.test", [{ addressId: pref, level: "read" }]);
		await addDevice(m);

		const sends = await enableVapid(h);
		await deliverEmail(h, {
			from: "a@ext.jp",
			to: "pref@mail.tsubame.test",
			raw: mime({ from: "a@ext.jp", to: "pref@mail.tsubame.test", subject: "既定値で飛ぶ" }),
		});
		await drainQueues(h);
		expect(sends).toHaveLength(1);
	});

	scenario("FR-16-7", "スパム判定 spam は通知しない", async () => {
		const seeded = await seedDomain(h, { addresses: ["spam"] });
		const spam = seeded.addressIds["spam"]!;
		const { client: m } = await createMember("spam@tsubame.test", [{ addressId: spam, level: "read" }]);
		await addDevice(m);

		const sends = await enableVapid(h);
		const messageId = await insertMessage(h, { addressId: spam, spamVerdict: "spam" });
		h.pending.push({ queue: "outbound", body: { kind: "notify", event: "received", messageId } });
		await drainQueues(h);

		expect(sends).toHaveLength(0);
	});

	scenario("FR-16-7", "owner にはキャッチオールの受け皿の新着が通知される", async () => {
		const seeded = await seedDomain(h, { addresses: ["recruit"] });
		const recruit = seeded.addressIds["recruit"]!;
		const db = getDb(h.env);
		await db.update(schema.addresses).set({ isCatchAll: true }).where(eq(schema.addresses.id, recruit));

		await addDevice(owner, { name: "オーナーの iPhone" });

		const sends = await enableVapid(h);
		await deliverEmail(h, {
			from: "job@ext.jp",
			to: "recruit@mail.tsubame.test",
			raw: mime({ from: "job@ext.jp", to: "recruit@mail.tsubame.test", subject: "応募ありがとう" }),
		});
		await drainQueues(h);

		expect(sends).toHaveLength(1);
	});

	scenario("FR-16-6", "90 日開かれていない端末の購読を定期実行で消す", async () => {
		await addDevice(owner);
		expect(await countDevices(owner)).toBe(1);

		// 端末は登録されたまま、lastSeenAt だけ 91 日前に戻し「90 日開かず放置」を再現する。
		const db = getDb(h.env);
		const device = await db.select().from(schema.pushDevices).all();
		await db
			.update(schema.pushDevices)
			.set({ lastSeenAt: new Date(Date.now() - 91 * 86_400_000) })
			.where(eq(schema.pushDevices.id, device[0]!.id));

		const ctx = createExecutionContext();
		await worker.scheduled({} as ScheduledController, h.env, ctx);
		await waitOnExecutionContext(ctx);

		expect(await countDevices(owner)).toBe(0);
	});
});
