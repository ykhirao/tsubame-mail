import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { messages, threads } from "@/db/schema";
import { newId } from "@/lib/id";
import { drainQueues, freshHarness, loginAsOwner, seedDomain, type Client, type Harness } from "../e2e/harness";

const from = "ai@mail.tsubame.test";

describe("送信・返信の宛先まわり（#66 / #74 / #80 / #106）", () => {
	let h: Harness;
	let owner: Client;

	beforeEach(async () => {
		h = await freshHarness();
		owner = await loginAsOwner(h);
	});

	async function seedInbound(overrides: { toAddr: string; ccAddr?: string | null }) {
		const db = getDb(h.env);
		const mailbox = (await seedDomain(h, { domain: "reply.tsubame.test", addresses: ["box"] })).addressIds
			.box!;
		const threadId = newId("thread");
		await db.insert(threads).values({
			id: threadId,
			addressId: mailbox,
			lastMessageAt: new Date(),
			messageCount: 1,
			unreadCount: 1,
		});
		const inboundId = newId("message");
		await db.insert(messages).values({
			id: inboundId,
			threadId,
			addressId: mailbox,
			direction: "inbound",
			status: "received",
			fromAddr: "sender@ext.example.jp",
			toAddr: overrides.toAddr,
			ccAddr: overrides.ccAddr ?? null,
			rfcMessageId: "orig@ext.example.jp",
			receivedAt: new Date(),
		});
		return { inboundId, mailbox };
	}

	it("明示した to が全部自分だと 400（#66）", async () => {
		const { inboundId } = await seedInbound({ toAddr: "box@reply.tsubame.test" });
		const res = await owner.post(`/api/v1/messages/${inboundId}/reply`, {
			text: "返信",
			to: "box@reply.tsubame.test",
		});
		expect(res.status).toBe(400);
		expect(h.pending).toHaveLength(0);
	});

	it("replyAll で to を省略しても、受信 To/Cc 由来の宛先数に上限がある（#74）", async () => {
		const ccMany = Array.from({ length: 101 }, (_, i) => `c${i}@ext.example.jp`).join(", ");
		const { inboundId } = await seedInbound({
			toAddr: "box@reply.tsubame.test",
			ccAddr: ccMany,
		});
		const res = await owner.post(`/api/v1/messages/${inboundId}/reply`, {
			text: "返信",
			replyAll: true,
		});
		expect(res.status).toBe(400);
		expect(h.pending).toHaveLength(0);
	});

	it("使える宛先が 0 件になる入力は 400（#80）", async () => {
		await seedDomain(h, { addresses: ["ai"] });
		const unclosed = '"open <a@x.jp>, b@c.jp';
		const res = await owner.post("/api/v1/messages", {
			from,
			to: unclosed,
			text: "本文",
		});
		expect(res.status).toBe(400);
		expect(h.pending).toHaveLength(0);
	});

	it("レート制限に達すると 429（#106）", async () => {
		await seedDomain(h, { addresses: ["ai"] });
		(h.env as any).SEND_RATE_LIMIT = {
			limit: async () => ({ success: false }),
		};
		const res = await owner.post("/api/v1/messages", {
			from,
			to: "x@ext.example.jp",
			text: "本文",
		});
		expect(res.status).toBe(429);
		expect(h.pending).toHaveLength(0);
		expect(await getDb(h.env).select().from(messages).all()).toHaveLength(0);
	});

	it("レート制限の binding が無くても送信できる（#106）", async () => {
		await seedDomain(h, { addresses: ["ai"] });
		(h.env as any).SEND_RATE_LIMIT = undefined;
		const res = await owner.post("/api/v1/messages", {
			from,
			to: "x@ext.example.jp",
			text: "本文",
		});
		expect(res.status).toBe(202);
	});
});

describe("返信の引用を含めた本文のバイト上限（#115）", () => {
	let h: Harness;
	let owner: Client;

	beforeEach(async () => {
		h = await freshHarness();
		owner = await loginAsOwner(h);
	});

	async function seedInbound(overrides: { toAddr: string }) {
		const db = getDb(h.env);
		const mailbox = (await seedDomain(h, { domain: "replyq.tsubame.test", addresses: ["box"] })).addressIds
			.box!;
		const threadId = newId("thread");
		await db.insert(threads).values({
			id: threadId,
			addressId: mailbox,
			lastMessageAt: new Date(),
			messageCount: 1,
			unreadCount: 1,
		});
		const inboundId = newId("message");
		await db.insert(messages).values({
			id: inboundId,
			threadId,
			addressId: mailbox,
			direction: "inbound",
			status: "received",
			fromAddr: "sender@ext.example.jp",
			toAddr: overrides.toAddr,
			rfcMessageId: "orig@ext.example.jp",
			receivedAt: new Date(),
		});
		return { inboundId, mailbox };
	}

	it("元メールの引用を足した後の text が 1MB を超えると 400（#115）", async () => {
		const { inboundId } = await seedInbound({ toAddr: "box@replyq.tsubame.test" });
		const db = getDb(h.env);
		// 引用（text 最大 256KB / html 最大 512KB）はサーバが返信時に足すので入力検査に掛からない。#115。
		await db
			.update(messages)
			.set({ textBody: "あ".repeat(Math.floor((256 * 1024) / 3)), htmlBody: "x".repeat(512 * 1024) })
			.where(eq(messages.id, inboundId));
		const res = await owner.post(`/api/v1/messages/${inboundId}/reply`, {
			text: "x".repeat(1024 * 1024),
		});
		expect(res.status).toBe(400);
		expect(h.pending).toHaveLength(0);
	});

	it("text + html + 件名 の合計が 1.5MB を超える返信も 400（#115）", async () => {
		const { inboundId } = await seedInbound({ toAddr: "box@replyq.tsubame.test" });
		const db = getDb(h.env);
		await db
			.update(messages)
			.set({
				textBody: "a".repeat(200 * 1024),
				htmlBody: "x".repeat(500 * 1024),
			})
			.where(eq(messages.id, inboundId));
		// 個別は 1MB 未満でも、引用と合わせた合計が 1.5MB を超える。
		const res = await owner.post(`/api/v1/messages/${inboundId}/reply`, {
			text: "b".repeat(700 * 1024),
			html: "c".repeat(300 * 1024),
		});
		expect(res.status).toBe(400);
		expect(h.pending).toHaveLength(0);
	});

	it("通常サイズの返信は 202 のまま（#115）", async () => {
		const { inboundId } = await seedInbound({ toAddr: "box@replyq.tsubame.test" });
		const res = await owner.post(`/api/v1/messages/${inboundId}/reply`, { text: "返信" });
		expect(res.status).toBe(202);
	});
});
