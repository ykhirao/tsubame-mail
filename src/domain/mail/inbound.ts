// キューは at-least-once なので、同じ rawKey を二重処理しないこと。
import { and, asc, desc, eq } from "drizzle-orm";
import { attachments, messages, routingRules } from "@/db/schema";
import type { Db } from "@/db/client";
import { getDb } from "@/db/client";
import { newId } from "@/lib/id";
import { getRaw, putAttachment } from "@/services/r2";
import { parseRawMime } from "./parse";
import {
	adjustThreadUnread,
	createThread,
	findExistingThreadId,
	updateThreadStats,
} from "./thread";
import { matchRule, type Matcher } from "@/domain/routing/rules";
import { dispatchMessageEvent } from "@/services/webhooks";
import type { InboundQueueMessage } from "@/services/queue";

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
): Promise<{ read: boolean }> {
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

	for (const rule of rules) {
		if (!matchRule(rule.matcher as Matcher, opts.match)) continue;
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

	return { read };
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
	const raw = new Uint8Array(await rawObj.arrayBuffer());
	const sizeBytes = raw.byteLength;

	const parsed = await parseRawMime(raw);
	// receivedAt は queue 側が ms で渡す。Date ヘッダは秒なので 1000 倍が要る。
	const receivedAt = new Date(parsed.date ? parsed.date * 1000 : msg.receivedAt);

	const existingThread = await findExistingThreadId(db, {
		addressId: msg.addressId,
		inReplyTo: parsed.inReplyTo,
		references: parsed.references,
	});
	const isNewThread = existingThread === null;
	const threadId = existingThread ?? (await createThread(db, {
		addressId: msg.addressId,
		subject: parsed.subject,
		lastMessageAt: receivedAt,
	}));

	const messageId = newId("message");
	await db.insert(messages).values({
		id: messageId,
		threadId,
		addressId: msg.addressId,
		direction: "inbound",
		status: "received",
		rfcMessageId: parsed.messageId,
		inReplyTo: parsed.inReplyTo,
		referencesHeader: parsed.references,
		fromAddr: parsed.from?.address ?? "",
		fromName: parsed.from?.name,
		toAddr: parsed.to,
		ccAddr: parsed.cc || null,
		subject: parsed.subject,
		snippet: parsed.snippet,
		textBody: parsed.text,
		htmlBody: parsed.html,
		rawR2Key: msg.rawKey,
		sizeBytes,
		hasAttachments: parsed.attachments.length > 0,
		isRead: false,
		isStarred: false,
		receivedAt,
	});

	for (const att of parsed.attachments) {
		const attachmentId = newId("attachment");
		const r2Key = await putAttachment(env, messageId, attachmentId, att.content, att.contentType);
		await db.insert(attachments).values({
			id: attachmentId,
			messageId,
			filename: att.filename,
			contentType: att.contentType,
			sizeBytes: att.sizeBytes,
			contentId: att.contentId,
			isInline: att.isInline,
			r2Key,
		});
	}

	// 新規スレッドは作成時に 1 件・未読 1 で初期化済みなので、二重に足さない。
	if (!isNewThread) {
		await updateThreadStats(db, { threadId, lastMessageAt: receivedAt, unreadDelta: 1 });
	}

	const { read } = await applyAddressRules(db, {
		addressId: msg.addressId,
		messageId,
		match: {
			from: parsed.from?.address,
			to: parsed.to,
			subject: parsed.subject,
			text: parsed.text,
		},
	});
	if (read) {
		await adjustThreadUnread(db, threadId, -1);
	}

	await dispatchMessageEvent(env, "message.received", messageId);
}
