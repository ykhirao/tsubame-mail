import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@/db/client";
import { buildTestApp, createApiKeyFor, createUser, db, json, request, resetDb, sessionCookie } from "./auth-helpers";

const app = buildTestApp();

beforeEach(resetDb);

const OWNER = {
	email: "owner@example.test",
	name: "オーナー",
	password: "correct-horse-1234",
	secret: "vitest-fixture-internal-secret-9f8e7d6c",
};

async function bootstrapOwner(): Promise<{ cookie: string; id: string }> {
	const res = await request(app, "/api/v1/auth/bootstrap", json(OWNER));
	expect(res.status).toBe(201);
	const [row] = await db().select().from(schema.users).where(eq(schema.users.email, OWNER.email));
	return { cookie: sessionCookie(res), id: row!.id };
}

async function issueWith(bearer: string, name: string): Promise<{ id: string; token: string; parentKeyId: string | null }> {
	const res = await request(app, "/api/v1/me/api-keys", {
		method: "POST",
		bearer,
		body: JSON.stringify({ name, scopes: ["read", "admin"] }),
	});
	expect(res.status).toBe(201);
	return (await res.json()) as { id: string; token: string; parentKeyId: string | null };
}

async function revokedAt(id: string): Promise<Date | null> {
	const [row] = await db().select().from(schema.apiKeys).where(eq(schema.apiKeys.id, id));
	return row?.revokedAt ?? null;
}

describe("#25 子キーのカスケード失効", () => {
	it("キーで発行したキーは親を持ち、親を失効すると孫まで失効して使えなくなる", async () => {
		const owner = await bootstrapOwner();
		const root = await createApiKeyFor({ userId: owner.id, scopes: ["read", "admin"] });
		const child = await issueWith(root.token, "子");
		const grandchild = await issueWith(child.token, "孫");
		expect(child.parentKeyId).toBe(root.id);
		expect(grandchild.parentKeyId).toBe(child.id);

		const res = await request(app, `/api/v1/me/api-keys/${root.id}`, { method: "DELETE", cookie: owner.cookie });
		expect(res.status).toBe(200);

		expect(await revokedAt(child.id)).not.toBeNull();
		expect(await revokedAt(grandchild.id)).not.toBeNull();
		expect((await request(app, "/api/v1/me", { bearer: grandchild.token })).status).toBe(401);

		const [audit] = await db()
			.select()
			.from(schema.auditLogs)
			.where(eq(schema.auditLogs.targetId, root.id));
		expect((audit!.meta as { descendants: string[] }).descendants.sort()).toEqual([child.id, grandchild.id].sort());
	});

	it("子を失効しても親と兄弟は生きている", async () => {
		const owner = await bootstrapOwner();
		const root = await createApiKeyFor({ userId: owner.id, scopes: ["read", "admin"] });
		const a = await issueWith(root.token, "a");
		const b = await issueWith(root.token, "b");

		await request(app, `/api/v1/me/api-keys/${a.id}`, { method: "DELETE", cookie: owner.cookie });

		expect(await revokedAt(a.id)).not.toBeNull();
		expect(await revokedAt(root.id)).toBeNull();
		expect(await revokedAt(b.id)).toBeNull();
	});

	it("画面（セッション）から発行したキーは親を持たない", async () => {
		const owner = await bootstrapOwner();
		const res = await request(app, "/api/v1/me/api-keys", {
			method: "POST",
			cookie: owner.cookie,
			body: JSON.stringify({ name: "画面", scopes: ["read"] }),
		});
		expect(((await res.json()) as { parentKeyId: string | null }).parentKeyId).toBeNull();
	});

	it("管理 API で他の利用者向けに発行したキーも、親の失効で失効する", async () => {
		const owner = await bootstrapOwner();
		const member = await createUser({ role: "member" });
		const root = await createApiKeyFor({ userId: owner.id, scopes: ["read", "admin"] });
		const created = await request(app, "/api/v1/admin/api-keys", {
			method: "POST",
			bearer: root.token,
			body: JSON.stringify({ userId: member.id, name: "メンバー用", scopes: ["read"] }),
		});
		expect(created.status).toBe(201);
		const memberKey = (await created.json()) as { id: string; parentKeyId: string | null };
		expect(memberKey.parentKeyId).toBe(root.id);

		const res = await request(app, `/api/v1/admin/api-keys/${root.id}`, { method: "DELETE", cookie: owner.cookie });
		expect(res.status).toBe(200);
		expect(await revokedAt(memberKey.id)).not.toBeNull();
	});

	it("利用者を削除すると、その人のキーから他の利用者向けに発行したキーも失効する", async () => {
		const owner = await bootstrapOwner();
		const second = await createUser({ role: "owner" });
		const member = await createUser({ role: "member" });
		const secondKey = await createApiKeyFor({ userId: second.id, scopes: ["read", "admin"] });
		const created = await request(app, "/api/v1/admin/api-keys", {
			method: "POST",
			bearer: secondKey.token,
			body: JSON.stringify({ userId: member.id, name: "メンバー用", scopes: ["read"] }),
		});
		const memberKey = (await created.json()) as { id: string };

		const res = await request(app, `/api/v1/admin/users/${second.id}`, { method: "DELETE", cookie: owner.cookie });
		expect(res.status).toBe(200);
		expect(await revokedAt(memberKey.id)).not.toBeNull();
	});
});
