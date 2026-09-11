import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { addresses, attachments, messages, threads } from "@/db/schema";
import { newId } from "@/lib/id";
import { composeMime, formatMessageIdList } from "@/domain/mail/compose";
import { sendMessageInput } from "@/shared/contracts/send";
import { stripHeader } from "@/services/sender";
import {
	captureSentEmails,
	drainQueues,
	freshHarness,
	loginAsOwner,
	seedDomain,
	type Client,
	type Harness,
} from "../e2e/harness";

const INJECTED = "<a@b.com>\r\nBcc: attacker@evil.com\r\nX-Injected: yes";

function headerBlock(raw: string): string {
	return raw.split(/\r?\n\r?\n/)[0]!;
}

describe("ヘッダインジェクション（スキーマ）", () => {
	const base = { from: "me@example.com", to: "a@b.jp", text: "本文" };

	it("inReplyTo に改行を入れると弾く", () => {
		expect(sendMessageInput.safeParse({ ...base, inReplyTo: INJECTED }).success).toBe(false);
		expect(sendMessageInput.safeParse({ ...base, inReplyTo: "<a@b.com>" }).success).toBe(true);
	});

	it("宛先に改行を入れると弾く", () => {
		expect(sendMessageInput.safeParse({ ...base, to: "a@b.com\r\nX-Inj:1" }).success).toBe(false);
		expect(sendMessageInput.safeParse({ ...base, cc: ["c@d.jp", "e@f.jp\nX:1"] }).success).toBe(false);
	});

	it("添付のファイル名と Content-Type に改行やパスを入れると弾く", () => {
		const att = (a: Record<string, string>) => ({
			...base,
			attachments: [{ filename: "a.txt", contentType: "text/plain", base64: "aGk=", ...a }],
		});
		expect(sendMessageInput.safeParse(att({ filename: "../../raw/2026/09/msg_x.eml" })).success).toBe(false);
		expect(sendMessageInput.safeParse(att({ filename: 'a.txt"\r\nX-Inj: 1' })).success).toBe(false);
		expect(sendMessageInput.safeParse(att({ contentType: "text/plain\r\nX-CT: 1" })).success).toBe(false);
		expect(sendMessageInput.safeParse(att({ contentType: "text/html; charset=utf-8" })).success).toBe(false);
		expect(sendMessageInput.safeParse(att({ filename: "資料 (1).txt" })).success).toBe(true);
	});
});

describe("ヘッダインジェクション（composeMime）", () => {
	const input = {
		messageId: "msg_1",
		fromAddr: "me@example.com",
		toAddr: "a@b.jp",
		subject: "件名",
		textBody: "本文",
	};

	it("スキーマを通らない値が来ても、改行入りの値はヘッダに書かない", () => {
		expect(() => composeMime({ ...input, inReplyTo: INJECTED })).toThrow();
		expect(() => composeMime({ ...input, referencesHeader: INJECTED })).toThrow();
		expect(composeMime({ ...input, toAddr: "a@b.jp, a@b.com\r\nx-inj:1" })).not.toMatch(/^x-inj:/im);
		expect(() =>
			composeMime(input, [{ filename: "a\r\nX-Inj: 1", contentType: "text/plain", base64: "aGk=" }]),
		).toThrow();
		expect(() =>
			composeMime(input, [{ filename: "a", contentType: "text/plain\r\nX-CT: 1", base64: "aGk=" }]),
		).toThrow();
	});

	it("Bcc ヘッダを組み立てない", () => {
		const raw = composeMime({ ...input, bccAddr: "secret@x.jp" });
		expect(raw).not.toMatch(/^Bcc:/im);
		expect(raw).not.toContain("secret@x.jp");
	});

	it("山括弧の無い Message-ID（受信メール由来）を付け直す", () => {
		const raw = composeMime({ ...input, inReplyTo: "p@x", referencesHeader: "g@x <p@x> p@x" });
		const head = headerBlock(raw);
		expect(head).toContain("In-Reply-To: <p@x>");
		expect(head).toContain("References: <g@x> <p@x>");
	});

	it("ファイル名の引用符で filename= の外に出られない", () => {
		const raw = composeMime(input, [{ filename: 'a".txt', contentType: "text/plain", base64: "aGk=" }]);
		expect(raw).toContain('filename="a\\".txt"');
	});
});

describe("formatMessageIdList", () => {
	it("空や記号だけのトークンは落とす", () => {
		expect(formatMessageIdList("<> < >")).toBeNull();
		expect(formatMessageIdList(null)).toBeNull();
	});
});

describe("stripHeader", () => {
	it("同名のヘッダが複数あっても全部消す", () => {
		const raw = "From: x@y.jp\r\nBcc: legit@x.jp\r\nTo: a@b.jp\r\nBcc: attacker@evil.com\r\n\r\nbody";
		const out = stripHeader(raw, "Bcc");
		expect(out).not.toContain("legit@x.jp");
		expect(out).not.toContain("attacker@evil.com");
		expect(out).toBe("From: x@y.jp\r\nTo: a@b.jp\r\n\r\nbody");
	});

	it("本文の Bcc: で始まる行には触らない", () => {
		const raw = "From: x@y.jp\r\n\r\nBcc: 本文の一部\r\n";
		expect(stripHeader(raw, "Bcc")).toBe(raw);
	});
});

describe("送信 API", () => {
	let h: Harness;
	let owner: Client;
	const from = "ai@mail.tsubame.test";

	beforeEach(async () => {
		h = await freshHarness();
		owner = await loginAsOwner(h);
		await seedDomain(h, { addresses: ["ai"] });
	});

	it("inReplyTo の CRLF は 400 で弾き、何も積まない", async () => {
		const res = await owner.post("/api/v1/messages", {
			from,
			to: "x@ext.example.jp",
			text: "本文",
			inReplyTo: INJECTED,
		});
		expect(res.status).toBe(400);
		expect(h.pending).toHaveLength(0);
	});

	it("添付のファイル名で R2 の名前空間を越えられない", async () => {
		const bad = await owner.post("/api/v1/messages", {
			from,
			to: "x@ext.example.jp",
			text: "本文",
			attachments: [{ filename: "../../raw/2026/09/msg_x.eml", contentType: "text/plain", base64: "aGk=" }],
		});
		expect(bad.status).toBe(400);

		const ok = await owner.post("/api/v1/messages", {
			from,
			to: "x@ext.example.jp",
			text: "本文",
			attachments: [{ filename: "..資料.txt", contentType: "text/plain", base64: "aGk=" }],
		});
		expect(ok.status).toBe(202);
		const att = await getDb(h.env)
			.select()
			.from(attachments)
			.where(eq(attachments.messageId, ok.body.id))
			.get();
		expect(att!.r2Key).toBe(`att/${ok.body.id}/${att!.id}`);
	});

	it("壊れた base64 は 400 で、メッセージの行を残さない", async () => {
		const res = await owner.post("/api/v1/messages", {
			from,
			to: "x@ext.example.jp",
			text: "本文",
			attachments: [{ filename: "a.txt", contentType: "text/plain", base64: "@@@" }],
		});
		expect(res.status).toBe(400);
		expect(await getDb(h.env).select().from(messages).all()).toHaveLength(0);
	});

	it("Bcc はエンベロープにだけ入り、どの受信者のヘッダにも出ない", async () => {
		const sent = captureSentEmails(h);
		const res = await owner.post("/api/v1/messages", {
			from,
			to: "to@ext.example.jp",
			bcc: ["hidden@ext.example.jp"],
			text: "本文",
		});
		expect(res.status).toBe(202);
		await drainQueues(h);

		expect(sent.map((s) => s.to).sort()).toEqual(["hidden@ext.example.jp", "to@ext.example.jp"]);
		for (const s of sent) {
			expect(headerBlock(s.raw)).not.toMatch(/^Bcc:/im);
			expect(s.raw).not.toContain("hidden@ext.example.jp");
		}
	});

	async function seedInbound(): Promise<{ inboundId: string; mailbox: string }> {
		const db = getDb(h.env);
		const mailbox = (await seedDomain(h, { domain: "reply.tsubame.test", addresses: ["box"] })).addressIds.box!;
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
			toAddr: "box@reply.tsubame.test",
			rfcMessageId: "orig-1@ext.example.jp",
			referencesHeader: "root-0@ext.example.jp",
			receivedAt: new Date(),
		});
		return { inboundId, mailbox };
	}

	async function issueKey(scopes: string[], addressIds: string[] | null = null): Promise<string> {
		const me = await owner.get("/api/v1/me");
		const res = await owner.post("/api/v1/admin/api-keys", {
			userId: me.body.id,
			name: "テストキー",
			scopes,
			addressIds,
		});
		expect(res.status).toBe(201);
		return res.body.token;
	}

	it("send だけのキーでは受信メールを引用した返信を作れない", async () => {
		const { inboundId } = await seedInbound();
		owner.useKey(await issueKey(["send"]));
		const res = await owner.post(`/api/v1/messages/${inboundId}/reply`, { text: "返信" });
		expect(res.status).toBe(403);
		expect(h.pending).toHaveLength(0);
	});

	it("read と send があれば返信でき、読めないメッセージへの返信は 404", async () => {
		const { inboundId, mailbox } = await seedInbound();
		const other = (await seedDomain(h, { domain: "other.tsubame.test", addresses: ["x"] })).addressIds.x!;

		const otherKey = await issueKey(["read", "send"], [other]);
		const mailboxKey = await issueKey(["read", "send"], [mailbox]);

		owner.useKey(otherKey);
		const hidden = await owner.post(`/api/v1/messages/${inboundId}/reply`, { text: "返信" });
		expect(hidden.status).toBe(404);

		owner.useKey(mailboxKey);
		const ok = await owner.post(`/api/v1/messages/${inboundId}/reply`, { text: "返信" });
		expect(ok.status).toBe(202);
	});

	it("返信の In-Reply-To / References は受信メールの Message-ID に山括弧を付けて出す", async () => {
		const sent = captureSentEmails(h);
		const { inboundId } = await seedInbound();

		const res = await owner.post(`/api/v1/messages/${inboundId}/reply`, { text: "返信" });
		expect(res.status).toBe(202);
		await drainQueues(h);

		const head = headerBlock(sent[0]!.raw);
		expect(head).toContain("In-Reply-To: <orig-1@ext.example.jp>");
		expect(head).toContain("References: <root-0@ext.example.jp> <orig-1@ext.example.jp>");
	});

	it("メールボックス自身に +タグ が無くても、タグ付き宛先を自分と認識する（#23 再検査失敗）", async () => {
		const sent = captureSentEmails(h);
		const db = getDb(h.env);
		const mailbox = (await seedDomain(h, { domain: "tagself.tsubame.test", addresses: ["box"] })).addressIds
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
			toAddr: "box+news@tagself.tsubame.test",
			ccAddr: "box+promo@tagself.tsubame.test",
			rfcMessageId: "orig-tag@ext.example.jp",
			receivedAt: new Date(),
		});

		const res = await owner.post(`/api/v1/messages/${inboundId}/reply`, { text: "返信", replyAll: true });
		expect(res.status).toBe(202);
		await drainQueues(h);

		const to = sent.map((s) => s.to);
		expect(to).not.toContain("box+news@tagself.tsubame.test");
		expect(to).not.toContain("box+promo@tagself.tsubame.test");
		expect(to).toContain("sender@ext.example.jp");
	});

	it("メールボックス自身が +タグ 付きなら、別タグやタグ無しの宛先は別人のまま（#23 再検査: 別人を自分扱いする退行）", async () => {
		const sent = captureSentEmails(h);
		const db = getDb(h.env);
		const mailbox = (await seedDomain(h, { domain: "owntag.tsubame.test", addresses: ["box+a"] })).addressIds[
			"box+a"
		]!;
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
			toAddr: "box@owntag.tsubame.test, box+b@owntag.tsubame.test",
			rfcMessageId: "orig-owntag@ext.example.jp",
			receivedAt: new Date(),
		});

		const res = await owner.post(`/api/v1/messages/${inboundId}/reply`, { text: "返信", replyAll: true });
		expect(res.status).toBe(202);
		await drainQueues(h);

		const to = sent.map((s) => s.to);
		expect(to).toContain("box@owntag.tsubame.test");
		expect(to).toContain("box+b@owntag.tsubame.test");
	});

	it("表示名に \" を含む保存済みの宛先も全員に返信で読める（#39 再検査失敗）", async () => {
		const sent = captureSentEmails(h);
		const db = getDb(h.env);
		const mailbox = (await seedDomain(h, { domain: "quoted.tsubame.test", addresses: ["box"] })).addressIds
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
			toAddr: '"x\\"y" <bob@ext.example.jp>, carol@ext.example.jp',
			rfcMessageId: "orig-quote@ext.example.jp",
			receivedAt: new Date(),
		});

		const res = await owner.post(`/api/v1/messages/${inboundId}/reply`, { text: "返信", replyAll: true });
		expect(res.status).toBe(202);
		await drainQueues(h);

		const to = sent.map((s) => s.to);
		expect(to).toContain("bob@ext.example.jp");
		expect(to).toContain("carol@ext.example.jp");
	});

	it("アーカイブ済みのアドレスからは送信できない（#37）", async () => {
		const db = getDb(h.env);
		const row = await db.select().from(addresses).where(eq(addresses.address, from)).get();
		await db.update(addresses).set({ archivedAt: new Date() }).where(eq(addresses.id, row!.id));

		const res = await owner.post("/api/v1/messages", { from, to: "x@ext.example.jp", text: "本文" });
		expect(res.status).toBe(403);
		expect(h.pending).toHaveLength(0);
	});

	it("エイリアスのアドレスからは送信できない（#37）", async () => {
		const db = getDb(h.env);
		const target = (await seedDomain(h, { domain: "target.tsubame.test", addresses: ["real"] })).addressIds
			.real!;
		const aliasId = newId("address");
		await db.insert(addresses).values({
			id: aliasId,
			domainId: (await db.select().from(addresses).where(eq(addresses.id, target)).get())!.domainId,
			localPart: "alias",
			address: "alias@target.tsubame.test",
			kind: "alias",
			aliasTargetId: target,
			isCatchAll: false,
		});

		const res = await owner.post("/api/v1/messages", {
			from: "alias@target.tsubame.test",
			to: "x@ext.example.jp",
			text: "本文",
		});
		expect(res.status).toBe(403);
		expect(h.pending).toHaveLength(0);
	});

	it("アーカイブ済みのアドレス宛の受信は配送されない（#37 resolve.ts）", async () => {
		const { resolveIncoming } = await import("@/domain/routing/resolve");
		const db = getDb(h.env);
		const row = await db.select().from(addresses).where(eq(addresses.address, from)).get();
		await db.update(addresses).set({ archivedAt: new Date() }).where(eq(addresses.id, row!.id));

		const result = await resolveIncoming(db, { from: "sender@ext.example.jp", to: from });
		expect(result.action).not.toBe("deliver");
	});
});
