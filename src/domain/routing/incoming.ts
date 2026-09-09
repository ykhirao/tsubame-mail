/**
 * setReject() / forward() はこのハンドラの中でしか呼べない。
 * 本文はパースせず、生 MIME を R2 に置いてキューに積み、すぐ返すこと。
 */
import { getDb } from "@/db/client";
import { newId } from "@/lib/id";
import { saveRaw } from "@/services/r2";
import type { InboundQueueMessage } from "@/services/queue";
import { resolveIncoming } from "./resolve";

const FORWARD_HEADER = "X-Tsubame-Forwarded";

export async function handleIncomingEmail(
	message: ForwardableEmailMessage,
	env: CloudflareEnv,
	ctx: ExecutionContext,
): Promise<void> {
	const db = getDb(env);

	const result = await resolveIncoming(db, { from: message.from, to: message.to });
	const forwarded = message.headers.get(FORWARD_HEADER);

	switch (result.action) {
		case "reject":
			message.setReject(result.reason);
			return;

		case "forward": {
			// 自分が転送したメールが戻ってきている。再転送すると無限に回る。
			if (forwarded) {
				message.setReject("転送ループを検知したため受信を拒否しました");
				return;
			}
			const headers = new Headers(message.headers);
			headers.set(FORWARD_HEADER, message.to);
			await message.forward(result.to, headers);
			return;
		}

		case "drop":
			return;

		case "deliver": {
			const messageId = newId("message");
			const rawKey = await saveRaw(env, messageId, message.raw, new Date(), message.rawSize);
			const payload: InboundQueueMessage = {
				kind: "inbound",
				addressId: result.addressId,
				rawKey,
				envelope: { from: message.from, to: message.to },
				receivedAt: Date.now(),
			};
			ctx.waitUntil(env.INBOUND_QUEUE.send(payload));
			return;
		}
	}
}
