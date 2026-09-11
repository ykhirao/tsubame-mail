// 同じジョブを二重に送らない。claim できなかった（queued でも、期限切れの sending でもない）
// ジョブは何もせず返す。
import { and, eq, lt, or, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { addresses, attachments, messages, outboundJobs } from "@/db/schema";
import type { OutboundSendMessage } from "@/services/queue";
import { dispatchMessageEvent } from "@/services/webhooks";
import { bytesToBase64, parseMailboxes, sendRawEmail } from "@/services/sender";
import { normalizeAddress } from "./address";
import { composeMime, generateMessageId, type ComposeAttachment } from "./compose";

export const OUTBOUND_BACKOFF_SECONDS = [10, 60, 300] as const;
export const OUTBOUND_MAX_ATTEMPTS = 3;

// Worker が sending への更新後・送信完了前に落ちると、他に誰も拾わない行が残る
// （精査 #21）。at-least-once のキュー再配達がその job を再訪したときに拾えるよう、
// この時間を超えた sending は queued と同じに扱う。
const SENDING_STUCK_SECONDS = 120;

export function backoffDelaySeconds(attempts: number): number {
	const idx = Math.min(attempts, OUTBOUND_BACKOFF_SECONDS.length) - 1;
	return OUTBOUND_BACKOFF_SECONDS[Math.max(idx, 0)]!;
}

export function isRetryExhausted(attempts: number): boolean {
	return attempts > OUTBOUND_MAX_ATTEMPTS;
}

// 送信できない恒久状態（アーカイブ済み・エイリアス・回数上限）は再試行しても同じなので
// 一括でメッセージとジョブを failed に落とし、Webhook を発火させる。
async function failOutbound(
	db: ReturnType<typeof getDb>,
	env: CloudflareEnv,
	jobId: string,
	messageId: string,
	lastError: string,
): Promise<void> {
	await db.update(messages).set({ status: "failed" }).where(eq(messages.id, messageId));
	await db
		.update(outboundJobs)
		.set({ status: "failed", lastError })
		.where(eq(outboundJobs.id, jobId));
	await dispatchMessageEvent(env, "message.failed", messageId);
	await env.OUTBOUND_QUEUE.send({ kind: "notify", event: "send_failed", messageId });
}

export async function processOutboundSend(
	msg: OutboundSendMessage,
	env: CloudflareEnv,
	_ctx: ExecutionContext,
): Promise<void> {
	const db = getDb(env);
	const now = new Date();

	// 読んでから更新すると、同じ job を 2 つのコンシューマが同時に拾える。
	// 1 文の UPDATE ... WHERE ... RETURNING で「拾えたのは 1 人だけ」を保証する。
	// nextAttemptAt を「sending の期限」としても使う。クラッシュで sending のまま
	// 期限を過ぎた行は、同じ job の再配達（キューは at-least-once）が来たときに拾い直す。
	const claimed = await db
		.update(outboundJobs)
		.set({
			status: "sending",
			nextAttemptAt: new Date(now.getTime() + SENDING_STUCK_SECONDS * 1000),
			// 期限切れの sending の拾い直しでも試行回数を数える。数えないと attempts が上限の
			// 固まった job を再配達のたびに送り続ける（精査 #59）。
			attempts: sql`${outboundJobs.attempts} + 1`,
		})
		.where(
			and(
				eq(outboundJobs.id, msg.jobId),
				or(
					eq(outboundJobs.status, "queued"),
					and(eq(outboundJobs.status, "sending"), lt(outboundJobs.nextAttemptAt, now)),
				),
			),
		)
		.returning();
	const job = claimed[0];
	if (!job) {
		// キューの再配達は通常すぐ届く。期限切れの sending だけを拾う設計だと、
		// 期限（SENDING_STUCK_SECONDS）より前に再配達が来て claim に失敗し、
		// そのまま ack されて job が二度と配達されなくなる（精査 #21 差し戻し）。
		// まだ処理中と分かっている sending なら、期限が来る頃に自分を積み直す。
		const current = await db.select().from(outboundJobs).where(eq(outboundJobs.id, msg.jobId)).get();
		if (current?.status === "sending" && current.nextAttemptAt && current.nextAttemptAt > now) {
			const remainingSeconds = Math.ceil((current.nextAttemptAt.getTime() - now.getTime()) / 1000);
			await env.OUTBOUND_QUEUE.send(
				{ kind: "outbound.send", jobId: msg.jobId, messageId: msg.messageId },
				{ delaySeconds: remainingSeconds + 1 },
			);
		}
		return; // sent / failed / 不存在、または上で積み直した
	}

	const message = await db
		.select()
		.from(messages)
		.where(eq(messages.id, msg.messageId))
		.get();
	if (!message) return;

	// 試行回数の上限に達した job は送らず failed にする（#59）。
	if (isRetryExhausted(job.attempts)) {
		await failOutbound(db, env, job.id, message.id, "送信試行回数の上限に達しました");
		return;
	}

	// キュー投入の後に差出人がアーカイブ・エイリアス化されても送信しない（精査 #67）。
	// assertCanSend と同じ判定を配信直前にも掛ける。
	const fromNorm = normalizeAddress(message.fromAddr);
	const sender = fromNorm
		? await db
				.select({ kind: addresses.kind, archivedAt: addresses.archivedAt })
				.from(addresses)
				.where(eq(addresses.address, fromNorm))
				.get()
		: null;
	if (sender?.archivedAt) {
		await failOutbound(db, env, job.id, message.id, "差出人アドレスがアーカイブされています");
		return;
	}
	if (sender?.kind === "alias") {
		await failOutbound(db, env, job.id, message.id, "差出人アドレスがエイリアス化されています");
		return;
	}

	let raw: string;
	try {
		const attachRows = await db
			.select()
			.from(attachments)
			.where(eq(attachments.messageId, message.id))
			.all();
		const attachList: ComposeAttachment[] = [];
		for (const a of attachRows) {
			const obj = await env.BUCKET.get(a.r2Key);
			// R2 から添付が消えていると空 0 バイトの添付を黙って送ってしまう（精査 #102）。
			// 見つからなければ throw して再試行させ、上限に達したら failed にする。
			if (!obj) throw new Error(`添付データが見つかりません: ${a.filename}`);
			const buf = new Uint8Array(await obj.arrayBuffer());
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

		raw = composeMime(
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
	} catch (err) {
		const attempts = job.attempts;
		const lastError = err instanceof Error ? err.message : String(err);
		console.error("送信に失敗", { jobId: job.id, attempts, lastError });

		if (isRetryExhausted(attempts)) {
			await failOutbound(db, env, job.id, message.id, lastError);
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
		return;
	}

	// ここから下は送信済み。失敗しても再送はしない（再送すると同じメールが再度届く）。
	// DB 更新や Webhook 配信の失敗は、送信自体の成否とは別に記録するだけにとどめる。
	try {
		await db.update(messages).set({ status: "sent" }).where(eq(messages.id, message.id));
		await db
			.update(outboundJobs)
			.set({ status: "sent", sentAt: new Date() })
			.where(eq(outboundJobs.id, job.id));
		await dispatchMessageEvent(env, "message.sent", message.id);
	} catch (err) {
		console.error("送信後の記録に失敗（メール自体は送信済み）", {
			jobId: job.id,
			messageId: message.id,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}
