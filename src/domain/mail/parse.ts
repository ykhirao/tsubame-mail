// to / cc は複数アドレスになりうる。カンマ結合した完全なリストで保持する。
import PostalMime, { type Address, type Email } from "postal-mime";
import { formatAddressList, type ParsedAddress } from "./address";

export type ParsedAttachment = {
	filename: string;
	contentType: string;
	sizeBytes: number;
	contentId: string | null;
	isInline: boolean;
	content: Uint8Array;
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
};

function stripBrackets(value: string | undefined | null): string | null {
	const t = value?.trim();
	return t ? t.replace(/^<|>$/g, "").trim() : null;
}

function cleanReferences(ref: string | undefined | null): string | null {
	if (!ref) return null;
	return ref
		.split(/\s+/)
		.map((t) => t.replace(/^<|>$/g, "").trim())
		.filter(Boolean)
		.join(" ");
}

function flattenAddresses(list: Address[] | undefined): ParsedAddress[] {
	if (!list) return [];
	return list.flatMap((a) => {
		if (a.address) return [{ address: a.address, name: a.name || undefined }];
		if (a.group) return a.group.map((g) => ({ address: g.address, name: g.name || undefined }));
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

function buildSnippet(text: string | null | undefined, html: string | null | undefined): string {
	const raw = text?.trim() || (html ? html.replace(/<[^>]*>/g, " ").trim() : "");
	return raw.replace(/\s+/g, " ").slice(0, 200);
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
		inReplyTo: stripBrackets(email.inReplyTo),
		references: cleanReferences(email.references),
		date: parseDate(email.date, null),
		snippet: buildSnippet(email.text, email.html),
		attachments,
	};
}
