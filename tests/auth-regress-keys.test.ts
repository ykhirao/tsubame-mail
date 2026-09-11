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

async function ownerCookie() {
	const res = await request(app, "/api/v1/auth/bootstrap", json(OWNER));
	expect(res.status).toBe(201);
	return sessionCookie(res);
}

describe("#83 expiresAt のオーバーフローでは無期限キーができない", () => {
	it("me の POST で Date の上限を超える expiresAt は 400", async () => {
		const cookie = await ownerCookie();
		const res = await request(app, "/api/v1/me/api-keys", {
			method: "POST",
			cookie,
			body: JSON.stringify({ name: "k", scopes: ["read"], expiresAt: 8_640_000_000_001 }),
		});
		expect(res.status).toBe(400);
	});

	it("短命の親キーでも、オーバーフロー値で無期限の子キーは作れない（clamp を回避できない）", async () => {
		const owner = await createUser({ role: "owner", email: "o@example.test" });
		const parent = await createApiKeyFor({
			userId: owner.id,
			scopes: ["admin", "read"],
			expiresAt: new Date(Date.now() + 60_000),
		});
		const res = await request(app, "/api/v1/me/api-keys", {
			method: "POST",
			bearer: parent.token,
			body: JSON.stringify({ name: "子", scopes: ["read"], expiresAt: 8_640_000_000_001 }),
		});
		expect(res.status).toBe(400);
	});

	it("上限（8_640_000_000）ちょうどは受け付ける", async () => {
		const cookie = await ownerCookie();
		const res = await request(app, "/api/v1/me/api-keys", {
			method: "POST",
			cookie,
			body: JSON.stringify({ name: "k", scopes: ["read"], expiresAt: 8_640_000_000 }),
		});
		expect(res.status).toBe(201);
	});

	it("admin の POST でもオーバーフローは 400", async () => {
		const cookie = await ownerCookie();
		const user = await createUser({ role: "member", email: "m@example.test" });
		const res = await request(app, "/api/v1/admin/api-keys", {
			method: "POST",
			cookie,
			body: JSON.stringify({
				userId: user.id,
				name: "k",
				scopes: ["read"],
				expiresAt: 8_640_000_000_001,
			}),
		});
		expect(res.status).toBe(400);
	});
});

describe("#100 addressIds の実在と上限", () => {
	it("存在しない addressId は 400（owner の all でも保存されない）", async () => {
		const cookie = await ownerCookie();
		const res = await request(app, "/api/v1/me/api-keys", {
			method: "POST",
			cookie,
			body: JSON.stringify({ name: "k", scopes: ["read"], addressIds: ["adr_nope"] }),
		});
		expect(res.status).toBe(400);
	});

	it("addressIds が上限（100）を超えると 400", async () => {
		const cookie = await ownerCookie();
		const domainId = await createDomain();
		const ids = [];
		for (let i = 0; i < 101; i++) ids.push(await createAddress(domainId, `a${i}`));
		const res = await request(app, "/api/v1/me/api-keys", {
			method: "POST",
			cookie,
			body: JSON.stringify({ name: "k", scopes: ["read"], addressIds: ids }),
		});
		expect(res.status).toBe(400);
	});

	it("admin の POST でも owner 宛で存在しない addressId は 400", async () => {
		const cookie = await ownerCookie();
		const [owner] = await db()
			.select()
			.from(schema.users)
			.where(eq(schema.users.role, "owner"))
			.limit(1);
		const res = await request(app, "/api/v1/admin/api-keys", {
			method: "POST",
			cookie,
			body: JSON.stringify({ userId: owner!.id, name: "k", scopes: ["read"], addressIds: ["adr_nope"] }),
		});
		expect(res.status).toBe(400);
	});
});

describe("#98 owner のパスワード再設定が監査で見分けられる", () => {
	async function latestUpdateMeta() {
		const logs = await db()
			.select()
			.from(schema.auditLogs)
			.where(eq(schema.auditLogs.action, "user.update"));
		return (logs[logs.length - 1]?.meta ?? {}) as Record<string, unknown>;
	}

	it("password 変更の meta に passwordChanged が入り、値そのものは入らない", async () => {
		const cookie = await ownerCookie();
		const user = await createUser({ role: "member", email: "m@example.test", password: OWNER.password });
		const res = await request(app, `/api/v1/admin/users/${user.id}`, {
			method: "PATCH",
			cookie,
			body: JSON.stringify({ password: "reset-secret-1234" }),
		});
		expect(res.status).toBe(200);
		const meta = await latestUpdateMeta();
		expect(meta.passwordChanged).toBe(true);
		expect(JSON.stringify(meta)).not.toContain("reset-secret-1234");
	});

	it("name だけの変更は passwordChanged が false", async () => {
		const cookie = await ownerCookie();
		const user = await createUser({ role: "member", email: "m2@example.test", password: OWNER.password });
		await request(app, `/api/v1/admin/users/${user.id}`, {
			method: "PATCH",
			cookie,
			body: JSON.stringify({ name: "新名前" }),
		});
		const meta = await latestUpdateMeta();
		expect(meta.passwordChanged).toBe(false);
	});

	it("owner がパスワードを設定すると mustChangePassword が立つ", async () => {
		const cookie = await ownerCookie();
		const user = await createUser({ role: "member", email: "m3@example.test", password: OWNER.password });
		await request(app, `/api/v1/admin/users/${user.id}`, {
			method: "PATCH",
			cookie,
			body: JSON.stringify({ password: "reset-secret-5678" }),
		});
		const [row] = await db()
			.select()
			.from(schema.users)
			.where(eq(schema.users.id, user.id))
			.limit(1);
		expect(row?.mustChangePassword).toBe(true);
	});
});

describe("#99 パスワード変更で API キーが失効する", () => {
	it("/me のパスワード変更で自分のキーが失効する", async () => {
		const cookie = await ownerCookie();
		const [owner] = await db()
			.select()
			.from(schema.users)
			.where(eq(schema.users.email, OWNER.email))
			.limit(1);
		const key = await createApiKeyFor({ userId: owner!.id });

		await request(app, "/api/v1/me", {
			method: "PATCH",
			cookie,
			body: JSON.stringify({ currentPassword: OWNER.password, newPassword: "brand-new-1234" }),
		});

		expect((await request(app, "/api/v1/me", { bearer: key.token })).status).toBe(401);
		const [row] = await db()
			.select()
			.from(schema.apiKeys)
			.where(eq(schema.apiKeys.id, key.id))
			.limit(1);
		expect(row?.revokedAt).not.toBeNull();
	});

	it("admin のパスワード変更でそのユーザーのキーが失効する", async () => {
		const cookie = await ownerCookie();
		const user = await createUser({ role: "member", email: "r@example.test", password: OWNER.password });
		const key = await createApiKeyFor({ userId: user.id });

		await request(app, `/api/v1/admin/users/${user.id}`, {
			method: "PATCH",
			cookie,
			body: JSON.stringify({ password: "reset-secret-9012" }),
		});

		const [row] = await db()
			.select()
			.from(schema.apiKeys)
			.where(eq(schema.apiKeys.id, key.id))
			.limit(1);
		expect(row?.revokedAt).not.toBeNull();
	});
});
