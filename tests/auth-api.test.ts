import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@/db/client";
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
	resetDb,
	sessionCookie,
} from "./auth-helpers";

const app = buildTestApp();

beforeEach(resetDb);

const OWNER = {
	email: "owner@example.test",
	name: "オーナー",
	password: "correct-horse-1234",
	secret: "vitest-fixture-internal-secret-9f8e7d6c",
};

async function bootstrap() {
	const res = await request(app, "/api/v1/auth/bootstrap", json(OWNER));
	expect(res.status).toBe(201);
	return { res, cookie: sessionCookie(res) };
}

describe("POST /v1/auth/bootstrap", () => {
	it("最初の owner を作れる", async () => {
		const { res } = await bootstrap();
		const body = (await res.json()) as { role: string; email: string };
		expect(body.role).toBe("owner");
		expect(body.email).toBe(OWNER.email);
	});

	it("2 回目は 409", async () => {
		await bootstrap();
		const res = await request(
			app,
			"/api/v1/auth/bootstrap",
			json({ ...OWNER, email: "other@example.test" }),
		);
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("conflict");
	});

	it("短すぎるパスワードは 400", async () => {
		const res = await request(app, "/api/v1/auth/bootstrap", json({ ...OWNER, password: "short" }));
		expect(res.status).toBe(400);
	});

	it("INTERNAL_SECRET がテスト・ローカル用の既知の値だと拒否する（#48）", async () => {
		const knownSecrets = ["test-internal-secret-0123456789", "local-dev-internal-secret-0123456789"];
		for (const secret of knownSecrets) {
			const res = await request(app, "/api/v1/auth/bootstrap", {
				...json({ ...OWNER, secret }),
				env: { INTERNAL_SECRET: secret },
			});
			expect(res.status).toBe(403);
		}

		const stateRes = await request(app, "/api/v1/auth/setup-state");
		const state = (await stateRes.json()) as { needsSetup: boolean };
		expect(state.needsSetup).toBe(true);
	});

	it("bootstrap は IP 単位でレート制限される（#52）", async () => {
		let sawRateLimited = false;
		const fixedIp = "203.0.113.1";
		for (let i = 0; i < 25; i++) {
			const res = await request(app, "/api/v1/auth/bootstrap", {
				...json({ ...OWNER, email: `owner-${i}@example.test`, secret: "wrong-secret-value" }),
				headers: { "cf-connecting-ip": fixedIp },
			});
			if (res.status === 429) {
				sawRateLimited = true;
				break;
			}
			expect(res.status).toBe(403);
		}
		expect(sawRateLimited).toBe(true);
	});
});

describe("POST /v1/auth/login", () => {
	it("セッション Cookie は HttpOnly / Secure / SameSite=Lax / Path=/", async () => {
		await bootstrap();
		const res = await request(
			app,
			"/api/v1/auth/login",
			json({ email: OWNER.email, password: OWNER.password }),
		);
		expect(res.status).toBe(200);
		const cookie = res.headers.get("set-cookie") ?? "";
		expect(cookie).toContain("tsb_session=");
		expect(cookie).toMatch(/HttpOnly/i);
		expect(cookie).toMatch(/Secure/i);
		expect(cookie).toMatch(/SameSite=Lax/i);
		expect(cookie).toMatch(/Path=\//i);
	});

	it("平文のトークンは Cookie にしか出ず、レスポンス本文には出ない", async () => {
		await bootstrap();
		const res = await request(
			app,
			"/api/v1/auth/login",
			json({ email: OWNER.email, password: OWNER.password }),
		);
		const text = await res.text();
		expect(text).not.toContain("tsb_session");
		expect(text).not.toContain("token");
	});

	it("パスワードが違えば 401、メールが無い場合と同じ文言", async () => {
		await bootstrap();
		const wrong = await request(
			app,
			"/api/v1/auth/login",
			json({ email: OWNER.email, password: "wrong-password-1234" }),
		);
		const missing = await request(
			app,
			"/api/v1/auth/login",
			json({ email: "nobody@example.test", password: "wrong-password-1234" }),
		);
		expect(wrong.status).toBe(401);
		expect(missing.status).toBe(401);
		const a = (await wrong.json()) as { error: { message: string } };
		const b = (await missing.json()) as { error: { message: string } };
		expect(a.error.message).toBe(b.error.message);
	});

	it("agent（パスワード無し）はログインできない", async () => {
		await bootstrap();
		const agent = await createUser({ role: "agent", email: "agent@example.test" });
		const res = await request(
			app,
			"/api/v1/auth/login",
			json({ email: agent.email, password: "anything-1234" }),
		);
		expect(res.status).toBe(401);
	});

	it("居ないメールでも agent でも、同じダミーハッシュに対して verifyPassword を走らせる（#26）", async () => {
		await bootstrap();
		const agent = await createUser({ role: "agent", email: "agent2@example.test" });
		const password = await import("@/lib/password");
		const spy = vi.spyOn(password, "verifyPassword");

		await request(app, "/api/v1/auth/login", json({ email: "nobody2@example.test", password: "x-0000000000" }));
		await request(app, "/api/v1/auth/login", json({ email: agent.email, password: "x-0000000000" }));

		expect(spy).toHaveBeenCalledTimes(2);
		for (const call of spy.mock.calls) {
			expect(call[1]).toBe(password.DUMMY_PASSWORD_HASH);
		}
		spy.mockRestore();
	});

	it("総当たりはレート制限で 429 になる", async () => {
		await bootstrap();
		const user = await createUser({
			role: "member",
			email: "bruteforce@example.test",
			password: "correct-horse-1234",
		});
		let sawRateLimited = false;
		// wrangler.jsonc の LOGIN_RATE_LIMIT は 60 秒あたり 20 回。
		for (let i = 0; i < 25; i++) {
			const res = await request(
				app,
				"/api/v1/auth/login",
				json({ email: user.email, password: `wrong-${i}-0000` }),
			);
			if (res.status === 429) {
				sawRateLimited = true;
				break;
			}
			expect(res.status).toBe(401);
		}
		expect(sawRateLimited).toBe(true);
	});

	it("無効化されたユーザーはログインできない", async () => {
		await bootstrap();
		const user = await createUser({
			role: "member",
			email: "disabled@example.test",
			password: "correct-horse-1234",
			status: "disabled",
		});
		const res = await request(
			app,
			"/api/v1/auth/login",
			json({ email: user.email, password: "correct-horse-1234" }),
		);
		expect(res.status).toBe(401);
	});
});

describe("POST /v1/auth/logout と GET /v1/auth/session", () => {
	it("ログアウトするとセッションが無効になる", async () => {
		const { cookie } = await bootstrap();
		expect((await request(app, "/api/v1/auth/session", { cookie })).status).toBe(200);

		const out = await request(app, "/api/v1/auth/logout", { method: "POST", cookie });
		expect(out.status).toBe(200);
		expect(out.headers.get("set-cookie") ?? "").toMatch(/tsb_session=;|Max-Age=0/i);

		expect((await request(app, "/api/v1/auth/session", { cookie })).status).toBe(401);
	});

	it("未ログインは 401", async () => {
		expect((await request(app, "/api/v1/auth/session")).status).toBe(401);
	});
});

describe("GET /v1/me", () => {
	it("owner はアドレス無制限として返る", async () => {
		const { cookie } = await bootstrap();
		const domainId = await createDomain();
		await createAddress(domainId, "info");

		const res = await request(app, "/api/v1/me", { cookie });
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			role: string;
			via: string;
			addressIds: string | string[];
			addresses: { address: string; canWrite: boolean }[];
		};
		expect(body.role).toBe("owner");
		expect(body.via).toBe("session");
		expect(body.addressIds).toBe("all");
		expect(body.addresses).toHaveLength(1);
		expect(body.addresses[0]!.canWrite).toBe(true);
	});

	it("member はアドレス文字列つきで自分の守備範囲だけを見る", async () => {
		await bootstrap();
		const domainId = await createDomain();
		const mine = await createAddress(domainId, "mine");
		await createAddress(domainId, "others");

		const user = await createUser({
			role: "member",
			email: "member@example.test",
			password: "correct-horse-1234",
		});
		await grant(user.id, mine, "read");

		const login = await request(
			app,
			"/api/v1/auth/login",
			json({ email: user.email, password: "correct-horse-1234" }),
		);
		const res = await request(app, "/api/v1/me", { cookie: sessionCookie(login) });
		const body = (await res.json()) as {
			addressIds: string[];
			writableAddressIds: string[];
			addresses: { id: string; address: string; canWrite: boolean }[];
		};
		expect(body.addressIds).toEqual([mine]);
		expect(body.writableAddressIds).toEqual([]);
		expect(body.addresses).toHaveLength(1);
		expect(body.addresses[0]!.address).toContain("mine@");
		expect(body.addresses[0]!.canWrite).toBe(false);
	});

	it("API キーの addressIds が owner の権限を狭める", async () => {
		await bootstrap();
		const domainId = await createDomain();
		const a = await createAddress(domainId, "a");
		await createAddress(domainId, "b");

		const owner = await createUser({ role: "owner", email: "o2@example.test" });
		const key = await createApiKeyFor({ userId: owner.id, addressIds: [a], scopes: ["read"] });

		const res = await request(app, "/api/v1/me", { bearer: key.token });
		const body = (await res.json()) as {
			via: string;
			scopes: string[];
			addressIds: string[];
			addresses: { id: string }[];
		};
		expect(body.via).toBe("api_key");
		expect(body.scopes).toEqual(["read"]);
		expect(body.addressIds).toEqual([a]);
		expect(body.addresses.map((x) => x.id)).toEqual([a]);
	});
});

describe("API キーの受け付け", () => {
	it("失効したキーは 401", async () => {
		const owner = await createUser({ role: "owner", email: "o3@example.test" });
		const key = await createApiKeyFor({ userId: owner.id, revokedAt: new Date(Date.now() - 1000) });
		expect((await request(app, "/api/v1/me", { bearer: key.token })).status).toBe(401);
	});

	it("期限切れのキーは 401", async () => {
		const owner = await createUser({ role: "owner", email: "o4@example.test" });
		const key = await createApiKeyFor({ userId: owner.id, expiresAt: new Date(Date.now() - 1000) });
		expect((await request(app, "/api/v1/me", { bearer: key.token })).status).toBe(401);
	});

	it("無効化されたユーザーのキーは 401", async () => {
		const owner = await createUser({ role: "owner", email: "o5@example.test", status: "disabled" });
		const key = await createApiKeyFor({ userId: owner.id });
		expect((await request(app, "/api/v1/me", { bearer: key.token })).status).toBe(401);
	});

	it("でたらめなキーは 401", async () => {
		expect((await request(app, "/api/v1/me", { bearer: "rid_deadbeef_not_a_key" })).status).toBe(401);
	});

	it("使うと last_used_at が入る", async () => {
		const owner = await createUser({ role: "owner", email: "o6@example.test" });
		const key = await createApiKeyFor({ userId: owner.id });
		await request(app, "/api/v1/me", { bearer: key.token });

		const res = await request(app, "/api/v1/me/api-keys", { bearer: key.token });
		const body = (await res.json()) as { data: { id: string; lastUsedAt: number | null }[] };
		expect(body.data[0]!.lastUsedAt).not.toBeNull();
	});
});

describe("/v1/me/api-keys のスコープの門（#25）", () => {
	it("read だけのキーでは新しいキーを作れない", async () => {
		const owner = await createUser({ role: "owner", email: "gate1@example.test" });
		const leaked = await createApiKeyFor({ userId: owner.id, scopes: ["read"] });

		const res = await request(app, "/api/v1/me/api-keys", {
			method: "POST",
			bearer: leaked.token,
			body: JSON.stringify({ name: "子キー", scopes: ["read"] }),
		});
		expect(res.status).toBe(403);
	});

	it("send だけのキーでは他のキーを失効できない", async () => {
		const owner = await createUser({ role: "owner", email: "gate2@example.test" });
		const target = await createApiKeyFor({ userId: owner.id, scopes: ["read"] });
		const attacker = await createApiKeyFor({ userId: owner.id, scopes: ["send"] });

		const res = await request(app, `/api/v1/me/api-keys/${target.id}`, {
			method: "DELETE",
			bearer: attacker.token,
		});
		expect(res.status).toBe(403);

		const still = await request(app, "/api/v1/me/api-keys", { bearer: target.token });
		expect(still.status).toBe(200);
	});

	it("admin スコープのキーからは作成・失効できる", async () => {
		const owner = await createUser({ role: "owner", email: "gate3@example.test" });
		const adminKey = await createApiKeyFor({ userId: owner.id, scopes: ["admin", "read"] });

		const created = await request(app, "/api/v1/me/api-keys", {
			method: "POST",
			bearer: adminKey.token,
			body: JSON.stringify({ name: "admin 発行", scopes: ["read"] }),
		});
		expect(created.status).toBe(201);
		const createdBody = (await created.json()) as { id: string };

		const revoked = await request(app, `/api/v1/me/api-keys/${createdBody.id}`, {
			method: "DELETE",
			bearer: adminKey.token,
		});
		expect(revoked.status).toBe(200);
	});

	it("Cookie セッションからは常に作成・失効できる", async () => {
		const { cookie } = await bootstrap();
		const created = await request(app, "/api/v1/me/api-keys", {
			method: "POST",
			cookie,
			body: JSON.stringify({ name: "セッション発行", scopes: ["read"] }),
		});
		expect(created.status).toBe(201);
	});

	it("期限付きの親キーからは、親の期限を超える子キーを作れない（clamp）", async () => {
		const owner = await createUser({ role: "owner", email: "gate4@example.test" });
		const parentExpiresAt = new Date(Date.now() + 60_000);
		const parent = await createApiKeyFor({
			userId: owner.id,
			scopes: ["admin", "read"],
			expiresAt: parentExpiresAt,
		});

		const farFuture = Math.floor(Date.now() / 1000) + 86_400 * 365;
		const res = await request(app, "/api/v1/me/api-keys", {
			method: "POST",
			bearer: parent.token,
			body: JSON.stringify({ name: "無期限を狙う子キー", scopes: ["read"], expiresAt: farFuture }),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { expiresAt: number | null };
		expect(body.expiresAt).not.toBeNull();
		expect(body.expiresAt!).toBeLessThanOrEqual(Math.floor(parentExpiresAt.getTime() / 1000));
	});

	it("監査ログに apiKeyId が残る", async () => {
		const owner = await createUser({ role: "owner", email: "gate5@example.test" });
		const adminKey = await createApiKeyFor({ userId: owner.id, scopes: ["admin", "read"] });

		const created = await request(app, "/api/v1/me/api-keys", {
			method: "POST",
			bearer: adminKey.token,
			body: JSON.stringify({ name: "監査確認", scopes: ["read"] }),
		});
		expect(created.status).toBe(201);

		const rows = await db()
			.select()
			.from(schema.auditLogs)
			.where(eq(schema.auditLogs.action, "api_key.create"));
		const last = rows[rows.length - 1];
		expect((last?.meta as { apiKeyId?: string } | null)?.apiKeyId).toBe(adminKey.id);
	});
});

describe("PATCH /v1/me", () => {
	it("表示名を変えられる", async () => {
		const { cookie } = await bootstrap();
		const res = await request(app, "/api/v1/me", {
			method: "PATCH",
			cookie,
			body: JSON.stringify({ name: "新しい名前" }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()) as { name: string }).toMatchObject({ name: "新しい名前" });
	});

	it("現在のパスワードが違えばパスワードを変えられない", async () => {
		const { cookie } = await bootstrap();
		const res = await request(app, "/api/v1/me", {
			method: "PATCH",
			cookie,
			body: JSON.stringify({ currentPassword: "wrong-password", newPassword: "new-password-1234" }),
		});
		expect(res.status).toBe(403);
	});

	it("パスワードを変えると既存セッションが切れる", async () => {
		const { cookie } = await bootstrap();
		const res = await request(app, "/api/v1/me", {
			method: "PATCH",
			cookie,
			body: JSON.stringify({
				currentPassword: OWNER.password,
				newPassword: "brand-new-password-1234",
			}),
		});
		expect(res.status).toBe(200);
		expect((await request(app, "/api/v1/me", { cookie })).status).toBe(401);

		const relogin = await request(
			app,
			"/api/v1/auth/login",
			json({ email: OWNER.email, password: "brand-new-password-1234" }),
		);
		expect(relogin.status).toBe(200);
	});
});
