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

export type DeliverResult = {
	delivered: number;
	/** 一時的失敗（429/5xx/タイムアウト）で再試行に回す端末。成功・恒久失敗・gone は含まない（#131）。 */
	retryDeviceIds: string[];
};

// 恒久的な失敗を続けた端末は無効化する。これが無いと失敗端末 1 台が
// バッチ全体をキュー再試行と DLQ で握る。無効化した端末は filterDevices が除くので
// 再試行では失敗した端末だけに届く。
const PERMANENT_FAILURE_THRESHOLD = 3;

async function markSuccess(db: Db, deviceId: string, now: number): Promise<void> {
	await db
		.update(schema.pushDevices)
		.set({ lastSuccessAt: new Date(now), failureCount: 0 })
		.where(eq(schema.pushDevices.id, deviceId));
}

async function markPermanentFailure(db: Db, deviceId: string): Promise<void> {
	const row = await db
		.select({ failureCount: schema.pushDevices.failureCount, enabled: schema.pushDevices.enabled })
		.from(schema.pushDevices)
		.where(eq(schema.pushDevices.id, deviceId))
		.get();
	const failureCount = (row?.failureCount ?? 0) + 1;
	const enabled = failureCount >= PERMANENT_FAILURE_THRESHOLD ? false : (row?.enabled ?? true);
	await db
		.update(schema.pushDevices)
		.set({ failureCount, enabled })
		.where(eq(schema.pushDevices.id, deviceId));
}

type DeviceResult = "delivered" | "resolved" | "retryable";

async function handleOutcome(
	res: WebPushResponse,
	sub: PushSubscription,
	sendOpts: SendOptions,
	opts: DeliverOptions,
	dev: DeviceSendSpec,
	db: Db,
): Promise<DeviceResult> {
	switch (res.outcome) {
		case "ok":
			await markSuccess(db, dev.id, opts.now);
			return "delivered";
		case "gone":
			await db.delete(schema.pushDevices).where(eq(schema.pushDevices.id, dev.id));
			return "resolved";
		case "too_large":
			if (!opts.buildShrunk) return "resolved";
			const shrunk = opts.buildShrunk();
			const res2 = await sendWebPush(sub, new TextEncoder().encode(shrunk), sendOpts);
			if (res2.outcome === "ok") {
				await markSuccess(db, dev.id, opts.now);
				return "delivered";
			}
			if (res2.outcome === "gone") {
				await db.delete(schema.pushDevices).where(eq(schema.pushDevices.id, dev.id));
				return "resolved";
			}
			// 縮めた再送も失敗したら、その結果（一過性か恒久か）で扱う。
			return await finishFailure(res2, db, dev);
		case "retry":
			return "retryable";
		case "error":
			return await finishFailure(res, db, dev);
	}
}

async function finishFailure(res: WebPushResponse, db: Db, dev: DeviceSendSpec): Promise<DeviceResult> {
	if (res.outcome === "retry") return "retryable";
	await markPermanentFailure(db, dev.id);
	return "resolved";
}

/**
 * 端末ごとに続行し、1 台の失敗で他へ届くのを止めない。
 * 一時的失敗（429/5xx/タイムアウト）の端末は retryDeviceIds に返し、呼び出し側が
 * notification_log に記録してキューへ再試行を投げる。成功端末に二度送らないため
 * ここでは throw せず結果を返す（#131）。
 */
export async function deliverToDevices(
	env: CloudflareEnv,
	db: Db,
	opts: DeliverOptions,
): Promise<DeliverResult> {
	const privateKey = JSON.parse(env.VAPID_PRIVATE_KEY!) as JsonWebKey;
	const subject = env.VAPID_SUBJECT ?? "";
	const cache = await createVapidTokenCache(db);
	try {
		let delivered = 0;
		const retryDeviceIds: string[] = [];
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
			const result = await handleOutcome(res, sub, sendOpts, opts, dev, db);
			if (result === "delivered") delivered += 1;
			else if (result === "retryable") retryDeviceIds.push(dev.id);
		}
		return { delivered, retryDeviceIds };
	} finally {
		await cache.flush();
	}
}
