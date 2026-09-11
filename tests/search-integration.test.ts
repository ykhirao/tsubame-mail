import { describe, expect, it, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations } from "./helpers/migrate";
import initSql from "../migrations/0000_init.sql?raw";
import ftsSql from "../migrations/0001_search_fts.sql?raw";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { Principal } from "@/shared/contracts/common";
import {
	queryMessages,
	queryThreadMessages,
	queryThreads,
	resolveMailboxId,
	decodeCursor,
	encodeCursor,
	MAX_THREAD_MESSAGES,
} from "@/domain/search/sql";
import { parseSearchQuery } from "@/domain/search/query";

const db = (() => drizzle(env.DB, { schema }))();

function splitSql(src: string): string[] {
	return src
		.split("--> statement-breakpoint")
		.map((s) =>
			s
				.split("\n")
				.filter((l) => !l.trim().startsWith("--"))
				.join("\n")
				.trim(),
		)
		.filter(Boolean);
}

beforeEach(async () => {
	await applyMigrations();
	await seed();
});

function principal(addressIds: string[] | "all", role: "owner" | "member" = "member"): Principal {
	return {
		userId: "usr_test",
		role,
		via: "session",
		scopes: ["read"],
		addressIds,
		writableAddressIds: addressIds,
	};
}

async function seed() {
	// テストごとにデータをリセットしてから基本データを投入する。
	// messages の DELETE は messages_fts を同期するトリガが働くので、FTS には直接触れない。
	await db.delete(schema.messages);
	await db.delete(schema.attachments);
	await db.delete(schema.threads);
	await db.delete(schema.addresses);
	await db.delete(schema.domains);

	await db.insert(schema.domains).values({
		id: "dom_1",
		name: "ex.com",
		zoneId: "zone_1",
		zoneName: "ex.com",
		mode: "subdomain",
	});
	await db.insert(schema.addresses).values([
		{ id: "adr_a", domainId: "dom_1", localPart: "a", address: "a@ex.com" },
		{ id: "adr_b", domainId: "dom_1", localPart: "b", address: "b@ex.com" },
	]);
	await db.insert(schema.threads).values({
		id: "thr_a",
		addressId: "adr_a",
		subject: "見積のご相談",
		lastMessageAt: new Date(1_770_000_000_000),
		messageCount: 2,
		unreadCount: 1,
	});
	await db.insert(schema.threads).values({
		id: "thr_b",
		addressId: "adr_b",
		subject: "請求書",
		lastMessageAt: new Date(1_770_020_000_000),
		messageCount: 1,
		unreadCount: 0,
	});
}

type MsgSeed = {
	id: string;
	addressId: string;
	subject: string;
	textBody?: string;
	receivedAt?: Date;
	threadId?: string | null;
};

function insertMessage(over: MsgSeed) {
	return db.insert(schema.messages).values({
		id: over.id,
		addressId: over.addressId,
		subject: over.subject,
		textBody: over.textBody ?? null,
		receivedAt: over.receivedAt ?? new Date(1_770_000_000_000),
		threadId: over.threadId ?? "thr_a",
		direction: "inbound",
		status: "received",
		fromAddr: "sender@example.com",
		fromName: "取引先",
		toAddr: "a@ex.com",
		isRead: false,
		isStarred: false,
		hasAttachments: false,
	});
}

describe("検索: 日本語の部分一致（FTS5 trigram と LIKE フォールバック）", () => {
	it("3 文字以上は FTS、1〜2 文字は LIKE のフォールバックで引ける", async () => {

		await insertMessage({
			id: "msg_jp",
			addressId: "adr_a",
			subject: "見積書を送ります",
			textBody: "お世話になっております。見積書を添付します。",
			receivedAt: new Date(1_770_000_100_000),
		});

		const principalAll = principal("all", "owner");
		const fts = await queryMessages(db, {
			principal: principalAll,
			filters: { search: parseSearchQuery("見積書") },
			order: "received_at",
			limit: 25,
		});
		expect(fts.rows.map((r) => r.id)).toContain("msg_jp");

		const like = await queryMessages(db, {
			principal: principalAll,
			filters: { search: parseSearchQuery("見積") },
			order: "received_at",
			limit: 25,
		});
		expect(like.rows.map((r) => r.id)).toContain("msg_jp");
	});

	it("subject: 演算子（短い日本語）も LIKE で部分一致する", async () => {

		await insertMessage({
			id: "msg_subj",
			addressId: "adr_a",
			subject: "請求書の送付について",
			receivedAt: new Date(1_770_000_200_000),
		});
		const r = await queryMessages(db, {
			principal: principal("all", "owner"),
			filters: { search: parseSearchQuery("subject:請求") },
			order: "received_at",
			limit: 25,
		});
		expect(r.rows.map((x) => x.id)).toContain("msg_subj");
	});

	it("期間(since/until)で絞り込める", async () => {

		await insertMessage({
			id: "msg_in",
			addressId: "adr_a",
			subject: "期限内",
			receivedAt: new Date(Date.UTC(2026, 0, 15)),
		});
		await insertMessage({
			id: "msg_out",
			addressId: "adr_a",
			subject: "期間外",
			receivedAt: new Date(Date.UTC(2026, 3, 1)),
		});
		const r = await queryMessages(db, {
			principal: principal("all", "owner"),
			filters: { search: parseSearchQuery("since:2026-01-01 until:2026-02-01") },
			order: "received_at",
			limit: 100,
		});
		const ids = r.rows.map((x) => x.id);
		expect(ids).toContain("msg_in");
		expect(ids).not.toContain("msg_out");
	});
});

describe("認可: 権限外のアドレスのメッセージを返さない", () => {
	it("addressIds に含まれないアドレスのメッセージは絶対に出ない", async () => {

		await insertMessage({
			id: "msg_a",
			addressId: "adr_a",
			subject: "見積書",
			receivedAt: new Date(1_770_000_400_000),
		});
		await db.insert(schema.messages).values({
			id: "msg_b",
			threadId: "thr_b",
			addressId: "adr_b",
			direction: "inbound",
			status: "received",
			fromAddr: "sender@example.com",
			toAddr: "b@ex.com",
			subject: "見積書（b宛て）",
			textBody: "機密: b の見積もり",
			receivedAt: new Date(1_770_000_500_000),
		});

		const r = await queryMessages(db, {
			principal: principal(["adr_a"]),
			filters: { search: parseSearchQuery("見積") },
			order: "received_at",
			limit: 100,
		});
		const ids = r.rows.map((x) => x.id);
		expect(ids).toContain("msg_a");
		expect(ids).not.toContain("msg_b");
	});

	it("アドレス解決(in:)は権限外を null として返す", async () => {

		const ok = await resolveMailboxId(db, principal(["adr_a"]), "a@ex.com");
		expect(ok).toBe("adr_a");
		const denied = await resolveMailboxId(db, principal(["adr_a"]), "b@ex.com");
		expect(denied).toBeNull();
	});
});

describe("FTS 同期トリガの delete コマンド形式（#27）", () => {
	it("UPDATE 後は旧語で MATCH してもヒットしない", async () => {
		await insertMessage({
			id: "msg_fts_upd",
			addressId: "adr_a",
			subject: "secret invoice",
			receivedAt: new Date(1_770_002_000_000),
		});
		const before = await queryMessages(db, {
			principal: principal("all", "owner"),
			filters: { search: parseSearchQuery("secret invoice") },
			order: "received_at",
			limit: 25,
		});
		expect(before.rows.map((r) => r.id)).toContain("msg_fts_upd");

		await db
			.update(schema.messages)
			.set({ subject: "changed" })
			.where(eq(schema.messages.id, "msg_fts_upd"));

		const stale = await queryMessages(db, {
			principal: principal("all", "owner"),
			filters: { search: parseSearchQuery("secret invoice") },
			order: "received_at",
			limit: 25,
		});
		expect(stale.rows.map((r) => r.id)).not.toContain("msg_fts_upd");

		const fresh = await queryMessages(db, {
			principal: principal("all", "owner"),
			filters: { search: parseSearchQuery("changed") },
			order: "received_at",
			limit: 25,
		});
		expect(fresh.rows.map((r) => r.id)).toContain("msg_fts_upd");
	});

	it("DELETE 後、rowid が再利用されても別アドレスの新しい行が旧語でヒットしない", async () => {
		await insertMessage({
			id: "msg_fts_del",
			addressId: "adr_a",
			subject: "world exclusive",
			receivedAt: new Date(1_770_003_000_000),
		});
		const row = await env.DB.prepare(
			`select rowid as r from messages where id = ?`,
		)
			.bind("msg_fts_del")
			.first<{ r: number }>();
		const rowid = row!.r;

		await db.delete(schema.messages).where(eq(schema.messages.id, "msg_fts_del"));

		await env.DB.prepare(
			`insert into messages
				(rowid, id, thread_id, address_id, direction, status, from_addr, to_addr, subject, received_at, is_read, is_starred, has_attachments)
			values (?, ?, 'thr_b', 'adr_b', 'inbound', 'received', 'sender@example.com', 'b@ex.com', 'hello', ?, 0, 0, 0)`,
		)
			.bind(rowid, "msg_fts_reused", 1_770_003_500_000)
			.run();

		const falsePositive = await queryMessages(db, {
			principal: principal("all", "owner"),
			filters: { search: parseSearchQuery("world exclusive") },
			order: "received_at",
			limit: 25,
		});
		expect(falsePositive.rows.map((r) => r.id)).not.toContain("msg_fts_reused");

		const genuine = await queryMessages(db, {
			principal: principal("all", "owner"),
			filters: { search: parseSearchQuery("hello") },
			order: "received_at",
			limit: 25,
		});
		expect(genuine.rows.map((r) => r.id)).toContain("msg_fts_reused");
	});
});

describe("カーソルページング", () => {
	it("limit をまたいでも重複・取りこぼしがない", async () => {

		for (let i = 0; i < 5; i++) {
			await insertMessage({
				id: `msg_pg_${i}`,
				addressId: "adr_a",
				subject: `ページング ${i}`,
				receivedAt: new Date(1_770_001_000_000 + i * 1000),
			});
		}
		const seen: string[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < 3; page++) {
			const r = await queryMessages(db, {
				principal: principal("all", "owner"),
				filters: { search: parseSearchQuery("") },
				order: "received_at",
				limit: 2,
				cursor,
			});
			seen.push(...r.rows.map((x) => x.id));
			cursor = r.nextCursor ?? undefined;
			if (!r.nextCursor) break;
		}
		expect(seen.length).toBe(5);
		expect(new Set(seen).size).toBe(5);
	});

	it("encodeCursor / decodeCursor が往復する", () => {
		const cur = encodeCursor(1_770_000_000, "msg_x");
		expect(decodeCursor(cur)).toEqual({ receivedAt: 1_770_000_000, id: "msg_x" });
		expect(decodeCursor("invalid!!")).toBeNull();
	});

	it("負数の receivedAt も読める（#19: 1970 年以前のクランプ前の値でも次ページが 400 にならない）", () => {
		const cur = encodeCursor(-62135596800, "msg_old");
		expect(decodeCursor(cur)).toEqual({ receivedAt: -62135596800, id: "msg_old" });
	});
});

describe("queryThreadMessages", () => {
	it("同じ From への接ぎ木で無限に伸ばせないよう上限を付ける（#35）", async () => {
		const total = MAX_THREAD_MESSAGES + 5;
		for (let i = 0; i < total; i++) {
			await insertMessage({
				id: `msg_thr_${i}`,
				addressId: "adr_a",
				subject: `続き ${i}`,
				receivedAt: new Date(1_770_002_000_000 + i * 1000),
				threadId: "thr_a",
			});
		}
		const rows = await queryThreadMessages(db, principal("all", "owner"), "thr_a");
		expect(rows.length).toBeLessThanOrEqual(MAX_THREAD_MESSAGES);
	});
});

describe("スレッド一覧・詳細は既定でゴミ箱を除外する（#92）", () => {
	it("全メッセージが trash のスレッドは受信箱に出ず、includeTrash で出せる", async () => {
		const thrId = "thr_trash";
		await insertMessage({
			id: "msg_a1",
			addressId: "adr_a",
			subject: "普通のメール",
			receivedAt: new Date(1_770_010_000_000),
		});
		await db.insert(schema.threads).values({
			id: thrId,
			addressId: "adr_a",
			subject: "宣伝",
			lastMessageAt: new Date(1_770_011_000_000),
			messageCount: 1,
			unreadCount: 0,
		});
		await db.insert(schema.messages).values({
			id: "msg_trash",
			threadId: thrId,
			addressId: "adr_a",
			direction: "inbound",
			status: "trash",
			fromAddr: "spam@evil.jp",
			toAddr: "a@ex.com",
			subject: "宣伝",
			receivedAt: new Date(1_770_011_000_000),
			isRead: false,
			isStarred: false,
			hasAttachments: false,
		});

		const normal = await queryThreads(db, { principal: principal("all", "owner"), limit: 25 });
		expect(normal.rows.map((t) => t.id)).toContain("thr_a");
		expect(normal.rows.map((t) => t.id)).not.toContain(thrId);

		const withTrash = await queryThreads(db, {
			principal: principal("all", "owner"),
			limit: 25,
			includeTrash: true,
		});
		expect(withTrash.rows.map((t) => t.id)).toContain(thrId);

		const msgs = await queryThreadMessages(db, principal("all", "owner"), thrId);
		expect(msgs).toHaveLength(0);
		const allMsgs = await queryThreadMessages(db, principal("all", "owner"), thrId, true);
		expect(allMsgs.map((m) => m.id)).toContain("msg_trash");
	});
});
