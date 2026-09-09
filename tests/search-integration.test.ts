import { describe, expect, it, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations } from "./helpers/migrate";
import initSql from "../migrations/0000_init.sql?raw";
import ftsSql from "../migrations/0001_search_fts.sql?raw";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "@/db/schema";
import type { Principal } from "@/shared/contracts/common";
import {
	queryMessages,
	resolveMailboxId,
	decodeCursor,
	encodeCursor,
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
});
