import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { schema } from "@/db/client";
import type { AppEnv } from "@/api/types";
import { ApiError } from "@/shared/errors";
import adminAddressRoutes from "@/api/v1/admin/addresses";
import {
	buildTestApp,
	createAddress,
	createDomain,
	createUser,
	db,
	grant,
	json,
	request,
	resetDb,
	sessionCookie,
} from "./auth-helpers";
import { createFakeCloudflare, getTestDb, ownerPrincipal, testEnv } from "./domains-helpers";

const app = buildTestApp();

beforeEach(resetDb);
afterEach(() => vi.unstubAllGlobals());

const PASSWORD = "correct-horse-1234";
const SECRET = "vitest-fixture-internal-secret-9f8e7d6c";

async function ownerCookie() {
	const res = await request(app, "/api/v1/auth/bootstrap", json({ email: "owner@example.test", name: "オーナー", password: PASSWORD, secret: SECRET }));
	expect(res.status).toBe(201);
	return sessionCookie(res);
}

// ドメイン名は一意にしつつ、プライマリ経由のログイン（zod の email 検証）が通る形にする。
async function mailbox(localPart: string) {
	const dname = `primary-${crypto.randomUUID().slice(0, 8)}.test`;
	const domainId = await createDomain(dname);
	const id = await createAddress(domainId, localPart, dname);
	return { domainId, id, address: `${localPart}@${dname}` };
}

describe("POST /admin/users のプライマリ（FR-4-5）", () => {
	it("既存メールボックスを選ぶと、write で割り当ててプライマリにして返す", async () => {
		const cookie = await ownerCookie();
		const { id, address } = await mailbox("alice");
		const res = await request(app, "/api/v1/admin/users", {
			...json({ email: "alice@example.test", name: "アリス", role: "member", password: PASSWORD, primaryAddress: { addressId: id } }),
			cookie,
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { id: string; primaryAddressId: string; primaryAddress: string };
		expect(body.primaryAddressId).toBe(id);
		expect(body.primaryAddress).toBe(address);
		const [user] = await db().select().from(schema.users).where(eq(schema.users.id, body.id));
		expect(user!.primaryAddressId).toBe(id);
		const grants = await db().select().from(schema.addressGrants).where(eq(schema.addressGrants.addressId, id));
		expect(grants).toHaveLength(1);
		expect(grants[0]).toMatchObject({ userId: body.id, level: "write" });
	});

	it("email が無い member も作れて、ログインはプライマリで行う", async () => {
		const cookie = await ownerCookie();
		const { id, address } = await mailbox("bob");
		const res = await request(app, "/api/v1/admin/users", {
			...json({ name: "ボブ", role: "member", password: PASSWORD, primaryAddress: { addressId: id } }),
			cookie,
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { id: string };
		expect(body).toMatchObject({ email: null, externalEmail: null });
		const login = await request(app, "/api/v1/auth/login", json({ email: address, password: PASSWORD }));
		expect(login.status).toBe(200);
	});

	it("primaryAddress は必須（無いと 400）", async () => {
		const cookie = await ownerCookie();
		const res = await request(app, "/api/v1/admin/users", {
			...json({ email: "x@example.test", name: "X", role: "member", password: PASSWORD }),
			cookie,
		});
		expect(res.status).toBe(400);
	});

	it("アーカイブ済みメールボックスは 400", async () => {
		const cookie = await ownerCookie();
		const { id } = await mailbox("arch");
		await db().update(schema.addresses).set({ archivedAt: new Date() }).where(eq(schema.addresses.id, id));
		const res = await request(app, "/api/v1/admin/users", {
			...json({ email: "a2@example.test", name: "A", role: "member", password: PASSWORD, primaryAddress: { addressId: id } }),
			cookie,
		});
		expect(res.status).toBe(400);
	});

	it("エイリアスは 400", async () => {
		const cookie = await ownerCookie();
		const { id: targetId } = await mailbox("target");
		const { id: aliasId } = await mailbox("alias-a");
		await db().update(schema.addresses).set({ kind: "alias", aliasTargetId: targetId }).where(eq(schema.addresses.id, aliasId));
		const res = await request(app, "/api/v1/admin/users", {
			...json({ email: "a3@example.test", name: "A", role: "member", password: PASSWORD, primaryAddress: { addressId: aliasId } }),
			cookie,
		});
		expect(res.status).toBe(400);
	});

	it("別のユーザーのプライマリは 409", async () => {
		const cookie = await ownerCookie();
		const other = await createUser({ role: "owner", email: "other@example.test" });
		const { id } = await mailbox("taken");
		await db().update(schema.users).set({ primaryAddressId: id }).where(eq(schema.users.id, other.id));
		const res = await request(app, "/api/v1/admin/users", {
			...json({ email: "a4@example.test", name: "A", role: "member", password: PASSWORD, primaryAddress: { addressId: id } }),
			cookie,
		});
		expect(res.status).toBe(409);
	});

	it("外部アドレス（email）とプライマリを同じにできない（409）", async () => {
		const cookie = await ownerCookie();
		const { id, address } = await mailbox("same");
		const res = await request(app, "/api/v1/admin/users", {
			...json({ email: address, name: "A", role: "member", password: PASSWORD, primaryAddress: { addressId: id } }),
			cookie,
		});
		expect(res.status).toBe(409);
	});

	it("その場で作るプライマリはドメインとローカル部で作って割り当てる（FR-4-5）", async () => {
		vi.stubGlobal("fetch", createFakeCloudflare({ zones: [{ id: "zone", name: "primary.test" }] }).fetch);
		const cookie = await ownerCookie();
		const domainId = await createDomain("primary.test");
		const res = await request(app, "/api/v1/admin/users", {
			...json({ name: "オンデマンド", role: "member", password: PASSWORD, primaryAddress: { domainId, localPart: "od", displayName: "オンデマンド" } }),
			cookie,
			env: { CF_API_TOKEN: "t", CF_ACCOUNT_ID: "a", EMAIL_WORKER_NAME: "tsubame" },
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { id: string; primaryAddress: string; primaryAddressId: string };
		expect(body.primaryAddress).toBe("od@primary.test");
		const grants = await db().select().from(schema.addressGrants).where(eq(schema.addressGrants.addressId, body.primaryAddressId));
		expect(grants).toHaveLength(1);
		expect(grants[0]).toMatchObject({ userId: body.id, level: "write" });
	});
});

describe("PATCH /admin/users/:id のプライマリ変更（FR-4-5）", () => {
	async function memberWithPrimary() {
		const { id: primaryId } = await mailbox("p1");
		const member = await createUser({ role: "member", email: "m@example.test", password: PASSWORD });
		await db().update(schema.users).set({ primaryAddressId: primaryId }).where(eq(schema.users.id, member.id));
		await grant(member.id, primaryId, "write");
		return { member, primaryId };
	}

	it("write で割り当てた別のメールボックスへ変えられる", async () => {
		const cookie = await ownerCookie();
		const { member } = await memberWithPrimary();
		const { id: nextId } = await mailbox("p2");
		await grant(member.id, nextId, "write");
		const res = await request(app, `/api/v1/admin/users/${member.id}`, {
			cookie,
			method: "PATCH",
			body: JSON.stringify({ primaryAddressId: nextId }),
		});
		expect(res.status).toBe(200);
		expect((await res.json() as { primaryAddressId: string }).primaryAddressId).toBe(nextId);
	});

	it("write で割り当てていないメールボックスには変えられない（400）", async () => {
		const cookie = await ownerCookie();
		const { member } = await memberWithPrimary();
		const { id: nopeId } = await mailbox("nope");
		const res = await request(app, `/api/v1/admin/users/${member.id}`, {
			cookie,
			method: "PATCH",
			body: JSON.stringify({ primaryAddressId: nopeId }),
		});
		expect(res.status).toBe(400);
	});

	it("別のユーザーのプライマリには変えられない（409）", async () => {
		const cookie = await ownerCookie();
		const { member } = await memberWithPrimary();
		const other = await createUser({ role: "owner", email: "o2@example.test" });
		const { id: theirsId } = await mailbox("theirs");
		await db().update(schema.users).set({ primaryAddressId: theirsId }).where(eq(schema.users.id, other.id));
		await grant(member.id, theirsId, "write");
		const res = await request(app, `/api/v1/admin/users/${member.id}`, {
			cookie,
			method: "PATCH",
			body: JSON.stringify({ primaryAddressId: theirsId }),
		});
		expect(res.status).toBe(409);
	});
});

describe("grants PUT とプライマリ（FR-4-5：プライマリは常に write で割り当てる）", () => {
	it("一覧に無いプライマリは write のまま残る", async () => {
		const cookie = await ownerCookie();
		const { id: p1 } = await mailbox("gp");
		const member = await createUser({ role: "member", email: "gm@example.test", password: PASSWORD });
		await db().update(schema.users).set({ primaryAddressId: p1 }).where(eq(schema.users.id, member.id));
		await grant(member.id, p1, "write");
		const { id: other } = await mailbox("go");
		const body = JSON.stringify({ grants: [{ addressId: other, level: "write" }] });
		const res = await request(app, `/api/v1/admin/users/${member.id}/grants`, {
			cookie,
			method: "PUT",
			body,
		});
		expect(res.status).toBe(200);
		const rows = await db().select().from(schema.addressGrants).where(eq(schema.addressGrants.userId, member.id));
		expect(rows.map((r) => [r.addressId, r.level]).sort()).toEqual([[other, "write"], [p1, "write"]].sort());
	});

	it("read に下げるのも 400、write のままなら 200", async () => {
		const cookie = await ownerCookie();
		const { id: p1 } = await mailbox("gr");
		const member = await createUser({ role: "member", email: "gm2@example.test", password: PASSWORD });
		await db().update(schema.users).set({ primaryAddressId: p1 }).where(eq(schema.users.id, member.id));
		await grant(member.id, p1, "write");
		const down = await request(app, `/api/v1/admin/users/${member.id}/grants`, {
			cookie,
			method: "PUT",
			body: JSON.stringify({ grants: [{ addressId: p1, level: "read" }] }),
		});
		expect(down.status).toBe(400);
		const keep = await request(app, `/api/v1/admin/users/${member.id}/grants`, {
			cookie,
			method: "PUT",
			body: JSON.stringify({ grants: [{ addressId: p1, level: "write" }] }),
		});
		expect(keep.status).toBe(200);
	});
});

describe("admin/addresses とプライマリ（FR-4-6 / assignToMe / 保護）", () => {
	// buildTestApp は /api/v1/admin/addresses をマウントしないので、ここでは ownerPrincipal で組み立てる。
	function mountAdmin() {
		const a = new Hono<AppEnv>();
		a.onError((err, c) => {
			if (err instanceof ApiError) return c.json(err.toJSON(), err.status as 400);
			return c.json({ error: { code: "internal", message: "内部エラー" } }, 500);
		});
		a.use("*", async (c, next) => {
			c.set("db", getTestDb());
			c.set("requestId", "test");
			c.set("principal", ownerPrincipal);
			await next();
		});
		a.route("/admin/addresses", adminAddressRoutes);
		return a;
	}
	function seedOwner() {
		return db().insert(schema.users).values({
			id: ownerPrincipal.userId,
			email: "owner@example.test",
			externalEmail: "owner@example.test",
			name: "オーナー",
			role: "owner",
			status: "active",
		});
	}
	async function adminPost(body: Record<string, unknown>) {
		const res = await mountAdmin().fetch(new Request("https://test.local/admin/addresses", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}), testEnv);
		return { status: res.status, json: (await res.json()) as any };
	}
	async function adminCall(path: string, init: RequestInit) {
		const res = await mountAdmin().fetch(new Request(`https://test.local/admin/addresses${path}`, {
			...init,
			headers: { "content-type": "application/json", ...(init.headers ?? {}) },
		}), testEnv);
		return { status: res.status, json: (await res.json()) as any };
	}

	beforeEach(() => {
		vi.stubGlobal("fetch", createFakeCloudflare({ zones: [{ id: "zone", name: "primary.test" }] }).fetch);
	});

	it("プライマリの無い owner が最初のメールボックスを作るとプライマリになる（FR-4-6）", async () => {
		await seedOwner();
		const domainId = await createDomain("primary.test");
		const res = await adminPost({ domainId, localPart: "first", kind: "mailbox", isCatchAll: false });
		expect(res.status).toBe(201);
		const [owner] = await db().select().from(schema.users).where(eq(schema.users.id, ownerPrincipal.userId));
		expect(owner!.primaryAddressId).toBe(res.json.data.id);
		const grants = await db().select().from(schema.addressGrants).where(eq(schema.addressGrants.userId, ownerPrincipal.userId));
		expect(grants).toHaveLength(1);
		expect(grants[0]).toMatchObject({ addressId: owner!.primaryAddressId, level: "write" });
	});

	it("assignToMe: true なら write で割り当て、無ければ誰のものでもない", async () => {
		await seedOwner();
		const domainId = await createDomain("primary.test");
		const { id: existing } = await mailbox("primer");
		await db().update(schema.users).set({ primaryAddressId: existing }).where(eq(schema.users.id, ownerPrincipal.userId));
		const unassigned = await adminPost({ domainId, localPart: "free", kind: "mailbox", isCatchAll: false });
		expect(unassigned.status).toBe(201);
		expect(
			(await db().select().from(schema.addressGrants).where(eq(schema.addressGrants.addressId, unassigned.json.data.id))).length,
		).toBe(0);
		const mine = await adminPost({ domainId, localPart: "mine", kind: "mailbox", isCatchAll: false, assignToMe: true });
		expect(mine.status).toBe(201);
		expect(
			(await db().select().from(schema.addressGrants).where(eq(schema.addressGrants.addressId, mine.json.data.id))).length,
		).toBe(1);
	});

	it("プライマリはアーカイブ化・エイリアス化・削除できない（FR-4-5）", async () => {
		await seedOwner();
		const { id: primary, domainId } = await mailbox("protected");
		await db().update(schema.users).set({ primaryAddressId: primary }).where(eq(schema.users.id, ownerPrincipal.userId));
		const target = await createAddress(domainId, "t2", "primary.test");

		const archive = await adminCall(`/${primary}`, { method: "PATCH", body: JSON.stringify({ archived: true }) });
		expect(archive.status).toBe(409);

		const aliasify = await adminCall(`/${primary}`, { method: "PATCH", body: JSON.stringify({ kind: "alias", aliasTargetId: target }) });
		expect(aliasify.status).toBe(409);

		const del = await adminCall(`/${primary}`, { method: "DELETE" });
		expect(del.status).toBe(409);
		expect(target).toBeTruthy();
	});

	it("プライマリ以外のエイリアス化はアーカイブ・削除と同様に保護されない", async () => {
		await seedOwner();
		const { id: primary } = await mailbox("pk");
		await db().update(schema.users).set({ primaryAddressId: primary }).where(eq(schema.users.id, ownerPrincipal.userId));
		const { id: secondary, address } = await mailbox("secondary");
		const res = await adminCall(`/${secondary}`, { method: "PATCH", body: JSON.stringify({ displayName: address }) });
		expect(res.status).toBe(200);
	});
});
