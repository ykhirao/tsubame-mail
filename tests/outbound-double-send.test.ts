import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { outboundJobs } from "@/db/schema";
import { processOutboundSend } from "@/domain/mail/outbound";
import { isOutboundSend } from "@/services/queue";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { captureSentEmails, freshHarness, loginAsOwner, seedDomain, type Harness } from "../e2e/harness";

async function sendOne(h: Harness): Promise<{ messageId: string; jobId: string }> {
	const owner = await loginAsOwner(h);
	const { addressIds } = await seedDomain(h, { addresses: ["ai"] });
	void addressIds;
	const res = await owner.post("/api/v1/messages", {
		from: "ai@mail.tsubame.test",
		to: "x@ext.example.jp",
		text: "本文",
	});
	expect(res.status).toBe(202);
	const messageId = res.body.id as string;
	const job = await getDb(h.env).select().from(outboundJobs).where(eq(outboundJobs.messageId, messageId)).get();
	return { messageId, jobId: job!.id };
}

async function runProcessOnce(h: Harness, jobId: string, messageId: string): Promise<void> {
	const ctx = createExecutionContext();
	await processOutboundSend({ kind: "outbound.send", jobId, messageId }, h.env, ctx);
	await waitOnExecutionContext(ctx);
}

describe("送信の部分失敗・二重送信（#21）", () => {
	it("同じ job を 2 回同時に処理しても 1 回しか送らない", async () => {
		const h = await freshHarness();
		const sent = captureSentEmails(h);
		const { messageId, jobId } = await sendOne(h);

		// 2 つのコンシューマが同じ queued job を同時に拾った状況を再現する。
		await Promise.all([runProcessOnce(h, jobId, messageId), runProcessOnce(h, jobId, messageId)]);

		expect(sent).toHaveLength(1);
		const job = await getDb(h.env).select().from(outboundJobs).where(eq(outboundJobs.id, jobId)).get();
		expect(job!.status).toBe("sent");
	});

	it("sending のまま止まった job は、再配達で拾い直して送信を完了する", async () => {
		const h = await freshHarness();
		const sent = captureSentEmails(h);
		const { messageId, jobId } = await sendOne(h);

		// Worker が sending に更新した直後にクラッシュした状況を再現する（期限切れの sending）。
		const db = getDb(h.env);
		await db
			.update(outboundJobs)
			.set({ status: "sending", nextAttemptAt: new Date(Date.now() - 1000) })
			.where(eq(outboundJobs.id, jobId));

		await runProcessOnce(h, jobId, messageId);

		expect(sent).toHaveLength(1);
		const job = await db.select().from(outboundJobs).where(eq(outboundJobs.id, jobId)).get();
		expect(job!.status).toBe("sent");
	});

	it("sending がまだ期限内なら送信せず、期限が来る頃に自分を積み直す（二重送信を防ぐ）", async () => {
		const h = await freshHarness();
		const sent = captureSentEmails(h);
		const { messageId, jobId } = await sendOne(h);

		const db = getDb(h.env);
		await db
			.update(outboundJobs)
			.set({ status: "sending", nextAttemptAt: new Date(Date.now() + 60_000) })
			.where(eq(outboundJobs.id, jobId));
		h.pending.length = 0; // 元の enqueue 分を消して、今回の積み直しだけを見る

		await runProcessOnce(h, jobId, messageId);

		expect(sent).toHaveLength(0);
		const job = await db.select().from(outboundJobs).where(eq(outboundJobs.id, jobId)).get();
		expect(job!.status).toBe("sending");

		// claim に失敗しても ack して終わらせない。期限が来る頃に自分を OUTBOUND_QUEUE へ積み直す。
		const requeued = h.pending.find(
			(p) => p.queue === "outbound" && isOutboundSend(p.body) && p.body.jobId === jobId,
		);
		expect(requeued).toBeDefined();
		expect(requeued!.delaySeconds).toBeGreaterThan(0);
		expect(requeued!.delaySeconds).toBeLessThanOrEqual(61);
	});

	it("claim に失敗しても sent / failed になっていれば積み直さない", async () => {
		const h = await freshHarness();
		const sent = captureSentEmails(h);
		const { messageId, jobId } = await sendOne(h);

		await runProcessOnce(h, jobId, messageId);
		expect(sent).toHaveLength(1);
		h.pending.length = 0;

		// 送信済みの job にもう一度同じメッセージが配達された状況（at-least-once の再配達）。
		await runProcessOnce(h, jobId, messageId);

		expect(sent).toHaveLength(1);
		expect(h.pending).toHaveLength(0);
	});
});
