import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { newId } from "@/lib/id";
import { ApiError } from "@/shared/errors";
import messagesRoutes from "@/api/v1/messages";
import addressesRoutes from "@/api/v1/addresses";
import {
	buildTestApp,
	createAddress,
	createApiKeyFor,
	createDomain,
	createUser,
	db,
	grant,
	json,
	request,
	sessionCookie,
} from "./auth-helpers";
import { callJson, memberPrincipal, mountRouter, ownerPrincipal } from "./domains-helpers";
import type { Principal } from "@/shared/contracts/common";
import { parseSearchQuery } from "@/domain/search/query";
import { queryThreads } from "@/domain/search/sql";

const app = buildTestApp();

async function wipe() {
	const d = db();
	await d.delete(schema.auditLogs);
	await d.delete(schema.sessions);
	await d.delete(schema.apiKeys);
	await d.delete(schema.addressGrants);
	await d.delete(schema.messages);
	await d.delete(schema.attachments);
	await d.delete(schema.threads);
	await d.delete(schema.addresses);
	await d.delete(schema.domains);
	await d.delete(schema.users);
}

beforeEach(wipe);

async function seedAddressesForUser(memberId: string, n: number): Promise<string[]> {
	const domainId = await createDomain("grants.test");
	const ids: string[] = [];
	for (let i = 0; i < n; i++) {
		const id = await createAddress(domainId, `addr${i}`, "grants.test");
		ids.push(id);
		await grant(memberId, id, "read");
	}
	return ids;
}

async function insertMsg(over: {
	id: string;
	addressId: string;
	direction: "inbound" | "outbound";
	status: "received" | "sent" | "failed" | "trash";
	subject?: string;
	threadId?: string | null;
	isStarred?: boolean;
}) {
	await db().insert(schema.messages).values({
		id: over.id,
		addressId: over.addressId,
		direction: over.direction,
		status: over.status,
		fromAddr: "sender@example.test",
		fromName: "差出人",
		toAddr: "a@grants.test",
		subject: over.subject ?? "件名",
		textBody: over.subject ?? "本文",
		receivedAt: new Date(1_770_000_000_000),
		threadId: over.threadId ?? null,
		isRead: false,
		isStarred: over.isStarred ?? false,
		hasAttachments: false,
	});
}

describe("#57 D1 バインド変数 100 個の上限（grant 150 件の member）", () => {
	it("PUT /admin/users/:id/grants に grant 150 件を入れても 200 になる", async () => {
		const owner = await createUser({ role: "owner", password: "password-1234" });
		const login = await request(app, "/api/v1/auth/login", json({ email: owner.email, password: "password-1234" }));
		const cookie = sessionCookie(login);

		const member = await createUser({ role: "member", password: "password-1234" });
		const ids = await seedAddressesForUser(member.id, 150);
		const grants = ids.map((addressId) => ({ addressId, level: "read" as const }));

		const res = await request(app, `/api/v1/admin/users/${member.id}/grants`, {
			method: "PUT",
			body: JSON.stringify(grants),
			cookie,
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { grants: unknown[] };
		expect(body.grants.length).toBe(150);
	});

	it("grant 150 件の member の /me が 200 になる（listAccessibleAddresses が全部返す）", async () => {
		const member = await createUser({ role: "member", password: "password-1234" });
		await seedAddressesForUser(member.id, 150);
		const key = await createApiKeyFor({ userId: member.id, scopes: ["read"], addressIds: null });

		const res = await request(app, "/api/v1/me", { bearer: key.token });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { addresses: unknown[] };
		expect(body.addresses.length).toBe(150);
	});

	it("grant 150 件の member の /addresses と /messages が 200 になる（500 にならない）", async () => {
		const member = await createUser({ role: "member", password: "password-1234" });
		const ids = await seedAddressesForUser(member.id, 150);
		await insertMsg({ id: newId("message"), addressId: ids[0]!, direction: "inbound", status: "received" });
		const p = memberPrincipal(ids, []);

		const addrApp = mountRouter("/", addressesRoutes, p);
		const list = await callJson(addrApp, "/?limit=200");
		expect(list.status).toBe(200);

		const msgApp = mountRouter("/", messagesRoutes, p);
		const ml = await callJson(msgApp, "/?limit=25");
		expect(ml.status).toBe(200);
		expect(ml.json.data).toHaveLength(1);
	});

	it("grant 150 件の member のスレッド一覧が 500 にならない", async () => {
		const member = await createUser({ role: "member", password: "password-1234" });
		const ids = await seedAddressesForUser(member.id, 150);
		const p = memberPrincipal(ids, []);
		const r = await queryThreads(db(), { principal: p, limit: 25 });
		expect(r.rows).toEqual([]);
	});
});

describe("#88 ?q= の語数・文字数の上限", () => {
	it("parseSearchQuery は 11 語で invalid_request を投げる", () => {
		const q = Array.from({ length: 11 }, (_, i) => `word${i}`).join(" ");
		expect(() => parseSearchQuery(q)).toThrowError(ApiError);
	});

	it("parseSearchQuery は 500 文字超で invalid_request を投げる", () => {
		expect(() => parseSearchQuery("あ".repeat(501))).toThrowError(ApiError);
	});

	it("10 語（2 文字語）は通る", () => {
		const q = Array.from({ length: 10 }, () => "ab").join(" ");
		const parsed = parseSearchQuery(q);
		expect(parsed.freeWords.length).toBe(10);
	});

	it("messages?q に 11 語で 400", async () => {
		const d = await createDomain("lim.test");
		const aid = await createAddress(d, "inbox", "lim.test");
		const p = memberPrincipal([aid]);
		const msgApp = mountRouter("/", messagesRoutes, p);
		const q = Array.from({ length: 11 }, (_, i) => `word${i}`).join(" ");
		const res = await callJson(msgApp, `/?q=${encodeURIComponent(q)}`);
		expect(res.status).toBe(400);
	});

	it("messages?q に 500 文字超で 400", async () => {
		const d = await createDomain("lim2.test");
		const aid = await createAddress(d, "inbox", "lim2.test");
		const p = memberPrincipal([aid]);
		const msgApp = mountRouter("/", messagesRoutes, p);
		const res = await callJson(msgApp, `/?q=${encodeURIComponent("あ".repeat(501))}`);
		expect(res.status).toBe(400);
	});

	it("10 語（2 文字語）の relevance 検索は 200（LIKE 経路、バインド上限を超えない）", async () => {
		const d = await createDomain("lim3.test");
		const aid = await createAddress(d, "inbox", "lim3.test");
		await insertMsg({ id: newId("message"), addressId: aid, direction: "inbound", status: "received", subject: "ab ab ab" });
		const p = memberPrincipal([aid]);
		const msgApp = mountRouter("/", messagesRoutes, p);
		const q = Array.from({ length: 10 }, () => "ab").join(" ");
		const res = await callJson(msgApp, `/?q=${encodeURIComponent(q)}&order=relevance`);
		expect(res.status).toBe(200);
	});

	it("grant 付き member でも 10 語の relevance が 200（#57 と合わせて）", async () => {
		const member = await createUser({ role: "member", password: "password-1234" });
		const d = await createDomain("lim4.test");
		const aid = await createAddress(d, "inbox", "lim4.test");
		await grant(member.id, aid, "read");
		await insertMsg({ id: newId("message"), addressId: aid, direction: "inbound", status: "received", subject: "ab ab ab" });
		const p = memberPrincipal([aid]);
		const msgApp = mountRouter("/", messagesRoutes, p);
		const q = Array.from({ length: 10 }, () => "ab").join(" ");
		const res = await callJson(msgApp, `/?q=${encodeURIComponent(q)}&order=relevance`);
		expect(res.status).toBe(200);
	});
});

describe("#68 outbound を trash から received にできない", () => {
	it("outbound を trash へ移し、status=received で戻しても sent のまま", async () => {
		const d = await createDomain("out.test");
		const aid = await createAddress(d, "out", "out.test");
		const id = newId("message");
		await insertMsg({ id, addressId: aid, direction: "outbound", status: "sent" });

		const p: Principal = { ...memberPrincipal([aid], [aid]), scopes: ["read", "send"] };
		const msgApp = mountRouter("/", messagesRoutes, p);

		const toTrash = await callJson(msgApp, `/${id}`, { method: "PATCH", body: JSON.stringify({ status: "trash" }) });
		expect(toTrash.status).toBe(200);
		expect(toTrash.json.status).toBe("trash");

		const restore = await callJson(msgApp, `/${id}`, { method: "PATCH", body: JSON.stringify({ status: "received" }) });
		expect(restore.status).toBe(200);
		expect(restore.json.status).toBe("sent");
	});

	it("送信に失敗した outbound は trash から戻しても failed に戻る（sent にしない）", async () => {
		const d = await createDomain("outfail.test");
		const aid = await createAddress(d, "out", "outfail.test");
		const id = newId("message");
		await insertMsg({ id, addressId: aid, direction: "outbound", status: "failed" });
		await db().insert(schema.outboundJobs).values({ id: newId("job"), messageId: id, status: "failed", attempts: 4 });

		const p: Principal = { ...memberPrincipal([aid], [aid]), scopes: ["read", "send"] };
		const msgApp = mountRouter("/", messagesRoutes, p);

		await callJson(msgApp, `/${id}`, { method: "PATCH", body: JSON.stringify({ status: "trash" }) });
		const restore = await callJson(msgApp, `/${id}`, { method: "PATCH", body: JSON.stringify({ status: "received" }) });
		expect(restore.status).toBe(200);
		expect(restore.json.status).toBe("failed");
	});
});

describe("#113 スレッド一覧の view フィルタ", () => {
	it("inbox / starred / sent / trash がそれぞれ正しいスレッドを返す", async () => {
		const d = await createDomain("view.test");
		const aid = await createAddress(d, "inbox", "view.test");

		const threads = [
			{ id: "thr_inbox", subject: "inbox", at: 1_770_000_000_000 },
			{ id: "thr_star", subject: "star", at: 1_770_000_100_000 },
			{ id: "thr_sent", subject: "sent", at: 1_770_000_200_000 },
			{ id: "thr_trash", subject: "trash", at: 1_770_000_300_000 },
		];
		for (const t of threads) {
			await db().insert(schema.threads).values({
				id: t.id, addressId: aid, subject: t.subject, lastMessageAt: new Date(t.at), messageCount: 1, unreadCount: 0,
			});
		}

		await insertMsg({ id: newId("message"), addressId: aid, direction: "inbound", status: "received", threadId: "thr_inbox" });
		await insertMsg({ id: newId("message"), addressId: aid, direction: "inbound", status: "received", threadId: "thr_star", isStarred: true });
		await insertMsg({ id: newId("message"), addressId: aid, direction: "outbound", status: "sent", threadId: "thr_sent" });
		await insertMsg({ id: newId("message"), addressId: aid, direction: "inbound", status: "trash", threadId: "thr_trash" });

		const r = (view: "inbox" | "starred" | "sent" | "trash") =>
			queryThreads(db(), { principal: ownerPrincipal, limit: 50, view });

		expect((await r("inbox")).rows.map((t) => t.id).sort()).toEqual(["thr_inbox", "thr_sent", "thr_star"]);
		expect((await r("starred")).rows.map((t) => t.id)).toEqual(["thr_star"]);
		expect((await r("sent")).rows.map((t) => t.id)).toEqual(["thr_sent"]);
		expect((await r("trash")).rows.map((t) => t.id)).toEqual(["thr_trash"]);
	});

	it("メッセージ 1 件も無いスレッドは view に関係なく出ない", async () => {
		const d = await createDomain("view2.test");
		const aid = await createAddress(d, "inbox", "view2.test");
		await db().insert(schema.threads).values({
			id: "thr_empty", addressId: aid, subject: "empty", lastMessageAt: new Date(1_770_000_000_000), messageCount: 0, unreadCount: 0,
		});
		const r = await queryThreads(db(), { principal: ownerPrincipal, limit: 50, view: "inbox" });
		expect(r.rows.map((t) => t.id)).not.toContain("thr_empty");
	});
});
