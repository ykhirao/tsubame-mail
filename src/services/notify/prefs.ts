import { and, asc, eq, gt } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import type { Db } from "@/db/client";
import { jsonIdsIn } from "@/domain/access/policy";
import { defaultPrefs } from "@/domain/notify/decide";
import type {
	MailboxLevel,
	NotificationMatcher,
	NotificationPrefs,
	NotificationRule,
	Role,
} from "@/domain/notify/decide";
import type { QuietSchedule } from "@/domain/notify/schedule";
import type { QuietHours } from "@/db/schema";

function toMinutes(hm: string): number {
	const [h, m] = hm.split(":").map(Number);
	return (h ?? 0) * 60 + (m ?? 0);
}

function toQuietSchedule(q: QuietHours): QuietSchedule {
	return {
		tz: q.tz,
		mode: q.mode,
		ranges: q.ranges.map((r) => ({
			days: r.days,
			start: toMinutes(r.start),
			end: toMinutes(r.end),
		})),
	};
}

export async function loadPrefs(db: Db, userId: string): Promise<NotificationPrefs> {
	const [row, mailboxRows, ruleRows] = await Promise.all([
		db.select().from(schema.notificationPrefs).where(eq(schema.notificationPrefs.userId, userId)).get(),
		db
			.select()
			.from(schema.notificationMailboxPrefs)
			.where(eq(schema.notificationMailboxPrefs.userId, userId))
			.all(),
		db
			.select()
			.from(schema.notificationRules)
			.where(eq(schema.notificationRules.userId, userId))
			.orderBy(asc(schema.notificationRules.priority), asc(schema.notificationRules.createdAt))
			.all(),
	]);

	const mailboxLevels: Record<string, MailboxLevel> = {};
	for (const mb of mailboxRows) mailboxLevels[mb.addressId] = mb.level;
	const rules: NotificationRule[] = ruleRows.map((r) => ({
		id: r.id,
		matcher: r.matcher as NotificationMatcher,
		action: r.action,
		enabled: r.enabled,
	}));

	const prefs: NotificationPrefs = {
		...defaultPrefs,
		mailboxLevels,
		rules,
	};
	if (row) {
		prefs.enabled = row.enabled;
		prefs.pausedUntil = row.pausedUntil ? row.pausedUntil.getTime() : null;
		prefs.display = row.display;
		prefs.badge = row.badge;
		prefs.groupByThread = row.groupByThread;
		prefs.burstWindowSec = row.burstWindowSec;
		prefs.suppressWhenActive = row.suppressWhenActive;
		prefs.spamSuspicious = row.spamSuspicious;
		prefs.quiet = row.quiet ? toQuietSchedule(row.quiet) : null;
		prefs.notifySendFailure = row.notifySendFailure;
		prefs.notifyCatchAll = row.notifyCatchAll;
	}
	return prefs;
}

/** バッジ用の未読数。badge=notified なら通知レベルが off でないメールボックスの未読だけ数える。 */
export async function countUnread(
	db: Db,
	userId: string,
	_role: Role,
	prefs: NotificationPrefs,
): Promise<number> {
	if (prefs.badge === "off") return 0;
	// owner も割り当てたメールボックスだけ数える（管理者モードで全アドレスが見えても数は増やさない）。
	const filter = jsonIdsIn(
		schema.threads.addressId,
		(
			await db
				.select({ addressId: schema.addressGrants.addressId })
				.from(schema.addressGrants)
				.where(eq(schema.addressGrants.userId, userId))
				.all()
		).map((g) => g.addressId),
	);
	const rows = await db
		.select({ addressId: schema.threads.addressId, unread: schema.threads.unreadCount })
		.from(schema.threads)
		.where(and(gt(schema.threads.unreadCount, 0), filter));
	let total = 0;
	for (const r of rows) {
		if (prefs.badge === "notified") {
			const level = prefs.mailboxLevels[r.addressId] ?? "all";
			if (level === "off") continue;
		}
		total += r.unread;
	}
	return total;
}
