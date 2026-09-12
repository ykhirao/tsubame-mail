import { and, asc, eq, lt, lte, sql } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import type { Db } from "@/db/client";
import { jsonIdsIn } from "@/domain/access/policy";
import { newId } from "@/lib/id";
import { decide, decideSendFailure, filterDevices } from "@/domain/notify/decide";
import type { Decision, NotificationPrefs } from "@/domain/notify/decide";
import { nextQuietEnd } from "@/domain/notify/schedule";
import type { NotifyMessage } from "./queue";
import {
	countThreadMessagesSince,
	eligibleUserIds,
	loadDevices,
	loadMessageAddressIds,
	loadMessageContext,
	loadLastNotifiedAt,
	loadThreadPref,
	loadUserForDecide,
	writeUserIds,
	type MessageContext,
	type LoadedUser,
} from "./notify/load";
import { countUnread } from "./notify/prefs";
import { buildCoalesced, buildDigest, buildFailure, buildReceived, buildTest } from "./notify/render";
import { deliverToDevices, type DeliverResult, type DeviceSendSpec } from "./notify/deliver";

type Kind = "received" | "send_failed";
type LogDecision = "sent" | "held" | "digest" | "dropped";
export type NotificationLogRow = typeof schema.notificationLog.$inferSelect;

// OUTBOUND_QUEUE の max_retries（wrangler.jsonc）に合わせ、通知の再配達で諦める判定に使う。
// これが無いと一時失敗端末を記録し続けたまま再試行が尽きて DLQ に落ちる。
export const NOTIFY_MAX_RETRIES = 3;
export type NotifyRetry = { attempts: number; maxRetries: number };
const DEFAULT_RETRY: NotifyRetry = { attempts: 1, maxRetries: NOTIFY_MAX_RETRIES };

function retryAllowed(retry: NotifyRetry): boolean {
	// item.attempts は 1 始まり。max_retries を超えた回の retry() は DLQ へ落ちるので、
	// 超える前に再試行を止めて諦める（#131）。
	return retry.attempts <= retry.maxRetries;
}

// deliverToDevices / redeliverPending から throw される再試行の合図。consumer.ts が item.retry() に変換する。
const REQUEUE_REASON = "push service retry";

export async function processNotify(
	msg: NotifyMessage,
	env: CloudflareEnv,
	ctx: ExecutionContext,
	retry: NotifyRetry = DEFAULT_RETRY,
): Promise<void> {
	void ctx;
	if (msg.event === "test") {
		await processTest(msg, env);
		return;
	}
	if (msg.userId) {
		if (msg.event === "received") {
			await processReceivedForUser(msg.messageId, msg.userId, env, msg.ruleRead === true, retry);
		}
		else await processSendFailedForUser(msg.messageId, msg.userId, env, retry);
		return;
	}
	if (msg.event === "received") await splitReceived(msg.messageId, env, msg.ruleRead === true);
	else await splitSendFailed(msg.messageId, env);
}

async function splitReceived(messageId: string, env: CloudflareEnv, ruleRead: boolean): Promise<void> {
	const db = getDb(env);
	const ctx = await loadMessageContext(db, messageId);
	if (!ctx) return;
	const userIds = await eligibleUserIds(db, ctx.mailbox.id);
	if (userIds.length === 0) return;
	// Free の 1 実行あたり外部リクエスト上限（50）に収めるため、利用者ごとに 1 メッセージへ分ける。
	await env.OUTBOUND_QUEUE.sendBatch(
		userIds.map((userId) => ({
			body: { kind: "notify", event: "received", messageId, userId, ruleRead },
		})),
	);
}

async function splitSendFailed(messageId: string, env: CloudflareEnv): Promise<void> {
	const db = getDb(env);
	const ctx = await loadMessageContext(db, messageId);
	if (!ctx) return;
	const userIds = ctx.sentByUserId ? [ctx.sentByUserId] : await writeUserIds(db, ctx.mailbox.id);
	if (userIds.length === 0) return;
	await env.OUTBOUND_QUEUE.sendBatch(
		userIds.map((userId) => ({
			body: { kind: "notify", event: "send_failed", messageId, userId },
		})),
	);
}

async function findLog(db: Db, userId: string, messageId: string, kind: Kind): Promise<NotificationLogRow | undefined> {
	return db
		.select()
		.from(schema.notificationLog)
		.where(
			and(
				eq(schema.notificationLog.userId, userId),
				eq(schema.notificationLog.messageId, messageId),
				eq(schema.notificationLog.kind, kind),
			),
		)
		.get();
}

// 画面は表示中 60 秒ごとに使用中の合図を送る。1 回取りこぼしても外れないよう少し広く取る。
const ACTIVE_WINDOW_MS = 90_000;

async function processReceivedForUser(
	messageId: string,
	userId: string,
	env: CloudflareEnv,
	ruleRead: boolean,
	retry: NotifyRetry,
): Promise<void> {
	const db = getDb(env);
	const existing = await findLog(db, userId, messageId, "received");
	if (existing) {
		// ログが空で残っていれば完成済み。再配達でも重複しない。
		if (!existing.retryDeviceIds || existing.retryDeviceIds.length === 0) return;
		await redeliverPending(env, db, userId, existing, retry);
		return;
	}
	const ctx = await loadMessageContext(db, messageId);
	if (!ctx) return;
	const loaded = await loadUserForDecide(db, userId, ctx.mailbox.id);
	if (!loaded) return;
	const now = Date.now();
	const threadPref = ctx.thread.id ? await loadThreadPref(db, userId, ctx.thread.id) : null;
	const lastNotifiedAt = ctx.thread.id ? await loadLastNotifiedAt(db, userId, ctx.thread.id) : null;
	const decision = decide({
		message: { ...ctx.message, markedRead: ruleRead },
		thread: {
			...ctx.thread,
			followed: threadPref === "follow",
			muted: threadPref === "mute",
			lastNotifiedAt,
		},
		mailbox: ctx.mailbox,
		user: loaded.user,
		prefs: loaded.prefs,
		now,
	});
	const coalesced = decision.reason === "coalesced" && lastNotifiedAt !== null;
	await applyDecision(env, db, messageId, userId, "received", ctx, loaded, decision, now, retry, async () => {
		const devices = await loadDevices(db, userId);
		const results = filterDevices({
			devices: devices.map((d) => ({ id: d.id, enabled: d.enabled, addressIds: d.addressIds })),
			addressId: ctx.mailbox.id,
			prefs: loaded.prefs,
			activeElsewhere: devices.some(
				(d) => d.lastSeenAt !== null && now - d.lastSeenAt.getTime() <= ACTIVE_WINDOW_MS,
			),
			now,
		});
		const toSend = results.filter((r) => r.action === "send").map((r) => r.deviceId);
		if (toSend.length === 0) return { delivered: 0, retryDeviceIds: [] };
		const specs = devices.filter((d) => toSend.includes(d.id)).map(toSendSpec);
		const appBadge =
			loaded.prefs.badge === "off"
				? undefined
				: await countUnread(db, userId, loaded.user.role, loaded.prefs);
		// 短時間に続いた分は通常の通知を 1 通の「新着 N 件」に置き換える（PN-4-14）。
		if (coalesced) {
			const count = await countThreadMessagesSince(db, ctx.thread.id, lastNotifiedAt!);
			const payload = buildCoalesced(ctx.thread.id, count, { appBadge });
			return maybeDeliver(env, db, specs, payload, decision.urgency ?? "normal", ctx.thread.id.slice(0, 32), () =>
				buildCoalesced(ctx.thread.id, count),
			);
		}
		const payload = buildReceived(ctx, ctx.thread.id, loaded.prefs, {
			appBadge,
			silent: decision.silent ?? false,
		});
		return maybeDeliver(env, db, specs, payload, decision.urgency ?? "normal", ctx.thread.id.slice(0, 32), () =>
			buildReceived(ctx, ctx.thread.id, loaded.prefs, {
				appBadge,
				silent: decision.silent ?? false,
				shrink: true,
			}),
		);
	});
}

async function processSendFailedForUser(
	messageId: string,
	userId: string,
	env: CloudflareEnv,
	retry: NotifyRetry,
): Promise<void> {
	const db = getDb(env);
	const existing = await findLog(db, userId, messageId, "send_failed");
	if (existing) {
		if (!existing.retryDeviceIds || existing.retryDeviceIds.length === 0) return;
		await redeliverPending(env, db, userId, existing, retry);
		return;
	}
	const ctx = await loadMessageContext(db, messageId);
	if (!ctx) return;
	const loaded = await loadUserForDecide(db, userId, ctx.mailbox.id);
	if (!loaded) return;
	const now = Date.now();
	const decision = decideSendFailure({ user: loaded.user, prefs: loaded.prefs, now });
	await applyDecision(env, db, messageId, userId, "send_failed", ctx, loaded, decision, now, retry, async () => {
		const devices = (await loadDevices(db, userId)).filter((d) => d.enabled);
		if (devices.length === 0) return { delivered: 0, retryDeviceIds: [] };
		const payload = buildFailure(ctx, ctx.thread.id);
		return maybeDeliver(env, db, devices.map(toSendSpec), payload, "normal", ctx.thread.id.slice(0, 32), () =>
			buildFailure(ctx, ctx.thread.id, true),
		);
	});
}

async function applyDecision(
	env: CloudflareEnv,
	db: Db,
	messageId: string,
	userId: string,
	kind: Kind,
	ctx: MessageContext,
	loaded: LoadedUser,
	decision: Decision,
	now: number,
	retry: NotifyRetry,
	onSent: () => Promise<DeliverResult>,
): Promise<void> {
	const reason = decision.reason;
	switch (decision.decision) {
		case "excluded":
			return;
		case "sent": {
			const result = await onSent();
			await recordLog(db, {
				userId,
				messageId,
				kind,
				decision: "sent",
				reason,
				holdGroup: null,
				deviceCount: result.delivered,
				retryDeviceIds: result.retryDeviceIds,
			});
			// 一時失敗が残り、再試行が許される間だけ throw でキューに戻す。
			// retryDeviceIds は先に書いたので、再配達で失敗分だけ送り直せる。
			if (result.retryDeviceIds.length > 0 && retryAllowed(retry)) throw new Error(REQUEUE_REASON);
			return;
		}
		case "held": {
			await recordLog(db, {
				userId,
				messageId,
				kind,
				decision: "held",
				reason,
				holdGroup: holdGroupFor(reason, loaded.prefs, now),
				deviceCount: 0,
			});
			return;
		}
		case "digest": {
			const due = nextQuietEnd(loaded.prefs.quiet!, now);
			await upsertDigest(db, userId, due, messageId);
			await recordLog(db, {
				userId,
				messageId,
				kind,
				decision: "digest",
				reason,
				holdGroup: String(due),
				deviceCount: 0,
			});
			return;
		}
		case "dropped": {
			await recordLog(db, { userId, messageId, kind, decision: "dropped", reason, holdGroup: null, deviceCount: 0 });
			return;
		}
	}
}

// 一時失敗を残した通知の再配達。ログが持つ端末 id だけに送り、成功は外す（#131）。
// 再試行の上限を超えたら（＝これ以上 item.retry() が効かない）諦めて配列を空にする。
async function redeliverPending(
	env: CloudflareEnv,
	db: Db,
	userId: string,
	existing: NotificationLogRow,
	retry: NotifyRetry,
): Promise<void> {
	const pending = existing.retryDeviceIds ?? [];
	const live = await loadDevices(db, userId);
	const targets = live.filter((d) => pending.includes(d.id)).map(toSendSpec);
	if (!existing.messageId || targets.length === 0) {
		await clearRetries(db, existing.id);
		return;
	}
	const ctx = await loadMessageContext(db, existing.messageId);
	const loaded = ctx ? await loadUserForDecide(db, userId, ctx.mailbox.id) : null;
	if (!ctx || !loaded) {
		await clearRetries(db, existing.id);
		return;
	}
	const shrunk =
		existing.kind === "send_failed"
			? buildFailure(ctx, ctx.thread.id, true)
			: buildReceived(ctx, ctx.thread.id, loaded.prefs, { shrink: true });
	const payload =
		existing.kind === "send_failed"
			? buildFailure(ctx, ctx.thread.id)
			: buildReceived(ctx, ctx.thread.id, loaded.prefs, {});
	const result = await maybeDeliver(env, db, targets, payload, "normal", ctx.thread.id.slice(0, 32), () => shrunk);
	const stillFailing = result.retryDeviceIds;
	const canRetry = retryAllowed(retry);
	await updateRetries(db, existing.id, {
		deviceCount: existing.deviceCount + result.delivered,
		// 失敗が残り再試行できる間だけ保持し、そうでなければ諦めて空にする。
		retryDeviceIds: stillFailing.length > 0 && canRetry ? stillFailing : [],
	});
	if (stillFailing.length > 0 && canRetry) throw new Error(REQUEUE_REASON);
}

async function clearRetries(db: Db, logId: string): Promise<void> {
	await db.update(schema.notificationLog).set({ retryDeviceIds: [] }).where(eq(schema.notificationLog.id, logId));
}

async function updateRetries(
	db: Db,
	logId: string,
	opts: { deviceCount: number; retryDeviceIds: string[] },
): Promise<void> {
	await db
		.update(schema.notificationLog)
		.set({ deviceCount: opts.deviceCount, retryDeviceIds: opts.retryDeviceIds })
		.where(eq(schema.notificationLog.id, logId));
}

function holdGroupFor(reason: string, prefs: NotificationPrefs, now: number): string | null {
	if (reason === "paused") return prefs.pausedUntil ? String(prefs.pausedUntil) : null;
	if (reason === "quiet_drop" || reason === "quiet_digest") {
		return prefs.quiet ? String(nextQuietEnd(prefs.quiet, now)) : null;
	}
	return null;
}

async function maybeDeliver(
	env: CloudflareEnv,
	db: Db,
	devices: DeviceSendSpec[],
	payloadText: string,
	urgency: "very-low" | "low" | "normal" | "high",
	topic: string | undefined,
	buildShrunk: () => string,
): Promise<DeliverResult> {
	if (!env.VAPID_PRIVATE_KEY || devices.length === 0) return { delivered: 0, retryDeviceIds: [] };
	return deliverToDevices(env, db, {
		devices,
		payloadText,
		buildShrunk,
		urgency,
		topic,
		now: Date.now(),
	});
}

function toSendSpec(d: { id: string; endpoint: string; p256dh: string; auth: string }): DeviceSendSpec {
	return { id: d.id, endpoint: d.endpoint, p256dh: d.p256dh, auth: d.auth };
}

async function recordLog(
	db: Db,
	opts: {
		userId: string;
		messageId: string;
		kind: Kind;
		decision: LogDecision;
		reason: string;
		holdGroup: string | null;
		deviceCount: number;
		retryDeviceIds?: string[];
	},
): Promise<void> {
	await db.insert(schema.notificationLog).values({
		id: newId("notification"),
		userId: opts.userId,
		messageId: opts.messageId,
		kind: opts.kind,
		decision: opts.decision,
		reason: opts.reason,
		holdGroup: opts.holdGroup,
		deviceCount: opts.deviceCount,
		retryDeviceIds: opts.retryDeviceIds ?? [],
	});
}

async function upsertDigest(db: Db, userId: string, dueAt: number, messageId: string): Promise<void> {
	const row = await db
		.select()
		.from(schema.notificationDigests)
		.where(
			and(
				eq(schema.notificationDigests.userId, userId),
				eq(schema.notificationDigests.dueAt, new Date(dueAt)),
			),
		)
		.get();
	if (row) {
		const ids = row.messageIds.includes(messageId) ? row.messageIds : [...row.messageIds, messageId];
		await db
			.update(schema.notificationDigests)
			.set({ messageIds: ids })
			.where(eq(schema.notificationDigests.id, row.id));
	} else {
		await db.insert(schema.notificationDigests).values({
			id: newId("digest"),
			userId,
			dueAt: new Date(dueAt),
			messageIds: [messageId],
		});
	}
}

async function processTest(
	msg: Extract<NotifyMessage, { event: "test" }>,
	env: CloudflareEnv,
): Promise<void> {
	const db = getDb(env);
	const device = await db.select().from(schema.pushDevices).where(eq(schema.pushDevices.id, msg.deviceId)).get();
	if (!device || !env.VAPID_PRIVATE_KEY) return;
	await deliverToDevices(env, db, {
		devices: [toSendSpec(device)],
		payloadText: buildTest(),
		urgency: "normal",
		now: Date.now(),
	});
}

export async function handleScheduled(
	controller: ScheduledController,
	env: CloudflareEnv,
	ctx: ExecutionContext,
): Promise<void> {
	void ctx;
	const db = getDb(env);
	const now = Date.now();

	const due = await db
		.select()
		.from(schema.notificationDigests)
		.where(lte(schema.notificationDigests.dueAt, new Date(now)))
		.orderBy(asc(schema.notificationDigests.userId))
		.all();
	const groups = new Map<string, string[]>();
	for (const row of due) {
		const ids = groups.get(row.userId) ?? [];
		groups.set(row.userId, [...ids, ...row.messageIds]);
	}
	const failed = new Set<string>();
	for (const [userId, messageIds] of groups) {
		const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
		const devices = (user ? await loadDevices(db, userId) : []).filter((d) => d.enabled);
		if (user && devices.length > 0 && env.VAPID_PRIVATE_KEY) {
			// digest も端末ごとの受け取るメールボックスで間引く（PN-5-8）。
			const mailboxIds = await loadMessageAddressIds(db, messageIds);
			const toSend = devices.filter(
				(d) => d.addressIds === null || d.addressIds.some((a) => mailboxIds.includes(a)),
			);
			if (toSend.length > 0) {
				const result = await deliverToDevices(env, db, {
					devices: toSend.map(toSendSpec),
					payloadText: buildDigest(messageIds.length),
					urgency: "normal",
					now,
				});
				// 全台一過性の失敗なら届かなかった digest は消さず次回の定期実行に残す。
				if (result.delivered === 0 && result.retryDeviceIds.length > 0) failed.add(userId);
			}
		}
	}
	const digestIds = due.filter((r) => !failed.has(r.userId)).map((r) => r.id);
	if (digestIds.length > 0) {
		await db.delete(schema.notificationDigests).where(jsonIdsIn(schema.notificationDigests.id, digestIds));
	}

	const DAY = 86400000;
	await db.delete(schema.notificationLog).where(lt(schema.notificationLog.createdAt, new Date(now - 30 * DAY)));
	// raw SQL はプレースホルダへ Date を渡せない。timestamp 列は unix 秒で持たれている。
	await db
		.delete(schema.pushDevices)
		.where(
			sql`coalesce(${schema.pushDevices.lastSeenAt}, ${schema.pushDevices.createdAt}) < ${Math.floor(
				now / 1000,
			) - 90 * 86400}`,
		);
}
