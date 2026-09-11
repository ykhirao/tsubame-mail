import { and, asc, eq, inArray, lt, lte, sql } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import type { Db } from "@/db/client";
import { newId } from "@/lib/id";
import { decide, decideSendFailure, filterDevices } from "@/domain/notify/decide";
import type { Decision, NotificationPrefs } from "@/domain/notify/decide";
import { nextQuietEnd } from "@/domain/notify/schedule";
import type { NotifyMessage } from "./queue";
import {
	eligibleUserIds,
	loadDevices,
	loadMessageContext,
	loadLastNotifiedAt,
	loadThreadPref,
	loadUserForDecide,
	writeUserIds,
	type MessageContext,
	type LoadedUser,
} from "./notify/load";
import { countUnread } from "./notify/prefs";
import { buildDigest, buildFailure, buildReceived, buildTest } from "./notify/render";
import { deliverToDevices, type DeviceSendSpec } from "./notify/deliver";

type Kind = "received" | "send_failed";
type LogDecision = "sent" | "held" | "digest" | "dropped";

export async function processNotify(
	msg: NotifyMessage,
	env: CloudflareEnv,
	ctx: ExecutionContext,
): Promise<void> {
	void ctx;
	if (msg.event === "test") {
		await processTest(msg, env);
		return;
	}
	if (msg.userId) {
		if (msg.event === "received") await processReceivedForUser(msg.messageId, msg.userId, env);
		else await processSendFailedForUser(msg.messageId, msg.userId, env);
		return;
	}
	if (msg.event === "received") await splitReceived(msg.messageId, env);
	else await splitSendFailed(msg.messageId, env);
}

async function splitReceived(messageId: string, env: CloudflareEnv): Promise<void> {
	const db = getDb(env);
	const ctx = await loadMessageContext(db, messageId);
	if (!ctx) return;
	const userIds = await eligibleUserIds(db, ctx.mailbox.id);
	if (userIds.length === 0) return;
	// Free の 1 実行あたり外部リクエスト上限（50）に収めるため、利用者ごとに 1 メッセージへ分ける。
	await env.OUTBOUND_QUEUE.sendBatch(
		userIds.map((userId) => ({
			body: { kind: "notify", event: "received", messageId, userId },
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

async function hasLog(db: Db, userId: string, messageId: string, kind: Kind): Promise<boolean> {
	const row = await db
		.select({ id: schema.notificationLog.id })
		.from(schema.notificationLog)
		.where(
			and(
				eq(schema.notificationLog.userId, userId),
				eq(schema.notificationLog.messageId, messageId),
				eq(schema.notificationLog.kind, kind),
			),
		)
		.get();
	return !!row;
}

// 画面は表示中 60 秒ごとに使用中の合図を送る。1 回取りこぼしても外れないよう少し広く取る。
const ACTIVE_WINDOW_MS = 90_000;

async function processReceivedForUser(
	messageId: string,
	userId: string,
	env: CloudflareEnv,
): Promise<void> {
	const db = getDb(env);
	if (await hasLog(db, userId, messageId, "received")) return;
	const ctx = await loadMessageContext(db, messageId);
	if (!ctx) return;
	const loaded = await loadUserForDecide(db, userId, ctx.mailbox.id);
	if (!loaded) return;
	const now = Date.now();
	const threadPref = ctx.thread.id ? await loadThreadPref(db, userId, ctx.thread.id) : null;
	const lastNotifiedAt = ctx.thread.id ? await loadLastNotifiedAt(db, userId, ctx.thread.id) : null;
	const decision = decide({
		message: ctx.message,
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
	await applyDecision(env, db, messageId, userId, "received", ctx, loaded, decision, now, async () => {
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
		if (toSend.length === 0) return 0;
		const specs = devices.filter((d) => toSend.includes(d.id)).map(toSendSpec);
		const appBadge =
			loaded.prefs.badge === "off"
				? undefined
				: await countUnread(db, userId, loaded.user.role, loaded.prefs);
		const payload = buildReceived(ctx, ctx.thread.id, loaded.prefs, {
			appBadge,
			silent: decision.silent ?? false,
		});
		await maybeDeliver(env, db, specs, payload, decision.urgency ?? "normal", ctx.thread.id.slice(0, 32), () =>
			buildReceived(ctx, ctx.thread.id, loaded.prefs, {
				appBadge,
				silent: decision.silent ?? false,
				shrink: true,
			}),
		);
		return toSend.length;
	});
}

async function processSendFailedForUser(
	messageId: string,
	userId: string,
	env: CloudflareEnv,
): Promise<void> {
	const db = getDb(env);
	if (await hasLog(db, userId, messageId, "send_failed")) return;
	const ctx = await loadMessageContext(db, messageId);
	if (!ctx) return;
	const loaded = await loadUserForDecide(db, userId, ctx.mailbox.id);
	if (!loaded) return;
	const now = Date.now();
	const decision = decideSendFailure({ user: loaded.user, prefs: loaded.prefs, now });
	await applyDecision(env, db, messageId, userId, "send_failed", ctx, loaded, decision, now, async () => {
		const devices = (await loadDevices(db, userId)).filter((d) => d.enabled);
		if (devices.length === 0) return 0;
		const payload = buildFailure(ctx, ctx.thread.id);
		await maybeDeliver(env, db, devices.map(toSendSpec), payload, "normal", ctx.thread.id.slice(0, 32), () =>
			buildFailure(ctx, ctx.thread.id, true),
		);
		return devices.length;
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
	onSent: () => Promise<number>,
): Promise<void> {
	const reason = decision.reason;
	switch (decision.decision) {
		case "excluded":
			return;
		case "sent": {
			const deviceCount = await onSent();
			await recordLog(db, { userId, messageId, kind, decision: "sent", reason, holdGroup: null, deviceCount });
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
): Promise<void> {
	if (!env.VAPID_PRIVATE_KEY || devices.length === 0) return;
	await deliverToDevices(env, db, {
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
	for (const [userId, messageIds] of groups) {
		const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
		const devices = (user ? await loadDevices(db, userId) : []).filter((d) => d.enabled);
		if (user && devices.length > 0 && env.VAPID_PRIVATE_KEY) {
			await deliverToDevices(env, db, {
				devices: devices.map(toSendSpec),
				payloadText: buildDigest(messageIds.length),
				urgency: "normal",
				now,
			});
		}
	}
	const digestIds = due.map((r) => r.id);
	if (digestIds.length > 0) {
		await db.delete(schema.notificationDigests).where(inArray(schema.notificationDigests.id, digestIds));
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
