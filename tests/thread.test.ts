import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { getDb } from "@/db/client";
import { addresses, domains, messages, threads } from "@/db/schema";
import { resetDb } from "./helpers";
import { findExistingThreadId, parseThreadMessageIds } from "@/domain/mail/thread";
import { newId } from "@/lib/id";

const ADR = "adr_test";

beforeEach(async () => {
	await resetDb();
	const db = getDb(env);
	// threads.address_id / addresses.domain_id の外部キー制約を満たすため土台を作る。
	await db.insert(domains).values({
		id: "dom_test",
		name: "example.com",
		zoneId: "z",
		zoneName: "example.com",
		mode: "apex",
	});
	await db.insert(addresses).values([
		{ id: ADR, domainId: "dom_test", localPart: "a", address: "a@example.com", kind: "mailbox" },
		{
			id: "other",
			domainId: "dom_test",
			localPart: "other",
			address: "other@example.com",
			kind: "mailbox",
		},
	]);
});

async function seedThreadWith(
	addressId: string,
	msg: { direction: "inbound" | "outbound"; fromAddr: string; rfcMessageId: string; toAddr?: string },
): Promise<string> {
	const db = getDb(env);
	const threadId = newId("thread");
	await db.insert(threads).values({
		id: threadId,
		addressId,
		lastMessageAt: new Date(1000000),
		messageCount: 1,
		unreadCount: 0,
	});
	await db.insert(messages).values({
		id: newId("message"),
		threadId,
		addressId,
		direction: msg.direction,
		status: msg.direction === "inbound" ? "received" : "sent",
		fromAddr: msg.fromAddr,
		toAddr: msg.toAddr ?? "x@y.com",
		rfcMessageId: msg.rfcMessageId,
		receivedAt: new Date(1000000),
	});
	return threadId;
}

describe("thread", () => {
	it("自分が送った outbound への返信は、山括弧付きで保存された Message-ID にも刺さる（宛先に含まれる場合）", async () => {
		const threadId = await seedThreadWith(ADR, {
			direction: "outbound",
			fromAddr: "a@example.com",
			toAddr: "partner@else.example",
			rfcMessageId: "<msg_abc@example.com>",
		});
		const found = await findExistingThreadId(getDb(env), {
			addressId: ADR,
			inReplyTo: "msg_abc@example.com",
			references: null,
			fromAddr: "partner@else.example",
		});
		expect(found).toBe(threadId);
	});

	it("送った outbound の Message-ID を知っているだけの無関係な第三者は接ぎ木できない（#10）", async () => {
		// Bcc 受信者・転送先・ML 経由などで Message-ID を知りえても、その outbound の
		// To/Cc/Bcc に居なければアンカーにしない。From 偽装は不要な攻撃だった。
		await seedThreadWith(ADR, {
			direction: "outbound",
			fromAddr: "a@example.com",
			toAddr: "partner@else.example",
			rfcMessageId: "<msg_abc@example.com>",
		});
		const found = await findExistingThreadId(getDb(env), {
			addressId: ADR,
			inReplyTo: "msg_abc@example.com",
			references: null,
			fromAddr: "attacker@evil.jp",
		});
		expect(found).toBeNull();
	});

	it("同じ送信者の inbound への続きは同じスレッドに刺さる", async () => {
		const threadId = await seedThreadWith(ADR, {
			direction: "inbound",
			fromAddr: "x@y.com",
			rfcMessageId: "abc-123@x.example",
		});
		const found = await findExistingThreadId(getDb(env), {
			addressId: ADR,
			inReplyTo: "abc-123@x.example",
			references: null,
			fromAddr: "X@Y.com",
		});
		expect(found).toBe(threadId);
	});

	it("第三者が既知の inbound Message-ID を In-Reply-To に入れても接ぎ木されない", async () => {
		await seedThreadWith(ADR, {
			direction: "inbound",
			fromAddr: "partner@trusted.example",
			rfcMessageId: "known-1@trusted.example",
		});
		const found = await findExistingThreadId(getDb(env), {
			addressId: ADR,
			inReplyTo: "known-1@trusted.example",
			references: "known-1@trusted.example",
			fromAddr: "attacker@evil.example",
		});
		expect(found).toBeNull();
	});

	it("同じ Message-ID でも別アドレスには紐づかない", async () => {
		await seedThreadWith("other", {
			direction: "outbound",
			fromAddr: "other@example.com",
			rfcMessageId: "abc@other",
		});
		const found = await findExistingThreadId(getDb(env), {
			addressId: ADR,
			inReplyTo: "abc@other",
			references: null,
			fromAddr: "other@example.com",
		});
		expect(found).toBeNull();
	});

	it("参照が無ければ null", async () => {
		const found = await findExistingThreadId(getDb(env), {
			addressId: ADR,
			inReplyTo: null,
			references: null,
			fromAddr: "x@y.com",
		});
		expect(found).toBeNull();
	});

	it("References が大量でも D1 のバインド上限で落ちず、直近の親に刺さる", async () => {
		const threadId = await seedThreadWith(ADR, {
			direction: "outbound",
			fromAddr: "a@example.com",
			rfcMessageId: "<latest@example.com>",
		});
		const refs = [...Array.from({ length: 300 }, (_, i) => `<old-${i}@x.example>`), "<latest@example.com>"];
		const found = await findExistingThreadId(getDb(env), {
			addressId: ADR,
			inReplyTo: "unknown@x.example",
			references: refs.join(" "),
			fromAddr: "x@y.com",
		});
		expect(found).toBe(threadId);
	});
});

describe("parseThreadMessageIds", () => {
	it("山括弧を外して件名を列挙する", () => {
		expect(parseThreadMessageIds("<a@x>", "<b@x> <c@x>")).toEqual(["a@x", "b@x", "c@x"]);
	});
});
