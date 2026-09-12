// Message-ID は送信前に自前で採番する。返信がスレッドに刺さるために必要。
// node ビルドは eol を node:os の EOL に頼り Workers では bare LF になる。browser ビルドは \r\n 固定。
import { createMimeMessage } from "mimetext/browser";
import { MIME_TYPE, MAX_SUBJECT_BYTES } from "@/shared/contracts/send";
import { formatAddressList, parseAddressList } from "./address";

export type ComposeAttachment = {
	filename: string;
	contentType: string;
	/** base64 エンコード済みであること。mimetext は生バイト列を受け付けない。 */
	base64: string;
};

export function addressListToCsv(value: string | string[]): string {
	const raw = Array.isArray(value) ? value.join(", ") : value;
	return formatAddressList(parseAddressList(raw));
}
export type ComposeInput = {
	messageId: string;
	fromAddr: string;
	fromName?: string | null;
	toAddr: string;
	ccAddr?: string | null;
	subject?: string | null;
	textBody?: string | null;
	htmlBody?: string | null;
	/** ヘッダには書かない。Bcc の宛先はエンベロープだけで配る（sender.ts）。 */
	bccAddr?: string | null;
	inReplyTo?: string | null;
	referencesHeader?: string | null;
};

export function generateMessageId(messageId: string, fromAddr: string): string {
	const at = fromAddr.lastIndexOf("@");
	const domain = at >= 0 ? fromAddr.slice(at + 1) : "localhost";
	return `<${messageId}@${domain}>`;
}

export function toMailboxObjects(csv: string): { addr: string; name?: string }[] {
	return parseAddressList(csv).map((a) => {
		assertNoLineBreak("宛先アドレス", a.address);
		// 表示名が長すぎると base64 化した To 行が RFC 5322 の 998 文字を超える（精査 #66）。
		// 超える分は表示名を落としてアドレスだけで出す。
		if (!a.name || !displayNameFitsLine(a.name, a.address)) return { addr: a.address };
		return { addr: a.address, name: a.name };
	});
}

// mimetext は件名と表示名しかエンコードせず、それ以外の値はヘッダへ素通しする。
// 改行が 1 つ混ざるだけで任意のヘッダや本文を差し込まれる。
function assertNoLineBreak(label: string, value: string): void {
	if (/[\r\n\0]/.test(value)) throw new Error(`${label}に改行を含められません`);
}

// mimetext は宛先をエンコードした 1 行ごとに折り返す。表示名は base64 化で 4/3 に膨らむので、
// 「To: =?utf-8?B?...?= <addr>」1 行が 998 文字に収まるか、表示名の分だけで判定する。
const TO_LINE_BUDGET = 900;
function displayNameFitsLine(name: string, addr: string): boolean {
	const nameBytes = new TextEncoder().encode(name).length;
	const addrLen = new TextEncoder().encode(addr).length;
	const encodedName = `=?utf-8?B?`.length + Math.ceil(nameBytes / 3) * 4 + `?=`.length;
	return encodedName + addrLen <= TO_LINE_BUDGET;
}

/**
 * 山括弧の有無が混ざった Message-ID の並びを `<a@x> <b@x>` の形に揃える。
 * 受信メールの Message-ID は山括弧を外して保存しているので、返信ではここで付け直す。
 */
export function formatMessageIdList(
	value: string | null | undefined,
	headerName: "In-Reply-To" | "References" = "In-Reply-To",
): string | null {
	if (!value) return null;
	assertNoLineBreak("Message-ID", value);
	const ids = new Set<string>();
	for (const token of value.split(/\s+/)) {
		const id = token.replace(/^<|>$/g, "");
		if (!id || /[<>\x00-\x1f\x7f]/.test(id)) continue;
		ids.add(id);
	}
	if (ids.size === 0) return null;
	const wrapped = [...ids].map((id) => `<${id}>`);
	const kept = clampReferences(wrapped, `${headerName}: `.length);
	return kept.length > 0 ? kept.join(" ") : null;
}

// mimetext は filename を `filename="..."` にそのまま埋める。
function quotedStringContent(value: string): string {
	return value.replace(/[\\"]/g, "\\$&");
}

// 非 ASCII のファイル名を RFC 2231 の filename* パラメータにする。
// addAttachment は name=/filename= に値を素通しし、8bit のヘッダ行になる。unreserved 以外を %XX で
// 符号化するので `"` / `;` が混ざっても壊れない（#119）。
function rfc2231Param(value: string): string {
	const SAFE = /[A-Za-z0-9\-._~]/;
	let out = "UTF-8''";
	for (const b of new TextEncoder().encode(value)) {
		const ch = String.fromCharCode(b);
		out += SAFE.test(ch) ? ch : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
	}
	return out;
}

// mimetext はヘッダを折り返さない。RFC 5322 は 1 行 998 文字までなので、
// "References: " の分を引いた残りに収まるよう、古い ID から捨てる
// （直近の親を残すのが RFC 5322 §3.6.4 の推奨）。
const MAX_HEADER_LINE = 998;
function clampReferences(ids: string[], headerNameLength: number): string[] {
	const budget = MAX_HEADER_LINE - headerNameLength;
	const kept: string[] = [];
	let len = 0;
	for (let i = ids.length - 1; i >= 0; i--) {
		const id = ids[i]!;
		const add = kept.length === 0 ? id.length : id.length + 1;
		if (len + add > budget) break;
		kept.unshift(id);
		len += add;
	}
	return kept;
}

// 件名はここで黙って切らない。上限を超える入力は契約（send.ts）が 400 で弾き、返信は
// outbound.ts が「Re: 」を足す前に切り詰める。ここまで届いたら経路の抜けなので throw する（#22）。
function assertSubjectFits(subject: string): void {
	if (new TextEncoder().encode(subject).length > MAX_SUBJECT_BYTES) {
		throw new Error(`件名は ${MAX_SUBJECT_BYTES} バイトまでです`);
	}
}

const bodyEncoder = new TextEncoder();

// addMessage は encoding を base64 にしても本文を変換しない。宣言と実体を食い違わせないため
// （受信側が生テキストを base64 と誤読する）、ここで本文を base64 にしておく。#104 の
// boundary 注入も、base64 なら行が `--<boundary>` になり得ないので同時に塞がる。
function encodeBodyBase64(value: string): string {
	const bytes = bodyEncoder.encode(value);
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary);
}

export function composeMime(
	input: ComposeInput,
	attachments: ComposeAttachment[] = [],
): string {
	const msg = createMimeMessage();

	assertNoLineBreak("差出人アドレス", input.fromAddr);
	msg.setSender({ addr: input.fromAddr, name: input.fromName ?? undefined });
	msg.setTo(toMailboxObjects(input.toAddr));
	if (input.ccAddr) msg.setCc(toMailboxObjects(input.ccAddr));

	const rfcMessageId = generateMessageId(input.messageId, input.fromAddr);
	msg.setHeader("Message-ID", rfcMessageId);
	const inReplyTo = formatMessageIdList(input.inReplyTo, "In-Reply-To");
	if (inReplyTo) msg.setHeader("In-Reply-To", inReplyTo);
	const references = formatMessageIdList(input.referencesHeader, "References");
	if (references) msg.setHeader("References", references);

	const subject = (input.subject ?? "").trim() || "(件名なし)";
	assertSubjectFits(subject);
	msg.setSubject(subject);

	if (input.textBody && input.htmlBody) {
		msg.addMessage({
			contentType: "text/plain",
			data: encodeBodyBase64(input.textBody),
			charset: "UTF-8",
			encoding: "base64",
		});
		msg.addMessage({
			contentType: "text/html",
			data: encodeBodyBase64(input.htmlBody),
			charset: "UTF-8",
			encoding: "base64",
		});
	} else if (input.htmlBody) {
		msg.addMessage({
			contentType: "text/html",
			data: encodeBodyBase64(input.htmlBody),
			charset: "UTF-8",
			encoding: "base64",
		});
	} else if (input.textBody) {
		msg.addMessage({
			contentType: "text/plain",
			data: encodeBodyBase64(input.textBody),
			charset: "UTF-8",
			encoding: "base64",
		});
	} else {
		throw new Error("送信する本文（text / html）がありません");
	}

	for (const a of attachments) {
		assertNoLineBreak("添付のファイル名", a.filename);
		if (!MIME_TYPE.test(a.contentType)) throw new Error(`添付の Content-Type が不正です: ${a.contentType}`);
		const content = msg.addAttachment({
			filename: quotedStringContent(a.filename),
			contentType: a.contentType,
			data: a.base64,
		});
		// addAttachment は filename を `name="…"` / `filename="…"` に素通しする。
		// 非 ASCII は生 UTF-8 の 8bit ヘッダ行になるので RFC 2231 で符号化して差し替える（#119）。
		if (/[^\x00-\x7f]/.test(a.filename)) {
			content.setHeader("Content-Type", `${a.contentType}; name*=${rfc2231Param(a.filename)}`);
			content.setHeader("Content-Disposition", `attachment; filename*=${rfc2231Param(a.filename)}`);
		}
	}

	return msg.asRaw();
}

export { parseAddressList as parseAddressCsv };
