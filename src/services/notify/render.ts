import type { NotificationPrefs } from "@/domain/notify/decide";
import type { MessageContext } from "./load";

const APP_NAME = "Tsubame";

function snippet80(body: string | null | undefined): string {
	if (!body) return "";
	return body.replace(/\s+/g, " ").trim().slice(0, 80);
}

export function buildReceivedBody(ctx: MessageContext, prefs: NotificationPrefs): string {
	if (prefs.display === "minimal") {
		return ctx.mailbox.isCatchAll ? "キャッチオール" : `新着メール · ${ctx.mailbox.name}`;
	}
	const subject = ctx.message.subject ?? "";
	const base =
		prefs.display === "full"
			? `${subject} ／ ${snippet80(ctx.message.textBody)}`
			: subject;
	if (!ctx.mailbox.isCatchAll) return base;
	const dest = ctx.envelopeTo ? `宛先 ${ctx.envelopeTo}` : "宛先不明";
	return `キャッチオール ・ ${dest}\n${base}`;
}

export type ReceivedOptions = {
	appBadge?: number;
	silent?: boolean;
	shrink?: boolean;
};

export function buildReceived(
	ctx: MessageContext,
	threadId: string,
	prefs: NotificationPrefs,
	opts: ReceivedOptions = {},
): string {
	const title =
		prefs.display === "minimal"
			? APP_NAME
			: ctx.message.fromName || ctx.message.fromAddr || "(不明な差出人)";
	let body = buildReceivedBody(ctx, prefs);
	if (opts.shrink) body = body.slice(0, 60) || "新着メール";

	const data: Record<string, unknown> = { messageId: ctx.message.id };
	const notification: Record<string, unknown> = {
		title,
		body,
		navigate: `/threads/${threadId}`,
		data,
		actions: [
			{ action: "read", title: "既読にする" },
			{ action: "trash", title: "ゴミ箱へ" },
		],
	};
	// 「同じ会話は 1 件にまとめる」がオフなら、tag と data.threadId を入れない。
	// sw は data.threadId で既存通知を閉じるので、入れなければまとまらない。
	if (prefs.groupByThread) {
		notification.tag = threadId;
		data.threadId = threadId;
	}
	if (opts.appBadge !== undefined) notification.app_badge = opts.appBadge;
	if (opts.silent) notification.silent = true;
	return JSON.stringify({ web_push: 8030, notification });
}

/** 短時間に続いた分を 1 通に置き換えた通知（PN-4-14）。 */
export function buildCoalesced(threadId: string, count: number, opts: { appBadge?: number } = {}): string {
	const notification: Record<string, unknown> = {
		title: APP_NAME,
		body: `新着 ${count} 件`,
		navigate: `/threads/${threadId}`,
		tag: threadId,
		data: { threadId },
	};
	if (opts.appBadge !== undefined) notification.app_badge = opts.appBadge;
	return JSON.stringify({ web_push: 8030, notification });
}

export function buildFailure(
	ctx: MessageContext,
	threadId: string,
	shrink = false,
): string {
	const subject = ctx.message.subject ?? "";
	const body = shrink ? "送信に失敗しました" : `送信に失敗しました ／ ${subject}`;
	return JSON.stringify({
		web_push: 8030,
		notification: {
			title: APP_NAME,
			body,
			navigate: `/threads/${threadId}`,
			tag: threadId,
			data: { threadId, messageId: ctx.message.id },
		},
	});
}

export function buildTest(): string {
	return JSON.stringify({
		web_push: 8030,
		notification: { title: APP_NAME, body: "テスト通知", navigate: "/", data: {} },
	});
}

export function buildDigest(count: number): string {
	return JSON.stringify({
		web_push: 8030,
		notification: {
			title: APP_NAME,
			body: `おやすみ中に ${count} 件の新着`,
			navigate: "/",
			data: {},
		},
	});
}
