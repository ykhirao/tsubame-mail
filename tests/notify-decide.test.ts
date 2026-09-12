import { describe, expect, it } from "vitest";
import {
	defaultPrefs,
	decide,
	decideSendFailure,
	filterDevices,
	matchNotification,
	type Mailbox,
	type Message,
	type NotificationPrefs,
	type QuietSchedule,
	type Thread,
	type User,
} from "@/domain/notify/decide";

const message: Message = {
	id: "msg_1",
	addressId: "adr_1",
	direction: "inbound",
	fromAddr: "bob@example.com",
	fromName: null,
	toAddr: "info@example.com",
	ccAddr: null,
	subject: "こんにちは",
	textBody: "本文です",
	hasAttachments: false,
	spamVerdict: "clean",
};

const thread: Thread = {
	id: "thr_1",
	messageCount: 3,
	hasOutbound: false,
	followed: false,
	muted: false,
	lastNotifiedAt: null,
};

const mailbox: Mailbox = { id: "adr_1", address: "info@example.com", name: "info@example.com", isCatchAll: false };

const user: User = { id: "usr_1", role: "member", status: "active", deviceCount: 1, assigned: true };

const dayLongQuiet: QuietSchedule = { tz: "Asia/Tokyo", mode: "drop", ranges: [{ days: [], start: 0, end: 1440 }] };

const NOW = Date.UTC(2026, 5, 1, 3, 0);

function args(over: Partial<Parameters<typeof decide>[0]> = {}) {
	return {
		message,
		thread,
		mailbox,
		user,
		prefs: defaultPrefs,
		now: NOW,
		...over,
	};
}

const expectReason = (over: Parameters<typeof decide>[0], reason: string) => {
	const d = decide(over);
	expect(d.reason).toBe(reason);
	return d;
};

describe("decide 表 1・2: 対象外", () => {
	it("agent は対象外", () => {
		expect(decide(args({ user: { ...user, role: "agent" } })).decision).toBe("excluded");
	});
	it("無効な利用者は対象外", () => {
		expect(decide(args({ user: { ...user, status: "disabled" } })).decision).toBe("excluded");
	});
	it("購読端末 0 は対象外", () => {
		expect(decide(args({ user: { ...user, deviceCount: 0 } })).decision).toBe("excluded");
	});
	it("member で割り当てが無いと対象外", () => {
		const d = expectReason(args({ user: { ...user, assigned: false } }), "not_assigned");
		expect(d.decision).toBe("excluded");
	});
	it("owner で割り当て無しは対象外（キャッチオール・レベル明示でも同じ）", () => {
		for (const over of [
			{ user: { ...user, role: "owner" as const, assigned: false } },
			{
				user: { ...user, role: "owner" as const, assigned: false },
				prefs: { ...defaultPrefs, mailboxLevels: { [mailbox.id]: "all" as const } },
			},
			{
				user: { ...user, role: "owner" as const, assigned: false },
				mailbox: { ...mailbox, isCatchAll: true },
			},
		] as Parameters<typeof args>[0][]) {
			const d = decide(args(over));
			expect(d.reason).toBe("not_assigned");
			expect(d.decision).toBe("excluded");
		}
	});
	it("owner で割り当てられていれば通知レベルに従う", () => {
		const optIn = (level: "all" | "off") =>
			args({
				user: { ...user, role: "owner", assigned: true },
				prefs: { ...defaultPrefs, mailboxLevels: { [mailbox.id]: level } },
			});
		expect(decide(optIn("all")).decision).toBe("sent");
		expect(decide(optIn("off")).decision).not.toBe("sent");
	});
	it("owner で割り当てたキャッチオールなら通知される", () => {
		const d = expectReason(
			args({ user: { ...user, role: "owner", assigned: true }, mailbox: { ...mailbox, isCatchAll: true } }),
			"mailbox_level",
		);
		expect(d.decision).toBe("sent");
	});
});

describe("decide 表 3〜11", () => {
	it("全体オフで送らない", () => {
		const d = expectReason(args({ prefs: { ...defaultPrefs, enabled: false } }), "disabled");
		expect(d.decision).toBe("dropped");
	});
	it("一時停止中は保留（解除後も通知しない）", () => {
		const d = expectReason(
			args({ prefs: { ...defaultPrefs, pausedUntil: NOW + 60_000 } }),
			"paused",
		);
		expect(d.decision).toBe("held");
	});
	it("ルールで破棄されたものは送らない", () => {
		expect(expectReason(args({ message: { ...message, discarded: true } }), "rule_trashed").decision).toBe("dropped");
	});
	it("ルールで既読にされたものは送らない", () => {
		expect(expectReason(args({ message: { ...message, markedRead: true } }), "rule_read").decision).toBe("dropped");
	});
	it("スパム判定は送らない", () => {
		expect(expectReason(args({ message: { ...message, spamVerdict: "spam" } }), "spam").decision).toBe("dropped");
	});
	it("スパム疑いは既定で送らない", () => {
		expect(expectReason(args({ message: { ...message, spamVerdict: "suspicious" } }), "spam").decision).toBe("dropped");
	});
	it("スパム疑いを通知設定にすると通る", () => {
		expect(decide(args({ prefs: { ...defaultPrefs, spamSuspicious: "notify" }, message: { ...message, spamVerdict: "suspicious" } })).decision).toBe("sent");
	});
	it("会話をミュートしていると送らない", () => {
		expect(expectReason(args({ thread: { ...thread, muted: true } }), "thread_muted").decision).toBe("dropped");
	});
});

describe("decide 表 8: 通知ルール", () => {
	const rule = (action: "always" | "normal" | "silent" | "never") => ({
		prefs: {
			...defaultPrefs,
			rules: [{ id: "nrl_1", action, enabled: true, matcher: { from: "bob@example.com" } }],
		},
	});
	it("必ず通知は high で送る", () => {
		expect(decide(args(rule("always")))).toEqual({
			decision: "sent",
			reason: "rule:nrl_1",
			urgency: "high",
		});
	});
	it("通知は normal で送る", () => {
		expect(decide(args(rule("normal")))).toEqual({
			decision: "sent",
			reason: "rule:nrl_1",
			urgency: "normal",
		});
	});
	it("音なしで通知は silent", () => {
		expect(decide(args(rule("silent")))).toEqual({
			decision: "sent",
			reason: "rule:nrl_1",
			urgency: "low",
			silent: true,
		});
	});
	it("通知しないは落とす", () => {
		expect(decide(args(rule("never")))).toEqual({ decision: "dropped", reason: "rule:nrl_1" });
	});
	it("無効なルールは飛ばされる", () => {
		expect(decide(args({ prefs: { ...defaultPrefs, rules: [{ id: "nrl_1", action: "always", enabled: false, matcher: { from: "bob" } }] } })).decision).toBe("sent");
	});
	it("必ず通知はキャッチオールのスイッチがオフでも通る", () => {
		const d = expectReason(
			args({
				user: { ...user, role: "owner", assigned: true },
				mailbox: { ...mailbox, isCatchAll: true },
				prefs: { ...defaultPrefs, notifyCatchAll: false, rules: [{ id: "nrl_1", action: "always", enabled: true, matcher: { from: "bob" } }] },
			}),
			"rule:nrl_1",
		);
		expect(d.decision).toBe("sent");
	});
});

describe("decide 表 9・10: フォローとメールボックスレベル", () => {
	it("会話をフォローしていると通知", () => {
		expect(decide(args({ thread: { ...thread, followed: true } }))).toEqual({
			decision: "sent",
			reason: "thread_followed",
			urgency: "normal",
		});
	});
	it("レベル off は落とす", () => {
		expect(expectReason(args({ prefs: { ...defaultPrefs, mailboxLevels: { adr_1: "off" } } }), "mailbox_level").decision).toBe("dropped");
	});
	it("direct で To に入っていなければ落とす", () => {
		expect(expectReason(args({ prefs: { ...defaultPrefs, mailboxLevels: { adr_1: "direct" } }, message: { ...message, toAddr: "other@example.com" } }), "mailbox_level").decision).toBe("dropped");
	});
	it("direct で To に入っていれば通知", () => {
		expect(decide(args({ prefs: { ...defaultPrefs, mailboxLevels: { adr_1: "direct" } } })).decision).toBe("sent");
	});
	it("new_thread で既存スレッドへの返信は落とす", () => {
		expect(expectReason(args({ prefs: { ...defaultPrefs, mailboxLevels: { adr_1: "new_thread" } }, thread: { ...thread, messageCount: 3 } }), "mailbox_level").decision).toBe("dropped");
	});
	it("new_thread で新しい会話は通知", () => {
		expect(decide(args({ prefs: { ...defaultPrefs, mailboxLevels: { adr_1: "new_thread" } }, thread: { ...thread, messageCount: 0 } })).decision).toBe("sent");
	});
});

describe("decide 表 10・11・14", () => {
	it("キャッチオールのスイッチがオフなら落とす", () => {
		expect(expectReason(args({ mailbox: { ...mailbox, isCatchAll: true }, prefs: { ...defaultPrefs, notifyCatchAll: false } }), "catch_all_off").decision).toBe("dropped");
	});
	it("おやすみ drop は保留", () => {
		expect(expectReason(args({ prefs: { ...defaultPrefs, quiet: dayLongQuiet } }), "quiet_drop").decision).toBe("held");
	});
	it("おやすみ digest は digest", () => {
		const d = expectReason(args({ prefs: { ...defaultPrefs, quiet: { ...dayLongQuiet, mode: "digest" } } }), "quiet_digest");
		expect(d.decision).toBe("digest");
	});
	it("必ず通知はおやすみ中も通る", () => {
		const d = expectReason(
			args({
				prefs: {
					...defaultPrefs,
					quiet: dayLongQuiet,
					rules: [{ id: "nrl_1", action: "always", enabled: true, matcher: { from: "bob" } }],
				},
			}),
			"rule:nrl_1",
		);
		expect(d.decision).toBe("sent");
	});
	it("窓内の直近送信があると連続まとめ", () => {
		const d = expectReason(
			args({ prefs: { ...defaultPrefs, burstWindowSec: 60 }, thread: { ...thread, lastNotifiedAt: NOW - 10_000 } }),
			"coalesced",
		);
		expect(d.decision).toBe("sent");
	});
	it("窓外の直近送信はまとめない", () => {
		expect(decide(args({ prefs: { ...defaultPrefs, burstWindowSec: 60 }, thread: { ...thread, lastNotifiedAt: NOW - 120_000 } })).decision).toBe("sent");
	});
	it("既定（レベル all）は通知", () => {
		expect(decide(args())).toEqual({ decision: "sent", reason: "mailbox_level", urgency: "normal" });
	});
});

describe("decideSendFailure（3・4・11 だけ）", () => {
	const base = { user, prefs: defaultPrefs, now: NOW };
	it("agent は対象外", () => {
		expect(decideSendFailure({ ...base, user: { ...user, role: "agent" } }).decision).toBe("excluded");
	});
	it("全体オフ or 送信失敗通知オフで落とす", () => {
		expect(decideSendFailure({ ...base, prefs: { ...defaultPrefs, notifySendFailure: false } })).toEqual({
			decision: "dropped",
			reason: "disabled",
		});
		expect(decideSendFailure({ ...base, prefs: { ...defaultPrefs, enabled: false } })).toEqual({
			decision: "dropped",
			reason: "disabled",
		});
	});
	it("一時停止中は保留", () => {
		expect(decideSendFailure({ ...base, prefs: { ...defaultPrefs, pausedUntil: NOW + 60_000 } })).toEqual({
			decision: "held",
			reason: "paused",
		});
	});
	it("おやすみ中の扱い", () => {
		expect(decideSendFailure({ ...base, prefs: { ...defaultPrefs, quiet: dayLongQuiet } }).decision).toBe("held");
		expect(decideSendFailure({ ...base, prefs: { ...defaultPrefs, quiet: { ...dayLongQuiet, mode: "digest" } } }).decision).toBe("digest");
	});
	it("メールボックスのレベルやルールには消されない", () => {
		const prefs: NotificationPrefs = {
			...defaultPrefs,
			mailboxLevels: { adr_1: "off" },
			rules: [{ id: "nrl_1", action: "never", enabled: true, matcher: { from: "bob" } }],
		};
		expect(decideSendFailure({ ...base, prefs })).toEqual({
			decision: "sent",
			reason: "send_failure",
			urgency: "normal",
		});
	});
});

describe("matchNotification", () => {
	const m = { ...message, ccAddr: "info@example.com" };
	const box = mailbox;
	it("空 matcher は全件一致", () => {
		expect(matchNotification({}, m, box, thread)).toBe(true);
	});
	it("差出人の部分一致（大文字小文字を無視）", () => {
		expect(matchNotification({ from: "BOB@" }, m, box, thread)).toBe(true);
		expect(matchNotification({ from: "alice" }, m, box, thread)).toBe(false);
	});
	it("件名・本文・宛先の部分一致", () => {
		expect(matchNotification({ subject: "こんにち" }, m, box, thread)).toBe(true);
		expect(matchNotification({ body: "本文" }, m, box, thread)).toBe(true);
		expect(matchNotification({ to: "info@example.com" }, m, box, thread)).toBe(true);
		expect(matchNotification({ to: "elsewhere" }, m, box, thread)).toBe(false);
	});
	it("メールボックス・添付あり", () => {
		expect(matchNotification({ mailboxIds: ["adr_1"] }, m, box, thread)).toBe(true);
		expect(matchNotification({ mailboxIds: ["adr_2"] }, m, box, thread)).toBe(false);
		expect(matchNotification({ hasAttachment: true }, m, box, thread)).toBe(false);
		expect(matchNotification({ hasAttachment: true }, { ...m, hasAttachments: true }, box, thread)).toBe(true);
	});
	it("自分たちが送った会話への返信", () => {
		expect(matchNotification({ replyToOwn: true }, m, box, thread)).toBe(false);
		expect(matchNotification({ replyToOwn: true }, m, box, { ...thread, hasOutbound: true })).toBe(true);
	});
	it("CC にだけ入っている", () => {
		// to にも入っているので cc+to は CC-only にならない
		expect(matchNotification({ ccOnly: true }, m, box, thread)).toBe(false);
		const ccOnlyMsg: Message = { ...m, toAddr: "other@example.com" };
		expect(matchNotification({ ccOnly: true }, ccOnlyMsg, box, thread)).toBe(true);
	});
	it("すべての条件を満たす", () => {
		const matcher = { from: "bob", subject: "こんにち", hasAttachment: true };
		expect(matchNotification(matcher, { ...m, hasAttachments: true }, box, thread)).toBe(true);
	});
});

describe("filterDevices（表 12・13）", () => {
	const devices = [
		{ id: "dev_1", enabled: true, addressIds: null },
		{ id: "dev_2", enabled: true, addressIds: ["adr_1"] },
	];
	it("受け取るメールボックスに含まれない端末は間引く", () => {
		const r = filterDevices({
			devices: [{ id: "dev_3", enabled: true, addressIds: ["adr_9"] }],
			addressId: "adr_1",
			prefs: defaultPrefs,
			now: NOW,
		});
		expect(r).toEqual([{ deviceId: "dev_3", action: "suppress", reason: "device_filter" }]);
	});
	it("無効な端末は間引く", () => {
		const r = filterDevices({ devices: [{ id: "dev_1", enabled: false, addressIds: null }], addressId: "adr_1", prefs: defaultPrefs, now: NOW });
		expect(r[0]).toEqual({ deviceId: "dev_1", action: "suppress", reason: "device_filter" });
	});
	it("使用中の端末があり、抑える設定なら全端末に送らない", () => {
		const two = [
			{ id: "dev_a", enabled: true, addressIds: null },
			{ id: "dev_b", enabled: true, addressIds: null },
		];
		const r = filterDevices({
			devices: two,
			addressId: "adr_1",
			prefs: { ...defaultPrefs, suppressWhenActive: true },
			activeElsewhere: true,
			now: NOW,
		});
		expect(r.map((x) => x.reason)).toEqual(["active_elsewhere", "active_elsewhere"]);
		const off = filterDevices({ devices: two, addressId: "adr_1", prefs: defaultPrefs, activeElsewhere: true, now: NOW });
		expect(off.every((x) => x.action === "send")).toBe(true);
	});
	it("対象の端末は送る", () => {
		const r = filterDevices({ devices, addressId: "adr_1", prefs: defaultPrefs, now: NOW });
		expect(r.every((x) => x.action === "send")).toBe(true);
	});
});
