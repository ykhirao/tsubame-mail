/**
 * Worker の唯一の入口。
 *
 * ここには分岐しか書かない。処理は src/domain と src/services にある関数に委譲する。
 * email ハンドラだけは message.setReject() / message.forward() を呼べる唯一の場所なので、
 * 「拒否・転送の判定」はここで完結させること（キューからは呼べない）。
 */
import { createApp } from "@/api/app";
import type { AnyQueueMessage } from "@/services/queue";

const app = createApp();

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		if (url.pathname.startsWith("/api/")) {
			return app.fetch(request, env, ctx);
		}
		return env.ASSETS.fetch(request);
	},

	async email(message, env, ctx) {
		const { handleIncomingEmail } = await import("@/domain/routing/incoming");
		await handleIncomingEmail(message, env, ctx);
	},

	async queue(batch, env, ctx) {
		const { handleQueueBatch } = await import("@/services/consumer");
		await handleQueueBatch(batch as MessageBatch<AnyQueueMessage>, env, ctx);
	},
} satisfies ExportedHandler<CloudflareEnv, AnyQueueMessage>;
