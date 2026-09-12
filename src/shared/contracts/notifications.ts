import { z } from "zod";
import { paginationQuery, page } from "./common";

export const notificationLevel = z.enum(["all", "new_thread", "direct", "off"]);
export type NotificationLevel = z.infer<typeof notificationLevel>;

export const notificationDisplay = z.enum(["full", "sender_subject", "minimal"]);
export type NotificationDisplay = z.infer<typeof notificationDisplay>;

export const notificationBadge = z.enum(["all", "notified", "off"]);
export type NotificationBadge = z.infer<typeof notificationBadge>;

export const notificationAction = z.enum(["always", "normal", "silent", "never"]);
export type NotificationAction = z.infer<typeof notificationAction>;

export const quietMode = z.enum(["drop", "digest"]);

/** schedule.ts が Intl で解釈する値を保存から弾く。検証しないと保存時に RangeError になる。 */
function isKnownTimeZone(tz: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

/** days: 曜日（0=日曜）。end が start 以下なら日をまたぐ。時刻は "HH:MM"。 */
export const quietRange = z.object({
	days: z.array(z.number().int().min(0).max(6)).max(7),
	start: z.string().regex(/^\d{2}:\d{2}$/),
	end: z.string().regex(/^\d{2}:\d{2}$/),
});
export const quietHoursSchema = z.object({
	tz: z.string().min(1).refine(isKnownTimeZone, { message: "タイムゾーンが正しくありません" }),
	ranges: z.array(quietRange).default([]),
	mode: quietMode,
});
export type QuietHours = z.infer<typeof quietHoursSchema>;

/** ルーティングルールの matcher と違い、条件は自由組み合わせの AND。空オブジェクトなら全件一致。 */
export const notificationRuleMatcher = z.object({
	from: z.string().max(300).optional(),
	to: z.string().max(300).optional(),
	subject: z.string().max(500).optional(),
	body: z.string().max(2000).optional(),
	/** メールボックス（addressId）の複数選択。 */
	mailboxIds: z.array(z.string()).max(100).optional(),
	hasAttachment: z.boolean().optional(),
	/** 自分たちが送った会話への返信。 */
	replyToOwn: z.boolean().optional(),
	ccOnly: z.boolean().optional(),
});
export type NotificationRuleMatcher = z.infer<typeof notificationRuleMatcher>;

export const notificationRule = z.object({
	id: z.string(),
	name: z.string(),
	matcher: notificationRuleMatcher,
	action: notificationAction,
	priority: z.number().int(),
	enabled: z.boolean(),
});
export type NotificationRule = z.infer<typeof notificationRule>;

export const notificationRuleInput = z.object({
	name: z.string().min(1).max(200),
	matcher: notificationRuleMatcher,
	action: notificationAction,
	enabled: z.boolean().default(true),
});
export type NotificationRuleInput = z.infer<typeof notificationRuleInput>;

export const notificationRuleUpdate = notificationRuleInput.partial();
export type NotificationRuleUpdate = z.infer<typeof notificationRuleUpdate>;

export const mailboxNotification = z.object({
	id: z.string(),
	address: z.string(),
	displayName: z.string().nullable(),
	color: z.string(),
	isCatchAll: z.boolean(),
	level: notificationLevel,
	/** member には常に true。owner は割り当て（grant）があるかで分かれる。 */
	assigned: z.boolean(),
});
export type MailboxNotification = z.infer<typeof mailboxNotification>;

export const notificationSettings = z.object({
	enabled: z.boolean(),
	paused_until: z.number().nullable(),
	display: notificationDisplay,
	badge: notificationBadge,
	group_by_thread: z.boolean(),
	burst_window_sec: z.number(),
	suppress_when_active: z.boolean(),
	spam_suspicious: z.enum(["notify", "drop"]),
	quiet: quietHoursSchema.nullable(),
	notify_send_failure: z.boolean(),
	notify_catch_all: z.boolean(),
	feed_seen_at: z.number().nullable(),
	unseen_count: z.number(),
	mailboxes: z.array(mailboxNotification),
	rules: z.array(notificationRule),
});
export type NotificationSettings = z.infer<typeof notificationSettings>;

/** PATCH: プリセットか個別項目のどちらかを指定する。 */
export const notificationPatch = z
	.object({
		preset: z.enum(["all", "important", "later"]).optional(),
		enabled: z.boolean().optional(),
		paused_until: z.number().nullable().optional(),
		display: notificationDisplay.optional(),
		badge: notificationBadge.optional(),
		group_by_thread: z.boolean().optional(),
		burst_window_sec: z.number().int().min(0).optional(),
		suppress_when_active: z.boolean().optional(),
		spam_suspicious: z.enum(["notify", "drop"]).optional(),
		quiet: quietHoursSchema.nullable().optional(),
		notify_send_failure: z.boolean().optional(),
		notify_catch_all: z.boolean().optional(),
	})
	.refine((o) => o.preset !== undefined || Object.values(o).some((v) => v !== undefined), {
		message: "変更する項目を指定してください",
	});
export type NotificationPatch = z.infer<typeof notificationPatch>;

export const mailboxLevelInput = z.object({ level: notificationLevel });
export type MailboxLevelInput = z.infer<typeof mailboxLevelInput>;

export const ruleReorderInput = z.object({
	ids: z.array(z.string()).min(1).max(100),
});
export type RuleReorderInput = z.infer<typeof ruleReorderInput>;

export const dryRunInput = z.object({
	/** 指定すると既存設定ではなくこのルールだけに対して試す。 */
	rule: notificationRuleInput.optional(),
});
export type DryRunInput = z.infer<typeof dryRunInput>;

export const dryRunEntry = z.object({
	messageId: z.string(),
	addressId: z.string(),
	fromAddr: z.string(),
	subject: z.string().nullable(),
	receivedAt: z.number(),
	decision: z.string().nullable(),
	reason: z.string(),
});
export type DryRunEntry = z.infer<typeof dryRunEntry>;

export const feedDecision = z.enum(["sent", "held", "digest", "dropped"]);
export type FeedDecision = z.infer<typeof feedDecision>;

export const feedEntry = z.object({
	id: z.string(),
	type: z.literal("entry"),
	messageId: z.string().nullable(),
	kind: z.enum(["received", "send_failed"]),
	decision: feedDecision,
	reason: z.string(),
	holdGroup: z.string().nullable(),
	createdAt: z.number(),
	/** 束の中でも 1 件ごとに差出人・件名・メールボックスを出すための詳細。 */
	fromAddr: z.string(),
	subject: z.string().nullable(),
	mailboxAddress: z.string(),
	isCatchAll: z.boolean(),
});
export type FeedEntry = z.infer<typeof feedEntry>;

/** 同じ一時停止・おやすみの束。items は先頭 3 件まで。count が実際の全件数。 */
export const feedBundle = z.object({
	id: z.string(),
	type: z.literal("bundle"),
	decision: z.enum(["held", "digest"]),
	reason: z.string(),
	count: z.number(),
	createdAt: z.number(),
	items: z.array(feedEntry),
});
export type FeedBundle = z.infer<typeof feedBundle>;

export const feedItem = z.union([feedEntry, feedBundle]);
export type FeedItem = z.infer<typeof feedItem>;

const includeDroppedParam = z.enum(["1", "true"]).transform(() => true).optional();
export const feedQuery = paginationQuery.extend({
	include_dropped: includeDroppedParam,
	/** 束の残り（holdGroup に属する全 entry）を平坦に返す。 */
	hold_group: z.string().optional(),
});
export type FeedQuery = z.infer<typeof feedQuery>;

export const feedResponse = page(feedItem);
export type FeedResponse = z.infer<typeof feedResponse>;

export const threadNotificationInput = z.object({
	mode: z.enum(["follow", "mute"]),
});
export type ThreadNotificationInput = z.infer<typeof threadNotificationInput>;

export const devicePlatform = z.enum(["ios", "android", "desktop"]);
export type DevicePlatform = z.infer<typeof devicePlatform>;

export const deviceKeys = z.object({ p256dh: z.string().min(1).max(1000), auth: z.string().min(1).max(1000) });
export type DeviceKeys = z.infer<typeof deviceKeys>;

// サーバはこの URL へ POST するので、任意の URL を受けると内部や第三者への踏み台になる。
// ブラウザのプッシュサービスだけを通す。
const PUSH_SERVICE_HOSTS = [
	/^fcm\.googleapis\.com$/,
	/^updates\.push\.services\.mozilla\.com$/,
	/^web\.push\.apple\.com$/,
	/^[a-z0-9-]+\.push\.apple\.com$/,
	/^[a-z0-9-]+\.notify\.windows\.com$/,
];

export function isPushServiceEndpoint(raw: string): boolean {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return false;
	}
	if (url.protocol !== "https:" || url.port !== "" || url.username || url.password) return false;
	return PUSH_SERVICE_HOSTS.some((re) => re.test(url.hostname));
}

export const deviceInput = z.object({
	endpoint: z
		.string()
		.url()
		.max(1000)
		.refine(isPushServiceEndpoint, { message: "ブラウザのプッシュサービスの URL ではありません" }),
	keys: deviceKeys,
	name: z.string().min(1).max(200),
	platform: devicePlatform,
});
export type DeviceInput = z.infer<typeof deviceInput>;

export const deviceUpdate = z
	.object({
		name: z.string().min(1).max(200).optional(),
		enabled: z.boolean().optional(),
		addressIds: z.array(z.string()).max(100).nullable().optional(),
	})
	.refine((o) => o.name !== undefined || o.enabled !== undefined || o.addressIds !== undefined, {
		message: "変更する項目を指定してください",
	});
export type DeviceUpdate = z.infer<typeof deviceUpdate>;

export const device = z.object({
	id: z.string(),
	name: z.string(),
	platform: devicePlatform,
	enabled: z.boolean(),
	endpoint: z.string(),
	addressIds: z.array(z.string()).nullable(),
	lastSeenAt: z.number().nullable(),
	lastSuccessAt: z.number().nullable(),
	failureCount: z.number(),
	createdAt: z.number(),
});
export type Device = z.infer<typeof device>;

export const pushKeyResponse = z.object({
	/** 非圧縮 EC 点 0x04||x||y の base64url。未設定なら null。 */
	key: z.string().nullable(),
});
export type PushKeyResponse = z.infer<typeof pushKeyResponse>;
