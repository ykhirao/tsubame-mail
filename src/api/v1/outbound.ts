import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { and, inArray, eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { addresses, attachments, messages, outboundJobs, threads } from "@/db/schema";
import { newId } from "@/lib/id";
import type { AppEnv } from "@/api/types";
import { ApiError, conflict, forbidden, invalidRequest, notFound } from "@/shared/errors";
import { baseAddressOf, normalizeAddress, parseAddressList, formatAddressList } from "@/domain/mail/address";
import { addressListToCsv } from "@/domain/mail/compose";
import { canRead, requireScope } from "@/domain/access/policy";
import { canSendFrom, isSendingDisabled, SENDING_DISABLED_MESSAGE } from "@/services/sender";
import { putAttachment } from "@/services/r2";
import { buildReplyQuote, referencesFor, replySubject } from "@/domain/mail/quote";
import { readJson } from "@/lib/validate";
import {
	sendMessageInput,
	replyInput,
	MAX_RECIPIENTS,
	MAX_BODY_BYTES,
	MAX_COMBINED_BODY_BYTES,
	MAX_SUBJECT_BYTES,
	type SendMessageInput,
} from "@/shared/contracts/send";

const router = new Hono<AppEnv>();

// 添付は base64 で JSON に乗るため、25MB の合計上限より一回り大きく見て
// 本文全体としての上限を置く（zod の上限はここを通った後段の話）。
router.use(
	"*",
	bodyLimit({
		maxSize: 40 * 1024 * 1024,
		onError: () => {
			throw invalidRequest("リクエストが大きすぎます");
		},
	}),
);

async function resolveOwnAddress(
	db: ReturnType<typeof getDb>,
	fromRaw: string,
): Promise<{ id: string; kind: string; archivedAt: Date | null; domainId: string } | null> {
	const normalized = normalizeAddress(fromRaw);
	if (!normalized) return null;
	const row = await db
		.select({
			id: addresses.id,
			kind: addresses.kind,
			archivedAt: addresses.archivedAt,
			domainId: addresses.domainId,
		})
		.from(addresses)
		.where(eq(addresses.address, normalized))
		.get();
	return row ?? null;
}

async function assertCanSend(
	db: ReturnType<typeof getDb>,
	input: { from: string },
	principal: AppEnv["Variables"]["principal"],
): Promise<string> {
	requireScope(principal, "send");
	const row = await resolveOwnAddress(db, input.from);
	if (!row) throw forbidden("この差出人アドレスは登録されていません");
	if (row.archivedAt) throw forbidden("アーカイブ済みのアドレスからは送信できません");
	if (row.kind === "alias") throw forbidden("エイリアスのアドレスからは送信できません");
	if (!canSendFrom(principal.writableAddressIds, row.id)) {
		throw forbidden("このアドレスから送信する権限がありません");
	}
	if (await isSendingDisabled(db, row.domainId)) throw conflict(SENDING_DISABLED_MESSAGE);
	return row.id;
}

type DecodedAttachment = { filename: string; contentType: string; bytes: Uint8Array };

// 送信は 1 リクエスト 100 宛先の上限はあるがリクエスト数の上限が無かった（精査 #106）。
// 鍵は API キー id（セッションならユーザー id）で、漏れた send キー 1 本で送信量が制限されるようにする。
async function checkSendRateLimit(limiter: RateLimit | undefined, key: string): Promise<void> {
	if (!limiter) return;
	const { success } = await limiter.limit({ key });
	if (!success) {
		throw new ApiError("rate_limited", "送信が多すぎます。しばらく待ってからやり直してください");
	}
}

// メッセージの行を作る前に弾く。後で落ちると、送られないまま queued の行だけが残る。
function decodeAttachments(input: SendMessageInput["attachments"]): DecodedAttachment[] {
	return (input ?? []).map((att) => {
		let binary: string;
		try {
			binary = atob(att.base64);
		} catch {
			throw invalidRequest(`添付「${att.filename}」の base64 が不正です`);
		}
		return {
			filename: att.filename,
			contentType: att.contentType,
			bytes: Uint8Array.from(binary, (c) => c.charCodeAt(0)),
		};
	});
}

async function storeAttachments(
	db: ReturnType<typeof getDb>,
	env: CloudflareEnv,
	messageId: string,
	list: DecodedAttachment[],
): Promise<void> {
	for (const att of list) {
		const attId = newId("attachment");
		// キーはサーバ採番の id だけで作る。ファイル名を入れると `../raw/...` で他のメッセージの
		// 生 MIME と同じキーを作れてしまう。
		const r2Key = await putAttachment(env, messageId, attId, att.bytes, att.contentType);
		await db.insert(attachments).values({
			id: attId,
			messageId,
			filename: att.filename,
			contentType: att.contentType,
			sizeBytes: att.bytes.byteLength,
			isInline: false,
			r2Key,
		});
	}
}

type QueuedMessage = {
	addressId: string;
	fromAddr: string;
	fromName?: string;
	toAddr: string;
	ccAddr?: string | null;
	bccAddr?: string | null;
	subject?: string | null;
	textBody?: string | null;
	htmlBody?: string | null;
	inReplyTo?: string | null;
	referencesHeader?: string | null;
	/** 返信なら元メッセージのスレッド。無ければ新しいスレッドを作る。 */
	threadId?: string | null;
	attachments: DecodedAttachment[];
	sentByUserId: string;
};

async function enqueueOutbound(
	db: ReturnType<typeof getDb>,
	env: CloudflareEnv,
	m: QueuedMessage,
): Promise<{ id: string; status: string }> {
	const messageId = newId("message");
	const now = new Date();
	const jobId = newId("job");

	// 返信は元のスレッドに入れる。指定が無ければ自分だけのスレッドを立てる。
	// スレッド作成とメッセージ挿入を分けて await すると、間で失敗したとき
	// メッセージの無い空スレッド行が残る（精査 #22）。同じ batch で 1 トランザクションにする。
	const newThreadId = m.threadId ? null : newId("thread");
	const threadId = newThreadId ?? m.threadId!;

	const messageInsert = db.insert(messages).values({
		id: messageId,
		addressId: m.addressId,
		direction: "outbound",
		status: "queued",
		sentByUserId: m.sentByUserId,
		fromAddr: m.fromAddr,
		fromName: m.fromName ?? null,
		toAddr: m.toAddr,
		ccAddr: m.ccAddr ?? null,
		bccAddr: m.bccAddr ?? null,
		subject: m.subject ?? null,
		textBody: m.textBody ?? null,
		htmlBody: m.htmlBody ?? null,
		inReplyTo: m.inReplyTo ?? null,
		referencesHeader: m.referencesHeader ?? null,
		threadId,
		hasAttachments: m.attachments.length > 0,
		receivedAt: now,
		// 自分が書いて送ったものなので既読で作る。既定の false のままだと、送っただけで
		// 未読が増え、開いて消すこともできない（受信が 1 通も無いのにバッジが出る）。
		isRead: true,
	});
	const jobInsert = db.insert(outboundJobs).values({ id: jobId, messageId, status: "queued" });

	if (newThreadId) {
		const threadInsert = db.insert(threads).values({
			id: newThreadId,
			addressId: m.addressId,
			subject: m.subject ?? null,
			lastMessageAt: now,
			messageCount: 1,
			unreadCount: 0,
		});
		await db.batch([threadInsert, messageInsert, jobInsert]);
	} else {
		const threadUpdate = db
			.update(threads)
			.set({ lastMessageAt: now, messageCount: sql`${threads.messageCount} + 1` })
			.where(eq(threads.id, threadId));
		await db.batch([messageInsert, threadUpdate, jobInsert]);
	}

	try {
		await storeAttachments(db, env, messageId, m.attachments);
		await env.OUTBOUND_QUEUE.send({ kind: "outbound.send", jobId, messageId });
	} catch (err) {
		// batch は確定済みなので差し戻せない。送られもせず queued のまま残らないよう、
		// 添付保存やキュー投入の失敗で行を failed に落とす（#90）。
		await db.update(messages).set({ status: "failed" }).where(eq(messages.id, messageId));
		await db.update(outboundJobs).set({ status: "failed" }).where(eq(outboundJobs.id, jobId));
		throw err;
	}

	return { id: messageId, status: "queued" };
}

router.post("/", async (c) => {
	const db = getDb(c.env);
	const principal = c.get("principal");
	const input = await readJson(c.req, sendMessageInput);
	await checkSendRateLimit(c.env.SEND_RATE_LIMIT, `send:${principal.apiKeyId ?? principal.userId}`);

	const addressId = await assertCanSend(db, input, principal);
	const decoded = decodeAttachments(input.attachments);
	const toAddr = addressListToCsv(input.to);
	// 正規化後に実際に使える宛先が 0 件でも 202 を返すと、ジョブが
	// 「送信先が指定されていません」で failed になる（精査 #80）。
	if (parseAddressList(toAddr).length === 0) throw invalidRequest("宛先が指定されていません");

	// inReplyTo を付けた返信は In-Reply-To だけでなく References も継ぐ。参照先がこの Worker の
	// 行として見つかり、かつ同じ差出人アドレス宛てなら既存スレッドに入れる
	// （別アドレスのスレッドに混ぜない）。参照先が無ければ References は inReplyTo 単独で送る。
	let referencesHeader: string | null = null;
	let threadId: string | null = null;
	if (input.inReplyTo) {
		const bare = input.inReplyTo.replace(/^<|>$/g, "");
		const ref = await db
			.select({
				addressId: messages.addressId,
				threadId: messages.threadId,
				referencesHeader: messages.referencesHeader,
				rfcMessageId: messages.rfcMessageId,
			})
			.from(messages)
			// 送信元のアドレスに閉じる。他のアドレスの行を引くと、見られない会話の References が
			// 自分の送信ヘッダに写り、Message-ID の有無も分かってしまう（#136 #137）。
			.where(and(eq(messages.addressId, addressId), inArray(messages.rfcMessageId, [bare, `<${bare}>`])))
			.get();
		if (ref) {
			referencesHeader = referencesFor(ref.referencesHeader, ref.rfcMessageId ?? input.inReplyTo);
			threadId = ref.threadId;
		} else {
			referencesHeader = input.inReplyTo;
		}
	}

	const result = await enqueueOutbound(db, c.env, {
		sentByUserId: principal.userId,
		addressId,
		fromAddr: normalizeAddress(input.from)!,
		toAddr,
		ccAddr: input.cc ? addressListToCsv(input.cc) : null,
		bccAddr: input.bcc ? addressListToCsv(input.bcc) : null,
		subject: input.subject ?? null,
		textBody: input.text ?? null,
		htmlBody: input.html ?? null,
		inReplyTo: input.inReplyTo ?? null,
		referencesHeader,
		threadId,
		attachments: decoded,
	});

	return c.json(result, 202);
});

router.post("/:id/reply", async (c) => {
	const db = getDb(c.env);
	const env = c.env;
	const principal = c.get("principal");
	const id = c.req.param("id");

	const input = await readJson(c.req, replyInput);
	await checkSendRateLimit(c.env.SEND_RATE_LIMIT, `send:${principal.apiKeyId ?? principal.userId}`);

	// 返信は元メッセージを読んで引用するので、send だけでなく read も要る。
	requireScope(principal, "read");
	requireScope(principal, "send");

	const message = await db.select().from(messages).where(eq(messages.id, id)).get();
	// 権限外も 404。403 だと id の総当たりで存在を推測される。
	if (!message || !canRead(principal, message.addressId)) {
		throw notFound("メッセージが見つかりません");
	}

	const mailbox = await db.select().from(addresses).where(eq(addresses.id, message.addressId)).get();
	if (!mailbox) throw notFound("差出人アドレスが不正です");
	if (mailbox.archivedAt) throw forbidden("アーカイブ済みのアドレスからは送信できません");
	if (mailbox.kind === "alias") throw forbidden("エイリアスのアドレスからは送信できません");
	if (!canSendFrom(principal.writableAddressIds, mailbox.id)) {
		throw forbidden("このアドレスから送信する権限がありません");
	}
	if (await isSendingDisabled(db, mailbox.domainId)) throw conflict(SENDING_DISABLED_MESSAGE);
	const decoded = decodeAttachments(input.attachments);

	// 宛先: replyAll なら To+Cc から自分のアドレスを除く + 元の From。そうでなければ元の From。
	// isSelf は完全一致だけでなく、自分の +タグ 付きアドレスと、このメールボックスを指す
	// エイリアスも含める（精査 #23）。含めないと、返信が自分の受信箱に戻ってしまう。
	const own = normalizeAddress(mailbox.address)!;
	const aliasRows = await db
		.select({ address: addresses.address })
		.from(addresses)
		.where(eq(addresses.aliasTargetId, mailbox.id))
		.all();
	const ownAliases = new Set(aliasRows.map((r) => normalizeAddress(r.address)).filter((a): a is string => !!a));
	const isSelf = (addr: string) => {
		const n = normalizeAddress(addr);
		if (!n) return false;
		// own 自身に +タグ が無ければ box+news@ のようなタグ付き宛先も同じメールボックスとして
		// 自分に含める。own 側の base は取らないので、own に +タグ がある（box+a@x）ときの
		// box@x・box+b@x はここでは一致せず、別人のまま残る（精査 #23 再検査: 別人を自分扱いする退行）。
		if (n === own || baseAddressOf(n) === own) return true;
		if (ownAliases.has(n)) return true;
		const base = baseAddressOf(n);
		return base !== null && ownAliases.has(base);
	};
	const originalFrom = parseAddressList(message.fromAddr);

	// UI が最終宛先を表示・編集できるよう、明示指定があればそれを使う（精査 #23）。
	// 省略時は従来どおりサーバが計算する。cc の明示指定は無ければ空にする（replyAll の Cc を混ぜない）。
	const recipients = input.to
		? dedupeRecipients(parseAddressList(addressListToCsv(input.to)), isSelf)
		: replyAllRecipients(originalFrom, message.toAddr, message.ccAddr, isSelf, input.replyAll);
	const ccRecipients = input.cc ? dedupeRecipients(parseAddressList(addressListToCsv(input.cc)), isSelf) : [];

	// 自分を除いた結果 To が 0 件だと、To が空で Cc だけのメールを作って 202 の後に 4 回試行して
	// failed になる（精査 #66 / #80 / #126）。To は必須なので送る前に 400 で弾く。
	if (recipients.length === 0) throw invalidRequest("宛先（To）が指定されていません");
	// replyAll で to を省略した返信は受信 To / Cc 由来の宛先数に上限が無い（精査 #74）。
	if (recipients.length + ccRecipients.length > MAX_RECIPIENTS) {
		throw invalidRequest(`宛先は合計 ${MAX_RECIPIENTS} 件までです`);
	}

	const subject = clampReplySubject(replySubject(message.subject));
	const inReplyTo = message.rfcMessageId ?? null;
	const references = referencesFor(message.referencesHeader, message.rfcMessageId);

	const quote = buildReplyQuote({
		fromName: message.fromName,
		fromAddr: normalizeAddress(message.fromAddr) ?? message.fromAddr,
		receivedAt: message.receivedAt,
		textBody: message.textBody,
		htmlBody: message.htmlBody,
	});

	// 引用は入力検査の外で足すので、本文が上限を超えうる。利用者が書いた部分（text / html）は切らず、
	// 引用を末尾から切り詰めて上限に収める。#115。
	const { text: textBody, html: htmlBody } = fitReplyBodies(
		input.text?.trim() ?? "",
		input.html ?? "",
		quote.text,
		quote.html,
		subject,
	);

	const toAddr = formatAddressList(recipients);
	const ccAddr = ccRecipients.length > 0 ? formatAddressList(ccRecipients) : null;
	const addressId = mailbox.id;

	const result = await enqueueOutbound(db, env, {
		sentByUserId: principal.userId,
		addressId,
		fromAddr: mailbox.address,
		fromName: mailbox.displayName ?? undefined,
		toAddr,
		ccAddr,
		subject,
		textBody,
		htmlBody,
		inReplyTo,
		referencesHeader: references,
		threadId: message.threadId,
		attachments: decoded,
	});

	return c.json(result, 202);
});

const quoteBytes = new TextEncoder();
function byteLen(value: string): number {
	return quoteBytes.encode(value).length;
}

// UTF-8 の 1 文字を跨がない。末尾を切るときに継続バイトが残らないようにする（#22 / #115）。
function clampUtf8(value: string, maxBytes: number): string {
	const bytes = quoteBytes.encode(value);
	if (bytes.length <= maxBytes) return value;
	let end = maxBytes;
	// 0x80-0xBF は UTF-8 の継続バイト。境界がその途中なら 1 バイトずつ戻る。
	while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
	return new TextDecoder().decode(bytes.subarray(0, end));
}

// 返信は「Re: 」を付けて 600 バイトを超えるとき、元の件名を末尾から切る（#22）。
function clampReplySubject(subject: string): string {
	if (byteLen(subject) <= MAX_SUBJECT_BYTES) return subject;
	const prefix = "Re: ";
	return prefix + clampUtf8(subject.slice(prefix.length), MAX_SUBJECT_BYTES - byteLen(prefix));
}

const QUOTE_TRUNCATED_NOTE = "（引用が長いため途中までです）";

function truncateQuoteText(quote: string, maxBytes: number): string {
	const note = `\n${QUOTE_TRUNCATED_NOTE}`;
	if (byteLen(quote) <= maxBytes) return quote;
	if (maxBytes < byteLen(note)) return "";
	return clampUtf8(quote, maxBytes - byteLen(note)).replace(/\s+$/, "") + note;
}

function truncateQuoteHtml(quote: string, maxBytes: number): string {
	const note = `<br />${QUOTE_TRUNCATED_NOTE}</blockquote>`;
	if (byteLen(quote) <= maxBytes) return quote;
	if (maxBytes < byteLen(note)) return "";
	return clampUtf8(quote, maxBytes - byteLen(note)).replace(/\s+$/, "") + note;
}

// 返信本文を本文ごと・合計の上限に収める。利用者が書いた userText / userHtml は切らず、
// 足りない分は引用を末尾から切って注記を添える（#115）。
function fitReplyBodies(
	userText: string,
	userHtml: string,
	quoteTextFull: string,
	quoteHtmlFull: string,
	subject: string,
): { text: string | null; html: string | null } {
	const sep = userText ? "\n\n" : "";
	const userTextBytes = byteLen(userText) + byteLen(sep);
	const userHtmlBytes = byteLen(userHtml);
	const subjectBytes = byteLen(subject);

	const textQuoteBudget = Math.max(0, MAX_BODY_BYTES - userTextBytes);
	const htmlQuoteBudget = Math.max(0, MAX_BODY_BYTES - userHtmlBytes);
	const totalQuoteBudget = Math.max(
		0,
		MAX_COMBINED_BODY_BYTES - userTextBytes - userHtmlBytes - subjectBytes,
	);

	let textQuote = truncateQuoteText(quoteTextFull, textQuoteBudget);
	let htmlQuote = truncateQuoteHtml(quoteHtmlFull, htmlQuoteBudget);

	if (byteLen(textQuote) + byteLen(htmlQuote) > totalQuoteBudget) {
		const used = Math.max(1, byteLen(textQuote) + byteLen(htmlQuote));
		if (totalQuoteBudget <= 0) {
			textQuote = "";
			htmlQuote = "";
		} else {
			const ratio = totalQuoteBudget / used;
			textQuote = truncateQuoteText(
				quoteTextFull,
				Math.min(textQuoteBudget, Math.floor(byteLen(textQuote) * ratio)),
			);
			htmlQuote = truncateQuoteHtml(
				quoteHtmlFull,
				Math.min(htmlQuoteBudget, Math.floor(byteLen(htmlQuote) * ratio)),
			);
		}
	}

	const textBody = userText ? (textQuote ? `${userText}\n\n${textQuote}` : userText) : textQuote;
	const htmlBody = userHtml ? `${userHtml}${htmlQuote}` : htmlQuote;
	return { text: textBody || null, html: htmlBody || null };
}

export function dedupeRecipients(
	list: { address: string; name?: string }[],
	isSelf: (addr: string) => boolean,
): { address: string; name?: string }[] {
	const seen = new Set<string>();
	const out: { address: string; name?: string }[] = [];
	for (const m of list) {
		const key = normalizeAddress(m.address) ?? m.address.toLowerCase();
		if (isSelf(m.address) || seen.has(key)) continue;
		seen.add(key);
		out.push(m);
	}
	return out;
}

export function replyAllRecipients(
	originalFrom: { address: string; name?: string }[],
	toAddr: string,
	ccAddr: string | null | undefined,
	isSelf: (addr: string) => boolean,
	replyAll: boolean,
): { address: string; name?: string }[] {
	const seen = new Set<string>();
	const out: { address: string; name?: string }[] = [];
	const push = (m: { address: string; name?: string }) => {
		const key = normalizeAddress(m.address) ?? m.address.toLowerCase();
		if (isSelf(m.address) || seen.has(key)) return;
		seen.add(key);
		out.push(m);
	};
	for (const m of originalFrom) push(m);
	if (replyAll) {
		for (const m of parseAddressList(toAddr)) push(m);
		for (const m of parseAddressList(ccAddr)) push(m);
	}
	return out;
}

export default router;
