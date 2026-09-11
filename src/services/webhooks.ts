import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { messages, webhooks, webhookDeliveries } from "@/db/schema";
import { newId } from "@/lib/id";
import { parseAddressList } from "@/domain/mail/address";
import { webhookUrlProblem } from "@/shared/contracts/webhooks";
import type { WebhookRetryMessage } from "./queue";

export type MessageEvent = "message.received" | "message.sent" | "message.failed";

const MAX_ATTEMPTS = 5;
/** 打ち切るまでの遅延（秒）。末尾の値は残りの試行すべてに使い回す。 */
const RETRY_DELAYS = [30, 300, 1800] as const;
const TIMEOUT_MS = 10_000;

type WebhookMessagePayload = {
	id: string;
	threadId: string | null;
	addressId: string;
	direction: string;
	status: string;
	from: { address: string; name: string | null };
	to: string[];
	cc: string[];
	subject: string | null;
	snippet: string | null;
	hasAttachments: boolean;
	rfcMessageId: string | null;
	receivedAt: number | null;
};

function toUnixSeconds(date: Date | null | undefined): number | null {
	return date ? Math.floor(date.getTime() / 1000) : null;
}

function serializeMessage(m: typeof messages.$inferSelect): WebhookMessagePayload {
	return {
		id: m.id,
		threadId: m.threadId,
		addressId: m.addressId,
		direction: m.direction,
		status: m.status,
		from: { address: m.fromAddr, name: m.fromName },
		to: parseAddressList(m.toAddr).map((a) => a.address),
		cc: parseAddressList(m.ccAddr).map((a) => a.address),
		subject: m.subject,
		snippet: m.snippet,
		hasAttachments: m.hasAttachments,
		rfcMessageId: m.rfcMessageId,
		receivedAt: toUnixSeconds(m.receivedAt),
	};
}

export async function hmacHex(secret: string, data: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
	return [...new Uint8Array(sig)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/** 値は `t=<unix秒>,v1=<hex>`。署名対象は body そのものではなく `<t>.<body>`。 */
export async function buildSignatureHeader(
	secret: string,
	t: number,
	body: string,
): Promise<string> {
	const v1 = await hmacHex(secret, `${t}.${body}`);
	return `t=${t},v1=${v1}`;
}

export async function dispatchMessageEvent(
	env: CloudflareEnv,
	event: MessageEvent,
	messageId: string,
	opts?: { webhookCreatedBefore?: Date },
): Promise<void> {
	const db = getDb(env);
	const message = await db.select().from(messages).where(eq(messages.id, messageId)).get();
	if (!message) return;

	const enabled = await db
		.select()
		.from(webhooks)
		.where(eq(webhooks.enabled, true))
		.all();

	const targets = enabled.filter((w) => {
		if (opts?.webhookCreatedBefore !== undefined && w.createdAt.getTime() > opts.webhookCreatedBefore.getTime()) {
			return false;
		}
		if (!w.events.includes(event)) return false;
		// addressIds が null なら全アドレスが対象。
		if (w.addressIds === null) return true;
		return w.addressIds.includes(message.addressId);
	});

	await Promise.all(
		targets.map(async (w) => {
			// at-least-once の再配達で同じ Webhook・同じメッセージ・同じイベントの配信行が
			// 既にあれば作らない。二重配信を防ぐ（精査 #77）。
			const already = await db
				.select({ id: webhookDeliveries.id })
				.from(webhookDeliveries)
				.where(
					and(
						eq(webhookDeliveries.webhookId, w.id),
						eq(webhookDeliveries.event, event),
						eq(webhookDeliveries.messageId, messageId),
					),
				)
				.get();
			if (already) return;
			try {
				const deliveryId = newId("delivery");
				await db.insert(webhookDeliveries).values({
					id: deliveryId,
					webhookId: w.id,
					event,
					messageId,
					status: "pending",
					// attempt=0 で立てる。runDelivery は attempt >= delivery.attempt を「POST 済み」の
					// claim に使うので、初回 attempt 1 が誤って claim されないようにする（#86）。
					attempt: 0,
				});
				await runDelivery(env, deliveryId, 1);
			} catch (err) {
				console.error("webhook 配信に失敗", w.id, err);
			}
		}),
	);
}

/** @param attempt 今回使う試行番号（1 始まり）。 */
export async function runDelivery(
	env: CloudflareEnv,
	deliveryId: string,
	attempt: number,
): Promise<void> {
	const db = getDb(env);
	const delivery = await db
		.select()
		.from(webhookDeliveries)
		.where(eq(webhookDeliveries.id, deliveryId))
		.get();
	if (!delivery) return;

	const webhook = await db
		.select()
		.from(webhooks)
		.where(eq(webhooks.id, delivery.webhookId))
		.get();
	if (!webhook || !webhook.enabled) return;

	const message = delivery.messageId
		? await db.select().from(messages).where(eq(messages.id, delivery.messageId)).get()
		: undefined;
	const messagePayload = message ? serializeMessage(message) : null;

	const deliveredAt = Math.floor(Date.now() / 1000);
	const body = JSON.stringify({
		event: delivery.event,
		message: messagePayload,
		delivered_at: deliveredAt,
	});
	const signature = await buildSignatureHeader(webhook.secret, deliveredAt, body);

	// 検査を入れる前に登録された URL もあるので、登録時だけでなく送る直前にも見る。
	const urlProblem = webhookUrlProblem(webhook.url);

	// delivery.attempt が既に今回の attempt 以上 = この試行は POST 済み。
	// OUTBOUND_QUEUE.send の失敗でキューが同じ {deliveryId, attempt} を再配達しても
	// 受け手に再 POST せず、次試行の投入だけをやり直す（#86）。
	if (delivery.attempt >= attempt) {
		if (delivery.status === "success") return;
		if (delivery.status === "pending") {
			const nextAttempt = delivery.attempt + 1;
			if (urlProblem !== null || nextAttempt > MAX_ATTEMPTS) {
				await db
					.update(webhookDeliveries)
					.set({ status: "failed", nextRetryAt: null })
					.where(eq(webhookDeliveries.id, deliveryId));
				return;
			}
			const delaySec = RETRY_DELAYS[Math.min(delivery.attempt - 1, RETRY_DELAYS.length - 1)] ?? 1800;
			await env.OUTBOUND_QUEUE.send(
				{
					kind: "webhook.retry",
					deliveryId,
					webhookId: webhook.id,
					attempt: nextAttempt,
				},
				{ delaySeconds: delaySec },
			);
			return;
		}
		// failed: キューが最終試行を重複配達しても受け手へ再 POST しない。手動再送は
		// pending の delivery に attempt+1 を渡すので、この claim をまたいで POST に進むことはない（#118）。
		return;
	}

	const started = Date.now();
	let httpStatus: number | null = null;
	let error: string | null = urlProblem;
	if (urlProblem === null) {
		try {
			// 公開 URL から内部アドレスへ 302 で飛ばされるのを防ぐため、リダイレクトは追わない。
			const res = await fetch(webhook.url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Tsubame-Signature": signature,
				},
				body,
				redirect: "manual",
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
			httpStatus = res.status;
			if (res.status >= 300 && res.status < 400) {
				error = `HTTP ${res.status}（リダイレクトは追いません）`;
			} else if (res.status < 200 || res.status >= 300) {
				error = `HTTP ${res.status}`;
			}
		} catch (err) {
			error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
		}
	}
	const durationMs = Date.now() - started;

	if (error === null) {
		await db
			.update(webhookDeliveries)
			.set({
				status: "success",
				httpStatus,
				error: null,
				durationMs,
				attempt,
				nextRetryAt: null,
			})
			.where(eq(webhookDeliveries.id, deliveryId));
		return;
	}

	const giveUp = attempt >= MAX_ATTEMPTS || urlProblem !== null;
	const delaySec = RETRY_DELAYS[Math.min(attempt - 1, RETRY_DELAYS.length - 1)] ?? 1800;
	await db
		.update(webhookDeliveries)
		.set({
			status: giveUp ? "failed" : "pending",
			httpStatus,
			error,
			durationMs,
			attempt,
			nextRetryAt: giveUp ? null : new Date(Date.now() + delaySec * 1000),
		})
		.where(eq(webhookDeliveries.id, deliveryId));

	if (!giveUp) {
		await env.OUTBOUND_QUEUE.send(
			{
				kind: "webhook.retry",
				deliveryId,
				webhookId: webhook.id,
				attempt: attempt + 1,
			},
			{ delaySeconds: delaySec },
		);
	}
}

export async function processWebhookRetry(
	msg: WebhookRetryMessage,
	env: CloudflareEnv,
	_ctx: ExecutionContext,
): Promise<void> {
	await runDelivery(env, msg.deliveryId, msg.attempt);
}
