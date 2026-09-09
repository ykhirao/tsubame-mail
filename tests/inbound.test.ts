import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { getDb } from "@/db/client";
import { addresses, domains, messages, threads } from "@/db/schema";
import { fakeCtx, resetDb, sampleMime } from "./helpers";
import { processInbound } from "@/domain/mail/inbound";
import { saveRaw } from "@/services/r2";
import { newId } from "@/lib/id";
import { eq } from "drizzle-orm";
import type { InboundQueueMessage } from "@/services/queue";

const DOM_ID = "dom_test";
const ADR = "adr_test";
const DOMAIN = "example.com";

async function seed(): Promise<void> {
	const db = getDb(env);
	await db.insert(domains).values({ id: DOM_ID, name: DOMAIN, zoneId: "z", zoneName: DOMAIN, mode: "apex" });
	await db.insert(addresses).values({
		id: ADR,
		domainId: DOM_ID,
		localPart: "a",
		address: "a@example.com",
		kind: "mailbox",
	});
}

async function storeRaw(): Promise<string> {
	const bytes = new TextEncoder().encode(sampleMime());
	return saveRaw(env, newId("message"), new Blob([bytes]).stream() as ReadableStream<Uint8Array>, new Date());
}

function payload(rawKey: string): InboundQueueMessage {
	return {
		kind: "inbound",
		addressId: ADR,
		rawKey,
		envelope: { from: "taro@example.com", to: "a@example.com" },
		receivedAt: Date.now(),
	};
}

describe("processInbound", () => {
	beforeEach(resetDb);

	it("R2 の生 MIME をパースして保存し、スレッドを立てる", async () => {
		await seed();
		const key = await storeRaw();
		await processInbound(payload(key), env, fakeCtx);

		const db = getDb(env);
		const rows = await db.select().from(messages).where(eq(messages.addressId, ADR)).all();
		expect(rows).toHaveLength(1);
		const m = rows[0]!;
		expect(m.toAddr).toContain("a@b.jp");
		expect(m.toAddr).toContain("c@d.jp");
		expect(m.rfcMessageId).toBe("abc-123@x.example");
		expect(m.threadId).toBeTruthy();
		expect(m.hasAttachments).toBe(true);

		const t = await db.select().from(threads).where(eq(threads.id, m.threadId as string)).get();
		expect(t?.messageCount).toBe(1);
		expect(t?.unreadCount).toBe(1);
	});

	it("同じ rawKey は二重処理しない（at-least-once 対策）", async () => {
		await seed();
		const key = await storeRaw();
		await processInbound(payload(key), env, fakeCtx);
		await processInbound(payload(key), env, fakeCtx);

		const db = getDb(env);
		const rows = await db.select().from(messages).where(eq(messages.rawR2Key, key)).all();
		expect(rows).toHaveLength(1);
	});

	it("既存スレッドの In-Reply-To に刺さる", async () => {
		await seed();
		const db = getDb(env);
		const threadId = newId("thread");
		await db.insert(threads).values({
			id: threadId,
			addressId: ADR,
			lastMessageAt: new Date(1),
			messageCount: 1,
			unreadCount: 1,
		});
		await db.insert(messages).values({
			id: newId("message"),
			threadId,
			addressId: ADR,
			direction: "inbound",
			status: "received",
			fromAddr: "a@b.jp",
			toAddr: ADR,
			rfcMessageId: "prev-1@x.example",
			receivedAt: new Date(1),
		});

		const key = await storeRaw();
		await processInbound(payload(key), env, fakeCtx);

		const rows = await db.select().from(messages).where(eq(messages.rawR2Key, key)).all();
		expect(rows).toHaveLength(1);
		expect(rows[0]!.threadId).toBe(threadId);

		const t = await db.select().from(threads).where(eq(threads.id, threadId)).get();
		expect(t?.messageCount).toBe(2);
		expect(t?.unreadCount).toBe(2);
	});
});
