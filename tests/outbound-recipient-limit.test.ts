import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { messages, threads } from "@/db/schema";
import { newId } from "@/lib/id";
import { MAX_BODY_BYTES, MAX_COMBINED_BODY_BYTES, MAX_SUBJECT_BYTES } from "@/shared/contracts/send";
import {
	captureSentEmails,
	drainQueues,
	freshHarness,
	loginAsOwner,
	seedDomain,
	type Client,
	type Harness,
} from "../e2e/harness";

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

	it("元メールの引用で本文が上限を超えても、引用を切って送り利用者の本文は残す（#115）", async () => {
		const { inboundId } = await seedInbound({ toAddr: "box@replyq.tsubame.test" });
		const db = getDb(h.env);
		// 引用（text 最大 256KB / html 最大 512KB）はサーバが返信時に足すので入力検査に掛からない。#115。
		await db
			.update(messages)
			.set({ textBody: "あ".repeat(Math.floor((256 * 1024) / 3)), htmlBody: "x".repeat(512 * 1024) })
			.where(eq(messages.id, inboundId));
		const userText = "x".repeat(1024 * 1024);
		const res = await owner.post(`/api/v1/messages/${inboundId}/reply`, { text: userText });
		expect(res.status).toBe(202);

		const reply = await db.select().from(messages).where(eq(messages.direction, "outbound")).get();
		expect(reply).toBeTruthy();
		// 利用者が書いた text はそのまま残る（引用を入れる余地が無いので引用は落ちている）。
		expect(reply!.textBody).toBe(userText);
		// 引用が残っている html 側は末尾から切られ、注記が付く。
		expect(reply!.htmlBody).toContain("（引用が長いため途中までです）");
		expect(new TextEncoder().encode(reply!.textBody!).byteLength).toBeLessThanOrEqual(MAX_BODY_BYTES);
		expect(new TextEncoder().encode(reply!.htmlBody!).byteLength).toBeLessThanOrEqual(MAX_BODY_BYTES);
	});

	it("text + html の合計が上限を超えても、それぞれの引用を切って送る（#115）", async () => {
		const { inboundId } = await seedInbound({ toAddr: "box@replyq.tsubame.test" });
		const db = getDb(h.env);
		await db
			.update(messages)
			.set({ textBody: "a".repeat(200 * 1024), htmlBody: "x".repeat(500 * 1024) })
			.where(eq(messages.id, inboundId));
		// 個別は 1MB 未満でも、引用と合わせた合計が 1.5MB を超える。
		const userText = "b".repeat(700 * 1024);
		const userHtml = "c".repeat(300 * 1024);
		const res = await owner.post(`/api/v1/messages/${inboundId}/reply`, {
			text: userText,
			html: userHtml,
		});
		expect(res.status).toBe(202);

		const reply = await db.select().from(messages).where(eq(messages.direction, "outbound")).get();
		expect(reply).toBeTruthy();
		// 利用者が書いた部分は先頭にそのまま残る。
		expect(reply!.textBody!.startsWith(userText)).toBe(true);
		expect(reply!.htmlBody!.startsWith(userHtml)).toBe(true);
		// 両方の引用が末尾から切られ、注記が付く。
		expect(reply!.textBody).toContain("（引用が長いため途中までです）");
		expect(reply!.htmlBody).toContain("（引用が長いため途中までです）");
		const textBytes = new TextEncoder().encode(reply!.textBody!).byteLength;
		const htmlBytes = new TextEncoder().encode(reply!.htmlBody!).byteLength;
		expect(textBytes).toBeLessThanOrEqual(MAX_BODY_BYTES);
		expect(htmlBytes).toBeLessThanOrEqual(MAX_BODY_BYTES);
		expect(textBytes + htmlBytes).toBeLessThanOrEqual(MAX_COMBINED_BODY_BYTES);
	});

	it("通常サイズの返信は 202 のまま（#115）", async () => {
		const { inboundId } = await seedInbound({ toAddr: "box@replyq.tsubame.test" });
		const res = await owner.post(`/api/v1/messages/${inboundId}/reply`, { text: "返信" });
		expect(res.status).toBe(202);
	});
});

describe("返信の件名の切り詰め（#22）", () => {
	let h: Harness;
	let owner: Client;

	beforeEach(async () => {
		h = await freshHarness();
		owner = await loginAsOwner(h);
	});

	async function seedInbound(overrides: { toAddr: string }) {
		const db = getDb(h.env);
		const mailbox = (await seedDomain(h, { domain: "replysub.tsubame.test", addresses: ["box"] })).addressIds
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
		return { inboundId };
	}

	function headerValue(raw: string, name: string): string {
		const m = raw.match(new RegExp(`^${name}:\\s*(.*)$`, "im"));
		return m ? m[1]!.trim() : "";
	}
	function decodeHeaderValue(value: string): string {
		return value.replace(/=\?([^?]+)\?([BQbq])\?([^?]*)\?=/g, (_m, _cs, enc, data) => {
			if (enc.toUpperCase() === "B") {
				const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
				return new TextDecoder().decode(bytes);
			}
			return data.replace(/_/g, " ");
		});
	}

	it("元の件名が 600 バイトいっぱいでも、Re: を足すと末尾を切って 600 バイトに収める（#22）", async () => {
		const { inboundId } = await seedInbound({ toAddr: "box@replysub.tsubame.test" });
		const db = getDb(h.env);
		// 受信メールとしては 600 バイトちょうどの件名も入る。
		await db
			.update(messages)
			.set({ subject: "あ".repeat(MAX_SUBJECT_BYTES / 3) })
			.where(eq(messages.id, inboundId));

		const sent = captureSentEmails(h);
		const res = await owner.post(`/api/v1/messages/${inboundId}/reply`, { text: "返信" });
		expect(res.status).toBe(202);
		await drainQueues(h);
		expect(sent).toHaveLength(1);

		const subject = decodeHeaderValue(headerValue(sent[0]!.raw, "Subject"));
		expect(subject).toMatch(/^Re: /);
		// 元の 600 バイトの件名に「Re: 」を足すと超える。末尾を切って 600 バイト以内、黙って落とさない。
		expect(new TextEncoder().encode(subject).byteLength).toBeLessThanOrEqual(MAX_SUBJECT_BYTES);
		expect(subject.includes("あ".repeat(MAX_SUBJECT_BYTES / 3))).toBe(false);
		expect(subject.includes("あ".repeat(100))).toBe(true);
	});
});
