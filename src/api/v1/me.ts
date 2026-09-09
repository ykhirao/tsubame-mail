import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { schema } from "@/db/client";
import { newId } from "@/lib/id";
import { hashPassword, verifyPassword } from "@/lib/password";
import { generateApiKey } from "@/lib/tokens";
import { readJson, unixSeconds } from "@/lib/validate";
import {
	addressSetHas,
	intersectAddressSets,
	listAccessibleAddresses,
	normalizeScopes,
	recordAudit,
} from "@/domain/access/policy";
import type { AddressSet } from "@/domain/access/policy";
import { createApiKeyBody } from "@/shared/contracts/api-keys";
import type { Scope } from "@/shared/contracts/common";
import { updateMeBody } from "@/shared/contracts/users";
import { forbidden, invalidRequest, notFound, unauthorized } from "@/shared/errors";
import { clientIp, getPrincipal, requireAuth } from "../middleware/auth";
import type { AppEnv } from "../types";

const app = new Hono<AppEnv>();

app.use("*", requireAuth);

app.get("/", async (c) => {
	const principal = getPrincipal(c);
	const db = c.get("db");

	const [user] = await db
		.select({
			id: schema.users.id,
			email: schema.users.email,
			name: schema.users.name,
			role: schema.users.role,
			status: schema.users.status,
			mustChangePassword: schema.users.mustChangePassword,
			lastLoginAt: schema.users.lastLoginAt,
		})
		.from(schema.users)
		.where(eq(schema.users.id, principal.userId))
		.limit(1);
	if (!user) throw unauthorized();

	const addresses = await listAccessibleAddresses(db, principal);

	return c.json({
		id: user.id,
		email: user.email,
		name: user.name,
		role: user.role,
		status: user.status,
		mustChangePassword: user.mustChangePassword,
		lastLoginAt: unixSeconds(user.lastLoginAt),
		via: principal.via,
		apiKeyId: principal.apiKeyId ?? null,
		scopes: principal.scopes,
		/** "all" ならアドレス無制限（owner かつキーの絞り込み無し）。 */
		addressIds: principal.addressIds,
		writableAddressIds: principal.writableAddressIds,
		addresses,
	});
});

app.patch("/", async (c) => {
	const principal = getPrincipal(c);
	const body = await readJson(c.req, updateMeBody);
	const db = c.get("db");

	const [user] = await db
		.select()
		.from(schema.users)
		.where(eq(schema.users.id, principal.userId))
		.limit(1);
	if (!user) throw unauthorized();

	const patch: { name?: string; passwordHash?: string; mustChangePassword?: boolean } = {};
	if (body.name) patch.name = body.name;

	if (body.newPassword) {
		if (!user.passwordHash) {
			throw invalidRequest("このアカウントはパスワードを持ちません（API キーのみで動きます）");
		}
		const ok = await verifyPassword(body.currentPassword ?? "", user.passwordHash);
		if (!ok) throw forbidden("現在のパスワードが違います");
		patch.passwordHash = await hashPassword(body.newPassword);
		// 仮パスワードから本人の値に変わったので、変更の強制を解く。
		patch.mustChangePassword = false;
	}

	await db.update(schema.users).set(patch).where(eq(schema.users.id, user.id));

	if (patch.passwordHash) {
		// パスワードを変えたら他のセッションを落とす（自分の Cookie も含めて全部）。
		await db.delete(schema.sessions).where(eq(schema.sessions.userId, user.id));
	}

	return c.json({
		id: user.id,
		email: user.email,
		name: patch.name ?? user.name,
		role: user.role,
		passwordChanged: Boolean(patch.passwordHash),
	});
});

app.get("/api-keys", async (c) => {
	const principal = getPrincipal(c);
	const db = c.get("db");
	const rows = await db
		.select()
		.from(schema.apiKeys)
		.where(eq(schema.apiKeys.userId, principal.userId))
		.orderBy(desc(schema.apiKeys.createdAt));
	return c.json({ data: rows.map(serializeKey), next_cursor: null });
});

app.post("/api-keys", async (c) => {
	const principal = getPrincipal(c);
	const body = await readJson(c.req, createApiKeyBody);
	const db = c.get("db");

	// 発行できる権限は **今のリクエストの権限まで**。
	// これを principal 基準にしておくと、絞られたキーからさらに広いキーを作る抜け道が塞がる。
	const scopes = clampScopes(principal.scopes, body.scopes);
	const addressIds = clampAddressIds(
		principal.addressIds,
		body.addressIds ?? null,
		principal.via === "api_key",
	);

	const generated = await generateApiKey();
	const id = newId("apiKey");
	const expiresAt = body.expiresAt ? new Date(body.expiresAt * 1000) : null;

	await db.insert(schema.apiKeys).values({
		id,
		userId: principal.userId,
		name: body.name,
		prefix: generated.prefix,
		keyHash: generated.hash,
		scopes,
		addressIds,
		expiresAt,
	});

	await recordAudit(db, {
		actorId: principal.userId,
		action: "api_key.create",
		targetType: "api_key",
		targetId: id,
		meta: { name: body.name, scopes, addressIds },
		ip: clientIp(c),
	});

	const [row] = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, id)).limit(1);
	// token はここでしか出てこない。保存しないので再表示もできない。
	return c.json({ ...serializeKey(row!), token: generated.token }, 201);
});

app.delete("/api-keys/:id", async (c) => {
	const principal = getPrincipal(c);
	const db = c.get("db");
	const id = c.req.param("id");

	const [key] = await db
		.select()
		.from(schema.apiKeys)
		.where(and(eq(schema.apiKeys.id, id), eq(schema.apiKeys.userId, principal.userId)))
		.limit(1);
	// 他人のキーは「見つからない」で返す（存在を漏らさない）。
	if (!key) throw notFound("キーが見つかりません");

	const revokedAt = key.revokedAt ?? new Date();
	await db.update(schema.apiKeys).set({ revokedAt }).where(eq(schema.apiKeys.id, id));

	await recordAudit(db, {
		actorId: principal.userId,
		action: "api_key.revoke",
		targetType: "api_key",
		targetId: id,
		ip: clientIp(c),
	});

	return c.json({ ...serializeKey(key), revokedAt: unixSeconds(revokedAt) });
});

export function serializeKey(row: typeof schema.apiKeys.$inferSelect) {
	return {
		id: row.id,
		userId: row.userId,
		name: row.name,
		prefix: row.prefix,
		scopes: normalizeScopes(row.scopes),
		addressIds: row.addressIds ?? null,
		expiresAt: unixSeconds(row.expiresAt),
		revokedAt: unixSeconds(row.revokedAt),
		lastUsedAt: unixSeconds(row.lastUsedAt),
		createdAt: unixSeconds(row.createdAt),
	};
}

export function clampScopes(available: Scope[], requested: Scope[]): Scope[] {
	const over = requested.filter((s) => !available.includes(s));
	if (over.length > 0) throw forbidden(`付与できないスコープです: ${over.join(", ")}`);
	return [...new Set(requested)];
}

/** requested が null なら「制限なし」。絞られた API キーからの発行だけ、そのキーの範囲で凍結する。 */
export function clampAddressIds(
	available: AddressSet,
	requested: string[] | null,
	freezeWhenUnrestricted: boolean,
): string[] | null {
	if (requested === null) {
		if (!freezeWhenUnrestricted || available === "all") return null;
		return [...available];
	}
	const over = requested.filter((id) => !addressSetHas(available, id));
	if (over.length > 0) throw forbidden(`権限の無いアドレスです: ${over.join(", ")}`);
	const set = intersectAddressSets(available, requested);
	return set === "all" ? [...new Set(requested)] : set;
}

export default app;
