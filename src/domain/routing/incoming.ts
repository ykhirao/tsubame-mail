/**
 * setReject() / forward() はこのハンドラの中でしか呼べない。
 * 本文はパースせず、生 MIME を R2 に置いてキューに積み、すぐ返すこと。
 */
import { getDb } from "@/db/client";
import { newId } from "@/lib/id";
import { saveRaw } from "@/services/r2";
import type { InboundQueueMessage } from "@/services/queue";
import { resolveIncoming } from "./resolve";

const FORWARD_HEADER = "X-Tsubamail-Forwarded";

/** Email Routing 自体の上限と同じ。コンシューマはこれを超える生 MIME をパースしない。 */
export const MAX_RAW_BYTES = 25 * 1024 * 1024;

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
			// 値は「転送済みか」の検知にしか使わない。エンベロープ宛先を外部に漏らす理由が無い。
			headers.set(FORWARD_HEADER, "1");
			await message.forward(result.to, headers);
			return;
		}

		case "drop":
			return;

		case "deliver": {
			// rawSize が無い実行環境でも受け取りは止めず、上限の検査はコンシューマ側に任せる。
			if (typeof message.rawSize === "number" && message.rawSize > MAX_RAW_BYTES) {
				message.setReject("メールのサイズが上限（25MB）を超えています");
				return;
			}
			const messageId = newId("message");
			const rawKey = await saveRaw(env, messageId, message.raw, new Date(), message.rawSize);
			const payload: InboundQueueMessage = {
				kind: "inbound",
				addressId: result.addressId,
				rawKey,
				envelope: { from: message.from, to: message.to },
				receivedAt: Date.now(),
			};
			// waitUntil だと投入失敗がハンドラの外で起き、送信側 MTA には 250 が返って再送も来ない。
			// await にして失敗を例外にし、Email Routing に一時失敗として再送させる。
			await env.INBOUND_QUEUE.send(payload);
			return;
		}
	}
}
