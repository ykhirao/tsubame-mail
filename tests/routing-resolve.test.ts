import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { getDb } from "@/db/client";
import { addresses, domains, routingRules } from "@/db/schema";
import { resetDb } from "./helpers";
import { resolveIncoming } from "@/domain/routing/resolve";
import { newId } from "@/lib/id";
import { matchRule } from "@/domain/routing/rules";

const DOM_ID = "dom_test";
const DOMAIN = "example.com";

describe("resolveIncoming", () => {
	beforeEach(resetDb);

	it("未登録ドメイン宛は reject", async () => {
		const db = getDb(env);
		const r = await resolveIncoming(db, { from: "x@y.com", to: "a@unregistered.example" });
		expect(r).toEqual({ action: "reject", reason: "このドメインは未登録です" });
	});

	it("実在メールボックスへ deliver（小文字正規化）", async () => {
		const db = getDb(env);
		await db.insert(domains).values({ id: DOM_ID, name: DOMAIN, zoneId: "z", zoneName: DOMAIN, mode: "apex" });
		await db
			.insert(addresses)
			.values({ id: "adr_a", domainId: DOM_ID, localPart: "a", address: "a@example.com", kind: "mailbox" });
		const r = await resolveIncoming(db, { from: "x@y.com", to: "A@example.com" });
		expect(r).toEqual({ action: "deliver", addressId: "adr_a" });
	});

	it("エイリアスは alias_target_id へ配送", async () => {
		const db = getDb(env);
		await db.insert(domains).values({ id: DOM_ID, name: DOMAIN, zoneId: "z", zoneName: DOMAIN, mode: "apex" });
		await db.insert(addresses).values([
			{ id: "adr_box", domainId: DOM_ID, localPart: "box", address: "box@example.com", kind: "mailbox" },
			{
				id: "adr_alias",
				domainId: DOM_ID,
				localPart: "alias",
				address: "alias@example.com",
				kind: "alias",
				aliasTargetId: "adr_box",
			},
		]);
		const r = await resolveIncoming(db, { from: "x@y.com", to: "alias@example.com" });
		expect(r).toEqual({ action: "deliver", addressId: "adr_box" });
	});

	it("catch-all が実在アドレスを覆い隠さない", async () => {
		const db = getDb(env);
		await db.insert(domains).values({ id: DOM_ID, name: DOMAIN, zoneId: "z", zoneName: DOMAIN, mode: "apex" });
		await db.insert(addresses).values([
			{ id: "adr_box", domainId: DOM_ID, localPart: "box", address: "box@example.com", kind: "mailbox" },
			{
				id: "adr_catch",
				domainId: DOM_ID,
				localPart: "_",
				address: "_@example.com",
				kind: "mailbox",
				isCatchAll: true,
			},
		]);
		const real = await resolveIncoming(db, { from: "x@y.com", to: "box@example.com" });
		expect(real).toEqual({ action: "deliver", addressId: "adr_box" });
		const unknown = await resolveIncoming(db, { from: "x@y.com", to: "nobody@example.com" });
		expect(unknown).toEqual({ action: "deliver", addressId: "adr_catch" });
	});

	it("reject ルールは実在アドレス宛でも効く", async () => {
		const db = getDb(env);
		await db.insert(domains).values({ id: DOM_ID, name: DOMAIN, zoneId: "z", zoneName: DOMAIN, mode: "apex" });
		await db
			.insert(addresses)
			.values({ id: "adr_box", domainId: DOM_ID, localPart: "box", address: "box@example.com", kind: "mailbox" });
		await db.insert(routingRules).values({
			id: newId("rule"),
			scope: "domain",
			domainId: DOM_ID,
			name: "spam",
			action: "reject",
			matcher: { from: "spammer@evil.com" },
			target: "スパムを拒否",
			priority: 10,
			enabled: true,
		});
		const r = await resolveIncoming(db, { from: "spammer@evil.com", to: "box@example.com" });
		expect(r).toEqual({ action: "reject", reason: "スパムを拒否" });
	});

	it("フォールバックは priority 降順で評価する（フォワード）", async () => {
		const db = getDb(env);
		await db.insert(domains).values({ id: DOM_ID, name: DOMAIN, zoneId: "z", zoneName: DOMAIN, mode: "apex" });
		await db.insert(routingRules).values([
			{
				id: newId("rule"),
				scope: "domain",
				domainId: DOM_ID,
				name: "low",
				action: "forward",
				matcher: {},
				target: "low@x.com",
				priority: 1,
				enabled: true,
			},
			{
				id: newId("rule"),
				scope: "domain",
				domainId: DOM_ID,
				name: "high",
				action: "forward",
				matcher: {},
				target: "high@x.com",
				priority: 100,
				enabled: true,
			},
		]);
		const r = await resolveIncoming(db, { from: "x@y.com", to: "unknown@example.com" });
		expect(r).toEqual({ action: "forward", to: "high@x.com" });
	});
});

describe("matchRule", () => {
	it("from の部分一致・大文字小文字を無視", () => {
		expect(matchRule({ from: "SPAM" }, { from: "Someone@Spam.example.com" })).toBe(true);
		expect(matchRule({ from: "spam" }, { from: "good@example.com" })).toBe(false);
	});

	it("空 matcher は全件一致", () => {
		expect(matchRule({}, { from: "x@y.com", to: "z@w.com" })).toBe(true);
	});

	it("subject が無い入力では subject 条件は不一致", () => {
		expect(matchRule({ subject: "見積" }, { from: "x@y.com" })).toBe(false);
	});

	it("contains は本文の部分一致", () => {
		expect(matchRule({ contains: "請求書" }, { text: "こちらに請求書を添付します" })).toBe(true);
	});
});
