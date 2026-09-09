import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { addresses, attachments, messages, outboundJobs, threads } from "@/db/schema";
import { newId } from "@/lib/id";
import type { AppEnv } from "@/api/types";
import { forbidden, invalidRequest, notFound } from "@/shared/errors";
import { normalizeAddress, parseAddressList, formatAddressList } from "@/domain/mail/address";
import { addressListToCsv } from "@/domain/mail/compose";
import { canSendFrom } from "@/services/sender";
import { buildReplyQuote, referencesFor, replySubject } from "@/domain/mail/quote";
import {
	sendMessageInput,
	replyInput,
	type SendMessageInput,
} from "@/shared/contracts/send";

const router = new Hono<AppEnv>();

async function resolveOwnAddress(
	db: ReturnType<typeof getDb>,
	fromRaw: string,
): Promise<string | null> {
	const normalized = normalizeAddress(fromRaw);
	if (!normalized) return null;
	const row = await db
		.select({ id: addresses.id })
		.from(addresses)
		.where(eq(addresses.address, normalized))
		.get();
	return row?.id ?? null;
}

async function assertCanSend(
	db: ReturnType<typeof getDb>,
	input: { from: string },
	principal: AppEnv["Variables"]["principal"],
): Promise<string> {
	const addressId = await resolveOwnAddress(db, input.from);
	if (!addressId) throw forbidden("この差出人アドレスは登録されていません");
	if (!canSendFrom(principal.writableAddressIds, addressId)) {
		throw forbidden("このアドレスから送信する権限がありません");
	}
	if (principal.via === "api_key" && !principal.scopes.includes("send")) {
		throw forbidden("この API キーには send スコープがありません");
	}
	return addressId;
}

async function storeAttachments(
	db: ReturnType<typeof getDb>,
	env: CloudflareEnv,
	messageId: string,
	attachmentsInput: SendMessageInput["attachments"],
): Promise<void> {
	if (!attachmentsInput?.length) return;
	for (let i = 0; i < attachmentsInput.length; i++) {
		const att = attachmentsInput[i]!;
		const attId = newId("attachment");
		const r2Key = `outbound/${messageId}/${i}-${att.filename}`;
		const bytes = Uint8Array.from(atob(att.base64), (c) => c.charCodeAt(0));
		await env.BUCKET.put(r2Key, bytes, { httpMetadata: { contentType: att.contentType } });
		await db.insert(attachments).values({
			id: attId,
			messageId,
			filename: att.filename,
			contentType: att.contentType,
			sizeBytes: bytes.byteLength,
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
	attachments?: SendMessageInput["attachments"];
};

async function createOutboundThread(
	db: ReturnType<typeof getDb>,
	m: QueuedMessage,
	now: Date,
): Promise<string> {
	const threadId = newId("thread");
	await db.insert(threads).values({
		id: threadId,
		addressId: m.addressId,
		subject: m.subject ?? null,
		lastMessageAt: now,
		messageCount: 1,
		unreadCount: 0,
	});
	return threadId;
}

async function enqueueOutbound(
	db: ReturnType<typeof getDb>,
	env: CloudflareEnv,
	m: QueuedMessage,
): Promise<{ id: string; status: string }> {
	const messageId = newId("message");
	const now = new Date();

	// 返信は元のスレッドに入れる。指定が無ければ自分だけのスレッドを立てる。
	// ここを落とすと、送った返信が会話から外れて別の行として並ぶ。
	const threadId = m.threadId ?? (await createOutboundThread(db, m, now));

	await db.insert(messages).values({
		id: messageId,
		addressId: m.addressId,
		direction: "outbound",
		status: "queued",
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
		hasAttachments: (m.attachments?.length ?? 0) > 0,
		receivedAt: now,
	});

	if (m.threadId) {
		const t = await db.select().from(threads).where(eq(threads.id, m.threadId)).get();
		if (t) {
			await db
				.update(threads)
				.set({ lastMessageAt: now, messageCount: t.messageCount + 1 })
				.where(eq(threads.id, m.threadId));
		}
	}

	await storeAttachments(db, env, messageId, m.attachments);

	const jobId = newId("job");
	await db.insert(outboundJobs).values({ id: jobId, messageId, status: "queued" });
	await env.OUTBOUND_QUEUE.send({ kind: "outbound.send", jobId, messageId });

	return { id: messageId, status: "queued" };
}

router.post("/", async (c) => {
	const db = getDb(c.env);
	const principal = c.get("principal");
	const body = await c.req.json().catch(() => null);
	const parsed = sendMessageInput.safeParse(body);
	if (!parsed.success) throw invalidRequest("送信内容が不正です", parsed.error);
	const input = parsed.data;

	const addressId = await assertCanSend(db, input, principal);

	const result = await enqueueOutbound(db, c.env, {
		addressId,
		fromAddr: normalizeAddress(input.from)!,
		toAddr: addressListToCsv(input.to),
		ccAddr: input.cc ? addressListToCsv(input.cc) : null,
		bccAddr: input.bcc ? addressListToCsv(input.bcc) : null,
		subject: input.subject ?? null,
		textBody: input.text ?? null,
		htmlBody: input.html ?? null,
		inReplyTo: input.inReplyTo ?? null,
		attachments: input.attachments,
	});

	return c.json(result, 202);
});

router.post("/:id/reply", async (c) => {
	const db = getDb(c.env);
	const env = c.env;
	const principal = c.get("principal");
	const id = c.req.param("id");

	const body = await c.req.json().catch(() => null);
	const parsed = replyInput.safeParse(body);
	if (!parsed.success) throw invalidRequest("返信内容が不正です", parsed.error);
	const input = parsed.data;

	const message = await db.select().from(messages).where(eq(messages.id, id)).get();
	if (!message) throw notFound("メッセージが見つかりません");
	if (principal.addressIds !== "all" && !principal.addressIds.includes(message.addressId)) {
		throw forbidden("このメッセージにアクセスする権限がありません");
	}

	const mailbox = await db.select().from(addresses).where(eq(addresses.id, message.addressId)).get();
	if (!mailbox) throw notFound("差出人アドレスが不正です");
	if (!canSendFrom(principal.writableAddressIds, mailbox.id)) {
		throw forbidden("このアドレスから送信する権限がありません");
	}
	if (principal.via === "api_key" && !principal.scopes.includes("send")) {
		throw forbidden("この API キーには send スコープがありません");
	}

	// 宛先: replyAll なら To+Cc から自分のアドレスを除く + 元の From。そうでなければ元の From。
	const own = normalizeAddress(mailbox.address)!;
	const originalFrom = parseAddressList(message.fromAddr);
	const isSelf = (addr: string) => normalizeAddress(addr) === own;

	const recipients = replyAllRecipients(originalFrom, message.toAddr, message.ccAddr, isSelf, input.replyAll);

	const subject = replySubject(message.subject);
	const inReplyTo = message.rfcMessageId ?? null;
	const references = referencesFor(message.referencesHeader, message.rfcMessageId);

	const quote = buildReplyQuote({
		fromName: message.fromName,
		fromAddr: normalizeAddress(message.fromAddr) ?? message.fromAddr,
		receivedAt: message.receivedAt,
		textBody: message.textBody,
		htmlBody: message.htmlBody,
	});

	const textBody = input.text ? input.text.trim() + "\n\n" + quote.text : quote.text;
	const htmlBody = input.html ? input.html + quote.html : quote.html;

	const toAddr = formatAddressList(recipients);
	const addressId = mailbox.id;

	const result = await enqueueOutbound(db, env, {
		addressId,
		fromAddr: mailbox.address,
		fromName: mailbox.displayName ?? undefined,
		toAddr,
		subject,
		textBody,
		htmlBody,
		inReplyTo,
		referencesHeader: references,
		threadId: message.threadId,
		attachments: input.attachments,
	});

	return c.json(result, 202);
});

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
