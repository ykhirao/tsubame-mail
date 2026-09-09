// 同じジョブを二重に送らない。status が sent のジョブは何もせず返す。
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { attachments, messages, outboundJobs } from "@/db/schema";
import type { OutboundSendMessage } from "@/services/queue";
import { dispatchMessageEvent } from "@/services/webhooks";
import { bytesToBase64, parseMailboxes, sendRawEmail } from "@/services/sender";
import { composeMime, generateMessageId, type ComposeAttachment } from "./compose";

export const OUTBOUND_BACKOFF_SECONDS = [10, 60, 300] as const;
export const OUTBOUND_MAX_ATTEMPTS = 3;

export function backoffDelaySeconds(attempts: number): number {
	const idx = Math.min(attempts, OUTBOUND_BACKOFF_SECONDS.length) - 1;
	return OUTBOUND_BACKOFF_SECONDS[Math.max(idx, 0)]!;
}

export function isRetryExhausted(attempts: number): boolean {
	return attempts > OUTBOUND_MAX_ATTEMPTS;
}

export async function processOutboundSend(
	msg: OutboundSendMessage,
	env: CloudflareEnv,
	_ctx: ExecutionContext,
): Promise<void> {
	const db = getDb(env);

	// キューは at-least-once。送信前に必ず現状の status を読んで二重送信を防ぐ。
	const job = await db
		.select()
		.from(outboundJobs)
		.where(eq(outboundJobs.id, msg.jobId))
		.get();
	if (!job) return;
	if (job.status !== "queued") return; // sent / sending / failed は何もしない

	const message = await db
		.select()
		.from(messages)
		.where(eq(messages.id, msg.messageId))
		.get();
	if (!message) return;

	await db
		.update(outboundJobs)
		.set({ status: "sending" })
		.where(eq(outboundJobs.id, job.id));

	try {
		const attachRows = await db
			.select()
			.from(attachments)
			.where(eq(attachments.messageId, message.id))
			.all();
		const attachList: ComposeAttachment[] = [];
		for (const a of attachRows) {
			const obj = await env.BUCKET.get(a.r2Key);
			const buf = obj ? new Uint8Array(await obj.arrayBuffer()) : new Uint8Array(0);
			attachList.push({
				filename: a.filename,
				contentType: a.contentType,
				base64: bytesToBase64(buf),
			});
		}

		// 返信がスレッドに刺さるよう、送信前に採番して DB にも残す。
		const rfcMessageId = generateMessageId(message.id, message.fromAddr);
		await db
			.update(messages)
			.set({ rfcMessageId })
			.where(eq(messages.id, message.id));

		const raw = composeMime(
			{
				messageId: message.id,
				fromAddr: message.fromAddr,
				fromName: message.fromName,
				toAddr: message.toAddr,
				ccAddr: message.ccAddr,
				bccAddr: message.bccAddr,
				subject: message.subject,
				textBody: message.textBody,
				htmlBody: message.htmlBody,
				inReplyTo: message.inReplyTo,
				referencesHeader: message.referencesHeader,
			},
			attachList,
		);

		await sendRawEmail(env, {
			from: { address: message.fromAddr, name: message.fromName ?? undefined },
			to: parseMailboxes(message.toAddr),
			cc: parseMailboxes(message.ccAddr),
			bcc: parseMailboxes(message.bccAddr),
			raw,
		});

		await db
			.update(messages)
			.set({ status: "sent" })
			.where(eq(messages.id, message.id));
		await db
			.update(outboundJobs)
			.set({ status: "sent", sentAt: new Date() })
			.where(eq(outboundJobs.id, job.id));
		await dispatchMessageEvent(env, "message.sent", message.id);
	} catch (err) {
		const attempts = job.attempts + 1;
		const lastError = err instanceof Error ? err.message : String(err);
		console.error("送信に失敗", { jobId: job.id, attempts, lastError });

		if (isRetryExhausted(attempts)) {
			await db
				.update(messages)
				.set({ status: "failed" })
				.where(eq(messages.id, message.id));
			await db
				.update(outboundJobs)
				.set({ status: "failed", attempts, lastError })
				.where(eq(outboundJobs.id, job.id));
			await dispatchMessageEvent(env, "message.failed", message.id);
			return;
		}

		const delay = backoffDelaySeconds(attempts);
		await db
			.update(outboundJobs)
			.set({
				status: "queued",
				attempts,
				lastError,
				nextAttemptAt: new Date(Date.now() + delay * 1000),
			})
			.where(eq(outboundJobs.id, job.id));
		await env.OUTBOUND_QUEUE.send(
			{ kind: "outbound.send", jobId: job.id, messageId: message.id },
			{ delaySeconds: delay },
		);
	}
}
