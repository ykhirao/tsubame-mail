/**
 * 絞り込みは必ず principal.addressIds で行う。userId で絞ってはいけない。
 * FTS5 trigram は 3 文字未満の語を索引しないので、1〜2 文字は LIKE に落とす。
 */
import {
	and,
	asc,
	desc,
	eq,
	exists,
	ne,
	sql,
	type AnyColumn,
	type SQL,
} from "drizzle-orm";
import { addresses, addressGrants, messages, threads } from "@/db/schema";
import type { Db } from "@/db/client";
import type { Principal } from "@/shared/contracts/common";
import type { MessageDirection, MessageStatus } from "@/shared/contracts/messages";
import { jsonIdsIn } from "@/domain/access/policy";
import { normalizeAddress } from "@/domain/mail/address";
import { invalidRequest } from "@/shared/errors";
import type { SearchQuery } from "./query";

export type MessageOrder = "received_at" | "relevance";

export type MessageListFilters = {
	search: SearchQuery;
	/** 解決済みの id であること。アドレス文字列は resolveMailboxId を通す。 */
	addressId?: string;
	direction?: MessageDirection;
	status?: MessageStatus;
	threadId?: string;
	/** アドレスで絞っていないときに除外する、自分で非表示にしたメールボックスの id。 */
	hiddenIds?: string[];
};

export type MessageListParams = {
	principal: Principal;
	filters: MessageListFilters;
	order: MessageOrder;
	limit: number;
	cursor?: string;
};

export type MessageRow = {
	id: string;
	threadId: string | null;
	addressId: string;
	direction: MessageDirection;
	status: MessageStatus;
	subject: string | null;
	snippet: string | null;
	fromAddr: string;
	fromName: string | null;
	toAddr: string;
	ccAddr: string | null;
	spamVerdict: string | null;
	receivedAt: Date;
	isRead: boolean;
	isStarred: boolean;
	hasAttachments: boolean;
	textBody?: string | null;
	htmlBody?: string | null;
};

const listColumns = {
	id: messages.id,
	threadId: messages.threadId,
	addressId: messages.addressId,
	direction: messages.direction,
	status: messages.status,
	subject: messages.subject,
	snippet: messages.snippet,
	fromAddr: messages.fromAddr,
	fromName: messages.fromName,
	toAddr: messages.toAddr,
	ccAddr: messages.ccAddr,
	spamVerdict: messages.spamVerdict,
	receivedAt: messages.receivedAt,
	isRead: messages.isRead,
	isStarred: messages.isStarred,
	hasAttachments: messages.hasAttachments,
};

function charLen(s: string): number {
	return Array.from(s).length;
}

function escapeFtsTerm(w: string): string {
	const cleaned = w.replace(/"/g, " ").replace(/\s+/g, " ").trim();
	return `"${cleaned}"`;
}

// D1 は LIKE のパターンを 50 バイトまでしか受けず、超えると 500 になる（#146）。前後の % を含めて数える。
const LIKE_PATTERN_MAX_BYTES = 50;

// LIKE の % _ \ をそのまま通すと 1 語で全件に当たる（#125）。制御文字（char(31) を含む）は
// 連結した列の区切りと衝突するので、含む語を何にも一致させない。
function likeCondition(col: AnyColumn | SQL, w: string): SQL {
	if (/[\x00-\x1f\x7f]/.test(w)) return sql`0`;
	const escaped = w.replace(/[\\%_]/g, (m) => `\\${m}`);
	const pattern = `%${escaped}%`;
	if (new TextEncoder().encode(pattern).length > LIKE_PATTERN_MAX_BYTES) {
		throw invalidRequest("検索語が長すぎます。1 つの条件は日本語で 15 文字、英数字で 46 文字くらいまでにしてください");
	}
	return sql`${col} like ${pattern} escape '\\'`;
}

function freeWordCondition(w: string): SQL {
	if (charLen(w) >= 3) {
		const term = escapeFtsTerm(w);
		return sql`exists (
			select 1 from "messages_fts" mf
			where mf.rowid = "messages"."rowid"
			  and mf.messages_fts match ${term}
		)`;
	}
	// 5 列ずつ LIKE を張ると語数×5 のバインドを積み、relevance で二重に出て 100 を超える（#88）。
	// 対象列を連結した 1 つの文字列と LIKE 1 本（1 バインド）にまとめる。列の間に制御文字を挟み、
	// 件名の末尾と本文の先頭のような列の境目をまたいで一致しないようにする（検索語は空白で割るので含まない）。
	const sep = sql`char(31)`;
	const haystack = sql`(coalesce(${messages.subject}, '') || ${sep} || coalesce(${messages.textBody}, '') || ${sep} || coalesce(${messages.fromAddr}, '') || ${sep} || coalesce(${messages.toAddr}, '') || ${sep} || coalesce(${messages.ccAddr}, ''))`;
	return likeCondition(haystack, w);
}

// 入れ子にすると語数に比例して SQL の式木が深くなり（#88）、平坦な和にする。
function relevanceScore(words: string[]): SQL {
	return sql.join(
		words.map((w) => sql`(case when ${freeWordCondition(w)} then 1 else 0 end)`),
		sql` + `,
	);
}

function cursorCondition(cur: { receivedAt: number; id: string }): SQL {
	return sql`(
		"messages"."received_at" < ${cur.receivedAt}
		or ("messages"."received_at" = ${cur.receivedAt} and "messages"."id" < ${cur.id})
	)`;
}

function threadCursorCondition(cur: { receivedAt: number; id: string }): SQL {
	return sql`(
		"threads"."last_message_at" < ${cur.receivedAt}
		or ("threads"."last_message_at" = ${cur.receivedAt} and "threads"."id" < ${cur.id})
	)`;
}

function buildMessageConditions(
	principal: Principal,
	filters: MessageListFilters,
): SQL[] {
	const conds: SQL[] = [];
	if (principal.addressIds !== "all") {
		conds.push(jsonIdsIn(messages.addressId, principal.addressIds));
	}
	const s = filters.search;
	// アドレスで名指ししたときは hidden でも出す。絞っていないときだけ自分の非表示を除く。
	if (filters.addressId) {
		conds.push(eq(messages.addressId, filters.addressId));
	} else if (filters.hiddenIds?.length) {
		conds.push(jsonIdsNotIn(messages.addressId, filters.hiddenIds));
	}
	if (filters.direction) conds.push(eq(messages.direction, filters.direction));
	if (filters.status) {
		conds.push(eq(messages.status, filters.status));
	} else {
		conds.push(ne(messages.status, "trash"));
	}
	if (filters.threadId) conds.push(eq(messages.threadId, filters.threadId));
	if (s.from) conds.push(likeCondition(messages.fromAddr, s.from));
	if (s.to) conds.push(likeCondition(messages.toAddr, s.to));
	if (s.subject) conds.push(likeCondition(messages.subject, s.subject));
	if (s.body) conds.push(likeCondition(messages.textBody, s.body));
	if (s.since !== undefined) conds.push(sql`${messages.receivedAt} >= ${s.since}`);
	if (s.until !== undefined) conds.push(sql`${messages.receivedAt} <= ${s.until}`);
	if (s.isUnread) conds.push(eq(messages.isRead, false));
	if (s.isStarred) conds.push(eq(messages.isStarred, true));
	if (s.hasAttachment) conds.push(eq(messages.hasAttachments, true));
	for (const w of s.freeWords) conds.push(freeWordCondition(w));
	return conds;
}

export async function queryMessages(
	db: Db,
	params: MessageListParams,
): Promise<{ rows: MessageRow[]; nextCursor: string | null }> {
	const conds = buildMessageConditions(params.principal, params.filters);
	if (params.cursor) {
		const cur = decodeCursor(params.cursor);
		if (!cur) throw invalidRequest("カーソルが不正です");
		conds.push(cursorCondition(cur));
	}
	const where = conds.length > 0 ? and(...conds) : undefined;

	let orderBy: SQL[];
	if (params.order === "relevance" && params.filters.search.freeWords.length > 0) {
		orderBy = [
			sql`${relevanceScore(params.filters.search.freeWords)} desc`,
			desc(messages.receivedAt),
			desc(messages.id),
		];
	} else {
		orderBy = [desc(messages.receivedAt), desc(messages.id)];
	}

	const rows = await db
		.select(listColumns)
		.from(messages)
		.where(where)
		.orderBy(...orderBy)
		.limit(params.limit + 1)
		.all();

	const hasMore = rows.length > params.limit;
	const page = rows.slice(0, params.limit);
	const last = page.at(-1);
	let nextCursor: string | null = null;
	if (hasMore && last) {
		nextCursor = encodeCursor(toUnix(last.receivedAt), last.id);
	}
	return { rows: page, nextCursor };
}

/** 権限外のアドレスは null を返す。呼び出し側は「該当なし」として扱うこと。 */
export async function resolveMailboxId(
	db: Db,
	principal: Principal,
	value: string,
): Promise<string | null> {
	let id = value;
	if (value.includes("@")) {
		const norm = normalizeAddress(value);
		if (!norm) return null;
		const row = await db
			.select({ id: addresses.id })
			.from(addresses)
			.where(eq(addresses.address, norm))
			.get();
		if (!row) return null;
		id = row.id;
	}
	if (!id) return null;
	if (principal.addressIds !== "all" && !principal.addressIds.includes(id)) {
		return null;
	}
	return id;
}

export function jsonIdsNotIn(column: AnyColumn, ids: string[]): SQL {
	if (ids.length === 0) return sql`1`;
	// jsonIdsIn と同じ JSON 1 本の形で、バインド変数が id の数に比例しないようにする（#57）。
	return sql`${column} not in (select value from json_each(${JSON.stringify(ids)}))`;
}

/** この利用者が grants で非表示にしたメールボックスの id。 */
export async function hiddenAddressIds(db: Db, userId: string): Promise<string[]> {
	const rows = await db
		.select({ addressId: addressGrants.addressId })
		.from(addressGrants)
		.where(and(eq(addressGrants.userId, userId), eq(addressGrants.hidden, true)))
		.all();
	return rows.map((r) => r.addressId);
}

export async function getMessage(
	db: Db,
	principal: Principal,
	messageId: string,
	opts: { withBody?: boolean; includeTrash?: boolean } = {},
): Promise<MessageRow | null> {
	const conds: SQL[] = [eq(messages.id, messageId)];
	if (!opts.includeTrash) conds.push(ne(messages.status, "trash"));
	if (principal.addressIds !== "all") {
		conds.push(jsonIdsIn(messages.addressId, principal.addressIds));
	}
	const columns = opts.withBody
		? { ...listColumns, textBody: messages.textBody, htmlBody: messages.htmlBody }
		: listColumns;
	return (await db.select(columns).from(messages).where(and(...conds)).get()) ?? null;
}

export type ThreadRow = {
	id: string;
	addressId: string;
	subject: string | null;
	lastMessageAt: Date;
	messageCount: number;
	unreadCount: number;
	address: string | null;
	addressColor: string | null;
	lastFromAddr: string | null;
	lastFromName: string | null;
	/** 最新のメールの向き。一覧で受信と送信控えを見分けるために出す（B-34）。 */
	lastDirection: MessageDirection | null;
	snippet: string | null;
	hasAttachments: boolean;
	isStarred: boolean;
};

export type ThreadView = "inbox" | "starred" | "sent" | "trash";

export type ThreadListParams = {
	principal: Principal;
	addressId?: string;
	limit: number;
	cursor?: string;
	view?: ThreadView;
	/** 既定 false。true でゴミ箱しか持たないスレッドも返す。 */
	includeTrash?: boolean;
	/** アドレスで絞っていないときに除外する、自分で非表示にしたメールボックスの id。 */
	hiddenIds?: string[];
};

const threadColumns = {
	id: threads.id,
	addressId: threads.addressId,
	subject: threads.subject,
	lastMessageAt: threads.lastMessageAt,
	messageCount: threads.messageCount,
	unreadCount: threads.unreadCount,
};

export async function queryThreads(
	db: Db,
	params: ThreadListParams,
): Promise<{ rows: ThreadRow[]; nextCursor: string | null }> {
	const conds: SQL[] = [];
	if (params.principal.addressIds !== "all") {
		conds.push(jsonIdsIn(threads.addressId, params.principal.addressIds));
	}
	if (params.addressId) {
		conds.push(eq(threads.addressId, params.addressId));
	} else if (params.hiddenIds?.length) {
		conds.push(jsonIdsNotIn(threads.addressId, params.hiddenIds));
	}
	if (params.cursor) {
		const cur = decodeCursor(params.cursor);
		if (!cur) throw invalidRequest("カーソルが不正です");
		conds.push(threadCursorCondition(cur));
	}
	const view = params.view ?? "inbox";
	const includeTrash = params.includeTrash === true || view === "trash";
	const threadHas = (cond: SQL) =>
		exists(
			db
				.select({ one: sql`1` })
				.from(messages)
				.where(and(eq(messages.threadId, threads.id), cond)),
		);
	if (view === "starred") {
		conds.push(threadHas(eq(messages.isStarred, true)));
	} else if (view === "sent") {
		conds.push(threadHas(eq(messages.direction, "outbound")));
	} else if (view === "trash") {
		conds.push(threadHas(eq(messages.status, "trash")));
	} else if (!includeTrash) {
		// メッセージが全てゴミ箱（drop ルールなど）のスレッドを受信箱に出さない（#92）。
		conds.push(threadHas(ne(messages.status, "trash")));
	}
	const where = conds.length > 0 ? and(...conds) : undefined;

	const rows = await db
		.select(threadColumns)
		.from(threads)
		.where(where)
		.orderBy(desc(threads.lastMessageAt), desc(threads.id))
		.limit(params.limit + 1)
		.all();

	const hasMore = rows.length > params.limit;
	const page = rows.slice(0, params.limit);
	const last = page.at(-1);
	let nextCursor: string | null = null;
	if (hasMore && last) {
		nextCursor = encodeCursor(toUnix(last.lastMessageAt), last.id);
	}
	return { rows: await withLastMessage(db, page, !includeTrash), nextCursor };
}

// スレッドごとに 1 クエリ投げず、ページ分をまとめて引いて JS 側で最新を選ぶ。
async function withLastMessage(
	db: Db,
	page: Omit<
		ThreadRow,
		| "address"
		| "addressColor"
		| "lastFromAddr"
		| "lastFromName"
		| "lastDirection"
		| "snippet"
		| "hasAttachments"
		| "isStarred"
	>[],
	excludeTrash: boolean,
): Promise<ThreadRow[]> {
	const ids = page.map((t) => t.id);
	if (ids.length === 0) return [];

	const msgConds: SQL[] = [jsonIdsIn(messages.threadId, ids)];
	if (excludeTrash) msgConds.push(ne(messages.status, "trash"));
	const rows = await db
		.select({
			threadId: messages.threadId,
			fromAddr: messages.fromAddr,
			fromName: messages.fromName,
			direction: messages.direction,
			snippet: messages.snippet,
			hasAttachments: messages.hasAttachments,
			isStarred: messages.isStarred,
			receivedAt: messages.receivedAt,
		})
		.from(messages)
		.where(and(...msgConds))
		.orderBy(asc(messages.receivedAt))
		.all();

	const addressIds = [...new Set(page.map((t) => t.addressId))];
	const addressRows = await db
		.select({ id: addresses.id, address: addresses.address, color: addresses.color })
		.from(addresses)
		.where(jsonIdsIn(addresses.id, addressIds))
		.all();
	const addressById = new Map(addressRows.map((a) => [a.id, a]));

	const latest = new Map<string, (typeof rows)[number]>();
	const starred = new Set<string>();
	const attached = new Set<string>();
	for (const r of rows) {
		if (!r.threadId) continue;
		latest.set(r.threadId, r); // 昇順なので最後に入ったものが最新
		if (r.isStarred) starred.add(r.threadId);
		if (r.hasAttachments) attached.add(r.threadId);
	}

	return page.map((t) => {
		const m = latest.get(t.id);
		return {
			...t,
			address: addressById.get(t.addressId)?.address ?? null,
			addressColor: addressById.get(t.addressId)?.color ?? null,
			lastFromAddr: m?.fromAddr ?? null,
			lastFromName: m?.fromName ?? null,
			lastDirection: m?.direction ?? null,
			snippet: m?.snippet ?? null,
			hasAttachments: attached.has(t.id),
			isStarred: starred.has(t.id),
		};
	});
}

/** 権限外なら null。 */
export async function getThread(
	db: Db,
	principal: Principal,
	threadId: string,
	includeTrash = false,
): Promise<ThreadRow | null> {
	const row = await db.select(threadColumns).from(threads).where(eq(threads.id, threadId)).get();
	if (!row) return null;
	if (principal.addressIds !== "all" && !principal.addressIds.includes(row.addressId)) {
		return null;
	}
	if (!includeTrash) {
		const live = await db
			.select({ one: sql`1` })
			.from(messages)
			.where(and(eq(messages.threadId, threadId), ne(messages.status, "trash")))
			.get();
		if (!live) return null;
	}
	const [withSummary] = await withLastMessage(db, [row], !includeTrash);
	return withSummary ?? null;
}

/** 同じ From への接ぎ木を無限に続けられても、1 スレッドで返す本文量に上限を付ける。 */
export const MAX_THREAD_MESSAGES = 200;

export type ThreadMessagesOptions = {
	includeTrash?: boolean;
	/** これより古いメッセージを取るカーソル。無いときは最新の MAX_THREAD_MESSAGES 件。 */
	before?: string;
};

export type ThreadMessagesResult = {
	/** 古い順。 */
	messages: MessageRow[];
	hasOlder: boolean;
	olderCursor: string | null;
	olderCount: number;
};

export async function queryThreadMessages(
	db: Db,
	principal: Principal,
	threadId: string,
	opts: ThreadMessagesOptions = {},
): Promise<ThreadMessagesResult> {
	const conds: SQL[] = [eq(messages.threadId, threadId)];
	if (principal.addressIds !== "all") {
		conds.push(jsonIdsIn(messages.addressId, principal.addressIds));
	}
	if (!opts.includeTrash) conds.push(ne(messages.status, "trash"));
	if (opts.before) {
		const cur = decodeCursor(opts.before);
		if (!cur) throw invalidRequest("カーソルが不正です");
		conds.push(cursorCondition(cur));
	}
	const where = and(...conds);
	const columns = { ...listColumns, textBody: messages.textBody, htmlBody: messages.htmlBody };
	// 最新の MAX_THREAD_MESSAGES 件を古い順に返すため、降順で max+1 取り、末尾の 1 件を捨てて反転する。#35 の再発防止。
	const rows = await db
		.select(columns)
		.from(messages)
		.where(where)
		.orderBy(desc(messages.receivedAt), desc(messages.id))
		.limit(MAX_THREAD_MESSAGES + 1)
		.all();
	const hasOlder = rows.length > MAX_THREAD_MESSAGES;
	const page = rows.slice(0, MAX_THREAD_MESSAGES);
	const messagesAsc = page.reverse();
	const oldest = messagesAsc[0];
	const olderCursor = hasOlder && oldest ? encodeCursor(toUnix(oldest.receivedAt), oldest.id) : null;
	const totalRow = await db
		.select({ n: sql`count(*)` })
		.from(messages)
		.where(where)
		.get();
	const total = Number(totalRow?.n ?? 0);
	const olderCount = Math.max(0, total - messagesAsc.length);
	return { messages: messagesAsc, hasOlder, olderCursor, olderCount };
}

export async function attachmentsForMessage(
	db: Db,
	messageId: string,
): Promise<Array<{ id: string; filename: string; contentType: string; sizeBytes: number; isInline: boolean }>> {
	const { attachments } = await import("@/db/schema");
	return db
		.select({
			id: attachments.id,
			filename: attachments.filename,
			contentType: attachments.contentType,
			sizeBytes: attachments.sizeBytes,
			isInline: attachments.isInline,
		})
		.from(attachments)
		.where(eq(attachments.messageId, messageId))
		.orderBy(attachments.createdAt, attachments.id)
		.all();
}

export function encodeCursor(seconds: number, id: string): string {
	const raw = `${Math.floor(seconds)}:${id}`;
	return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 不正なカーソルは throw せず null を返す。 */
export function decodeCursor(
	cursor: string,
): { receivedAt: number; id: string } | null {
	try {
		let s = cursor.replace(/-/g, "+").replace(/_/g, "/");
		while (s.length % 4 !== 0) s += "=";
		const decoded = atob(s);
		// received_at は外れ値クランプの前は負数もありえた（#19）。cursor 自体は正負どちらも読めてよい。
		const m = decoded.match(/^(-?\d+):(.+)$/);
		if (!m) return null;
		return { receivedAt: Number(m[1]), id: m[2]! };
	} catch {
		return null;
	}
}

export function toUnix(d: Date): number {
	return Math.floor(d.getTime() / 1000);
}
