// キューは at-least-once なので、同じ rawKey を二重処理しないこと。
import { and, asc, desc, eq } from "drizzle-orm";
import { attachments, messages, routingRules, threads } from "@/db/schema";
import type { Db } from "@/db/client";
import { getDb } from "@/db/client";
import { newId } from "@/lib/id";
import { getRaw, putAttachment } from "@/services/r2";
import { MAX_RAW_BYTES } from "@/domain/routing/incoming";
import { parseRawMime, type ParsedAttachment, type ParsedMessage } from "./parse";
import { escapeHtml } from "./quote";
import { adjustThreadUnread, findExistingThreadId, updateThreadStats } from "./thread";
import { matchRule, type Matcher } from "@/domain/routing/rules";
import { baseAddressOf, normalizeAddress } from "./address";
import { dispatchMessageEvent } from "@/services/webhooks";
import type { InboundQueueMessage } from "@/services/queue";

export const MAX_ATTACHMENTS = 50;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

// D1 は 1 行が大きすぎると insert が例外になり、同じメールがキューの再試行で回り続ける。
// 送信者が自由に大きくできる値は、1 行の合計が 1MB を下回るよう保存前に切り詰める。
export const STORED_BYTES = {
	text: 256 * 1024,
	html: 512 * 1024,
	subject: 2 * 1024,
	addressList: 32 * 1024,
	references: 8 * 1024,
	short: 1024,
	contentType: 255,
} as const;

const TRUNCATED_NOTICE = "[本文が長すぎるため、途中から先は保存していません]";

// 受信 Date ヘッダは送信者が自由に書ける。極端な過去日はページングのカーソルを負数にし、
// 極端な未来日はスレッド一覧の先頭に居座り続けるので、外れ値は投入時刻に落とす。
const RECEIVED_AT_PAST_MS = 365 * 24 * 60 * 60 * 1000;
const RECEIVED_AT_FUTURE_MS = 10 * 60 * 1000;

function resolveReceivedAt(dateHeaderSeconds: number | null, queuedAtMs: number): Date {
	if (dateHeaderSeconds === null) return new Date(queuedAtMs);
	const headerMs = dateHeaderSeconds * 1000;
	if (headerMs < queuedAtMs - RECEIVED_AT_PAST_MS || headerMs > queuedAtMs + RECEIVED_AT_FUTURE_MS) {
		return new Date(queuedAtMs);
	}
	return new Date(headerMs);
}

const encoder = new TextEncoder();

/** マルチバイト文字の途中では切らない。 */
export function clampUtf8(value: string, maxBytes: number): string {
	if (value.length * 3 <= maxBytes) return value;
	const bytes = encoder.encode(value);
	if (bytes.byteLength <= maxBytes) return value;
	return new TextDecoder().decode(bytes.subarray(0, maxBytes)).replace(/\uFFFD+$/, "");
}

function clampNullable(value: string | null | undefined, maxBytes: number): string | null {
	return value == null ? null : clampUtf8(value, maxBytes);
}

function truncateBody(value: string | null, maxBytes: number): { body: string | null; truncated: boolean } {
	if (value === null) return { body: null, truncated: false };
	const clamped = clampUtf8(value, maxBytes);
	return { body: clamped, truncated: clamped !== value };
}

function partitionAttachments(list: ParsedAttachment[]): {
	kept: ParsedAttachment[];
	skipped: ParsedAttachment[];
} {
	const kept: ParsedAttachment[] = [];
	const skipped: ParsedAttachment[] = [];
	for (const att of list) {
		if (kept.length < MAX_ATTACHMENTS && att.sizeBytes <= MAX_ATTACHMENT_BYTES) kept.push(att);
		else skipped.push(att);
	}
	return { kept, skipped };
}

function skippedAttachmentsNotice(skipped: ParsedAttachment[]): string {
	const names = skipped
		.slice(0, 10)
		.map((a) => clampUtf8(a.filename, 200))
		.join(", ");
	const more = skipped.length > 10 ? ` ほか ${skipped.length - 10} 件` : "";
	return `[添付 ${skipped.length} 件は件数（${MAX_ATTACHMENTS} 件）またはサイズ（${
		MAX_ATTACHMENT_BYTES / 1024 / 1024
	}MB）の上限を超えたため保存していません: ${names}${more}]`;
}

function withNotices(
	text: string | null,
	html: string | null,
	notices: string[],
): { text: string | null; html: string | null } {
	if (notices.length === 0) return { text, html };
	const plain = notices.join("\n");
	return {
		text: text ? `${text}\n\n${plain}` : plain,
		html: html ? `${html}<hr><p>${notices.map(escapeHtml).join("<br>")}</p>` : null,
	};
}

/** 上限を超えた生 MIME はパースせず、届いたことだけが分かる形で残す。 */
function oversizedPlaceholder(msg: InboundQueueMessage, sizeBytes: number): ParsedMessage {
	const mb = (sizeBytes / 1024 / 1024).toFixed(1);
	const text =
		`このメールは ${mb}MB あり、取り込める上限（${MAX_RAW_BYTES / 1024 / 1024}MB）を超えているため、` +
		"本文と添付を取り込んでいません。生 MIME は保存してあります。";
	return {
		messageId: null,
		from: { address: msg.envelope.from },
		to: msg.envelope.to,
		cc: "",
		subject: "（サイズ上限を超えたメール）",
		text,
		html: null,
		inReplyTo: null,
		references: null,
		date: null,
		snippet: text.slice(0, 200),
		attachments: [],
	};
}

/**
 * postal-mime は入れ子が深すぎる・ヘッダが大きすぎるメールで throw する（#20）。
 * 再試行しても同じ生 MIME なので必ず同じ例外になり、DLQ に落ちるまで痕跡なく消えていた。
 * パースを諦めて placeholder を残し、生 MIME は R2 に残っているので後から調べられる。
 */
function parseErrorPlaceholder(msg: InboundQueueMessage, err: unknown): ParsedMessage {
	const reason = err instanceof Error ? err.message : String(err);
	const text = `このメールは解析できませんでした（${reason}）。生 MIME は保存してあります。`;
	return {
		messageId: null,
		from: { address: msg.envelope.from },
		to: msg.envelope.to,
		cc: "",
		subject: "（解析できなかったメール）",
		text,
		html: null,
		inReplyTo: null,
		references: null,
		date: null,
		snippet: text.slice(0, 200),
		attachments: [],
	};
}

type AddressRuleMatch = {
	from?: string;
	to?: string;
	subject?: string | null;
	text?: string | null;
};

/** 返値の read は「最終的な既読状態」。スレッド未読数の調整に使う。 */
async function applyAddressRules(
	db: Db,
	opts: { addressId: string; messageId: string; match: AddressRuleMatch },
): Promise<{ read: boolean; dropped: boolean }> {
	const rules = await db
		.select()
		.from(routingRules)
		.where(
			and(
				eq(routingRules.scope, "address"),
				eq(routingRules.addressId, opts.addressId),
				eq(routingRules.enabled, true),
			),
		)
		.orderBy(desc(routingRules.priority), asc(routingRules.createdAt))
		.all();

	let read = false;
	let starred = false;
	let dropped = false;

	// resolve.ts の配送判定と同じく、正規化した宛先と +タグ を落とした基本アドレスにもルールを当てる。
	// envelope の生の値は引用ローカル部・末尾ドットを持てるので、リテラル一致だけだと
	// `"a"@example.com` / `a.@example.com` 宛の drop ルールをすり抜けられる（#28）。
	const toCandidates = [
		opts.match.to,
		opts.match.to ? normalizeAddress(opts.match.to) ?? undefined : undefined,
		opts.match.to ? baseAddressOf(opts.match.to) ?? undefined : undefined,
	];
	for (const rule of rules) {
		const matcher = rule.matcher as Matcher;
		const matched = toCandidates.some((to) => matchRule(matcher, { ...opts.match, to }));
		if (!matched) continue;
		if (rule.action === "mark") {
			if (rule.target === "read") read = true;
			else if (rule.target === "unread") read = false;
			else if (rule.target === "star") starred = true;
			else if (rule.target === "unstar") starred = false;
		} else if (rule.action === "drop") {
			dropped = true;
		}
	}

	const updates: { isRead: boolean; isStarred: boolean; status?: "trash" } = {
		isRead: read,
		isStarred: starred,
	};
	if (dropped) updates.status = "trash";
	await db.update(messages).set(updates).where(eq(messages.id, opts.messageId));

	return { read, dropped };
}

export async function processInbound(
	msg: InboundQueueMessage,
	env: CloudflareEnv,
	ctx: ExecutionContext,
): Promise<void> {
	void ctx;
	const db = getDb(env);

	// キューは at-least-once。同じ rawKey が保存済みならスキップする。
	const dup = await db
		.select({ id: messages.id })
		.from(messages)
		.where(eq(messages.rawR2Key, msg.rawKey))
		.get();
	if (dup) return;

	const rawObj = await getRaw(env, msg.rawKey);
	if (!rawObj) throw new Error(`生 MIME が見つかりません: ${msg.rawKey}`);
	const sizeBytes = rawObj.size;

	const parsed = await (async () => {
		if (sizeBytes > MAX_RAW_BYTES) return oversizedPlaceholder(msg, sizeBytes);
		// R2 からの読み出し自体はここでは囲わない。読み出し失敗まで placeholder にすると
		// 行が保存されて ack され、再配達が rawR2Key の重複判定で捨てられて本文が永久に取り込めない（#56）。
		// 読み出しは投げっぱなしにしてキューに再配達させ、パースの例外だけ placeholder にする。
		const bytes = new Uint8Array(await rawObj.arrayBuffer());
		try {
			return await parseRawMime(bytes);
		} catch (err) {
			console.error("受信メールの解析に失敗した", { rawKey: msg.rawKey, err });
			return parseErrorPlaceholder(msg, err);
		}
	})();
	const receivedAt = resolveReceivedAt(parsed.date, msg.receivedAt);
	const subject = clampNullable(parsed.subject, STORED_BYTES.subject);

	const existingThread = await findExistingThreadId(db, {
		addressId: msg.addressId,
		inReplyTo: parsed.inReplyTo,
		references: parsed.references,
		fromAddr: parsed.from?.address ?? null,
	});
	const isNewThread = existingThread === null;
	// 新規スレッドの行は message の insert と同じ batch で立てる。分けて insert すると
	// message が落ちたとき空スレッド行が残り、再配達で rawR2Key の dup 判定に掛からず
	// また新スレッドが生える（精査 #91）。
	const newThreadId = isNewThread ? newId("thread") : null;
	const threadId = existingThread ?? newThreadId!;

	const { kept, skipped } = partitionAttachments(parsed.attachments);
	const text = truncateBody(parsed.text, STORED_BYTES.text);
	const html = truncateBody(parsed.html, STORED_BYTES.html);
	const notices: string[] = [];
	if (text.truncated || html.truncated) notices.push(TRUNCATED_NOTICE);
	if (skipped.length > 0) notices.push(skippedAttachmentsNotice(skipped));
	const bodies = withNotices(text.body, html.body, notices);
	if (notices.length > 0) {
		console.warn("受信メールの一部を上限で切り詰めた", {
			rawKey: msg.rawKey,
			truncatedBody: text.truncated || html.truncated,
			skippedAttachments: skipped.length,
		});
	}

	const messageId = newId("message");
	const messageInsert = db.insert(messages).values({
		id: messageId,
		threadId,
		addressId: msg.addressId,
		direction: "inbound",
		status: "received",
		rfcMessageId: clampNullable(parsed.messageId, STORED_BYTES.short),
		inReplyTo: clampNullable(parsed.inReplyTo, STORED_BYTES.short),
		referencesHeader: clampNullable(parsed.references, STORED_BYTES.references),
		fromAddr: clampUtf8(parsed.from?.address ?? "", STORED_BYTES.short),
		fromName: clampNullable(parsed.from?.name, STORED_BYTES.short),
		toAddr: clampUtf8(parsed.to, STORED_BYTES.addressList),
		ccAddr: clampNullable(parsed.cc || null, STORED_BYTES.addressList),
		subject,
		snippet: parsed.snippet,
		textBody: bodies.text,
		htmlBody: bodies.html,
		rawR2Key: msg.rawKey,
		sizeBytes,
		hasAttachments: kept.length > 0,
		isRead: false,
		isStarred: false,
		receivedAt,
	});
	if (isNewThread) {
		// 新規スレッドは messageCount:1・unreadCount:1 で初期化するので、後に足さない。
		const threadInsert = db.insert(threads).values({
			id: newThreadId!,
			addressId: msg.addressId,
			subject,
			lastMessageAt: receivedAt,
			messageCount: 1,
			unreadCount: 1,
		});
		await db.batch([threadInsert, messageInsert]);
	} else {
		await messageInsert;
	}

	for (const att of kept) {
		const attachmentId = newId("attachment");
		const r2Key = await putAttachment(env, messageId, attachmentId, att.content, att.contentType);
		await db.insert(attachments).values({
			id: attachmentId,
			messageId,
			filename: clampUtf8(att.filename, STORED_BYTES.short),
			contentType: clampUtf8(att.contentType, STORED_BYTES.contentType),
			sizeBytes: att.sizeBytes,
			contentId: clampNullable(att.contentId, STORED_BYTES.short),
			isInline: att.isInline,
			r2Key,
		});
	}

	// 新規スレッドは作成時に 1 件・未読 1 で初期化済みなので、二重に足さない。
	if (!isNewThread) {
		await updateThreadStats(db, { threadId, lastMessageAt: receivedAt, unreadDelta: 1 });
	}

	const { read, dropped } = await applyAddressRules(db, {
		addressId: msg.addressId,
		messageId,
		// To ヘッダは送信者が書き換えられる。実際の宛先であるエンベロープで照合する。
		match: {
			from: parsed.from?.address,
			to: msg.envelope.to,
			subject: parsed.subject,
			text: parsed.text,
		},
	});
	// drop はスレッド未読数も減らす。queryThreads / サイドバーは trash を除外するので、
	// 足したままだと一覧の未読と食い違う（精査 #92）。
	if (read || dropped) {
		await adjustThreadUnread(db, threadId, -1);
	}

	await dispatchMessageEvent(env, "message.received", messageId);
}
