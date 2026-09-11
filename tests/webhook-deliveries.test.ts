import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { addresses, domains, messages, webhooks, webhookDeliveries } from "@/db/schema";
import { dispatchMessageEvent, runDelivery } from "@/services/webhooks";
import { applyMigrations } from "./helpers/migrate";

function useCleanState() {
	beforeEach(async () => {
		await applyMigrations();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});
}

async function seedBase() {
	const db = getDb(env);
	const domainId = "dom_test";
	const addressId = "adr_a";
	const otherAddressId = "adr_b";
	await db.insert(domains).values({
		id: domainId,
		name: "example.com",
		zoneId: "zone",
		zoneName: "example.com",
		mode: "subdomain",
	});
	for (const [id, local] of [
		[addressId, "a"],
		[otherAddressId, "b"],
	] as const) {
		await db.insert(addresses).values({
			id,
			domainId,
			localPart: local,
			address: `${local}@example.com`,
		});
	}
	return { addressId, otherAddressId };
}

async function seedMessage(addressId: string) {
	const db = getDb(env);
	const messageId = "msg_test";
	await db.insert(messages).values({
		id: messageId,
		addressId,
		direction: "inbound",
		status: "received",
		fromAddr: "sender@x.example",
		toAddr: "a@example.com",
		subject: "テストメール",
		textBody: "本文です",
		receivedAt: new Date(),
	});
	return messageId;
}

async function seedWebhook(
	name: string,
	url: string,
	opts: { events: string[]; addressIds?: string[] | null; enabled?: boolean },
) {
	const db = getDb(env);
	await db.insert(webhooks).values({
		id: `whk_${name}`,
		name,
		url,
		secret: "whksecret",
		events: opts.events,
		addressIds: opts.addressIds ?? null,
		enabled: opts.enabled ?? true,
	});
	return `whk_${name}`;
}

async function deliveries() {
	const db = getDb(env);
	return db.select().from(webhookDeliveries).all();
}

describe("通知ペイロードから bcc を落とす（#43）", () => {
	useCleanState();

	it("送信メールの bcc は外部 URL に出ない", async () => {
		const { addressId } = await seedBase();
		const db = getDb(env);
		const messageId = "msg_sent_1";
		await db.insert(messages).values({
			id: messageId,
			addressId,
			direction: "outbound",
			status: "sent",
			fromAddr: "a@example.com",
			toAddr: "dest@example.com",
			bccAddr: "secret-hidden@example.com",
			subject: "件名",
			textBody: "本文",
			receivedAt: new Date(),
		});
		await seedWebhook("bcc", "https://bcc.example/hook", { events: ["message.sent"] });

		const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response("{}", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		await dispatchMessageEvent(env, "message.sent", messageId);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const body = fetchMock.mock.calls[0]![1]!.body as string;
		const payload = JSON.parse(body) as { message: Record<string, unknown> };
		expect(body).not.toContain("secret-hidden@example.com");
		expect(payload.message).not.toHaveProperty("bcc");
	});
});

describe("dispatchMessageEvent の宛先・イベント絞り込み", () => {
	useCleanState();

	it("対象アドレス・対象イベントの webhook にのみ配信する", async () => {
		const { addressId, otherAddressId } = await seedBase();
		const messageId = await seedMessage(addressId);
		await seedWebhook("a", "https://a.example/hook", {
			events: ["message.received"],
			addressIds: [addressId],
		});
		await seedWebhook("b", "https://b.example/hook", {
			events: ["message.sent"],
			addressIds: [addressId],
		});
		await seedWebhook("c", "https://c.example/hook", {
			events: ["message.received"],
			addressIds: [otherAddressId],
		});

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("{}", { status: 200 })),
		);

		await dispatchMessageEvent(env, "message.received", messageId);

		const rows = await deliveries();
		expect(rows).toHaveLength(1);
		expect(rows[0]!.webhookId).toBe("whk_a");
		expect(rows[0]!.status).toBe("success");
	});

	it("addressIds が null なら全アドレスに配信する", async () => {
		const { addressId } = await seedBase();
		const messageId = await seedMessage(addressId);
		await seedWebhook("all", "https://all.example/hook", {
			events: ["message.received"],
			addressIds: null,
		});

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("{}", { status: 200 })),
		);

		await dispatchMessageEvent(env, "message.received", messageId);

		const rows = await deliveries();
		expect(rows).toHaveLength(1);
		expect(rows[0]!.webhookId).toBe("whk_all");
	});
});

describe("dispatchMessageEvent の部分失敗", () => {
	useCleanState();

	it("1 つが失敗しても他の webhook への配信を止めない", async () => {
		const { addressId } = await seedBase();
		const messageId = await seedMessage(addressId);
		await seedWebhook("fail", "https://fail.example/hook", {
			events: ["message.received"],
		});
		await seedWebhook("ok", "https://ok.example/hook", {
			events: ["message.received"],
		});

		const sendSpy = vi
			.spyOn(env.OUTBOUND_QUEUE, "send")
			.mockResolvedValue({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } });

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				if (url === "https://fail.example/hook") {
					throw new Error("ECONNREFUSED");
				}
				return new Response("ok", { status: 200 });
			}),
		);

		await dispatchMessageEvent(env, "message.received", messageId);

		const rows = await deliveries();
		expect(rows).toHaveLength(2);

		const failed = rows.find((r) => r.webhookId === "whk_fail")!;
		expect(failed.status).toBe("pending");
		expect(failed.error).toContain("ECONNREFUSED");
		expect(failed.attempt).toBe(1);

		const ok = rows.find((r) => r.webhookId === "whk_ok")!;
		expect(ok.status).toBe("success");
		expect(ok.httpStatus).toBe(200);

		expect(sendSpy).toHaveBeenCalledTimes(1);
		const msg = sendSpy.mock.calls[0]![0] as { kind: string; attempt: number };
		expect(msg.kind).toBe("webhook.retry");
		expect(msg.attempt).toBe(2);
	});
});

describe("失敗した配信のキュー重複配達で再 POST しない（#118）", () => {
	useCleanState();

	it("最終試行で failed になった配信に同じ {deliveryId, attempt} を流しても POST は増えない", async () => {
		const { addressId } = await seedBase();
		const messageId = await seedMessage(addressId);
		await seedWebhook("dup118", "https://dup118.example/hook", { events: ["message.received"] });
		const db = getDb(env);
		const deliveryId = "dlv_dup118";
		await db.insert(webhookDeliveries).values({
			id: deliveryId,
			webhookId: "whk_dup118",
			event: "message.received" as const,
			messageId,
			status: "failed",
			httpStatus: 503,
			error: "HTTP 503",
			attempt: 5,
			nextRetryAt: null,
		});

		const fetchMock = vi.fn(async () => new Response("x", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		// キューが最終試行の {deliveryId, attempt:5} を重複配達してくる。
		await runDelivery(env, deliveryId, 5);

		expect(fetchMock).not.toHaveBeenCalled();
		const row = await db
			.select()
			.from(webhookDeliveries)
			.where(eq(webhookDeliveries.id, deliveryId))
			.get();
		expect(row!.status).toBe("failed");
		expect(row!.attempt).toBe(5);
	});

	it("成功済みの配信を同じ attempt で再配達しても POST しない", async () => {
		const { addressId } = await seedBase();
		const messageId = await seedMessage(addressId);
		await seedWebhook("dupok118", "https://dupok118.example/hook", {
			events: ["message.received"],
		});
		const db = getDb(env);
		const deliveryId = "dlv_dupok118";
		await db.insert(webhookDeliveries).values({
			id: deliveryId,
			webhookId: "whk_dupok118",
			event: "message.received" as const,
			messageId,
			status: "success",
			httpStatus: 200,
			attempt: 3,
		});

		const fetchMock = vi.fn(async () => new Response("x", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		await runDelivery(env, deliveryId, 3);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("再試行のバックオフと打ち切り", () => {
	useCleanState();

	it("順に 30s / 300s / 1800s 遅延させ、5 回で failed にする", async () => {
		await seedBase();
		const messageId = await seedMessage("adr_a");
		await seedWebhook("retry", "https://retry.example/hook", {
			events: ["message.received"],
		});
		const db = getDb(env);
		const deliveryId = "dlv_test";
		await db.insert(webhookDeliveries).values({
			id: deliveryId,
			webhookId: "whk_retry",
			event: "message.received" as const,
			messageId,
			status: "pending",
			attempt: 0,
		});

		const sendSpy = vi
			.spyOn(env.OUTBOUND_QUEUE, "send")
			.mockResolvedValue({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } });
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("timeout");
			}),
		);

		const expectedDelays = [30, 300, 1800, 1800];
		for (let attempt = 1; attempt <= 5; attempt++) {
			const before = Date.now();
			await runDelivery(env, deliveryId, attempt);
			const row = await db
				.select()
				.from(webhookDeliveries)
				.where(eq(webhookDeliveries.id, deliveryId))
				.get();
			expect(row!.attempt).toBe(attempt);

			if (attempt < 5) {
				const delay = expectedDelays[attempt - 1]!;
				expect(row!.status).toBe("pending");
				expect(row!.nextRetryAt!.getTime()).toBeGreaterThan(before + delay * 1000 - 2000);
				expect(row!.nextRetryAt!.getTime()).toBeLessThan(before + delay * 1000 + 5000);
				expect(sendSpy).toHaveBeenCalledTimes(attempt);
				const sent = sendSpy.mock.calls[attempt - 1]!;
				expect((sent[0] as { attempt: number }).attempt).toBe(attempt + 1);
				expect((sent[1] as { delaySeconds: number }).delaySeconds).toBe(delay);
			} else {
				expect(row!.status).toBe("failed");
				expect(row!.nextRetryAt).toBeNull();
				expect(sendSpy).toHaveBeenCalledTimes(4);
			}
		}
	});

	it("webhook を無効化すると配信しない", async () => {
		const { addressId } = await seedBase();
		const messageId = await seedMessage(addressId);
		await seedWebhook("off", "https://off.example/hook", {
			events: ["message.received"],
			enabled: false,
		});

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("{}", { status: 200 })),
		);

		await dispatchMessageEvent(env, "message.received", messageId);
		expect(await deliveries()).toHaveLength(0);
	});
});

describe("配信先の SSRF 対策（#12）", () => {
	useCleanState();

	async function seedDelivery(url: string) {
		await seedBase();
		const messageId = await seedMessage("adr_a");
		await seedWebhook("ssrf", url, { events: ["message.received"] });
		const db = getDb(env);
		await db.insert(webhookDeliveries).values({
			id: "dlv_ssrf",
			webhookId: "whk_ssrf",
			event: "message.received" as const,
			messageId,
			status: "pending",
			attempt: 0,
		});
		return async () =>
			(await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, "dlv_ssrf")).get())!;
	}

	it("検査より前に登録された内部向け URL には送らず、再試行もしない", async () => {
		const row = await seedDelivery("http://169.254.169.254/latest/meta-data");
		const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const sendSpy = vi
			.spyOn(env.OUTBOUND_QUEUE, "send")
			.mockResolvedValue({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } });

		await runDelivery(env, "dlv_ssrf", 1);

		expect(fetchMock).not.toHaveBeenCalled();
		expect(sendSpy).not.toHaveBeenCalled();
		const after = await row();
		expect(after.status).toBe("failed");
		expect(after.error).toContain("https://");
		expect(after.nextRetryAt).toBeNull();
	});

	it("リダイレクトは追わず、3xx は失敗として記録する", async () => {
		const row = await seedDelivery("https://redirect.example/hook");
		const fetchMock = vi.fn(
			async (_url: string, _init?: RequestInit) =>
				new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/" } }),
		);
		vi.stubGlobal("fetch", fetchMock);
		vi.spyOn(env.OUTBOUND_QUEUE, "send").mockResolvedValue({
			metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
		});

		await runDelivery(env, "dlv_ssrf", 1);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]![1]!.redirect).toBe("manual");
		const after = await row();
		expect(after.status).toBe("pending");
		expect(after.httpStatus).toBe(302);
		expect(after.error).toContain("リダイレクト");
	});
});

describe("キュー再配達で受け手への POST を増幅しない（#86）", () => {
	useCleanState();

	it("OUTBOUND_QUEUE.send の失敗で再配達されても、同じ試行で再 POST しない", async () => {
		const { addressId } = await seedBase();
		const messageId = await seedMessage(addressId);
		await seedWebhook("amp", "https://amp.example/hook", {
			events: ["message.received"],
		});
		const db = getDb(env);
		const deliveryId = "dlv_amp";
		await db.insert(webhookDeliveries).values({
			id: deliveryId,
			webhookId: "whk_amp",
			event: "message.received" as const,
			messageId,
			status: "pending",
			attempt: 0,
		});

		const fetchMock = vi.fn(async () => new Response("x", { status: 503 }));
		vi.stubGlobal("fetch", fetchMock);
		const sendSpy = vi
			.spyOn(env.OUTBOUND_QUEUE, "send")
			.mockRejectedValue(new Error("queue 一時障害"));

		// max_retries: 3 と同じ 4 回（初回 + 3 再配達）同じ {deliveryId, attempt} を投げる。
		for (let i = 0; i < 4; i++) {
			await expect(runDelivery(env, deliveryId, 1)).rejects.toThrow("queue 一時障害");
		}

		const row = await db
			.select()
			.from(webhookDeliveries)
			.where(eq(webhookDeliveries.id, deliveryId))
			.get();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(sendSpy).toHaveBeenCalledTimes(4);
		expect(row!.status).toBe("pending");
		expect(row!.attempt).toBe(1);
	});
});
