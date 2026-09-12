import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { addresses, attachments, messages, outboundJobs } from "@/db/schema";
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

describe("送信の再回収と恒久失敗（#59 / #67 / #102）", () => {
	it("attempts が上限の期限切れ sending は送信 0 回で failed（#59）", async () => {
		const h = await freshHarness();
		const sent = captureSentEmails(h);
		const { messageId, jobId } = await sendOne(h);

		const db = getDb(h.env);
		// Worker が落ち続けて attempts が上限に達した固まった job。期限切れ sending の
		// 拾い直しでも送らない（claims が attempts を数える）。
		await db
			.update(outboundJobs)
			.set({ status: "sending", nextAttemptAt: new Date(Date.now() - 1000), attempts: 99 })
			.where(eq(outboundJobs.id, jobId));

		await runProcessOnce(h, jobId, messageId);

		expect(sent).toHaveLength(0);
		const job = await db.select().from(outboundJobs).where(eq(outboundJobs.id, jobId)).get();
		expect(job!.status).toBe("failed");
		expect(job!.attempts).toBe(100);
		const m = await db.select().from(messages).where(eq(messages.id, messageId)).get();
		expect(m!.status).toBe("failed");
	});

	it("キュー投入後に差出人をアーカイブしても送信されない（#67）", async () => {
		const h = await freshHarness();
		const sent = captureSentEmails(h);
		const { messageId, jobId } = await sendOne(h);

		const db = getDb(h.env);
		const sender = await db
			.select()
			.from(addresses)
			.where(eq(addresses.address, "ai@mail.tsubame.test"))
			.get();
		await db
			.update(addresses)
			.set({ archivedAt: new Date() })
			.where(eq(addresses.id, sender!.id));

		await runProcessOnce(h, jobId, messageId);

		expect(sent).toHaveLength(0);
		const job = await db.select().from(outboundJobs).where(eq(outboundJobs.id, jobId)).get();
		expect(job!.status).toBe("failed");
		expect(job!.lastError).toContain("アーカイブ");
	});

	it("R2 から添付が消えていれば送信せず再試行する（#102）", async () => {
		const h = await freshHarness();
		const owner = await loginAsOwner(h);
		await seedDomain(h, { addresses: ["ai"] });
		const sent = captureSentEmails(h);

		const res = await owner.post("/api/v1/messages", {
			from: "ai@mail.tsubame.test",
			to: "x@ext.example.jp",
			text: "本文",
			attachments: [{ filename: "a.txt", contentType: "text/plain", base64: btoa("hello") }],
		});
		expect(res.status).toBe(202);
		const messageId = res.body.id as string;
		const db = getDb(h.env);
		const job = await db
			.select()
			.from(outboundJobs)
			.where(eq(outboundJobs.messageId, messageId))
			.get();
		const att = await db
			.select()
			.from(attachments)
			.where(eq(attachments.messageId, messageId))
			.get();
		await h.env.BUCKET.delete(att!.r2Key);

		await runProcessOnce(h, job!.id, messageId);

		// 空の添付を黙って送らない。再試行（queued）に戻り、EMAIL.send は呼ばれない。
		expect(sent).toHaveLength(0);
		const jobAfter = await db.select().from(outboundJobs).where(eq(outboundJobs.id, job!.id)).get();
		expect(jobAfter!.status).toBe("queued");
		expect(jobAfter!.lastError).toContain("添付データが見つかりません");
		const m = await db.select().from(messages).where(eq(messages.id, messageId)).get();
		expect(m!.status).not.toBe("sent");
	});
});

describe("出し分けた宛先ごとの送信済み記録（#21 / #59）", () => {
	async function seedTwoRecipients(h: Harness) {
		const owner = await loginAsOwner(h);
		await seedDomain(h, { addresses: ["ai"] });
		const res = await owner.post("/api/v1/messages", {
			from: "ai@mail.tsubame.test",
			to: ["a@ext.example.jp", "b@ext.example.jp"],
			text: "本文",
		});
		expect(res.status).toBe(202);
		const messageId = res.body.id as string;
		const job = await getDb(h.env).select().from(outboundJobs).where(eq(outboundJobs.messageId, messageId)).get();
		return { messageId, jobId: job!.id };
	}

	it("N 件目の宛先で失敗したら、成功済みの宛先には再送しない", async () => {
		const h = await freshHarness();
		const db = getDb(h.env);
		const envelope: string[] = [];
		let bFirstFails = true;
		(h.env as { EMAIL: unknown }).EMAIL = {
			async send(message: { from: string; to: string }) {
				envelope.push(message.to);
				if (message.to === "b@ext.example.jp" && bFirstFails) {
					bFirstFails = false;
					throw new Error("一時的な配送失敗");
				}
				return { messageId: `captured-${envelope.length}` };
			},
		};
		const { messageId, jobId } = await seedTwoRecipients(h);

		// 1 回目: a は送れ、b で失敗。成功した a は送信済みとして記録して job を queued に戻す。
		await runProcessOnce(h, jobId, messageId);
		let job = await db.select().from(outboundJobs).where(eq(outboundJobs.id, jobId)).get();
		expect(job!.status).toBe("queued");
		expect(job!.sentRecipients).toEqual(["a@ext.example.jp"]);
		expect(envelope.filter((t) => t === "a@ext.example.jp")).toHaveLength(1);

		// 再試行では a は送らず b だけ送って sent にする。
		await runProcessOnce(h, jobId, messageId);
		job = await db.select().from(outboundJobs).where(eq(outboundJobs.id, jobId)).get();
		expect(job!.status).toBe("sent");
		expect(job!.sentRecipients).toEqual(["a@ext.example.jp", "b@ext.example.jp"]);
		expect(envelope.filter((t) => t === "a@ext.example.jp")).toHaveLength(1);
		expect(envelope.filter((t) => t === "b@ext.example.jp")).toHaveLength(2);
		const m = await db.select().from(messages).where(eq(messages.id, messageId)).get();
		expect(m!.status).toBe("sent");
	});

	it("送信済み宛先が全件記録された sending は送信 0 回で sent にする", async () => {
		const h = await freshHarness();
		const sent = captureSentEmails(h);
		const db = getDb(h.env);
		const { messageId, jobId } = await sendOne(h);

		// 全宛先を送った直後にクラッシュして status=sending のまま残った job（再配達が来る）。
		await db
			.update(outboundJobs)
			.set({ status: "sending", nextAttemptAt: new Date(Date.now() - 1000), sentRecipients: ["x@ext.example.jp"] })
			.where(eq(outboundJobs.id, jobId));

		await runProcessOnce(h, jobId, messageId);

		expect(sent).toHaveLength(0);
		const job = await db.select().from(outboundJobs).where(eq(outboundJobs.id, jobId)).get();
		expect(job!.status).toBe("sent");
		expect(job!.sentRecipients).toEqual(["x@ext.example.jp"]);
	});
});
