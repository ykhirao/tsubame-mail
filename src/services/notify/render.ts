import type { NotificationPrefs } from "@/domain/notify/decide";
import type { MessageContext } from "./load";

const APP_NAME = "Tsubame";

function snippet80(body: string | null | undefined): string {
	if (!body) return "";
	return body.replace(/\s+/g, " ").trim().slice(0, 80);
}

export function buildReceivedBody(ctx: MessageContext, prefs: NotificationPrefs): string {
	if (prefs.display === "minimal") {
		return ctx.mailbox.isCatchAll ? "キャッチオール" : `新着メール · ${ctx.mailbox.address}`;
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

	const notification: Record<string, unknown> = {
		title,
		body,
		navigate: `/threads/${threadId}`,
		tag: threadId,
		data: { threadId, messageId: ctx.message.id },
		actions: [
			{ action: "read", title: "既読にする" },
			{ action: "trash", title: "ゴミ箱へ" },
		],
	};
	if (opts.appBadge !== undefined) notification.app_badge = opts.appBadge;
	if (opts.silent) notification.silent = true;
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
