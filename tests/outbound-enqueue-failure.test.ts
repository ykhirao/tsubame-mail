import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { messages, outboundJobs } from "@/db/schema";
import { drainQueues, freshHarness, loginAsOwner, seedDomain, type Harness } from "../e2e/harness";

async function outboundStatus(h: Harness): Promise<{ messageStatus: string; jobStatus: string }> {
	const msg = await getDb(h.env).select().from(messages).where(eq(messages.direction, "outbound")).get();
	expect(msg).toBeDefined();
	const job = await getDb(h.env)
		.select()
		.from(outboundJobs)
		.where(eq(outboundJobs.messageId, msg!.id))
		.get();
	return { messageStatus: msg!.status, jobStatus: job!.status };
}

describe("送信の添付保存 / キュー投入の失敗（#90）", () => {
	it("添付の R2 put が落ちても queued の行を残さず failed にする", async () => {
		const h = await freshHarness();
		const owner = await loginAsOwner(h);
		await seedDomain(h, { addresses: ["ai"] });
		h.env.BUCKET.put = (async () => {
			throw new Error("r2 down");
		}) as unknown as typeof h.env.BUCKET.put;

		const res = await owner.post("/api/v1/messages", {
			from: "ai@mail.tsubame.test",
			to: "x@ext.example.jp",
			text: "本文",
			attachments: [{ filename: "a.txt", contentType: "text/plain", base64: "aGk=" }],
		});
		expect(res.status).toBe(500);

		const s = await outboundStatus(h);
		expect(s.messageStatus).toBe("failed");
		expect(s.jobStatus).toBe("failed");

		// キューを回しても failed のまま。送られもせず queued で残る、を起こさない。
		await drainQueues(h);
		expect((await outboundStatus(h)).messageStatus).toBe("failed");
	});

	it("キュー投入（OUTBOUND_QUEUE.send）が落ちても同じく failed にする", async () => {
		const h = await freshHarness();
		const owner = await loginAsOwner(h);
		await seedDomain(h, { addresses: ["ai"] });
		h.env.OUTBOUND_QUEUE.send = (async () => {
			throw new Error("queue down");
		}) as unknown as typeof h.env.OUTBOUND_QUEUE.send;

		const res = await owner.post("/api/v1/messages", {
			from: "ai@mail.tsubame.test",
			to: "x@ext.example.jp",
			text: "本文",
		});
		expect(res.status).toBe(500);

		const s = await outboundStatus(h);
		expect(s.messageStatus).toBe("failed");
		expect(s.jobStatus).toBe("failed");
	});
});
