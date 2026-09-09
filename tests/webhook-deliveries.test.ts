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
			attempt: 1,
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
