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

describe("thread", () => {

	it("In-Reply-To で既存スレッドに刺さる", async () => {
		const db = getDb(env);
		const threadId = newId("thread");
		await db.insert(threads).values({
			id: threadId,
			addressId: ADR,
			lastMessageAt: new Date(1000000),
			messageCount: 1,
			unreadCount: 0,
		});
		await db.insert(messages).values({
			id: newId("message"),
			threadId,
			addressId: ADR,
			direction: "inbound",
			status: "received",
			fromAddr: "x@y.com",
			toAddr: ADR,
			rfcMessageId: "abc-123@x.example",
			receivedAt: new Date(1000000),
		});
		const found = await findExistingThreadId(db, {
			addressId: ADR,
			inReplyTo: "abc-123@x.example",
			references: null,
		});
		expect(found).toBe(threadId);
	});

	it("同じ Message-ID でも別アドレスには紐づかない", async () => {
		const db = getDb(env);
		const threadId = newId("thread");
		await db.insert(threads).values({
			id: threadId,
			addressId: "other",
			lastMessageAt: new Date(1),
			messageCount: 1,
			unreadCount: 0,
		});
		await db.insert(messages).values({
			id: newId("message"),
			threadId,
			addressId: "other",
			direction: "inbound",
			status: "received",
			fromAddr: "x@y.com",
			toAddr: "other",
			rfcMessageId: "abc@other",
			receivedAt: new Date(1),
		});
		const found = await findExistingThreadId(db, { addressId: ADR, inReplyTo: "abc@other", references: null });
		expect(found).toBeNull();
	});

	it("参照が無ければ null", async () => {
		const db = getDb(env);
		const found = await findExistingThreadId(db, { addressId: ADR, inReplyTo: null, references: null });
		expect(found).toBeNull();
	});
});

describe("parseThreadMessageIds", () => {
	it("山括弧を外して件名を列挙する", () => {
		expect(parseThreadMessageIds("<a@x>", "<b@x> <c@x>")).toEqual(["a@x", "b@x", "c@x"]);
	});
});
