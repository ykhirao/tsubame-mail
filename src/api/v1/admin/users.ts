import { Hono } from "hono";
import { asc, eq, inArray } from "drizzle-orm";
import { schema } from "@/db/client";
import { newId } from "@/lib/id";
import { generateTemporaryPassword, hashPassword } from "@/lib/password";
import { readJson, unixSeconds } from "@/lib/validate";
import { countActiveOwners, recordAudit } from "@/domain/access/policy";
import {
	createUserBody,
	putGrantsBody,
	updateUserBody,
} from "@/shared/contracts/users";
import type { GrantInput } from "@/shared/contracts/users";
import { conflict, invalidRequest, notFound } from "@/shared/errors";
import { clientIp, getPrincipal, requireOwner } from "../../middleware/auth";
import type { AppEnv } from "../../types";

const app = new Hono<AppEnv>();

app.use("*", requireOwner);

function serializeUser(row: typeof schema.users.$inferSelect) {
	return {
		id: row.id,
		email: row.email,
		name: row.name,
		role: row.role,
		status: row.status,
		hasPassword: row.passwordHash !== null,
		lastLoginAt: unixSeconds(row.lastLoginAt),
		createdAt: unixSeconds(row.createdAt),
	};
}

async function loadUser(db: AppEnv["Variables"]["db"], id: string) {
	const [row] = await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
	if (!row) throw notFound("ユーザーが見つかりません");
	return row;
}

async function loadGrants(db: AppEnv["Variables"]["db"], userId: string) {
	return await db
		.select({
			addressId: schema.addressGrants.addressId,
			level: schema.addressGrants.level,
			address: schema.addresses.address,
		})
		.from(schema.addressGrants)
		.leftJoin(schema.addresses, eq(schema.addresses.id, schema.addressGrants.addressId))
		.where(eq(schema.addressGrants.userId, userId));
}

app.get("/", async (c) => {
	const db = c.get("db");
	const rows = await db.select().from(schema.users).orderBy(asc(schema.users.createdAt));
	return c.json({ data: rows.map(serializeUser), next_cursor: null });
});

app.get("/:id", async (c) => {
	const db = c.get("db");
	const user = await loadUser(db, c.req.param("id"));
	return c.json({ ...serializeUser(user), grants: await loadGrants(db, user.id) });
});

app.post("/", async (c) => {
	const principal = getPrincipal(c);
	const body = await readJson(c.req, createUserBody);
	const db = c.get("db");

	const email = body.email.trim().toLowerCase();
	const [existing] = await db
		.select({ id: schema.users.id })
		.from(schema.users)
		.where(eq(schema.users.email, email))
		.limit(1);
	if (existing) throw conflict("そのメールアドレスは既に使われています");

	const id = newId("user");

	// password を省略したら仮パスワードを発行し、初回ログイン後の変更を必須にする。
	const isAgent = body.role === "agent";
	const temporaryPassword = isAgent || body.password ? null : generateTemporaryPassword();
	const plain = body.password ?? temporaryPassword;
	const passwordHash = isAgent ? null : await hashPassword(plain as string);

	await db.insert(schema.users).values({
		id,
		email,
		name: body.name,
		passwordHash,
		role: body.role,
		status: "active",
		mustChangePassword: temporaryPassword !== null,
	});

	await recordAudit(db, {
		actorId: principal.userId,
		action: "user.create",
		targetType: "user",
		targetId: id,
		meta: { email, role: body.role },
		ip: clientIp(c),
	});

	// 仮パスワードはここでしか返らない。保存しているのはハッシュだけ。
	return c.json(
		{ ...serializeUser(await loadUser(db, id)), temporaryPassword },
		201,
	);
});

app.patch("/:id", async (c) => {
	const principal = getPrincipal(c);
	const id = c.req.param("id");
	const body = await readJson(c.req, updateUserBody);
	const db = c.get("db");

	const user = await loadUser(db, id);

	// 最後の owner を降格・無効化させない。
	const losesOwnership =
		user.role === "owner" &&
		((body.role !== undefined && body.role !== "owner") || body.status === "disabled");
	if (losesOwnership && (await countActiveOwners(db, user.id)) === 0) {
		throw conflict("最後のオーナーを降格・無効化することはできません");
	}

	const patch: Partial<typeof schema.users.$inferInsert> = {};
	if (body.name !== undefined) patch.name = body.name;
	if (body.role !== undefined) patch.role = body.role;
	if (body.status !== undefined) patch.status = body.status;
	if (body.password !== undefined) {
		if ((body.role ?? user.role) === "agent") {
			throw invalidRequest("agent ロールはパスワードを持ちません");
		}
		patch.passwordHash = await hashPassword(body.password);
	}
	if (body.role === "agent") patch.passwordHash = null;

	await db.update(schema.users).set(patch).where(eq(schema.users.id, id));

	// 無効化・降格・パスワード変更のいずれでも、既存セッションは切る。
	if (body.status === "disabled" || body.role !== undefined || body.password !== undefined) {
		await db.delete(schema.sessions).where(eq(schema.sessions.userId, id));
	}

	await recordAudit(db, {
		actorId: principal.userId,
		action: "user.update",
		targetType: "user",
		targetId: id,
		meta: { name: body.name, role: body.role, status: body.status, password: undefined },
		ip: clientIp(c),
	});

	return c.json(serializeUser(await loadUser(db, id)));
});

app.delete("/:id", async (c) => {
	const principal = getPrincipal(c);
	const id = c.req.param("id");
	const db = c.get("db");

	const user = await loadUser(db, id);
	if (user.role === "owner" && (await countActiveOwners(db, user.id)) === 0) {
		throw conflict("最後のオーナーを削除することはできません");
	}

	// sessions / api_keys / address_grants は外部キーの cascade で消える。
	await db.delete(schema.users).where(eq(schema.users.id, id));

	await recordAudit(db, {
		actorId: principal.userId,
		action: "user.delete",
		targetType: "user",
		targetId: id,
		meta: { email: user.email, role: user.role },
		ip: clientIp(c),
	});

	return c.json({ ok: true, id });
});

app.put("/:id/grants", async (c) => {
	const principal = getPrincipal(c);
	const id = c.req.param("id");
	const parsed = await readJson(c.req, putGrantsBody);
	const grants: GrantInput[] = Array.isArray(parsed) ? parsed : parsed.grants;
	const db = c.get("db");

	const user = await loadUser(db, id);

	const merged = new Map<string, GrantInput>();
	for (const g of grants) merged.set(g.addressId, g);
	const wanted = [...merged.values()];

	if (wanted.length > 0) {
		const found = await db
			.select({ id: schema.addresses.id })
			.from(schema.addresses)
			.where(inArray(schema.addresses.id, wanted.map((g) => g.addressId)));
		const known = new Set(found.map((r) => r.id));
		const missing = wanted.filter((g) => !known.has(g.addressId)).map((g) => g.addressId);
		if (missing.length > 0) throw invalidRequest(`存在しないアドレスです: ${missing.join(", ")}`);
	}

	await db.delete(schema.addressGrants).where(eq(schema.addressGrants.userId, id));
	if (wanted.length > 0) {
		await db
			.insert(schema.addressGrants)
			.values(wanted.map((g) => ({ userId: id, addressId: g.addressId, level: g.level })));
	}

	await recordAudit(db, {
		actorId: principal.userId,
		action: "user.grants.replace",
		targetType: "user",
		targetId: id,
		meta: { grants: wanted },
		ip: clientIp(c),
	});

	return c.json({ userId: user.id, grants: await loadGrants(db, id) });
});

export default app;
