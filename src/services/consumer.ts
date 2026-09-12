import { isInbound, isNotify, isOutboundSend, isWebhookRetry, type AnyQueueMessage } from "./queue";

// 429/5xx で再試行に回すときの遅延（秒）。Webhook と同じく試行回数で指数に伸ばす。
// item.attempts は 1 始まり。末尾の値は残りの試行すべてに使い回す。
const NOTIFY_RETRY_DELAYS = [30, 300, 1800] as const;

export async function handleQueueBatch(
	batch: MessageBatch<AnyQueueMessage>,
	env: CloudflareEnv,
	ctx: ExecutionContext,
): Promise<void> {
	for (const item of batch.messages) {
		try {
			const body = item.body;
			if (isInbound(body)) {
				const { processInbound } = await import("@/domain/mail/inbound");
				await processInbound(body, env, ctx);
			} else if (isOutboundSend(body)) {
				const { processOutboundSend } = await import("@/domain/mail/outbound");
				await processOutboundSend(body, env, ctx);
			} else if (isWebhookRetry(body)) {
				const { processWebhookRetry } = await import("@/services/webhooks");
				await processWebhookRetry(body, env, ctx);
			} else if (isNotify(body)) {
				// attempts は通知の再配達で「諦めるのはどこまでか」を決めるのに渡す（#131）。
				const { processNotify, NOTIFY_MAX_RETRIES } = await import("@/services/notify");
				await processNotify(body, env, ctx, { attempts: item.attempts, maxRetries: NOTIFY_MAX_RETRIES });
			} else {
				console.error("未知のキューメッセージ", body);
			}
			item.ack();
		} catch (err) {
			console.error("キュー処理に失敗", err);
			const delay = isNotify(item.body)
				? NOTIFY_RETRY_DELAYS[Math.min(Math.max(item.attempts - 1, 0), NOTIFY_RETRY_DELAYS.length - 1)]
				: 10;
			item.retry({ delaySeconds: delay });
		}
	}
}
