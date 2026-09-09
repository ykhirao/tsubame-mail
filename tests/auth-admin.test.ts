import { beforeEach, describe, expect, it } from "vitest";
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

const PASSWORD = "correct-horse-1234";

async function ownerCookie(email = "owner@example.test") {
	const res = await request(
		app,
		"/api/v1/auth/bootstrap",
		json({
			email,
			name: "オーナー",
			password: PASSWORD,
			secret: "test-internal-secret-0123456789",
		}),
	);
	expect(res.status).toBe(201);
	return sessionCookie(res);
}

async function loginCookie(email: string) {
	const res = await request(app, "/api/v1/auth/login", json({ email, password: PASSWORD }));
	expect(res.status).toBe(200);
	return sessionCookie(res);
}

describe("/v1/admin は owner 専用", () => {
	it("member は 403", async () => {
		await ownerCookie();
		const user = await createUser({ role: "member", email: "m@example.test", password: PASSWORD });
		const cookie = await loginCookie(user.email);
		expect((await request(app, "/api/v1/admin/users", { cookie })).status).toBe(403);
	});

	it("未認証は 401", async () => {
		expect((await request(app, "/api/v1/admin/users")).status).toBe(401);
	});

	it("owner のキーでも admin スコープが無ければ 403", async () => {
		const owner = await createUser({ role: "owner", email: "o@example.test", password: PASSWORD });
		const noAdmin = await createApiKeyFor({ userId: owner.id, scopes: ["read", "send"] });
		const withAdmin = await createApiKeyFor({ userId: owner.id, scopes: ["admin"] });

		expect((await request(app, "/api/v1/admin/users", { bearer: noAdmin.token })).status).toBe(403);
		expect((await request(app, "/api/v1/admin/users", { bearer: withAdmin.token })).status).toBe(200);
	});
});

describe("POST /v1/admin/users", () => {
	it("member はパスワード省略で仮パスワードが発行され、agent はパスワード無しで作れる", async () => {
		const cookie = await ownerCookie();

		const noPassword = await request(
			app,
			"/api/v1/admin/users",
			{ ...json({ email: "x@example.test", name: "X", role: "member" }), cookie },
		);
		expect(noPassword.status).toBe(201);
		const created = (await noPassword.json()) as {
			temporaryPassword: string | null;
			mustChangePassword?: boolean;
		};
		expect(created.temporaryPassword).toMatch(/^[A-Za-z2-9]{20}$/);

		const agent = await request(app, "/api/v1/admin/users", {
			...json({ email: "ai@example.test", name: "AI", role: "agent" }),
			cookie,
		});
		expect(agent.status).toBe(201);
		const agentBody = (await agent.json()) as { hasPassword: boolean; temporaryPassword: null };
		expect(agentBody).toMatchObject({ hasPassword: false, temporaryPassword: null });
	});

	it("メールアドレスの重複は 409", async () => {
		const cookie = await ownerCookie();
		const body = { email: "dup@example.test", name: "D", role: "member", password: PASSWORD };
		expect((await request(app, "/api/v1/admin/users", { ...json(body), cookie })).status).toBe(201);
		expect((await request(app, "/api/v1/admin/users", { ...json(body), cookie })).status).toBe(409);
	});

	it("監査ログが残る", async () => {
		const cookie = await ownerCookie();
		await request(app, "/api/v1/admin/users", {
			...json({ email: "audit@example.test", name: "A", role: "agent" }),
			cookie,
		});
		const logs = await db()
			.select()
			.from(schema.auditLogs)
			.where(eq(schema.auditLogs.action, "user.create"));
		expect(logs).toHaveLength(1);
	});
});

describe("最後の owner は消せない", () => {
	it("削除は 409", async () => {
		const cookie = await ownerCookie();
		const [owner] = await db()
			.select()
			.from(schema.users)
			.where(eq(schema.users.role, "owner"))
			.limit(1);
		const res = await request(app, `/api/v1/admin/users/${owner!.id}`, {
			method: "DELETE",
			cookie,
		});
		expect(res.status).toBe(409);
	});

	it("降格も無効化も 409", async () => {
		const cookie = await ownerCookie();
		const [owner] = await db()
			.select()
			.from(schema.users)
			.where(eq(schema.users.role, "owner"))
			.limit(1);

		const demote = await request(app, `/api/v1/admin/users/${owner!.id}`, {
			method: "PATCH",
			cookie,
			body: JSON.stringify({ role: "member" }),
		});
		expect(demote.status).toBe(409);

		const disable = await request(app, `/api/v1/admin/users/${owner!.id}`, {
			method: "PATCH",
			cookie,
			body: JSON.stringify({ status: "disabled" }),
		});
		expect(disable.status).toBe(409);
	});

	it("owner が 2 人いれば片方は消せる", async () => {
		const cookie = await ownerCookie();
		const second = await request(app, "/api/v1/admin/users", {
			...json({ email: "o2@example.test", name: "O2", role: "owner", password: PASSWORD }),
			cookie,
		});
		const created = (await second.json()) as { id: string };
		const res = await request(app, `/api/v1/admin/users/${created.id}`, {
			method: "DELETE",
			cookie,
		});
		expect(res.status).toBe(200);
	});
});

describe("PUT /v1/admin/users/:id/grants", () => {
	it("総入れ替えになる", async () => {
		const cookie = await ownerCookie();
		const domainId = await createDomain();
		const a = await createAddress(domainId, "a");
		const b = await createAddress(domainId, "b");
		const user = await createUser({ role: "agent", email: "g@example.test" });

		const first = await request(app, `/api/v1/admin/users/${user.id}/grants`, {
			method: "PUT",
			cookie,
			body: JSON.stringify([
				{ addressId: a, level: "read" },
				{ addressId: b, level: "write" },
			]),
		});
		expect(first.status).toBe(200);
		expect(((await first.json()) as { grants: unknown[] }).grants).toHaveLength(2);

		const second = await request(app, `/api/v1/admin/users/${user.id}/grants`, {
			method: "PUT",
			cookie,
			body: JSON.stringify([{ addressId: b, level: "read" }]),
		});
		const body = (await second.json()) as { grants: { addressId: string; level: string }[] };
		expect(body.grants).toEqual([{ addressId: b, level: "read", address: expect.any(String) }]);
	});

	it("空配列で全部剥がせる", async () => {
		const cookie = await ownerCookie();
		const domainId = await createDomain();
		const a = await createAddress(domainId, "a");
		const user = await createUser({ role: "agent", email: "g2@example.test" });
		await grant(user.id, a, "write");

		const res = await request(app, `/api/v1/admin/users/${user.id}/grants`, {
			method: "PUT",
			cookie,
			body: JSON.stringify([]),
		});
		expect(((await res.json()) as { grants: unknown[] }).grants).toEqual([]);
	});

	it("存在しないアドレスは 400", async () => {
		const cookie = await ownerCookie();
		const user = await createUser({ role: "agent", email: "g3@example.test" });
		const res = await request(app, `/api/v1/admin/users/${user.id}/grants`, {
			method: "PUT",
			cookie,
			body: JSON.stringify([{ addressId: "adr_nope", level: "read" }]),
		});
		expect(res.status).toBe(400);
	});
});

describe("POST /v1/admin/api-keys", () => {
	it("AI 用の手順（agent + grant 1 件 + キーの addressIds）で 1 アドレスに閉じ込められる", async () => {
		const cookie = await ownerCookie();
		const domainId = await createDomain();
		const mine = await createAddress(domainId, "ai");
		const other = await createAddress(domainId, "human");

		const created = await request(app, "/api/v1/admin/users", {
			...json({ email: "bot@example.test", name: "ボット", role: "agent" }),
			cookie,
		});
		const agent = (await created.json()) as { id: string };

		await request(app, `/api/v1/admin/users/${agent.id}/grants`, {
			method: "PUT",
			cookie,
			body: JSON.stringify([{ addressId: mine, level: "write" }]),
		});

		const keyRes = await request(app, "/api/v1/admin/api-keys", {
			...json({
				userId: agent.id,
				name: "ボット本番",
				scopes: ["read", "send"],
				addressIds: [mine],
			}),
			cookie,
		});
		expect(keyRes.status).toBe(201);
		const key = (await keyRes.json()) as { token: string; prefix: string };
		expect(key.token.startsWith("tsb_")).toBe(true);
		expect(key.prefix).toBe(key.token.slice(0, 12));

		const me = await request(app, "/api/v1/me", { bearer: key.token });
		const body = (await me.json()) as { addressIds: string[]; writableAddressIds: string[] };
		expect(body.addressIds).toEqual([mine]);
		expect(body.writableAddressIds).toEqual([mine]);
		expect(body.addressIds).not.toContain(other);
	});

	it("ユーザーが権限を持たないアドレスをキーに入れようとしたら 400", async () => {
		const cookie = await ownerCookie();
		const domainId = await createDomain();
		const addr = await createAddress(domainId, "nope");
		const agent = await createUser({ role: "agent", email: "bot2@example.test" });

		const res = await request(app, "/api/v1/admin/api-keys", {
			...json({ userId: agent.id, name: "k", scopes: ["read"], addressIds: [addr] }),
			cookie,
		});
		expect(res.status).toBe(400);
	});

	it("一覧にトークンは出ない（発行時の 1 回だけ）", async () => {
		const cookie = await ownerCookie();
		const agent = await createUser({ role: "agent", email: "bot3@example.test" });
		const keyRes = await request(app, "/api/v1/admin/api-keys", {
			...json({ userId: agent.id, name: "k", scopes: ["read"] }),
			cookie,
		});
		const key = (await keyRes.json()) as { token: string };

		const list = await request(app, "/api/v1/admin/api-keys", { cookie });
		const text = await list.text();
		expect(text).not.toContain(key.token);
	});

	it("失効させると使えなくなる", async () => {
		const cookie = await ownerCookie();
		const agent = await createUser({ role: "agent", email: "bot4@example.test" });
		const keyRes = await request(app, "/api/v1/admin/api-keys", {
			...json({ userId: agent.id, name: "k", scopes: ["read"] }),
			cookie,
		});
		const key = (await keyRes.json()) as { id: string; token: string };
		expect((await request(app, "/api/v1/me", { bearer: key.token })).status).toBe(200);

		const revoked = await request(app, `/api/v1/admin/api-keys/${key.id}`, {
			method: "DELETE",
			cookie,
		});
		expect(revoked.status).toBe(200);
		expect((await request(app, "/api/v1/me", { bearer: key.token })).status).toBe(401);
	});
});

describe("/v1/me/api-keys は自分のキーだけ", () => {
	it("他人のキーは削除できない（404）", async () => {
		await ownerCookie();
		const a = await createUser({ role: "member", email: "a@example.test", password: PASSWORD });
		const b = await createUser({ role: "member", email: "b@example.test", password: PASSWORD });
		const bKey = await createApiKeyFor({ userId: b.id });

		const cookie = await loginCookie(a.email);
		const res = await request(app, `/api/v1/me/api-keys/${bKey.id}`, { method: "DELETE", cookie });
		expect(res.status).toBe(404);

		expect((await request(app, "/api/v1/me", { bearer: bKey.token })).status).toBe(200);
	});

	it("一覧に他人のキーは出ない", async () => {
		await ownerCookie();
		const a = await createUser({ role: "member", email: "a2@example.test", password: PASSWORD });
		const b = await createUser({ role: "member", email: "b2@example.test", password: PASSWORD });
		await createApiKeyFor({ userId: b.id });
		await createApiKeyFor({ userId: a.id });

		const cookie = await loginCookie(a.email);
		const res = await request(app, "/api/v1/me/api-keys", { cookie });
		const body = (await res.json()) as { data: { userId: string }[] };
		expect(body.data).toHaveLength(1);
		expect(body.data[0]!.userId).toBe(a.id);
	});

	it("持っていない権限のキーは作れない（スコープもアドレスも広げられない）", async () => {
		await ownerCookie();
		const domainId = await createDomain();
		const mine = await createAddress(domainId, "mine");
		const other = await createAddress(domainId, "other");
		const user = await createUser({ role: "member", email: "c@example.test", password: PASSWORD });
		await grant(user.id, mine, "read");

		const cookie = await loginCookie(user.email);

		const overAddress = await request(app, "/api/v1/me/api-keys", {
			...json({ name: "k", scopes: ["read"], addressIds: [other] }),
			cookie,
		});
		expect(overAddress.status).toBe(403);

		const ok = await request(app, "/api/v1/me/api-keys", {
			...json({ name: "k", scopes: ["read"], addressIds: [mine] }),
			cookie,
		});
		expect(ok.status).toBe(201);
	});

	it("絞られたキーから、より広いキーは作れない", async () => {
		await ownerCookie();
		const domainId = await createDomain();
		const a = await createAddress(domainId, "a");
		const b = await createAddress(domainId, "b");
		const user = await createUser({ role: "member", email: "d@example.test", password: PASSWORD });
		await grant(user.id, a, "write");
		await grant(user.id, b, "write");

		// a だけに絞られたキー。ここから b を含むキーを作れてはいけない。
		const narrow = await createApiKeyFor({ userId: user.id, addressIds: [a], scopes: ["read"] });

		const widerAddress = await request(app, "/api/v1/me/api-keys", {
			...json({ name: "k", scopes: ["read"], addressIds: [b] }),
			bearer: narrow.token,
		});
		expect(widerAddress.status).toBe(403);

		const widerScope = await request(app, "/api/v1/me/api-keys", {
			...json({ name: "k", scopes: ["read", "send"] }),
			bearer: narrow.token,
		});
		expect(widerScope.status).toBe(403);

		const same = await request(app, "/api/v1/me/api-keys", {
			...json({ name: "k", scopes: ["read"] }),
			bearer: narrow.token,
		});
		expect(same.status).toBe(201);
		expect((await same.json()) as { addressIds: string[] }).toMatchObject({ addressIds: [a] });
	});
});
