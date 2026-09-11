import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import devicesRoutes from "@/api/v1/devices";
import pushRoutes from "@/api/v1/push";
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
	app.route("/api/v1/push", pushRoutes);
	return app;
}

const devicePayload = {
	endpoint: "https://fcm.googleapis.com/fcm/send/endpoint-1",
	keys: { p256dh: "abc", auth: "def" },
	name: "iPhone",
	platform: "ios",
};

async function createSession(userId: string, id: string) {
	await db().insert(schema.sessions).values({
		id,
		userId,
		tokenHash: `h_${id}`,
		expiresAt: new Date(Date.now() + 3_600_000),
	});
}

beforeEach(async () => {
	await applyMigrations();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("端末 API の認可", () => {
	it("API キーは 403", async () => {
		const app = buildApp({
			userId: "usr_k",
			role: "owner",
			via: "api_key",
			scopes: ["read"],
			addressIds: "all",
			writableAddressIds: "all",
		});
		expect((await app.request("/api/v1/me/devices")).status).toBe(403);
		expect((await app.request("/api/v1/push/key")).status).toBe(403);
	});

	it("agent は 403", async () => {
		const app = buildApp(sessionPrincipal("usr_a", "agent"));
		expect((await app.request("/api/v1/me/devices")).status).toBe(403);
		expect((await app.request("/api/v1/push/key")).status).toBe(403);
	});
});

describe("端末の登録・更新・削除", () => {
	it("ブラウザのプッシュサービス以外の endpoint は受け付けない", async () => {
		const member = await createUser({ role: "member" });
		await createSession(member.id, "ses_1");
		const app = buildApp(sessionPrincipal(member.id, "member", "ses_1"));
		for (const endpoint of [
			"https://169.254.169.254/latest",
			"http://fcm.googleapis.com/fcm/send/x",
			"https://fcm.googleapis.com.evil.example/x",
			"https://fcm.googleapis.com:8443/x",
		]) {
			const res = await app.request("/api/v1/me/devices", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ ...devicePayload, endpoint }),
			});
			expect(res.status, endpoint).toBe(400);
		}
	});

	it("POST で登録し、同じ endpoint は上書きする（session_id に current を入れる）", async () => {
		const member = await createUser({ role: "member" });
		await createSession(member.id, "ses_1");
		await createSession(member.id, "ses_2");
		const app = buildApp(sessionPrincipal(member.id, "member", "ses_1"));

		const created = (await (
			await app.request("/api/v1/me/devices", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(devicePayload),
			})
		).json()) as { id: string; name: string; platform: string; sessionId?: never };
		expect(created.id).toMatch(/^dev_/);

		const row = await db()
			.select()
			.from(schema.pushDevices)
			.where(eq(schema.pushDevices.id, created.id))
			.get();
		expect(row!.sessionId).toBe("ses_1");

		// 違うセッションから同じ endpoint で登録すると上書きされ、session_id が変わる
		const app2 = buildApp(sessionPrincipal(member.id, "member", "ses_2"));
		const overwritten = (await (
			await app2.request("/api/v1/me/devices", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ ...devicePayload, name: "iPad" }),
			})
		).json()) as { id: string; name: string };
		expect(overwritten.id).toBe(created.id);
		expect(overwritten.name).toBe("iPad");
		const after = await db()
			.select()
			.from(schema.pushDevices)
			.where(eq(schema.pushDevices.id, created.id))
			.get();
		expect(after!.sessionId).toBe("ses_2");
	});

	it("PATCH / DELETE で自分の端末を変更・削除でき、他人の端末は 404", async () => {
		const member = await createUser({ role: "member" });
		const other = await createUser({ role: "member" });
		await createSession(member.id, "ses_dev");
		const app = buildApp(sessionPrincipal(member.id, "member", "ses_dev"));
		const created = (await (
			await app.request("/api/v1/me/devices", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(devicePayload),
			})
		).json()) as { id: string };

		const patched = (await (
			await app.request(`/api/v1/me/devices/${created.id}`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: "Mac", enabled: false }),
			})
		).json()) as { name: string; enabled: boolean };
		expect(patched.name).toBe("Mac");
		expect(patched.enabled).toBe(false);

		const otherApp = buildApp(sessionPrincipal(other.id, "member"));
		expect((await otherApp.request(`/api/v1/me/devices/${created.id}`, { method: "DELETE" })).status).toBe(404);

		expect((await app.request(`/api/v1/me/devices/${created.id}`, { method: "DELETE" })).status).toBe(204);
	});

	it("POST /test は OUTBOUND_QUEUE に test を積む", async () => {
		const member = await createUser({ role: "member" });
		await createSession(member.id, "ses_test");
		const app = buildApp(sessionPrincipal(member.id, "member"));
		const created = (await (
			await app.request("/api/v1/me/devices", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(devicePayload),
			})
		).json()) as { id: string };

		const send = vi
			.spyOn(env.OUTBOUND_QUEUE, "send")
			.mockImplementation(() => Promise.resolve() as Promise<never>);
		const res = await app.request(`/api/v1/me/devices/${created.id}/test`, { method: "POST" }, env);
		expect(res.status).toBe(202);
		expect(send).toHaveBeenCalledWith({
			kind: "notify",
			event: "test",
			deviceId: created.id,
			userId: member.id,
		});
	});

	it("POST /seen は last_seen_at を更新する", async () => {
		const member = await createUser({ role: "member" });
		await createSession(member.id, "ses_test");
		const app = buildApp(sessionPrincipal(member.id, "member"));
		const created = (await (
			await app.request("/api/v1/me/devices", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(devicePayload),
			})
		).json()) as { id: string };

		expect((await app.request(`/api/v1/me/devices/${created.id}/seen`, { method: "POST" })).status).toBe(204);
		const row = await db()
			.select()
			.from(schema.pushDevices)
			.where(eq(schema.pushDevices.id, created.id))
			.get();
		expect(row!.lastSeenAt).toBeTruthy();
	});
});

describe("push /key", () => {
	it("VAPID_PRIVATE_KEY 未設定なら { key: null }", async () => {
		const app = buildApp(sessionPrincipal("usr_p", "owner"));
		const res = await app.request("/api/v1/push/key", {}, env);
		const body = (await res.json()) as { key: string | null };
		expect(body.key).toBeNull();
	});

	it("JWK の x,y から非圧縮点 0x04||x||y の base64url を返す", async () => {
		const jwk = JSON.stringify({
			kty: "EC",
			crv: "P-256",
			// 全ゼロでなく実用値。64 バイトの非圧縮点を検証する。
			x: "MKBCTNIcKUSDii11ySs3526iDZ8AiTo7Tu6KPAqv7D4",
			y: "4Etl6SRW2YiLUrN5vfvVHuhp7x8PxltmWWlbbM4IFyM",
			d: "d",
		});
		// env を差し替えて key を渡す
		const customEnv = { ...env, VAPID_PRIVATE_KEY: jwk } as unknown as CloudflareEnv;
		const app = buildApp(sessionPrincipal("usr_p", "owner"));
		const res = await app.request("/api/v1/push/key", {}, customEnv);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { key: string };
		// 復号して先頭が 0x04、長さ 65 バイトか確認
		const b64 = body.key.replace(/-/g, "+").replace(/_/g, "/");
		const bin = atob(b64 + "===".slice(0, (4 - (b64.length % 4)) % 4));
		const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
		expect(bytes.length).toBe(65);
		expect(bytes[0]).toBe(0x04);
	});
});
