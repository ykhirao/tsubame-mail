import { isInbound, isNotify, isOutboundSend, isWebhookRetry, type AnyQueueMessage } from "./queue";

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
				const { processNotify } = await import("@/services/notify");
				await processNotify(body, env, ctx);
			} else {
				console.error("未知のキューメッセージ", body);
			}
			item.ack();
		} catch (err) {
			console.error("キュー処理に失敗", err);
			item.retry({ delaySeconds: 10 });
		}
	}
}
