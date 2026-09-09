import { beforeEach, describe, expect, it } from "vitest";
import {
	buildTestApp,
	createAddress,
	createApiKeyFor,
	createDomain,
	createUser,
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
	secret: "test-internal-secret-0123456789",
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
