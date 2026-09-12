import { beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import notificationRoutes from "@/api/v1/notifications";
import { getDb, schema } from "@/db/client";
import { newId } from "@/lib/id";
import authRoutes from "@/api/v1/auth";
import meRoutes from "@/api/v1/me";
import messageRoutes from "@/api/v1/messages";
import { requireAuth } from "@/api/middleware/auth";
import type { AppEnv } from "@/api/types";
import { ApiError } from "@/shared/errors";
import {
	createAddress,
	createApiKeyFor,
	createDomain,
	createUser,
	db,
	grant,
	resetDb,
} from "./auth-helpers";

const app = new Hono<AppEnv>();
app.onError((err, c) =>
	err instanceof ApiError
		? c.json(err.toJSON(), err.status as 400)
		: c.json({ error: { code: "internal", message: "内部エラーが発生しました" } }, 500),
);
app.use("*", async (c, next) => {
	c.set("db", getDb(c.env));
	c.set("requestId", "test");
	await next();
});
app.route("/api/v1/auth", authRoutes);
app.route("/api/v1/me", meRoutes);
app.use("/api/v1/messages/*", requireAuth);
app.route("/api/v1/messages", messageRoutes);
app.use("/api/v1/me/notifications/*", requireAuth);
app.route("/api/v1/me/notifications", notificationRoutes);

beforeEach(resetDb);

const OWNER = {
	email: "owner@example.test",
	name: "オーナー",
	password: "correct-horse-1234",
	secret: "vitest-fixture-internal-secret-9f8e7d6c",
};

type Client = ReturnType<typeof makeClient>;

function makeClient() {
	let cookie: string | null = null;
	let bearer: string | null = null;

	async function request(method: string, path: string, body?: unknown) {
		const headers = new Headers();
		if (body !== undefined) headers.set("content-type", "application/json");
		if (cookie) headers.set("cookie", cookie);
		if (bearer) headers.set("authorization", `Bearer ${bearer}`);
		headers.set("cf-connecting-ip", crypto.randomUUID());
		const res = await app.request(
			path,
			{ method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
			env,
		);
		const setCookie = res.headers.get("set-cookie");
		if (setCookie) cookie = setCookie.split(";")[0]!;
		const text = await res.text();
		try {
			return { status: res.status, body: JSON.parse(text) };
		} catch {
			return { status: res.status, body: text };
		}
	}

	return {
		get: (p: string) => request("GET", p),
		post: (p: string, b?: unknown) => request("POST", p, b),
		patch: (p: string, b?: unknown) => request("PATCH", p, b),
		put: (p: string, b?: unknown) => request("PUT", p, b),
		useKey: (t: string) => {
			bearer = t;
		},
	};
}

async function loginOwner(): Promise<{ client: Client; userId: string }> {
	const client = makeClient();
	const res = await client.post("/api/v1/auth/bootstrap", OWNER);
	expect(res.status).toBe(201);
	const me = await client.get("/api/v1/me");
	return { client, userId: me.body.id as string };
}

async function insertMessage(addressId: string, subject = "内密の件") {
	const id = newId("message");
	await db()
		.insert(schema.messages)
		.values({
			id,
			threadId: null,
			addressId,
			direction: "inbound",
			status: "received",
			fromAddr: "from@example.net",
			toAddr: "x@example.net",
			subject,
			textBody: "本文です。",
			hasAttachments: false,
			isRead: false,
			receivedAt: new Date(),
		});
	return id;
}

describe("POST /api/v1/me/admin-mode", () => {
	it("owner は管理者モードで他人のアドレスのメッセージを読め、出ると戻る", async () => {
		const { client } = await loginOwner();
		const domainId = await createDomain();
		const otherId = await createAddress(domainId, "other");
		// owner には割り当てない。他人のアドレスのメールにする。
		const msgId = await insertMessage(otherId);

		expect((await client.get(`/api/v1/messages/${msgId}`)).status).toBe(404);

		const enter = await client.post("/api/v1/me/admin-mode", { enabled: true });
		expect(enter.status).toBe(200);
		expect((await client.get("/api/v1/me")).body.adminMode).toBe(true);
		expect((await client.get(`/api/v1/messages/${msgId}`)).status).toBe(200);

		const exit = await client.post("/api/v1/me/admin-mode", { enabled: false });
		expect(exit.status).toBe(200);
		expect((await client.get("/api/v1/me")).body.adminMode).toBe(false);
		expect((await client.get(`/api/v1/messages/${msgId}`)).status).toBe(404);
	});

	it("管理者モードは期限が過ぎると自動で切れる", async () => {
		const { client, userId } = await loginOwner();
		const domainId = await createDomain();
		const otherId = await createAddress(domainId, "other");
		const msgId = await insertMessage(otherId);

		await client.post("/api/v1/me/admin-mode", { enabled: true });
		expect((await client.get(`/api/v1/messages/${msgId}`)).status).toBe(200);

		// 1 時間の期限を過去に倒して、期限切れの挙動を確かめる。
		await db()
			.update(schema.sessions)
			.set({ adminModeUntil: new Date(Date.now() - 60_000) })
			.where(eq(schema.sessions.userId, userId));
		expect((await client.get(`/api/v1/messages/${msgId}`)).status).toBe(404);
	});

	it("member は管理者モードに入れない", async () => {
		await loginOwner();
		const member = await createUser({
			role: "member",
			email: "m@example.test",
			password: "correct-horse-1234",
		});
		const c = makeClient();
		expect(
			(
				await c.post("/api/v1/auth/login", {
					email: member.email,
					password: "correct-horse-1234",
				})
			).status,
		).toBe(200);
		expect((await c.post("/api/v1/me/admin-mode", { enabled: true })).status).toBe(403);
	});

	it("API キー（owner の admin キーでも）では管理者モードに入れない", async () => {
		await loginOwner();
		const owner = await createUser({ role: "owner", email: "o@example.test" });
		const key = await createApiKeyFor({
			userId: owner.id,
			scopes: ["read", "send", "admin"],
			addressIds: null,
		});
		const c = makeClient();
		c.useKey(key.token);
		expect((await c.post("/api/v1/me/admin-mode", { enabled: true })).status).toBe(403);
	});

	it("入った・出たは監査ログに残る", async () => {
		const { client } = await loginOwner();
		await client.post("/api/v1/me/admin-mode", { enabled: true });
		await client.post("/api/v1/me/admin-mode", { enabled: false });
		const rows = await db()
			.select({ action: schema.auditLogs.action })
			.from(schema.auditLogs)
			.where(
				inArray(schema.auditLogs.action, ["admin_mode.enter", "admin_mode.exit"]),
			);
		expect(rows.map((r) => r.action).sort()).toEqual(["admin_mode.enter", "admin_mode.exit"]);
	});

	it("管理者モードでも他人のメールは変更できず、自分の割り当ては変えられる", async () => {
		const { client, userId } = await loginOwner();
		const domainId = await createDomain();
		const ownId = await createAddress(domainId, "own");
		const otherId = await createAddress(domainId, "other");
		await grant(userId, ownId, "write");

		const ownMsg = await insertMessage(ownId, "自分のメール");
		const otherMsg = await insertMessage(otherId, "他人のメール");

		await client.post("/api/v1/me/admin-mode", { enabled: true });

		expect((await client.patch(`/api/v1/messages/${otherMsg}`, { isRead: true })).status).toBe(
			403,
		);
		const otherAfter = await client.get(`/api/v1/messages/${otherMsg}`);
		expect(otherAfter.body.isRead).toBe(false);

		expect((await client.patch(`/api/v1/messages/${ownMsg}`, { isRead: true })).status).toBe(200);
		const ownAfter = await client.get(`/api/v1/messages/${ownMsg}`);
		expect(ownAfter.body.isRead).toBe(true);
	});
});

describe("管理者モードでも自分の設定は自分の割り当ての範囲だけ", () => {
	it("割り当ての無いメールボックスの通知レベルは、管理者モード中でも 403", async () => {
		const { client } = await loginOwner();
		const domainId = await createDomain();
		const otherId = await createAddress(domainId, "other");
		await client.post("/api/v1/me/admin-mode", { enabled: true });
		const res = await client.put(`/api/v1/me/notifications/mailboxes/${otherId}`, { level: "all" });
		expect(res.status).toBe(403);
	});
});
