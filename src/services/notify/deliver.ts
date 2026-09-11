import { eq } from "drizzle-orm";
import { schema } from "@/db/client";
import type { Db } from "@/db/client";
import { sendWebPush } from "@/services/webpush";
import type {
	PushSubscription,
	SendOptions,
	WebPushResponse,
} from "@/services/webpush";
import { createVapidTokenCache } from "./token-cache";

type PushUrgency = SendOptions["urgency"];

export type DeviceSendSpec = { id: string; endpoint: string; p256dh: string; auth: string };

export type DeliverOptions = {
	devices: DeviceSendSpec[];
	payloadText: string;
	buildShrunk?: () => string;
	urgency: PushUrgency;
	topic?: string;
	now: number;
};

async function markSuccess(db: Db, deviceId: string, now: number): Promise<void> {
	await db
		.update(schema.pushDevices)
		.set({ lastSuccessAt: new Date(now), failureCount: 0 })
		.where(eq(schema.pushDevices.id, deviceId));
}

/**
 * 端末ごとに送る。429 / 5xx / ネットワーク失敗は例外にしてキューの再試行に任せ、
 * gone は端末を消し、413 は本文を縮めて 1 回だけ再送する。
 */
export async function deliverToDevices(
	env: CloudflareEnv,
	db: Db,
	opts: DeliverOptions,
): Promise<void> {
	const privateKey = JSON.parse(env.VAPID_PRIVATE_KEY!) as JsonWebKey;
	const subject = env.VAPID_SUBJECT ?? "";
	const cache = await createVapidTokenCache(db);
	try {
		for (const dev of opts.devices) {
			const sub: PushSubscription = {
				endpoint: dev.endpoint,
				keys: { p256dh: dev.p256dh, auth: dev.auth },
			};
			const sendOpts: SendOptions = {
				vapid: privateKey,
				subject,
				ttl: 86400,
				urgency: opts.urgency,
				tokenCache: cache,
			};
			if (opts.topic !== undefined) sendOpts.topic = opts.topic;
			const res = await sendWebPush(sub, new TextEncoder().encode(opts.payloadText), sendOpts);
			await handleOutcome(res, sub, sendOpts, opts, dev, db);
		}
	} finally {
		await cache.flush();
	}
}

async function handleOutcome(
	res: WebPushResponse,
	sub: PushSubscription,
	sendOpts: SendOptions,
	opts: DeliverOptions,
	dev: DeviceSendSpec,
	db: Db,
): Promise<void> {
	switch (res.outcome) {
		case "ok":
			await markSuccess(db, dev.id, opts.now);
			return;
		case "gone":
			await db.delete(schema.pushDevices).where(eq(schema.pushDevices.id, dev.id));
			return;
		case "too_large":
			if (!opts.buildShrunk) return;
			const shrunk = opts.buildShrunk();
			const res2 = await sendWebPush(sub, new TextEncoder().encode(shrunk), sendOpts);
			if (res2.outcome === "ok") await markSuccess(db, dev.id, opts.now);
			else if (res2.outcome === "gone")
				await db.delete(schema.pushDevices).where(eq(schema.pushDevices.id, dev.id));
			else throw new Error("push service retry after shrink");
			return;
		case "retry":
		case "error":
			throw new Error("push service retry");
	}
}
