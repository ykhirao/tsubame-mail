import { z } from "zod";
import { parseAddressList } from "@/domain/mail/address";

// 100 件規模の宛先 CSV を 1 本の文字列に入れても十分足りるが、上限が無いと配列の 1 要素に
// 何百件も詰めて recipientCount（要素数しか見ない）をすり抜けられる（精査 #22）。
const MAX_SINGLE_LINE_CHARS = 10_000;

// 送信の値は MIME ヘッダにそのまま入る。改行を通すとヘッダを差し込まれる。
const singleLine = z
	.string()
	.max(MAX_SINGLE_LINE_CHARS, `1 項目は ${MAX_SINGLE_LINE_CHARS} 文字までです`)
	.regex(/^[^\r\n\0]*$/, "改行を含められません");

/** パラメータ（`; charset=...`）は付けられない。mimetext が `; name=` を後ろに足すため。 */
export const MIME_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;

// キーのスコープ（read/send/admin）だけでは送信量に上限が無く、
// 1 本のキーで巨大な JSON を R2 に置いたり大量に送信できてしまう（精査 #22）。
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS = 50;
export const MAX_RECIPIENTS = 100;
export const MAX_BODY_BYTES = 1024 * 1024;
// z.string().max はコード単位を数え、多バイト文字なら実バイト数が大幅に超える。D1 の 1 行 2MB 上限に
// zod の門より先に当たって 500 になるので、バイト数で検査する（#89）。
// 返信ではサーバが足す引用が入った後の本文にも同じ上限を掛ける（#115）。
export const MAX_COMBINED_BODY_BYTES = 1536 * 1024;
// mimetext は件名を =?utf-8?B?...?= の base64 に膨らませるので、998 文字のヘッダ上限より先に
// UTF-8 バイト数で止める。#22 はここで黙って切らず、超える入力は API が 400 で弾く。
export const MAX_SUBJECT_BYTES = 600;
/** RFC 5322 のヘッダ行上限。base64 化後の長さなので、生バイト数はこれより少し余裕を持たせる。 */
const base64LenForBytes = (bytes: number) => Math.ceil(bytes / 3) * 4;

export const attachment = z.object({
	filename: z
		.string()
		.min(1)
		.max(255)
		.regex(/^[^\x00-\x1f\x7f/\\]+$/, "ファイル名に制御文字や / \\ は使えません"),
	contentType: z.string().regex(MIME_TYPE, "Content-Type は type/subtype の形で指定してください"),
	base64: z.string().min(1).max(base64LenForBytes(MAX_ATTACHMENT_BYTES), "添付は 1 件 20MB までです"),
});
export type Attachment = z.infer<typeof attachment>;

/** 単一アドレス文字列でも配列でも受ける。内部では文字列に正規化してから扱う。 */
// 配列の要素数を無制限にすると、bodyLimit の 40MB まで要素を詰められ safeParse 自体が重くなる（精査 #79）。
const addressList = z.union([singleLine.min(1), z.array(singleLine.min(1)).min(1).max(MAX_RECIPIENTS)]);
export type AddressList = z.infer<typeof addressList>;

function recipientCount(list: string | string[] | undefined): number {
	if (!list) return 0;
	// 配列の要素数だけを数えると、1 要素にカンマ区切りで何百件も詰めた
	// `["a0@x.jp, a1@x.jp, …"]` が上限をすり抜ける（精査 #22）。実際に割った件数を数える。
	const csv = Array.isArray(list) ? list.join(", ") : list;
	return parseAddressList(csv).length;
}

function attachmentsTotalBytes(list: Attachment[] | undefined): number {
	if (!list) return 0;
	// base64 は 4/3 に膨らむので、合計判定も base64 側の長さで行う（生バイトへ戻す必要が無い）。
	return list.reduce((sum, a) => sum + a.base64.length, 0);
}

const sendMessageBase = {
	from: singleLine.min(1),
	to: addressList,
	cc: addressList.optional(),
	bcc: addressList.optional(),
	subject: z.string().optional(),
	text: z.string().max(MAX_BODY_BYTES).optional(),
	html: z.string().max(MAX_BODY_BYTES).optional(),
	attachments: z.array(attachment).max(MAX_ATTACHMENTS, `添付は ${MAX_ATTACHMENTS} 件までです`).optional(),
};

function byteLength(value: string | undefined): number {
	return value ? new TextEncoder().encode(value).length : 0;
}

function checkBodyBytes(
	input: { text?: string; html?: string; subject?: string },
	ctx: z.RefinementCtx,
): void {
	if (byteLength(input.text) > MAX_BODY_BYTES) {
		ctx.addIssue({ code: "custom", message: "本文（text）は 1MB までです", path: ["text"] });
	}
	if (byteLength(input.html) > MAX_BODY_BYTES) {
		ctx.addIssue({ code: "custom", message: "本文（html）は 1MB までです", path: ["html"] });
	}
	// z.string().max はコード単位を数えるため、日本語は文字数ではなくバイト数で弾く（#22）。
	if (byteLength(input.subject) > MAX_SUBJECT_BYTES) {
		ctx.addIssue({
			code: "custom",
			message: `件名は ${MAX_SUBJECT_BYTES} バイト（約 200 文字）までです`,
			path: ["subject"],
		});
	}
	const total = byteLength(input.text) + byteLength(input.html) + byteLength(input.subject);
	if (total > MAX_COMBINED_BODY_BYTES) {
		ctx.addIssue({ code: "custom", message: "本文と件名の合計サイズは 1.5MB までです", path: ["text"] });
	}
}

function checkAttachmentsTotal(
	attachments: Attachment[] | undefined,
	ctx: z.RefinementCtx,
): void {
	const total = attachmentsTotalBytes(attachments);
	if (base64LenForBytes(MAX_TOTAL_ATTACHMENT_BYTES) < total) {
		ctx.addIssue({ code: "custom", message: "添付の合計サイズは 25MB までです", path: ["attachments"] });
	}
}

export const sendMessageInput = z
	.object({
		...sendMessageBase,
		inReplyTo: z
			.string()
			.regex(/^<[^\s<>]+>$/, "inReplyTo は <id@domain> の形で指定してください")
			.optional(),
	})
	.superRefine((input, ctx) => {
		checkAttachmentsTotal(input.attachments, ctx);
		checkBodyBytes(input, ctx);
		// 閉じない引用の `"open <a@x.jp>` などで parseAddressList 後の件数が 0 になり、
		// 202 のままジョブが「送信先が指定されていません」で failed になる（精査 #80）。
		if (recipientCount(input.to) === 0) {
			ctx.addIssue({ code: "custom", message: "宛先が指定されていません", path: ["to"] });
		}
		const total = recipientCount(input.to) + recipientCount(input.cc) + recipientCount(input.bcc);
		if (total > MAX_RECIPIENTS) {
			ctx.addIssue({ code: "custom", message: `宛先は合計 ${MAX_RECIPIENTS} 件までです`, path: ["to"] });
		}
	});
export type SendMessageInput = z.infer<typeof sendMessageInput>;

export const sendMessageResult = z.object({
	id: z.string(),
	status: z.enum(["queued", "sent", "failed"]),
});
export type SendMessageResult = z.infer<typeof sendMessageResult>;

export const replyInput = z
	.object({
		text: z.string().max(MAX_BODY_BYTES).optional(),
		html: z.string().max(MAX_BODY_BYTES).optional(),
		replyAll: z.boolean().optional().default(false),
		/** 省略時はサーバが計算する宛先（From + replyAll なら To/Cc）をそのまま使う。 */
		to: addressList.optional(),
		cc: addressList.optional(),
		attachments: z.array(attachment).max(MAX_ATTACHMENTS, `添付は ${MAX_ATTACHMENTS} 件までです`).optional(),
	})
	.superRefine((input, ctx) => {
		checkAttachmentsTotal(input.attachments, ctx);
		checkBodyBytes(input, ctx);
		const total = recipientCount(input.to) + recipientCount(input.cc);
		if (total > MAX_RECIPIENTS) {
			ctx.addIssue({ code: "custom", message: `宛先は合計 ${MAX_RECIPIENTS} 件までです`, path: ["to"] });
		}
	});
export type ReplyInput = z.infer<typeof replyInput>;
