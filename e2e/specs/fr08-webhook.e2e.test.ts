import { beforeEach, describe, expect, vi } from "vitest";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "@/worker";
import type { AnyQueueMessage } from "@/services/queue";
import { eq } from "drizzle-orm";
import { scenario } from "../registry";
import {
	createClient,
	deliverEmail,
	drainQueues,
	freshHarness,
	loginAsOwner,
	mime,
	seedDomain,
	type Client,
	type Harness,
	createUserViaApi,
} from "../harness";
import { hmacHex } from "@/services/webhooks";

describe("FR-8 Webhook", () => {
	let h: Harness;
	let owner: Client;
	let aiId: string;
	let hitoId: string;

	beforeEach(async () => {
		h = await freshHarness();
		owner = await loginAsOwner(h);
		const seeded = await seedDomain(h, { addresses: ["ai", "hito"] });
		aiId = seeded.addressIds.ai!;
		hitoId = seeded.addressIds.hito!;
	});

	function stubWebhookFetch(status: number) {
		const calls: { url: string; body: string; headers: Headers }[] = [];
		vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
			const url = typeof input === "string" ? input : (input as Request).url;
			calls.push({ url, body: String(init?.body ?? ""), headers: new Headers(init?.headers) });
			return new Response(JSON.stringify({ ok: true }), { status });
		});
		return calls;
	}

	async function createWebhook(body: Record<string, unknown>) {
		const res = await owner.post("/api/v1/webhooks", {
			name: "hook",
			url: "https://hook.example.com/tsubame",
			events: ["message.received"],
			enabled: true,
			...body,
		});
		expect(res.status).toBe(201);
		return res.body;
	}

	scenario("FR-8-6", "owner は自分に割り当てていないアドレスも Webhook の対象にでき、その新着も届く", async () => {
		const { getDb } = await import("@/db/client");
		const { addressGrants } = await import("@/db/schema");
		await getDb(h.env).delete(addressGrants).where(eq(addressGrants.addressId, hitoId));
		expect((await owner.get("/api/v1/addresses")).body.data.map((a: { id: string }) => a.id)).not.toContain(hitoId);

		const calls = stubWebhookFetch(200);
		await createWebhook({ addressIds: [hitoId] });
		await deliverEmail(h, {
			from: "a@ext.jp",
			to: "hito@mail.tsubame.test",
			raw: mime({ from: "a@ext.jp", to: "hito@mail.tsubame.test", subject: "割り当て外" }),
		});
		await drainQueues(h);

		expect(calls).toHaveLength(1);
		expect(JSON.parse(calls[0]!.body).message.subject).toBe("割り当て外");
	});

	scenario(["FR-8-1", "FR-8-5"], "対象アドレス・対象イベントに一致する webhook にだけ POST が飛ぶ", async () => {
		await createWebhook({
			name: "ai 宛",
			url: "https://hook-a.example.com/tsubame",
			addressIds: [aiId],
		});
		await createWebhook({
			name: "hito 宛",
			url: "https://hook-b.example.com/tsubame",
			addressIds: [hitoId],
		});
		await createWebhook({
			name: "送信イベント",
			url: "https://hook-c.example.com/tsubame",
			addressIds: [aiId],
			events: ["message.sent"],
		});

		const calls = stubWebhookFetch(200);

		await deliverEmail(h, {
			from: "a@ext.jp",
			to: "ai@mail.tsubame.test",
			raw: mime({ from: "a@ext.jp", to: "ai@mail.tsubame.test" }),
		});
		await drainQueues(h);

		expect(calls.map((c) => c.url)).toEqual(["https://hook-a.example.com/tsubame"]);
	});

	scenario("FR-8-2", "署名ヘッダが正しい HMAC になっている", async () => {
		const created = await createWebhook({ url: "https://hook.example.com/tsubame" });
		const secret = created.secret as string;
		expect(secret).toBeTruthy();

		const calls = stubWebhookFetch(200);
		await deliverEmail(h, {
			from: "a@ext.jp",
			to: "ai@mail.tsubame.test",
			raw: mime({ from: "a@ext.jp", to: "ai@mail.tsubame.test" }),
		});
		await drainQueues(h);

		expect(calls).toHaveLength(1);
		const call = calls[0]!;
		const sig = call.headers.get("X-Tsubamail-Signature")!;
		expect(sig).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);

		// 署名対象は `<t>.<body>`。同じ secret で再計算して一致することを確かめる。
		const t = sig.match(/^t=(\d+)/)![1]!;
		const v1 = sig.match(/v1=([0-9a-f]{64})/)![1]!;
		const expected = await hmacHex(secret, `${t}.${call.body}`);
		expect(v1).toBe(expected);
	});

	const isWebhookRetry = (body: unknown) => (body as { kind?: string }).kind === "webhook.retry";

	async function processOne(h: Harness, pick?: (body: unknown) => boolean) {
		const index = pick ? h.pending.findIndex((p) => pick(p.body)) : 0;
		const [item] = h.pending.splice(index, 1);
		if (!item) throw new Error("流すキューメッセージがありません");
		const batch = {
			queue: item.queue === "inbound" ? "tsubame-inbound" : "tsubame-outbound",
			messages: [
				{
					id: crypto.randomUUID(),
					timestamp: new Date(),
					body: item.body,
					attempts: 1,
					ack() {},
					retry(opts?: { delaySeconds?: number }) {
						h.retried.push({ body: item.body, delaySeconds: opts?.delaySeconds });
					},
				},
			],
			ackAll() {},
			retryAll() {},
		} as unknown as MessageBatch<AnyQueueMessage>;
		const ctx = createExecutionContext();
		await worker.queue!(batch, h.env, ctx);
		await waitOnExecutionContext(ctx);
	}

	scenario(["FR-8-4", "FR-8-5"], "配信に失敗すると再試行が予約され、遅延が伸びる", async () => {
		await createWebhook({ url: "https://hook.example.com/tsubame" });
		stubWebhookFetch(500);

		await deliverEmail(h, {
			from: "a@ext.jp",
			to: "ai@mail.tsubame.test",
			raw: mime({ from: "a@ext.jp", to: "ai@mail.tsubame.test" }),
		});
		// 受信メッセージと初回の配信だけを処理する（drainQueues は再試行まで全部流してしまうので使わない）。
		await processOne(h);
		await processOne(h, isWebhookRetry);

		const retryMsg = h.pending.find((p) => p.queue === "outbound" && isWebhookRetry(p.body));
		expect(retryMsg).toBeTruthy();
		expect((retryMsg!.body as { kind: string }).kind).toBe("webhook.retry");

		const { getDb } = await import("@/db/client");
		const { webhookDeliveries } = await import("@/db/schema");
		const db = getDb(h.env);
		const first = await db.select().from(webhookDeliveries).all();
		expect(first).toHaveLength(1);
		expect(first[0]!.status).toBe("pending");
		expect(first[0]!.attempt).toBe(1);
		expect(first[0]!.nextRetryAt).not.toBeNull();

		await processOne(h, isWebhookRetry);
		const second = await db.select().from(webhookDeliveries).all();
		expect(second[0]!.attempt).toBe(2);
		expect(second[0]!.nextRetryAt!.getTime()).toBeGreaterThan(first[0]!.nextRetryAt!.getTime());
	});

	scenario("FR-8-3", "内部向け・http の URL は登録できず、配信はリダイレクトを追わない", async () => {
		for (const url of [
			"http://hook.example.com/tsubame",
			"https://127.0.0.1/tsubame",
			"https://169.254.169.254/latest/meta-data",
			"https://[::1]/tsubame",
			"https://localhost/tsubame",
		]) {
			const res = await owner.post("/api/v1/webhooks", {
				name: "hook",
				url,
				events: ["message.received"],
			});
			expect(res.status, url).toBe(400);
		}

		await createWebhook({ addressIds: [aiId] });
		const inits: RequestInit[] = [];
		vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
			inits.push(init ?? {});
			return new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/" } });
		});
		await deliverEmail(h, {
			from: "a@ext.jp",
			to: "ai@mail.tsubame.test",
			raw: mime({ from: "a@ext.jp", to: "ai@mail.tsubame.test" }),
		});
		await processOne(h);
		await processOne(h, isWebhookRetry);

		expect(inits).toHaveLength(1);
		expect(inits[0]!.redirect).toBe("manual");
		const hooks = await owner.get("/api/v1/webhooks");
		const deliveries = await owner.get(`/api/v1/webhooks/${hooks.body.data[0].id}/deliveries`);
		expect(deliveries.body.data[0].httpStatus).toBe(302);
		expect(deliveries.body.data[0].status).not.toBe("success");
	});

	scenario("FR-8-2", "secret は作成時だけ返り、一覧には出ない", async () => {
		const created = await createWebhook({ url: "https://hook.example.com/tsubame" });
		expect(created.secret).toBeTruthy();

		const list = await owner.get("/api/v1/webhooks");
		expect(list.status).toBe(200);
		expect(list.body.next_cursor).toBeNull();
		expect(list.body.data[0].secret).toBeUndefined();
		expect(list.body.data[0].id).toBe(created.id);
	});

	scenario("FR-8-4", "再送予約を過ぎた pending 配信を API から再送できる（B-20）", async () => {
		await createWebhook({ url: "https://hook.example.com/tsubame" });
		stubWebhookFetch(500);
		await deliverEmail(h, {
			from: "a@ext.jp",
			to: "ai@mail.tsubame.test",
			raw: mime({ from: "a@ext.jp", to: "ai@mail.tsubame.test" }),
		});
		// 受信だけ処理して、配信は pending（次回再試行予約つき）で止める。
		await processOne(h);

		const { getDb } = await import("@/db/client");
		const { webhookDeliveries } = await import("@/db/schema");
		const db = getDb(h.env);
		const [pendingRow] = await db.select().from(webhookDeliveries).all();
		expect(pendingRow!.status).toBe("pending");

		// キューのメッセージを失って予約だけが過去に取り残された状態を再現する。
		await db
			.update(webhookDeliveries)
			.set({ nextRetryAt: new Date(Date.now() - 3600 * 1000) })
			.where(eq(webhookDeliveries.id, pendingRow!.id));

		const calls = stubWebhookFetch(200);
		const res = await owner.post(`/api/v1/webhooks/deliveries/${pendingRow!.id}/retry`);
		expect(res.status).toBe(200);
		expect((res.body as { status: string }).status).toBe("success");
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe("https://hook.example.com/tsubame");
	});

	scenario("FR-8-4", "配信失敗は最大 5 回で打ち切り、failed になり再試行予定が残らない", async () => {
		await createWebhook({ url: "https://hook.example.com/tsubame" });
		stubWebhookFetch(500);
		await deliverEmail(h, {
			from: "a@ext.jp",
			to: "ai@mail.tsubame.test",
			raw: mime({ from: "a@ext.jp", to: "ai@mail.tsubame.test" }),
		});
		await processOne(h);
		for (let i = 0; i < 5; i++) {
			await processOne(h, isWebhookRetry);
		}

		expect(h.pending.some((p) => isWebhookRetry(p.body))).toBe(false);

		const { getDb } = await import("@/db/client");
		const { webhookDeliveries } = await import("@/db/schema");
		const db = getDb(h.env);
		const [d] = await db.select().from(webhookDeliveries).all();
		expect(d!.status).toBe("failed");
		expect(d!.attempt).toBe(5);
		expect(d!.nextRetryAt).toBeNull();
	});

	scenario("FR-8-4", "failed の配信を API から手動再送すると成功し、受け手に届く", async () => {
		await createWebhook({ url: "https://hook.example.com/tsubame" });
		stubWebhookFetch(500);
		await deliverEmail(h, {
			from: "a@ext.jp",
			to: "ai@mail.tsubame.test",
			raw: mime({ from: "a@ext.jp", to: "ai@mail.tsubame.test" }),
		});
		await processOne(h);
		for (let i = 0; i < 5; i++) {
			await processOne(h, isWebhookRetry);
		}

		const { getDb } = await import("@/db/client");
		const { webhookDeliveries } = await import("@/db/schema");
		const db = getDb(h.env);
		const [d] = await db.select().from(webhookDeliveries).all();
		expect(d!.status).toBe("failed");

		const calls = stubWebhookFetch(200);
		const res = await owner.post(`/api/v1/webhooks/deliveries/${d!.id}/retry`);
		expect(res.status).toBe(200);
		expect((res.body as { status: string }).status).toBe("success");
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe("https://hook.example.com/tsubame");
	});

	scenario("FR-8-4", "同じ試行の retry が重なって届いても受け手への POST は 1 回", async () => {
		await createWebhook({ url: "https://hook.example.com/tsubame" });
		const calls = stubWebhookFetch(200);
		await deliverEmail(h, {
			from: "a@ext.jp",
			to: "ai@mail.tsubame.test",
			raw: mime({ from: "a@ext.jp", to: "ai@mail.tsubame.test" }),
		});
		await processOne(h);

		// 同じ webhook.retry メッセージが再配達されて 2 つ積まれた状態を再現する。
		const retry = h.pending.find((p) => isWebhookRetry(p.body));
		expect(retry).toBeTruthy();
		h.pending.push(retry!);

		await processOne(h, isWebhookRetry);
		await processOne(h, isWebhookRetry);
		expect(calls).toHaveLength(1);

		const { getDb } = await import("@/db/client");
		const { webhookDeliveries } = await import("@/db/schema");
		const db = getDb(h.env);
		const [d] = await db.select().from(webhookDeliveries).all();
		expect(d!.status).toBe("success");
	});

	async function memberAndKeyedOwner(): Promise<[Client, Client]> {
		const memberCreate = await createUserViaApi(h, owner, {
			email: "member@tsubame.test",
			name: "メンバー",
			role: "member",
			password: "member-pass-12345",
		});
		expect(memberCreate.status).toBe(201);
		const member = createClient(h);
		expect((await member.post("/api/v1/auth/login", {
			email: "member@tsubame.test",
			password: "member-pass-12345",
		})).status).toBe(200);

		const me = await owner.get("/api/v1/me");
		const key = await owner.post("/api/v1/admin/api-keys", {
			userId: me.body.id,
			name: "read-send-owner",
			scopes: ["read", "send"],
			addressIds: null,
		});
		expect(key.status).toBe(201);
		const keyed = createClient(h);
		keyed.useKey(key.body.token);
		return [member, keyed];
	}

	scenario("FR-5-1", "member セッションと admin 無しの owner キーでは webhook を作成・更新・削除できない", async () => {
		const [member, keyed] = await memberAndKeyedOwner();

		const created = await owner.post("/api/v1/webhooks", {
			name: "既存フック",
			url: "https://hook.example.com/tsubame",
			events: ["message.received"],
			enabled: true,
		});
		expect(created.status).toBe(201);
		const webhookId = created.body.id;

		const createBody = {
			name: "権限の無い人が作るフック",
			url: "https://hook.example.com/x",
			events: ["message.received"],
		};

		for (const [label, client] of [
			["member", member],
			["owner read+send キー", keyed],
		] as const) {
			expect((await client.post("/api/v1/webhooks", createBody)).status, `${label} 作成`).toBe(403);
			expect((await client.patch(`/api/v1/webhooks/${webhookId}`, { enabled: false })).status, `${label} 更新`).toBe(403);
			expect((await client.del(`/api/v1/webhooks/${webhookId}`)).status, `${label} 削除`).toBe(403);
		}

		const still = await owner.get("/api/v1/webhooks");
		expect(still.status).toBe(200);
		expect(still.body.data[0].enabled).toBe(true);
	});

	scenario("FR-8-1", "不正な webhook 入力は 400", async () => {
		for (const body of [
			{ url: "https://hook.example.com/tsubame", events: ["message.received"] },
			{ name: "name だけ", events: ["message.received"] },
		]) {
			const res = await owner.post("/api/v1/webhooks", body as Record<string, unknown>);
			expect(res.status).toBe(400);
		}
	});
});
