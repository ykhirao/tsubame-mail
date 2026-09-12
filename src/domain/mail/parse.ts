// to / cc は複数アドレスになりうる。カンマ結合した完全なリストで保持する。
import PostalMime, { type Address, type Email } from "postal-mime";
import { formatAddressList, normalizeAddress, type ParsedAddress } from "./address";

export type ParsedAttachment = {
	filename: string;
	contentType: string;
	sizeBytes: number;
	contentId: string | null;
	isInline: boolean;
	content: Uint8Array;
};

export type InboundAuth = {
	dmarc: "pass" | "fail" | "none" | null;
	dkimPassDomains: string[];
};

export type ParsedMessage = {
	/** 山括弧を外した値。 */
	messageId: string | null;
	from: ParsedAddress | null;
	to: string;
	cc: string;
	subject: string | null;
	text: string | null;
	html: string | null;
	inReplyTo: string | null;
	references: string | null;
	/** Unix 秒（ms ではない）。パース不能なら null。 */
	date: number | null;
	snippet: string;
	attachments: ParsedAttachment[];
	/** CF ブロックが無い・判定が無いときは null。 */
	inboundAuth: InboundAuth | null;
	/** CF ブロックの `X-CF-SpamH-Score`。無ければ null。 */
	cfSpamScore: number | null;
};

// X-CF-SpamH-Score は 0 から始まる小さな整数で、実機では普通のメールが 0〜1、GTUBE が 2、
// スパム語や IP 直書きの実行ファイルへのリンクが 3〜4 だった（#140）。5 以上は Worker まで届かない。
// 1 通ずつの観測なので spam は出さず、3 以上を suspicious に留める。
export function spamVerdictFromScore(score: number | null): "clean" | "suspicious" | null {
	if (score === null) return null;
	return score >= 3 ? "suspicious" : "clean";
}

// Cloudflare は判定ヘッダをまとめた「CF ブロック」をメールの一番上に足す。1 本目の Received が
// mx.cloudflare.net 経由でなければブロックは無い。それ以外の名前のヘッダ（Google の Received など）が
// 来たらブロックは終わる。#6740 では Authentication-Results が無いことがあるため、位置を偽れない
// ARC-Authentication-Results を正として、Authentication-Results はそれとの一致だけを確認に使う。
const CF_BLOCK_KEYS = new Set([
	"arc-seal",
	"arc-message-signature",
	"arc-authentication-results",
	"received-spf",
	"authentication-results",
	"x-cf-spamh-score",
]);
const CF_RECEIVED_MARKER = "by mx.cloudflare.net";

// postal-mime は encoded-word をデコードするので、Message-ID 系ヘッダに CRLF が混入しうる
// （実害は無いが、返信生成時に assertNoLineBreak が throw して失敗する）。トークンをこの形に絞る。
const MESSAGE_ID_TOKEN = /^[^\s<>\x00-\x1f\x7f]+$/;
// CRLF で割れた断片（X-Inj など）を返信の References に出さないため、References / In-Reply-To は
// 山括弧で囲まれた Message-ID 形式（中身は MESSAGE_ID_TOKEN かつ @ を含む）だけを残す（#72）。
const REFERENCE_ID = /^<([^\s<>\x00-\x1f\x7f]+)>$/;

function stripBrackets(value: string | undefined | null): string | null {
	const t = value?.trim().replace(/^<|>$/g, "").trim();
	return t && MESSAGE_ID_TOKEN.test(t) ? t : null;
}

function referenceToken(value: string | undefined | null): string | null {
	if (!value) return null;
	for (const token of value.split(/\s+/)) {
		const m = REFERENCE_ID.exec(token);
		const id = m?.[1];
		if (id && id.includes("@")) return id;
	}
	return null;
}

function cleanReferences(ref: string | undefined | null): string | null {
	if (!ref) return null;
	const ids: string[] = [];
	for (const token of ref.split(/\s+/)) {
		const m = REFERENCE_ID.exec(token);
		const id = m?.[1];
		if (id && id.includes("@")) ids.push(id);
	}
	return ids.length > 0 ? ids.join(" ") : null;
}

function toParsedAddress(a: { address?: string; name?: string }): ParsedAddress | null {
	// postal-mime は address をそのまま渡す。タブなどの制御文字が混じっていると
	// normalizeAddress に通す返信時まで気付かず、その時点で宛先ゼロになって黙って失敗する。
	if (!a.address) return null;
	const address = normalizeAddress(a.address);
	return address ? { address, name: a.name || undefined } : null;
}

function flattenAddresses(list: Address[] | undefined): ParsedAddress[] {
	if (!list) return [];
	return list.flatMap((a) => {
		if (a.address) return [toParsedAddress(a)].filter((p): p is ParsedAddress => p !== null);
		if (a.group) return a.group.map((g) => toParsedAddress(g)).filter((p): p is ParsedAddress => p !== null);
		return [];
	});
}

function toBytes(content: ArrayBuffer | Uint8Array | string): Uint8Array {
	if (typeof content === "string") return new TextEncoder().encode(content);
	if (content instanceof ArrayBuffer) return new Uint8Array(content);
	return content;
}

function parseDate(value: string | undefined, fallback: number | null): number | null {
	if (!value) return fallback;
	const t = Date.parse(value);
	if (Number.isNaN(t)) return fallback;
	return Math.floor(t / 1000);
}

/** 200 文字を作るのに巨大な本文全体を正規表現に通さない。 */
const SNIPPET_SOURCE_CHARS = 20_000;

function buildSnippet(text: string | null | undefined, html: string | null | undefined): string {
	const plain = text?.slice(0, SNIPPET_SOURCE_CHARS).trim();
	const raw =
		plain || (html ? html.slice(0, SNIPPET_SOURCE_CHARS).replace(/<[^>]*>/g, " ").trim() : "");
	return raw.replace(/\s+/g, " ").slice(0, 200);
}

function parseAuthResult(value: string): InboundAuth {
	let dmarc: InboundAuth["dmarc"] = null;
	const dkimDomains: string[] = [];
	for (const token of value.split(";")) {
		const t = token.trim();
		const dm = /^dmarc=(pass|fail|none)\b/.exec(t);
		if (dm) dmarc = dm[1] as InboundAuth["dmarc"];
		const dk = /^dkim=pass header\.d=([^\s;]+)/.exec(t);
		if (dk) dkimDomains.push(dk[1]!);
	}
	return dkimDomains.length > 0 || dmarc !== null ? { dmarc, dkimPassDomains: dkimDomains } : { dmarc: null, dkimPassDomains: [] };
}

function sameVerdict(a: InboundAuth, b: InboundAuth): boolean {
	if (a.dmarc !== b.dmarc) return false;
	if (a.dkimPassDomains.length !== b.dkimPassDomains.length) return false;
	const bSet = new Set(b.dkimPassDomains);
	return a.dkimPassDomains.every((d) => bSet.has(d));
}

type Header = { key: string; originalKey: string; value: string };

function cfBlock(headers: Header[]): Header[] {
	const first = headers[0];
	if (!first || first.key !== "received" || !first.value.includes(CF_RECEIVED_MARKER)) return [];
	const block = [first];
	for (const h of headers.slice(1)) {
		if (!CF_BLOCK_KEYS.has(h.key)) break;
		block.push(h);
	}
	return block;
}

function inboundAuthFrom(headers: Header[]): InboundAuth | null {
	const block = cfBlock(headers);
	if (block.length === 0) return null;
	const auth = block.find((h) => h.key === "authentication-results")?.value;
	const arc = block.find((h) => h.key === "arc-authentication-results")?.value;
	// ARC は位置的に偽れないので正とする。#6740 の形（本物の Authentication-Results が無く送信者が偽を
	// 置いた）でも、ARC と食い違えば未認証になる。
	if (arc) {
		const arcVerdict = parseAuthResult(arc);
		if (auth && !sameVerdict(parseAuthResult(auth), arcVerdict)) return null;
		return arcVerdict.dmarc !== null || arcVerdict.dkimPassDomains.length > 0 ? arcVerdict : null;
	}
	if (auth) {
		const verdict = parseAuthResult(auth);
		return verdict.dmarc !== null || verdict.dkimPassDomains.length > 0 ? verdict : null;
	}
	return null;
}

function cfSpamScoreFrom(headers: Header[]): number | null {
	const block = cfBlock(headers);
	for (const h of block) {
		if (h.key !== "x-cf-spamh-score") continue;
		const n = Number(h.value.trim());
		if (!Number.isNaN(n)) return n;
	}
	return null;
}

export async function parseRawMime(raw: Uint8Array | ArrayBuffer | string): Promise<ParsedMessage> {
	const email: Email = await PostalMime.parse(raw);

	const froms = flattenAddresses(email.from ? [email.from] : []);
	const toString = formatAddressList(flattenAddresses(email.to));
	const ccString = formatAddressList(flattenAddresses(email.cc));

	const attachments = email.attachments.map((a) => {
		const content = toBytes(a.content);
		return {
			filename: a.filename || a.contentId || "添付ファイル",
			contentType: a.mimeType,
			sizeBytes: content.byteLength,
			contentId: stripBrackets(a.contentId),
			isInline: a.disposition === "inline" || a.related === true,
			content,
		};
	});

	return {
		messageId: stripBrackets(email.messageId),
		from: froms[0] ?? null,
		to: toString,
		cc: ccString,
		subject: email.subject ?? null,
		text: email.text ?? null,
		html: email.html ?? null,
		inReplyTo: referenceToken(email.inReplyTo),
		references: cleanReferences(email.references),
		date: parseDate(email.date, null),
		snippet: buildSnippet(email.text, email.html),
		attachments,
		inboundAuth: inboundAuthFrom(email.headers),
		cfSpamScore: cfSpamScoreFrom(email.headers),
	};
}
