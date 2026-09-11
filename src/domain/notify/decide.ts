import { parseAddressList } from "@/domain/mail/address";
import { isQuiet as scheduleIsQuiet, type QuietSchedule } from "./schedule";

export type { QuietRange, QuietSchedule } from "./schedule";

export type Role = "owner" | "member" | "agent";
export type UserStatus = "active" | "disabled";
export type Direction = "inbound" | "outbound";
export type SpamVerdict = "clean" | "suspicious" | "spam";
export type MailboxLevel = "all" | "new_thread" | "direct" | "off";
export type DisplayMode = "full" | "sender_subject" | "minimal";
export type BadgeMode = "all" | "notified" | "off";
export type RuleAction = "always" | "normal" | "silent" | "never";
export type DecisionValue = "sent" | "held" | "digest" | "dropped" | "excluded";
export type Urgency = "high" | "normal" | "low";

export type Message = {
	id: string;
	/** 届いたメールボックス。 */
	addressId: string;
	direction: Direction;
	fromAddr: string;
	fromName: string | null;
	/** カンマ結合の To リスト。 */
	toAddr: string;
	ccAddr: string | null;
	subject: string | null;
	textBody: string | null;
	hasAttachments: boolean;
	spamVerdict: SpamVerdict | null;
	/** アドレスルール（FR-7）で破棄・既読にされたメール。 */
	discarded?: boolean;
	markedRead?: boolean;
};

export type Thread = {
	id: string;
	/** このメッセージより前のメッセージ数。0 なら新しい会話。 */
	messageCount: number;
	/** 会話に送信が 1 通でも含まれる。「自分たちが送った会話への返信」の判定に使う。 */
	hasOutbound: boolean;
	followed: boolean;
	muted: boolean;
	/** 直近にこの会話へ通知した時刻（epoch ms）。連続まとめ(14)に使う。 */
	lastNotifiedAt: number | null;
};

export type Mailbox = {
	id: string;
	/** メールボックスのアドレス（例: info@example.com）。To / CC の判定に使う。 */
	address: string;
	isCatchAll: boolean;
};

export type User = {
	id: string;
	role: Role;
	status: UserStatus;
	/** 購読中の有効な端末の数。0 なら対象外。 */
	deviceCount: number;
	/** このメッセージの届いたメールボックスに明示的に割り当てられている。 */
	assigned: boolean;
};

/** ルーティング（FR-7）の matcher と同じ部分一致の形に、通知固有の条件を足したもの。 */
export type NotificationMatcher = {
	from?: string;
	to?: string;
	subject?: string;
	body?: string;
	mailboxIds?: string[];
	hasAttachment?: boolean;
	replyToOwn?: boolean;
	ccOnly?: boolean;
};

export type NotificationRule = {
	id: string;
	matcher: NotificationMatcher;
	action: RuleAction;
	enabled: boolean;
};
export type NotificationPrefs = {
	enabled: boolean;
	pausedUntil: number | null;
	display: DisplayMode;
	badge: BadgeMode;
	groupByThread: boolean;
	/** 続けて届いたもののまとめ窓（秒）。0 ならまとめない。 */
	burstWindowSec: number;
	suppressWhenActive: boolean;
	spamSuspicious: "notify" | "drop";
	quiet: QuietSchedule | null;
	notifySendFailure: boolean;
	notifyCatchAll: boolean;
	/** addressId → 通知レベル。無いアドレスは既定 all。 */
	mailboxLevels: Record<string, MailboxLevel>;
	rules: NotificationRule[];
};

export type NotifyInput = {
	message: Message;
	thread: Thread;
	mailbox: Mailbox;
	user: User;
	prefs: NotificationPrefs;
	now: number;
};

export type ReasonCode =
	| "user_ineligible"
	| "not_assigned"
	| "privilege_only"
	| "disabled"
	| "paused"
	| "rule_trashed"
	| "rule_read"
	| "spam"
	| "thread_muted"
	| `rule:${string}`
	| "thread_followed"
	| "mailbox_level"
	| "catch_all_off"
	| "quiet_drop"
	| "quiet_digest"
	| "coalesced"
	| "send_failure";

export type Decision = {
	decision: DecisionValue;
	reason: ReasonCode;
	urgency?: Urgency;
	silent?: boolean;
};

/** 設定の行が無い利用者を想定した既定値。無設定でも新しい会話と返信が通知される。 */
export const defaultPrefs: NotificationPrefs = {
	enabled: true,
	pausedUntil: null,
	display: "full",
	badge: "all",
	groupByThread: true,
	burstWindowSec: 0,
	suppressWhenActive: false,
	spamSuspicious: "drop",
	quiet: null,
	notifySendFailure: true,
	notifyCatchAll: true,
	mailboxLevels: {},
	rules: [],
};

function includes(haystack: string | null | undefined, needle: string): boolean {
	if (haystack === null || haystack === undefined) return false;
	return haystack.toLowerCase().includes(needle.toLowerCase());
}

function addressInList(list: string | null | undefined, address: string): boolean {
	return parseAddressList(list).some((a) => a.address === address);
}

function isTo(message: Message, mailbox: Mailbox): boolean {
	return addressInList(message.toAddr, mailbox.address);
}

function isCcOnly(message: Message, mailbox: Mailbox): boolean {
	return addressInList(message.ccAddr, mailbox.address) && !addressInList(message.toAddr, mailbox.address);
}

export function matchNotification(
	matcher: NotificationMatcher,
	message: Message,
	mailbox: Mailbox,
	thread: Thread,
): boolean {
	if (matcher.from && !includes(message.fromAddr, matcher.from)) return false;
	if (matcher.to && !includes(message.toAddr, matcher.to)) return false;
	if (matcher.subject && !includes(message.subject, matcher.subject)) return false;
	if (matcher.body && !includes(message.textBody, matcher.body)) return false;
	if (matcher.mailboxIds && !matcher.mailboxIds.includes(message.addressId)) return false;
	if (matcher.hasAttachment === true && !message.hasAttachments) return false;
	if (matcher.replyToOwn === true && !thread.hasOutbound) return false;
	if (matcher.ccOnly === true && !isCcOnly(message, mailbox)) return false;
	return true;
}

function quietHeld(schedule: QuietSchedule): Decision {
	return schedule.mode === "digest"
		? { decision: "digest", reason: "quiet_digest" }
		: { decision: "held", reason: "quiet_drop" };
}

/**
 * 1 通の受信に対する通知判定。表 1〜11 と 14 を順に評価し、最初に決まったところで返す。
 * 端末単位の 12（他端末使用中）・13（受け取るメールボックス）は filterDevices が担う。
 */
export function decide(input: NotifyInput): Decision {
	const { message, thread, mailbox, user, prefs, now } = input;

	if (user.role === "agent" || user.status === "disabled" || user.deviceCount === 0) {
		return { decision: "excluded", reason: "user_ineligible" };
	}
	// owner は割り当てが無くても特権で見える。キャッチオールの受け皿だけは通知候補に残し、それ以外は黙って外す。
	if (!user.assigned && !(user.role === "owner" && mailbox.isCatchAll)) {
		return {
			decision: "excluded",
			reason: user.role === "owner" ? "privilege_only" : "not_assigned",
		};
	}

	if (!prefs.enabled) return { decision: "dropped", reason: "disabled" };
	if (prefs.pausedUntil !== null && now < prefs.pausedUntil) {
		return { decision: "held", reason: "paused" };
	}

	if (message.discarded) return { decision: "dropped", reason: "rule_trashed" };
	if (message.markedRead) return { decision: "dropped", reason: "rule_read" };
	if (message.spamVerdict === "spam") return { decision: "dropped", reason: "spam" };
	if (message.spamVerdict === "suspicious" && prefs.spamSuspicious === "drop") {
		return { decision: "dropped", reason: "spam" };
	}
	if (thread.muted) return { decision: "dropped", reason: "thread_muted" };

	// ルールは prefs に優先順の上から並んでいる前提。最初に一致した 1 件だけが効く。
	const rule = prefs.rules.find((r) => r.enabled && matchNotification(r.matcher, message, mailbox, thread));
	if (rule) {
		const reason = `rule:${rule.id}` as const;
		switch (rule.action) {
			case "always":
				return { decision: "sent", reason, urgency: "high" };
			case "normal":
				return { decision: "sent", reason, urgency: "normal" };
			// 「音なし」は iOS で通常通知と同じになるが、判定は端末に委ねず silent として下流へ渡す。
			case "silent":
				return { decision: "sent", reason, urgency: "low", silent: true };
			case "never":
				return { decision: "dropped", reason };
		}
	}

	if (thread.followed) return { decision: "sent", reason: "thread_followed", urgency: "normal" };

	// 通知ルールはキャッチオールのスイッチより先に見ているので、「必ず通知」がオフを貫く。
	if (mailbox.isCatchAll && !prefs.notifyCatchAll) {
		return { decision: "dropped", reason: "catch_all_off" };
	}
	const level = prefs.mailboxLevels[mailbox.id] ?? "all";
	if (level === "off") return { decision: "dropped", reason: "mailbox_level" };
	if (level === "direct" && !isTo(message, mailbox)) {
		return { decision: "dropped", reason: "mailbox_level" };
	}
	if (level === "new_thread" && thread.messageCount > 0) {
		return { decision: "dropped", reason: "mailbox_level" };
	}

	if (prefs.quiet && scheduleIsQuiet(prefs.quiet, now)) return quietHeld(prefs.quiet);

	if (
		prefs.burstWindowSec > 0 &&
		thread.lastNotifiedAt !== null &&
		now - thread.lastNotifiedAt <= prefs.burstWindowSec * 1000
	) {
		return { decision: "sent", reason: "coalesced", urgency: "normal" };
	}

	return { decision: "sent", reason: "mailbox_level", urgency: "normal" };
}

export type SendFailureInput = {
	user: User;
	prefs: NotificationPrefs;
	now: number;
};

/** 送信失敗はメールボックスのレベルやルールで消えない知らせなので、3・4・11 だけを見る。 */
export function decideSendFailure(input: SendFailureInput): Decision {
	const { user, prefs, now } = input;
	if (user.role === "agent" || user.status === "disabled" || user.deviceCount === 0) {
		return { decision: "excluded", reason: "user_ineligible" };
	}
	if (!prefs.enabled || !prefs.notifySendFailure) return { decision: "dropped", reason: "disabled" };
	if (prefs.pausedUntil !== null && now < prefs.pausedUntil) {
		return { decision: "held", reason: "paused" };
	}
	if (prefs.quiet && scheduleIsQuiet(prefs.quiet, now)) return quietHeld(prefs.quiet);
	return { decision: "sent", reason: "send_failure", urgency: "normal" };
}

/** 端末ごとの結果。send 以外は下流でその端末に送らない。 */
export type DeviceResult = {
	deviceId: string;
	action: "send" | "suppress";
	reason: "active_elsewhere" | "device_filter" | "send";
};

export type Device = {
	id: string;
	enabled: boolean;
	/** 受け取るメールボックス。null なら全部。 */
	addressIds: string[] | null;
};

export type FilterDevicesInput = {
	devices: Device[];
	/** 対象のメールが届いたメールボックス。 */
	addressId: string;
	prefs: NotificationPrefs;
	/** どれかの端末でアプリが表示中（直近に使用中の合図があった）。画面で見えているので鳴らさない。 */
	activeElsewhere?: boolean;
	now: number;
};

/**
 * 端末単位の間引き。判定はすでに「送る」側で確定していても、端末ごとに
 * 受け取るメールボックス（13）と他端末使用中（12）で落とせる。
 */
export function filterDevices(input: FilterDevicesInput): DeviceResult[] {
	const suppressAll = input.prefs.suppressWhenActive && input.activeElsewhere === true;
	return input.devices.map((device) => {
		if (!device.enabled) return { deviceId: device.id, action: "suppress", reason: "device_filter" };
		if (device.addressIds !== null && !device.addressIds.includes(input.addressId)) {
			return { deviceId: device.id, action: "suppress", reason: "device_filter" };
		}
		if (suppressAll) {
			return { deviceId: device.id, action: "suppress", reason: "active_elsewhere" };
		}
		return { deviceId: device.id, action: "send", reason: "send" };
	});
}
