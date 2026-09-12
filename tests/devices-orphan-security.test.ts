import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import devicesRoutes from "@/api/v1/devices";
import { requireAuth } from "@/api/middleware/auth";
import { loadDevices } from "@/services/notify/load";
import { hashToken } from "@/lib/tokens";
import { newId } from "@/lib/id";
import { ApiError } from "@/shared/errors";
import type { AppEnv } from "@/api/types";
import type { Principal } from "@/shared/contracts/common";
import { applyMigrations } from "./helpers/migrate";
import { createUser, db } from "./auth-helpers";

function sessionPrincipal(userId: string, role: Principal["role"], sessionId = "ses_test"): Principal {
	return {
		userId,
		role,
		via: "session",
		scopes: ["read", "send", "admin"],
		addressIds: "all",
		writableAddressIds: "all",
		sessionId,
	};
}

function buildApp(principal: Principal) {
	const app = new Hono<AppEnv>();
	app.onError((err, c) =>
		err instanceof ApiError ? c.json(err.toJSON(), err.status as 400) : c.text("boom", 500),
	);
	app.use("*", async (c, next) => {
		c.set("db", getDb(env as unknown as CloudflareEnv));
		c.set("principal", principal);
		c.set("requestId", "test");
		await next();
	});
	app.route("/api/v1/me/devices", devicesRoutes);
	return app;
}

function devicePayload(endpoint: string) {
	return {
		endpoint,
		keys: { p256dh: "abc", auth: "def" },
		name: "iPhone",
		platform: "ios",
	};
}

async function createSession(userId: string, id: string, expiresAt = new Date(Date.now() + 3_600_000)) {
	await db().insert(schema.sessions).values({
		id,
		userId,
		tokenHash: `h_${id}`,
		expiresAt,
	});
}

async function insertDevice(userId: string, opts: { id?: string; sessionId?: string | null; endpoint: string }) {
	await db().insert(schema.pushDevices).values({
		id: opts.id ?? newId("device"),
		userId,
		sessionId: opts.sessionId ?? null,
		endpoint: opts.endpoint,
		p256dh: "abc",
		auth: "def",
		name: "テスト",
		platform: "ios",
		enabled: true,
		lastSeenAt: new Date(),
	});
	return (await db().select().from(schema.pushDevices).where(eq(schema.pushDevices.endpoint, opts.endpoint)).get())!;
}

beforeEach(async () => {
	await applyMigrations();
	await db().delete(schema.pushDevices);
});

function fcmEndpoint(n: unknown) {
	return `https://fcm.googleapis.com/fcm/send/ep-${n}`;
}

describe("#130 共有ブラウザで次の利用者が同じ endpoint を購読する", () => {
	it("他人の端末行を 500 にせず引き継ぎ、通知が前の利用者に届かない", async () => {
		const prev = await createUser({ role: "member" });
		const nextUser = await createUser({ role: "member" });
		await createSession(prev.id, "ses_prev");
		await createSession(nextUser.id, "ses_next");

		const prevApp = buildApp(sessionPrincipal(prev.id, "member", "ses_prev"));
		const e = fcmEndpoint("shared");
		const created = (await (
			await prevApp.request("/api/v1/me/devices", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(devicePayload(e)),
			})
		).json()) as { id: string };
		const ownedById = async (id: string) =>
			(await db().select().from(schema.pushDevices).where(eq(schema.pushDevices.id, id)).get())!;

		expect((await ownedById(created.id)).userId).toBe(prev.id);
		await db()
			.update(schema.pushDevices)
			.set({ addressIds: ["adr_prev_only"], failureCount: 2 })
			.where(eq(schema.pushDevices.id, created.id));

		// 前の利用者のセッションが切れた後、同じ端末（同じ endpoint）を次の利用者が購読する
		const nextApp = buildApp(sessionPrincipal(nextUser.id, "member", "ses_next"));
		const res = await nextApp.request("/api/v1/me/devices", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(devicePayload(e)),
		});
		expect(res.status).toBe(200);

		const row = await ownedById(created.id);
		expect(row.userId).toBe(nextUser.id);
		expect(row.sessionId).toBe("ses_next");
		// 前の利用者の絞り込みと失敗回数を持ち越さない（#139）。
		expect(row.addressIds).toBeNull();
		expect(row.failureCount).toBe(0);

		// 端末行は次の利用者のものに変わっているので、prev の一覧に並ばない
		const prevList = (await (await prevApp.request("/api/v1/me/devices")).json()) as { data: { id: string }[] };
		expect(prevList.data.some((d) => d.id === created.id)).toBe(false);
	});
});

describe("#130 期限切れ・無いセッションを持つ端末", () => {
	it("loadDevices は送らない端末を消す", async () => {
		const member = await createUser({ role: "member" });
		await createSession(member.id, "ses_live", new Date(Date.now() + 3_600_000));
		await createSession(member.id, "ses_dead", new Date(Date.now() - 3_600_000));

		const ok = await insertDevice(member.id, { sessionId: "ses_live", endpoint: fcmEndpoint("live") });
		const dead = await insertDevice(member.id, { sessionId: "ses_dead", endpoint: fcmEndpoint("dead") });
		const orphan = await insertDevice(member.id, { sessionId: null, endpoint: fcmEndpoint("orphan") });

		const loaded = await loadDevices(db(), member.id);
		const ids = loaded.map((d) => d.id);
		expect(ids).toContain(ok.id);
		expect(ids).not.toContain(dead.id);
		expect(ids).not.toContain(orphan.id);

		const count = await db()
			.select({ n: sqlCount() })
			.from(schema.pushDevices)
			.where(eq(schema.pushDevices.userId, member.id))
			.get();
		expect(Number(count!.n)).toBe(1);
	});
});

describe("#130 セッションの期限切れ掃除", () => {
	it("期限切れセッションを消すとき、紐づく端末も一緒に消す", async () => {
		const member = await createUser({ role: "member" });
		const token = "expired-token";
		await db().insert(schema.sessions).values({
			id: "ses_exp",
			userId: member.id,
			tokenHash: await hashToken(token),
			expiresAt: new Date(Date.now() - 3_600_000),
		});
		const dev = await insertDevice(member.id, { sessionId: "ses_exp", endpoint: fcmEndpoint("exp") });

		const app = new Hono<AppEnv>();
		app.onError((err, c) =>
			err instanceof ApiError ? c.json(err.toJSON(), err.status as 400) : c.text("boom", 500),
		);
		app.use("*", async (c, next) => {
			c.set("db", getDb(env as unknown as CloudflareEnv));
			c.set("requestId", "test");
			await next();
		});
		app.get("/protected", requireAuth, (c) => c.text("ok"));

		const res = await app.request("/protected", {
			headers: { cookie: `__Host-tsb_session=${token}`, "cf-connecting-ip": "1.2.3.4" },
		}, env);
		expect(res.status).toBe(401);

		expect(await db().select().from(schema.sessions).where(eq(schema.sessions.id, "ses_exp")).get()).toBeUndefined();
		expect(await db().select().from(schema.pushDevices).where(eq(schema.pushDevices.id, dev.id)).get()).toBeUndefined();
	});
});

describe("#133 端末数の上限", () => {
	it("10 台を超えて新規登録すると 400。既存の上書きは通る", async () => {
		const member = await createUser({ role: "member" });
		await createSession(member.id, "ses_limit");
		const app = buildApp(sessionPrincipal(member.id, "member", "ses_limit"));

		for (let i = 0; i < 10; i++) {
			const res = await app.request("/api/v1/me/devices", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(devicePayload(fcmEndpoint(i))),
			});
			expect(res.status).toBe(201);
		}

		// 上限に達しても、同じ endpoint の再登録（キー再生成）は上書きで通る
		const res = await app.request("/api/v1/me/devices", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(devicePayload(fcmEndpoint(0))),
		});
		expect(res.status).toBe(200);

		const over = await app.request("/api/v1/me/devices", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(devicePayload(fcmEndpoint("eleventh"))),
		});
		expect(over.status).toBe(400);
	});
});

function sqlCount() {
	return sql`count(*)`;
}
