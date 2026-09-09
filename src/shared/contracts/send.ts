import { z } from "zod";

export const attachment = z.object({
	filename: z.string().min(1),
	contentType: z.string().min(1),
	base64: z.string().min(1),
});
export type Attachment = z.infer<typeof attachment>;

/** 単一アドレス文字列でも配列でも受ける。内部では文字列に正規化してから扱う。 */
const addressList = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);
export type AddressList = z.infer<typeof addressList>;

export const sendMessageInput = z.object({
	from: z.string().min(1),
	to: addressList,
	cc: addressList.optional(),
	bcc: addressList.optional(),
	subject: z.string().optional(),
	text: z.string().optional(),
	html: z.string().optional(),
	attachments: z.array(attachment).optional(),
	inReplyTo: z.string().optional(),
	threadId: z.string().optional(),
});
export type SendMessageInput = z.infer<typeof sendMessageInput>;

export const sendMessageResult = z.object({
	id: z.string(),
	status: z.enum(["queued", "sent", "failed"]),
});
export type SendMessageResult = z.infer<typeof sendMessageResult>;

export const replyInput = z.object({
	text: z.string().optional(),
	html: z.string().optional(),
	replyAll: z.boolean().optional().default(false),
	attachments: z.array(attachment).optional(),
});
export type ReplyInput = z.infer<typeof replyInput>;
