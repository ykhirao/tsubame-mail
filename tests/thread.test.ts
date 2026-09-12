import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { getDb } from "@/db/client";
import { addresses, domains, messages, threads } from "@/db/schema";
import { resetDb } from "./helpers";
import { findExistingThreadId, parseThreadMessageIds, type ThreadRefs } from "@/domain/mail/thread";
import type { InboundAuth } from "@/domain/mail/parse";
import { newId } from "@/lib/id";

const ADR = "adr_test";

// 認証が無ければ接ぎ木しない（#127）。既存の接ぎ木テストは認証済み（dmarc=pass）にして、
// 認証の有無ではなく従来どおり「同送信者・宛先」の判定だけを検査する。
function refs(over: Omit<ThreadRefs, "addressId" | "inboundAuth"> & { inboundAuth?: InboundAuth | null }): ThreadRefs {
	return {
		addressId: ADR,
		...over,
		inboundAuth: over.inboundAuth === undefined ? { dmarc: "pass", dkimPassDomains: [] } : over.inboundAuth,
	};
}

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
		const found = await findExistingThreadId(
			getDb(env),
			refs({ inReplyTo: "msg_abc@example.com", references: null, fromAddr: "partner@else.example" }),
		);
		expect(found).toBe(threadId);
	});

	it("送った outbound の Message-ID を知っているだけの無関係な第三者は接ぎ木できない（#10）", async () => {
		// Bcc 受信者・転送先・ML 経由などで Message-ID を知りえても、その outbound の
		// To/Cc/Bcc に居なければアンカーにしない。認証済みでも宛先に含まれない攻撃者は通らない。
		await seedThreadWith(ADR, {
			direction: "outbound",
			fromAddr: "a@example.com",
			toAddr: "partner@else.example",
			rfcMessageId: "<msg_abc@example.com>",
		});
		const found = await findExistingThreadId(
			getDb(env),
			refs({ inReplyTo: "msg_abc@example.com", references: null, fromAddr: "attacker@evil.jp" }),
		);
		expect(found).toBeNull();
	});

	it("同じ送信者の inbound への続きは同じスレッドに刺さる", async () => {
		const threadId = await seedThreadWith(ADR, {
			direction: "inbound",
			fromAddr: "x@y.com",
			rfcMessageId: "abc-123@x.example",
		});
		const found = await findExistingThreadId(
			getDb(env),
			refs({ inReplyTo: "abc-123@x.example", references: null, fromAddr: "X@Y.com" }),
		);
		expect(found).toBe(threadId);
	});

	it("第三者が既知の inbound Message-ID を In-Reply-To に入れても接ぎ木されない", async () => {
		await seedThreadWith(ADR, {
			direction: "inbound",
			fromAddr: "partner@trusted.example",
			rfcMessageId: "known-1@trusted.example",
		});
		const found = await findExistingThreadId(
			getDb(env),
			refs({
				inReplyTo: "known-1@trusted.example",
				references: "known-1@trusted.example",
				fromAddr: "attacker@evil.example",
			}),
		);
		expect(found).toBeNull();
	});

	it("同じ Message-ID でも別アドレスには紐づかない", async () => {
		await seedThreadWith("other", {
			direction: "outbound",
			fromAddr: "other@example.com",
			rfcMessageId: "abc@other",
		});
		const found = await findExistingThreadId(
			getDb(env),
			refs({ inReplyTo: "abc@other", references: null, fromAddr: "other@example.com" }),
		);
		expect(found).toBeNull();
	});

	it("参照が無ければ null", async () => {
		const found = await findExistingThreadId(
			getDb(env),
			refs({ inReplyTo: null, references: null, fromAddr: "x@y.com" }),
		);
		expect(found).toBeNull();
	});

	it("References が大量でも D1 のバインド上限で落ちず、直近の親に刺さる", async () => {
		const threadId = await seedThreadWith(ADR, {
			direction: "outbound",
			fromAddr: "a@example.com",
			rfcMessageId: "<latest@example.com>",
		});
		const ids = [...Array.from({ length: 300 }, (_, i) => `<old-${i}@x.example>`), "<latest@example.com>"];
		const found = await findExistingThreadId(
			getDb(env),
			refs({ inReplyTo: "unknown@x.example", references: ids.join(" "), fromAddr: "x@y.com" }),
		);
		expect(found).toBe(threadId);
	});

	it("dmarc=none（送信元に DMARC が無い）で From を偽装し、既知の Message-ID を In-Reply-To に入れても接ぎ木されない（#127）", async () => {
		await seedThreadWith(ADR, {
			direction: "inbound",
			fromAddr: "partner@trusted.example",
			rfcMessageId: "known-1@trusted.example",
		});
		const found = await findExistingThreadId(
			getDb(env),
			refs({
				inReplyTo: "known-1@trusted.example",
				references: null,
				fromAddr: "partner@trusted.example",
				inboundAuth: { dmarc: "none", dkimPassDomains: [] },
			}),
		);
		expect(found).toBeNull();
	});

	it("dmarc=pass の正規の返信は従来どおり同じ送信者のスレッドに刺さる（#127 で塞がれない）", async () => {
		const threadId = await seedThreadWith(ADR, {
			direction: "inbound",
			fromAddr: "partner@trusted.example",
			rfcMessageId: "known-1@trusted.example",
		});
		const found = await findExistingThreadId(
			getDb(env),
			refs({
				inReplyTo: "known-1@trusted.example",
				references: null,
				fromAddr: "partner@trusted.example",
				inboundAuth: { dmarc: "pass", dkimPassDomains: ["trusted.example"] },
			}),
		);
		expect(found).toBe(threadId);
	});

	it("inboundAuth が null（CF ブロック無し・判定無し）なら接ぎ木しない（#127）", async () => {
		await seedThreadWith(ADR, {
			direction: "inbound",
			fromAddr: "partner@trusted.example",
			rfcMessageId: "known-1@trusted.example",
		});
		const found = await findExistingThreadId(
			getDb(env),
			refs({
				inReplyTo: "known-1@trusted.example",
				references: null,
				fromAddr: "partner@trusted.example",
				inboundAuth: null,
			}),
		);
		expect(found).toBeNull();
	});

	it("dmarc が無くても dkim の署名ドメインが From の親ドメインと一致すれば接ぎ木してよい（#127 の dkim 経路）", async () => {
		const threadId = await seedThreadWith(ADR, {
			direction: "inbound",
			fromAddr: "bob@mail.else.example",
			rfcMessageId: "known-2@else.example",
		});
		const found = await findExistingThreadId(
			getDb(env),
			refs({
				inReplyTo: "known-2@else.example",
				references: null,
				fromAddr: "bob@mail.else.example",
				inboundAuth: { dmarc: null, dkimPassDomains: ["else.example"] },
			}),
		);
		expect(found).toBe(threadId);
	});
});

describe("parseThreadMessageIds", () => {
	it("山括弧を外して件名を列挙する", () => {
		expect(parseThreadMessageIds("<a@x>", "<b@x> <c@x>")).toEqual(["a@x", "b@x", "c@x"]);
	});
});
