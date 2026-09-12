import { describe, expect, it } from "vitest";
import { defaultPrefs } from "@/domain/notify/decide";
import type { MessageContext } from "@/services/notify/load";
import { buildCoalesced, buildReceived, buildReceivedBody } from "@/services/notify/render";

const ctx: MessageContext = {
	message: {
		id: "msg_1",
		addressId: "adr_1",
		direction: "inbound",
		fromAddr: "bob@example.com",
		fromName: "ボブ",
		toAddr: "info@example.com",
		ccAddr: null,
		subject: "こんにちは",
		textBody: "本文",
		hasAttachments: false,
		spamVerdict: "clean",
	},
	mailbox: { id: "adr_1", address: "info@example.com", name: "受付", isCatchAll: false },
	thread: { id: "thr_1", messageCount: 0, hasOutbound: false, followed: false, muted: false, lastNotifiedAt: null },
	sentByUserId: null,
	envelopeTo: null,
};

describe("buildReceivedBody 最小限", () => {
	it("メールボックス名を出す（PN-5-5）", () => {
		expect(buildReceivedBody(ctx, { ...defaultPrefs, display: "minimal" })).toBe("新着メール · 受付");
	});

	it("キャッチオールの最小限は宛先を出さない", () => {
		const catchAll = { ...ctx, mailbox: { ...ctx.mailbox, isCatchAll: true } };
		expect(buildReceivedBody(catchAll, { ...defaultPrefs, display: "minimal" })).toBe("キャッチオール");
	});
});

describe("buildReceived まとめ（PN-6-2）", () => {
	it("group_by_thread オンなら tag と data.threadId を入れる", () => {
		const payload = JSON.parse(buildReceived(ctx, "thr_1", defaultPrefs)) as { notification: Record<string, unknown> };
		expect(payload.notification.tag).toBe("thr_1");
		expect((payload.notification.data as Record<string, unknown>).threadId).toBe("thr_1");
	});

	it("group_by_thread オフなら tag も data.threadId も入れない", () => {
		const payload = JSON.parse(
			buildReceived(ctx, "thr_1", { ...defaultPrefs, groupByThread: false }),
		) as { notification: Record<string, unknown> };
		expect(payload.notification.tag).toBeUndefined();
		expect((payload.notification.data as Record<string, unknown>).threadId).toBeUndefined();
	});
});

describe("buildCoalesced（PN-4-14）", () => {
	it("「新着 N 件」の 1 通として tag を付ける", () => {
		const payload = JSON.parse(buildCoalesced("thr_1", 5)) as {
			notification: { title: string; body: string; tag: string; app_badge?: number };
		};
		expect(payload.notification.body).toBe("新着 5 件");
		expect(payload.notification.tag).toBe("thr_1");
	});

	it("app_badge を渡せる", () => {
		const payload = JSON.parse(buildCoalesced("thr_1", 2, { appBadge: 7 })) as {
			notification: { app_badge?: number };
		};
		expect(payload.notification.app_badge).toBe(7);
	});
});
