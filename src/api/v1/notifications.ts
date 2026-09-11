import { decide } from "@/domain/notify/decide";
import { loadMessageContext, loadThreadPref, loadUserForDecide } from "@/services/notify/load";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { schema } from "@/db/client";
import type { Db } from "@/db/client";
import { newId } from "@/lib/id";
import { readJson, unixSeconds } from "@/lib/validate";
import { afterCursor, toPage } from "@/lib/paging";
import { addressFilter, addressSetHas } from "@/domain/access/policy";
import {
	notificationRuleInput,
	notificationRuleUpdate,
	notificationPatch,
	mailboxLevelInput,
	ruleReorderInput,
	dryRunInput,
	feedQuery,
	threadNotificationInput,
	type NotificationPatch,
	type NotificationLevel,
	type NotificationRule,
	type NotificationSettings,
	type FeedItem,
	type FeedBundle,
	type FeedEntry,
} from "@/shared/contracts/notifications";
import { forbidden, invalidRequest, notFound } from "@/shared/errors";
import { defaultColorFor } from "@/shared/colors";
import type { AppEnv } from "@/api/types";
import type { Principal } from "@/shared/contracts/common";

const app = new Hono<AppEnv>();
export default app;

/** 通知 API は全部セッション限定・agent 対象外。app.ts 側の requireAuth の後に置く。 */
export const notificationSessionGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
	const p = c.get("principal");
	if (p.via !== "session") throw forbidden("この操作は画面からログインして行ってください");
	if (p.role === "agent") throw forbidden("エージェントアカウントでは通知を利用できません");
	await next();
};

app.use("*", notificationSessionGuard);

const defaults = {
	enabled: true,
	pausedUntil: null as Date | null,
	display: "full" as const,
	badge: "notified" as const,
	groupByThread: true,
	burstWindowSec: 0,
	suppressWhenActive: false,
	spamSuspicious: "drop" as const,
	quiet: null as NonNullable<typeof schema.notificationPrefs.$inferSelect.quiet> | null,
	notifySendFailure: true,
	notifyCatchAll: true,
	feedSeenAt: null as Date | null,
	updatedAt: null as Date | null,
};

async function ensurePrefsRow(db: Db, userId: string): Promise<void> {
	const existing = await db
		.select({ id: schema.notificationPrefs.userId })
		.from(schema.notificationPrefs)
		.where(eq(schema.notificationPrefs.userId, userId))
		.limit(1);
	if (existing.length > 0) return;
	await db.insert(schema.notificationPrefs).values({ userId, ...defaults, updatedAt: new Date() });
}

function prefsPayload(row: typeof schema.notificationPrefs.$inferSelect) {
	return {
		enabled: row.enabled,
		paused_until: unixSeconds(row.pausedUntil),
		display: row.display,
		badge: row.badge,
		group_by_thread: row.groupByThread,
		burst_window_sec: row.burstWindowSec,
		suppress_when_active: row.suppressWhenActive,
		spam_suspicious: row.spamSuspicious,
		quiet: row.quiet,
		notify_send_failure: row.notifySendFailure,
		notify_catch_all: row.notifyCatchAll,
		feed_seen_at: unixSeconds(row.feedSeenAt),
	};
}

async function loadMailboxes(
	db: Db,
	principal: Principal,
	rows: { id: string; address: string; color: string | null; isCatchAll: boolean }[],
): Promise<{
	id: string;
	address: string;
	color: string;
	isCatchAll: boolean;
	assigned: boolean;
	level: NotificationLevel;
}[]> {
	// owner は addressIds が "all" で、grant の有無で「割り当て」かを分ける。member は全て割り当て済み。
	let grants = new Set<string>();
	if (principal.role === "owner") {
		const g = await db
			.select({ addressId: schema.addressGrants.addressId })
			.from(schema.addressGrants)
			.where(eq(schema.addressGrants.userId, principal.userId));
		grants = new Set(g.map((r) => r.addressId));
	}

	const prefRows = await db
		.select()
		.from(schema.notificationMailboxPrefs)
		.where(eq(schema.notificationMailboxPrefs.userId, principal.userId));
	const prefs = new Map(prefRows.map((r) => [r.addressId, r.level]));

	const notifyCatchAll = await loadNotifyCatchAll(db, principal.userId);

	return rows.map((row, index) => {
		const assigned = row.isCatchAll || (principal.role === "owner" ? grants.has(row.id) : true);
		const stored = prefs.get(row.id);
		const level = stored ?? defaultLevel(row.isCatchAll, assigned, notifyCatchAll);
		return {
			id: row.id,
			address: row.address,
			color: row.color ?? defaultColorFor(index),
			isCatchAll: row.isCatchAll,
			assigned,
			level,
		};
	});
}

async function loadNotifyCatchAll(db: Db, userId: string): Promise<boolean> {
	const [row] = await db
		.select({ notifyCatchAll: schema.notificationPrefs.notifyCatchAll })
		.from(schema.notificationPrefs)
		.where(eq(schema.notificationPrefs.userId, userId))
		.limit(1);
	return row?.notifyCatchAll ?? defaults.notifyCatchAll;
}

function defaultLevel(isCatchAll: boolean, assigned: boolean, notifyCatchAll: boolean): "all" | "off" {
	if (isCatchAll) return notifyCatchAll ? "all" : "off";
	return assigned ? "all" : "off";
}

async function loadVisibleAddresses(db: Db, principal: Principal) {
	const rows = await db
		.select({
			id: schema.addresses.id,
			address: schema.addresses.address,
			color: schema.addresses.color,
			isCatchAll: schema.addresses.isCatchAll,
		})
		.from(schema.addresses)
		.where(and(addressFilter(principal, schema.addresses.id), isNull(schema.addresses.archivedAt)));
	return rows;
}

async function loadRules(db: Db, userId: string): Promise<NotificationRule[]> {
	const rows = await db
		.select()
		.from(schema.notificationRules)
		.where(eq(schema.notificationRules.userId, userId))
		.orderBy(asc(schema.notificationRules.priority), asc(schema.notificationRules.id));
	return rows.map((r) => ({
		id: r.id,
		name: r.name,
		matcher: r.matcher as NotificationRule["matcher"],
		action: r.action,
		priority: r.priority,
		enabled: r.enabled,
	}));
}

async function unseenCount(db: Db, userId: string, feedSeenAt: Date | null): Promise<number> {
	const where = feedSeenAt
		? and(eq(schema.notificationLog.userId, userId), gt(schema.notificationLog.createdAt, feedSeenAt))
		: eq(schema.notificationLog.userId, userId);
	const [row] = await db
		.select({ n: sql<number>`count(*)` })
		.from(schema.notificationLog)
		.where(where);
	return Number(row?.n ?? 0);
}

async function settingsResponse(db: Db, principal: Principal): Promise<NotificationSettings> {
	const [row] = await db
		.select()
		.from(schema.notificationPrefs)
		.where(eq(schema.notificationPrefs.userId, principal.userId))
		.limit(1);
	const prefs = row ?? { userId: principal.userId, ...defaults };
	const [addrRows, rules, unseen] = await Promise.all([
		loadVisibleAddresses(db, principal),
		loadRules(db, principal.userId),
		unseenCount(db, principal.userId, prefs.feedSeenAt),
	]);
	const mailboxes = await loadMailboxes(db, principal, addrRows as typeof addrRows);
	return {
		...prefsPayload(prefs),
		unseen_count: unseen,
		mailboxes,
		rules,
	};
}

app.get("/", async (c) => {
	const principal = c.get("principal");
	const db = c.get("db");
	return c.json(await settingsResponse(db, principal));
});

app.patch("/", async (c) => {
	const principal = c.get("principal");
	const db = c.get("db");
	const body = await readJson(c.req, notificationPatch);
	await ensurePrefsRow(db, principal.userId);

	if (body.preset) {
		await applyPreset(db, principal, body.preset);
	} else {
		await db
			.update(schema.notificationPrefs)
			.set({ ...applyPrefPatch(body), updatedAt: new Date() })
			.where(eq(schema.notificationPrefs.userId, principal.userId));
	}

	return c.json(await settingsResponse(db, principal));
});

function applyPrefPatch(body: NotificationPatch) {
	const set: Partial<typeof schema.notificationPrefs.$inferInsert> = {};
	if (body.enabled !== undefined) set.enabled = body.enabled;
	if (body.paused_until !== undefined) set.pausedUntil = body.paused_until === null ? null : new Date(body.paused_until * 1000);
	if (body.display !== undefined) set.display = body.display;
	if (body.badge !== undefined) set.badge = body.badge;
	if (body.group_by_thread !== undefined) set.groupByThread = body.group_by_thread;
	if (body.burst_window_sec !== undefined) set.burstWindowSec = body.burst_window_sec;
	if (body.suppress_when_active !== undefined) set.suppressWhenActive = body.suppress_when_active;
	if (body.spam_suspicious !== undefined) set.spamSuspicious = body.spam_suspicious;
	if (body.quiet !== undefined) set.quiet = body.quiet;
	if (body.notify_send_failure !== undefined) set.notifySendFailure = body.notify_send_failure;
	if (body.notify_catch_all !== undefined) set.notifyCatchAll = body.notify_catch_all;
	return set;
}

async function applyPreset(db: Db, principal: Principal, preset: "all" | "important" | "later") {
	// 「あとで決める」は既定値のまま通知を受ける。設定しないと通知が来ない、にはしない。
	if (preset === "later") return;
	// プリセットは決定的な状態にするため、既存のルールをクリアする。
	await db.delete(schema.notificationRules).where(eq(schema.notificationRules.userId, principal.userId));

	const addrRows = await loadVisibleAddresses(db, principal);
	const mailboxes = await loadMailboxes(db, principal, addrRows as typeof addrRows);

	if (preset === "all" || preset === "important") {
		const level = preset === "all" ? "all" : "direct";
		for (const m of mailboxes) {
			await db
				.insert(schema.notificationMailboxPrefs)
				.values({ userId: principal.userId, addressId: m.id, level })
				.onConflictDoUpdate({ target: [schema.notificationMailboxPrefs.userId, schema.notificationMailboxPrefs.addressId], set: { level } });
		}
		await db
			.update(schema.notificationPrefs)
			.set({ enabled: true, updatedAt: new Date() })
			.where(eq(schema.notificationPrefs.userId, principal.userId));
	}

	if (preset === "important") {
		await db.insert(schema.notificationRules).values({
			id: newId("notificationRule"),
			userId: principal.userId,
			name: "返信を通知",
			matcher: { replyToOwn: true },
			action: "always",
			priority: 0,
		});
	}
}

app.put("/mailboxes/:addressId", async (c) => {
	const principal = c.get("principal");
	const db = c.get("db");
	const addressId = c.req.param("addressId");
	if (!addressSetHas(principal.addressIds, addressId)) throw forbidden("このメールボックスの設定は変更できません");
	const { level } = await readJson(c.req, mailboxLevelInput);
	await ensurePrefsRow(db, principal.userId);
	await db
		.insert(schema.notificationMailboxPrefs)
		.values({ userId: principal.userId, addressId, level })
		.onConflictDoUpdate({
			target: [schema.notificationMailboxPrefs.userId, schema.notificationMailboxPrefs.addressId],
			set: { level },
		});
	return c.json({ addressId, level });
});

app.get("/rules", async (c) => {
	const principal = c.get("principal");
	const db = c.get("db");
	return c.json({ data: await loadRules(db, principal.userId) });
});

app.post("/rules", async (c) => {
	const principal = c.get("principal");
	const db = c.get("db");
	const body = await readJson(c.req, notificationRuleInput);
	const [max] = await db
		.select({ p: sql<number>`coalesce(max(${schema.notificationRules.priority}), -1) + 1` })
		.from(schema.notificationRules)
		.where(eq(schema.notificationRules.userId, principal.userId));
	const id = newId("notificationRule");
	await db.insert(schema.notificationRules).values({
		id,
		userId: principal.userId,
		name: body.name,
		matcher: body.matcher as Record<string, unknown>,
		action: body.action,
		priority: Number(max?.p ?? 0),
		enabled: body.enabled,
	});
	const rule = await requireOwnRule(db, principal.userId, id);
	return c.json(rule, 201);
});

app.patch("/rules/:id", async (c) => {
	const principal = c.get("principal");
	const db = c.get("db");
	const id = c.req.param("id");
	const existing = await requireOwnRule(db, principal.userId, id);
	const body = await readJson(c.req, notificationRuleUpdate);
	const set: Record<string, unknown> = {};
	if (body.name !== undefined) set.name = body.name;
	if (body.matcher !== undefined) set.matcher = body.matcher as Record<string, unknown>;
	if (body.action !== undefined) set.action = body.action;
	if (body.enabled !== undefined) set.enabled = body.enabled;
	await db.update(schema.notificationRules).set(set).where(eq(schema.notificationRules.id, id));
	const updated = await requireOwnRule(db, principal.userId, id);
	return c.json({ ...existing, ...updated });
});

app.delete("/rules/:id", async (c) => {
	const principal = c.get("principal");
	const db = c.get("db");
	const id = c.req.param("id");
	await requireOwnRule(db, principal.userId, id);
	await db.delete(schema.notificationRules).where(eq(schema.notificationRules.id, id));
	return c.body(null, 204);
});

app.post("/rules/reorder", async (c) => {
	const principal = c.get("principal");
	const db = c.get("db");
	const { ids } = await readJson(c.req, ruleReorderInput);
	const owned = new Set((await loadRules(db, principal.userId)).map((r) => r.id));
	const unknown = ids.filter((id) => !owned.has(id));
	if (unknown.length > 0) throw invalidRequest("自分のルール以外は並べ替えられません", { unknown });
	for (let i = 0; i < ids.length; i++) {
		await db
			.update(schema.notificationRules)
			.set({ priority: i })
			.where(and(eq(schema.notificationRules.id, ids[i]!), eq(schema.notificationRules.userId, principal.userId)));
	}
	return c.json({ data: await loadRules(db, principal.userId) });
});

async function requireOwnRule(db: Db, userId: string, id: string): Promise<NotificationRule> {
	const [row] = await db
		.select()
		.from(schema.notificationRules)
		.where(and(eq(schema.notificationRules.id, id), eq(schema.notificationRules.userId, userId)))
		.limit(1);
	if (!row) throw notFound("通知ルールが見つかりません");
	return {
		id: row.id,
		name: row.name,
		matcher: row.matcher as NotificationRule["matcher"],
		action: row.action,
		priority: row.priority,
		enabled: row.enabled,
	};
}

app.post("/dry-run", async (c) => {
	const principal = c.get("principal");
	const db = c.get("db");
	const body = await readOptionalJson(c, (raw) => dryRunInput.safeParse(raw));
	const [rows] = await Promise.all([
		db
			.select({
				id: schema.messages.id,
				addressId: schema.messages.addressId,
				fromAddr: schema.messages.fromAddr,
				subject: schema.messages.subject,
				receivedAt: schema.messages.receivedAt,
			})
			.from(schema.messages)
			.where(
				and(
					eq(schema.messages.direction, "inbound"),
					addressFilter(principal, schema.messages.addressId),
				),
			)
			.orderBy(desc(schema.messages.receivedAt), desc(schema.messages.id))
			.limit(20),
	]);
	const now = Date.now();
	const data = [];
	for (const m of rows) {
		const ctx = await loadMessageContext(db, m.id);
		const loaded = ctx ? await loadUserForDecide(db, principal.userId, m.addressId) : null;
		let reason = "unavailable";
		let decision: string | null = null;
		if (ctx && loaded) {
			const threadPref = ctx.thread.id ? await loadThreadPref(db, principal.userId, ctx.thread.id) : null;
			const rules = body?.rule
				? [{ id: "draft", matcher: body.rule.matcher, action: body.rule.action, enabled: true }]
				: loaded.prefs.rules;
			const result = decide({
				message: ctx.message,
				thread: { ...ctx.thread, followed: threadPref === "follow", muted: threadPref === "mute" },
				mailbox: ctx.mailbox,
				// 試すときは端末の登録が無くても判定の中身を見せる。
				user: { ...loaded.user, deviceCount: Math.max(1, loaded.user.deviceCount) },
				prefs: { ...loaded.prefs, rules },
				now,
			});
			reason = result.reason;
			decision = result.decision;
		}
		data.push({
			messageId: m.id,
			addressId: m.addressId,
			fromAddr: m.fromAddr,
			subject: m.subject,
			receivedAt: Math.floor(m.receivedAt.getTime() / 1000),
			decision,
			reason,
		});
	}
	return c.json({ data });
});

async function readOptionalJson<T>(
	c: { req: { text: () => Promise<string> } },
	parse: (raw: unknown) => { success: boolean; data?: T; error?: unknown },
): Promise<T | null> {
	const text = await c.req.text().catch(() => "");
	if (!text.trim()) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw invalidRequest("JSON ボディが必要です");
	}
	const parsed = parse(raw);
	if (!parsed.success) throw invalidRequest("リクエストの内容が不正です", parsed.error);
	return parsed.data ?? null;
}

app.get("/feed", async (c) => {
	const principal = c.get("principal");
	const db = c.get("db");
	const q = feedQuery.safeParse(c.req.query());
	if (!q.success) throw invalidRequest("クエリが不正です", q.error.issues);
	const { limit, cursor, include_dropped } = q.data;
	const scope = and(
		eq(schema.notificationLog.userId, principal.userId),
		include_dropped ? undefined : inArray(schema.notificationLog.decision, ["sent", "held", "digest"]),
		afterCursor(schema.notificationLog, cursor, "desc"),
	);
	const rows = await db
		.select()
		.from(schema.notificationLog)
		.where(scope)
		.orderBy(desc(schema.notificationLog.createdAt), desc(schema.notificationLog.id))
		.limit(limit + 1);

	const pageRows = rows.slice(0, limit);
	const hasNext = rows.length > limit;
	const next_cursor = hasNext && pageRows.length > 0 ? toPage(rows, limit).next_cursor : null;

	const items = await groupFeed(db, principal.userId, pageRows);
	return c.json({ data: items, next_cursor });
});

async function groupFeed(db: Db, userId: string, rows: typeof schema.notificationLog.$inferSelect[]): Promise<FeedItem[]> {
	const entries = new Map<string, FeedEntry[]>();
	const standalone: FeedItem[] = [];
	for (const row of rows) {
		const entry = toFeedEntry(row);
		if (row.holdGroup && (row.decision === "held" || row.decision === "digest")) {
			const list = entries.get(row.holdGroup) ?? [];
			list.push(entry);
			entries.set(row.holdGroup, list);
		} else {
			standalone.push(entry);
		}
	}
	const bundles: FeedBundle[] = [];
	for (const [holdGroup, list] of entries) {
		const [countRow] = await db
			.select({ n: sql<number>`count(*)` })
			.from(schema.notificationLog)
			.where(and(eq(schema.notificationLog.userId, userId), eq(schema.notificationLog.holdGroup, holdGroup)));
		const first = list[0]!;
		bundles.push({
			id: holdGroup,
			type: "bundle",
			decision: first.decision as "held" | "digest",
			reason: first.reason,
			count: Number(countRow?.n ?? list.length),
			createdAt: first.createdAt,
			items: list.slice(0, 3),
		});
	}
	// 束の中では作成時刻が同じなので並び崩れない。束と単品は元の順序（新しい順）を保つ。
	// 束の作成時刻はグループ内で一致するので、全体を新しい順に戻す。
	return [...bundles, ...standalone].sort((a, b) => b.createdAt - a.createdAt);
}

function toFeedEntry(row: { id: string; createdAt: Date; decision: string; reason: string | null; holdGroup: string | null; messageId: string | null; kind: string }): FeedEntry {
	return {
		id: row.id,
		type: "entry",
		messageId: row.messageId,
		kind: row.kind as "received" | "send_failed",
		decision: row.decision as FeedEntry["decision"],
		reason: row.reason ?? "",
		holdGroup: row.holdGroup,
		createdAt: Math.floor(row.createdAt.getTime() / 1000),
	};
}

app.post("/feed/seen", async (c) => {
	const principal = c.get("principal");
	const db = c.get("db");
	const now = new Date();
	await ensurePrefsRow(db, principal.userId);
	await db
		.update(schema.notificationPrefs)
		.set({ feedSeenAt: now, updatedAt: new Date() })
		.where(eq(schema.notificationPrefs.userId, principal.userId));
	return c.json({ feed_seen_at: Math.floor(now.getTime() / 1000), unseen_count: 0 });
});

/** /threads/:id/notification にマウントされる想定。 */
export const threadNotificationRouter = new Hono<AppEnv>();
// /api/v1/threads にマウントされるので、"*" にすると API キーでのスレッド操作まで塞いでしまう。
threadNotificationRouter.use("/:id/notification", notificationSessionGuard);

threadNotificationRouter.get("/:id/notification", async (c) => {
	const principal = c.get("principal");
	const db = c.get("db");
	const threadId = c.req.param("id");
	await requireVisibleThread(db, principal, threadId);
	const row = await db
		.select({ mode: schema.threadNotificationPrefs.mode })
		.from(schema.threadNotificationPrefs)
		.where(
			and(
				eq(schema.threadNotificationPrefs.userId, principal.userId),
				eq(schema.threadNotificationPrefs.threadId, threadId),
			),
		)
		.get();
	return c.json({ threadId, mode: row?.mode ?? null });
});

threadNotificationRouter.put("/:id/notification", async (c) => {
	const principal = c.get("principal");
	const db = c.get("db");
	const threadId = c.req.param("id");
	await requireVisibleThread(db, principal, threadId);
	const { mode } = await readJson(c.req, threadNotificationInput);
	await db
		.insert(schema.threadNotificationPrefs)
		.values({ userId: principal.userId, threadId, mode })
		.onConflictDoUpdate({
			target: [schema.threadNotificationPrefs.userId, schema.threadNotificationPrefs.threadId],
			set: { mode },
		});
	return c.json({ threadId, mode });
});

threadNotificationRouter.delete("/:id/notification", async (c) => {
	const principal = c.get("principal");
	const db = c.get("db");
	await requireVisibleThread(db, principal, c.req.param("id"));
	await db
		.delete(schema.threadNotificationPrefs)
		.where(
			and(
				eq(schema.threadNotificationPrefs.userId, principal.userId),
				eq(schema.threadNotificationPrefs.threadId, c.req.param("id")),
			),
		);
	return c.body(null, 204);
});

async function requireVisibleThread(db: Db, principal: Principal, threadId: string): Promise<void> {
	const [row] = await db
		.select({ id: schema.threads.id })
		.from(schema.threads)
		.where(and(eq(schema.threads.id, threadId), addressFilter(principal, schema.threads.addressId)))
		.limit(1);
	if (!row) throw notFound("スレッドが見つかりません");
}

/** devices.ts と共有する直列化。 */
export function serializeDevice(row: typeof schema.pushDevices.$inferSelect) {
	return {
		id: row.id,
		name: row.name,
		platform: row.platform,
		enabled: row.enabled,
		endpoint: row.endpoint,
		p256dh: row.p256dh,
		auth: row.auth,
		addressIds: row.addressIds,
		lastSeenAt: unixSeconds(row.lastSeenAt),
		lastSuccessAt: unixSeconds(row.lastSuccessAt),
		failureCount: row.failureCount,
		createdAt: unixSeconds(row.createdAt),
	};
}


