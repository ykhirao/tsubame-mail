// キューは at-least-once なので、同じ rawKey を二重処理しないこと。
import { and, asc, desc, eq } from "drizzle-orm";
import { attachments, messages, routingRules } from "@/db/schema";
import type { Db } from "@/db/client";
import { getDb } from "@/db/client";
import { newId } from "@/lib/id";
import { getRaw, putAttachment } from "@/services/r2";
import { MAX_RAW_BYTES } from "@/domain/routing/incoming";
import { parseRawMime, spamVerdictFromScore, type ParsedAttachment, type ParsedMessage } from "./parse";
import { escapeHtml } from "./quote";
import { createThreadStatement, findExistingThreadId, updateThreadStatsStatement } from "./thread";
import { matchRule, type Matcher } from "@/domain/routing/rules";
import { baseAddressOf, normalizeAddress } from "./address";
import { canonicalAddress, canonicalMatcher } from "@/domain/routing/resolve";
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

// placeholder は envelope の値のまま保存する。MAIL FROM は送信者が自由に書けるので、
// カンマが混じると保存を読み直したときに宛先が割れる。正規化して落とす（#82 再検査失敗）。
function sanitizeEnvelope(value: string): string {
	return normalizeAddress(value) ?? "";
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
		from: { address: sanitizeEnvelope(msg.envelope.from) },
		to: sanitizeEnvelope(msg.envelope.to),
		cc: "",
		subject: "（サイズ上限を超えたメール）",
		text,
		html: null,
		inReplyTo: null,
		references: null,
		date: null,
		snippet: text.slice(0, 200),
		attachments: [],
		inboundAuth: null,
		cfSpamScore: null,
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
		from: { address: sanitizeEnvelope(msg.envelope.from) },
		to: sanitizeEnvelope(msg.envelope.to),
		cc: "",
		subject: "（解析できなかったメール）",
		text,
		html: null,
		inReplyTo: null,
		references: null,
		date: null,
		snippet: text.slice(0, 200),
		attachments: [],
		inboundAuth: null,
		cfSpamScore: null,
	};
}

type AddressRuleMatch = {
	from?: string;
	to?: string;
	subject?: string | null;
	text?: string | null;
};

/** 判定は messages の insert に status / isRead / isStarred として反映し、書き込みは batch に任せる（#77）。 */
async function matchAddressRules(
	db: Db,
	opts: { addressId: string; match: AddressRuleMatch },
): Promise<{ read: boolean; starred: boolean; dropped: boolean }> {
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
	// 配送判定が使う canonicalAddress（punycode）と NFKC 畳み込みも候補に足して、catch-all 経由で
	// 全角ローカル部や Unicode ドメインが届いても a のルールに当てる（#73）。
	const to = opts.match.to;
	const candidates = new Set<string>();
	const addCandidate = (s: string | undefined) => {
		if (!s) return;
		candidates.add(s);
		candidates.add(s.normalize("NFKC").toLowerCase());
	};
	addCandidate(to);
	if (to) {
		addCandidate(normalizeAddress(to) ?? undefined);
		addCandidate(baseAddressOf(to) ?? undefined);
	}
	const canonical = to ? canonicalAddress(to) ?? undefined : undefined;
	addCandidate(canonical);
	if (canonical) addCandidate(baseAddressOf(canonical) ?? undefined);
	const toCandidates = [...candidates];
	for (const rule of rules) {
		// resolve.ts のドメインスコープと同じく、matcher 側も punycode / NFC に揃え、
		// 候補の畳み込みと同じ NFKC の小文字化を通してから比べる（#124）。全角ローカル部の
		// matcher や Unicode ドメインの matcher が punycode / ASCII の envelope に当たる。
		const m = canonicalMatcher(rule.matcher as Matcher);
		const norm = {
			from: m.from ? m.from.normalize("NFKC").toLowerCase() : undefined,
			to: m.to ? m.to.normalize("NFKC").toLowerCase() : undefined,
		};
		const matched = toCandidates.some((c) =>
			matchRule({ ...m, ...norm }, { ...opts.match, to: c }),
		);
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

	return { read, starred, dropped };
}

export async function processInbound(
	msg: InboundQueueMessage,
	env: CloudflareEnv,
	ctx: ExecutionContext,
): Promise<void> {
	void ctx;
	const db = getDb(env);

	// キューは at-least-once。行が既にあれば、本文・添付・統計・ルールは batch で一括済み。
	// 残るのは Webhook 配信だけなので、再配達ではその re-run に徹する（精査 #77）。dispatch は冪等。
	const dup = await db
		.select({ id: messages.id, status: messages.status, createdAt: messages.createdAt })
		.from(messages)
		.where(eq(messages.rawR2Key, msg.rawKey))
		.get();
	if (dup) {
		// drop（trash）にしたメールへは外部通知しない。dup 経路も同じ（#123）。
		// 再配達の対象は、メッセージを受け取った時点で存在した webhook（createdAt が
		// メッセージの作成時刻以前のもの）に限る（#122）。
		if (dup.status !== "trash") {
			await dispatchMessageEvent(env, "message.received", dup.id, {
				webhookCreatedBefore: dup.createdAt,
			});
		}
		await enqueueNotify(env, dup.id);
		return;
	}

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
		inboundAuth: parsed.inboundAuth,
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

	// ルールの判定は insert 前に計算し、messages の insert に status / isRead / isStarred として反映する。
	// To ヘッダは送信者が書き換えられる。実際の宛先であるエンベロープで照合する（#77）。
	const { read, starred, dropped } = await matchAddressRules(db, {
		addressId: msg.addressId,
		match: {
			from: parsed.from?.address,
			to: msg.envelope.to,
			subject: parsed.subject,
			text: parsed.text,
		},
	});
	const status = dropped ? "trash" : "received";

	// 添付の R2 put を messages の insert より先に済ませる。ここで落ちたら再配達が最初から
	// やり直す。messageId は毎回採番し直すので前回の put は孤児として R2 に残る（許容・#77）。
	const attachmentRows: (typeof attachments.$inferInsert)[] = [];
	for (const att of kept) {
		const attachmentId = newId("attachment");
		const r2Key = await putAttachment(env, messageId, attachmentId, att.content, att.contentType);
		attachmentRows.push({
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

	// drop はスレッド未読数も減らす。queryThreads / サイドバーは trash を除外するので、
	// 足したままだと一覧の未読と食い違う（精査 #92）。未読の net 増分はここで畳む。
	const loweredUnread = read || dropped;

	// 新規スレッドも含めて thread・message・attachments を同じ batch にし、どれかが落ちると
	// 全部残らないようにする。行が残る = 本文・添付・統計・ルールが済んでいる、の合図になる（#77）。
	const threadStatement = isNewThread
		? createThreadStatement(db, {
				id: newThreadId!,
				addressId: msg.addressId,
				subject,
				lastMessageAt: receivedAt,
				messageCount: 1,
				unreadCount: loweredUnread ? 0 : 1,
			})
		: updateThreadStatsStatement(db, {
				threadId,
				lastMessageAt: receivedAt,
				unreadDelta: loweredUnread ? 0 : 1,
			});
	const messageInsert = db.insert(messages).values({
		id: messageId,
		threadId,
		addressId: msg.addressId,
		direction: "inbound",
		status,
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
		envelopeTo: clampNullable(sanitizeEnvelope(msg.envelope.to), STORED_BYTES.short),
		sizeBytes,
		hasAttachments: kept.length > 0,
		isRead: read,
		isStarred: starred,
		spamVerdict: spamVerdictFromScore(parsed.cfSpamScore),
		receivedAt,
	});
	await db.batch([
		threadStatement,
		messageInsert,
		...attachmentRows.map((r) => db.insert(attachments).values(r)),
	]);

	// drop で trash にしたメールには message.received を出さない（#123）。
	if (!dropped) {
		await dispatchMessageEvent(env, "message.received", messageId);
	}
	await enqueueNotify(env, messageId, read);
}

// 破棄・既読にしたメールも積む。送らなかった理由を通知欄に残すため。
// 再配達でも積み直すので、コンシューマ側が message ごとに冪等にする。
async function enqueueNotify(env: CloudflareEnv, messageId: string, ruleRead = false): Promise<void> {
	await env.OUTBOUND_QUEUE.send({ kind: "notify", event: "received", messageId, ruleRead });
}
