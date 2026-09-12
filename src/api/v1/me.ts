import { Hono } from "hono";
import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { schema } from "@/db/client";
import type { Db } from "@/db/client";
import { newId } from "@/lib/id";
import { hashPassword, verifyPassword } from "@/lib/password";
import { generateApiKey } from "@/lib/tokens";
import { afterCursor, toPage } from "@/lib/paging";
import { readJson, unixSeconds } from "@/lib/validate";
import {
	addressSetHas,
	intersectAddressSets,
	jsonIdsIn,
	listAccessibleAddresses,
	normalizeScopes,
	recordAudit,
} from "@/domain/access/policy";
import type { AddressSet } from "@/domain/access/policy";
import { createApiKeyBody } from "@/shared/contracts/api-keys";
import { paginationQuery } from "@/shared/contracts/common";
import type { Principal, Scope } from "@/shared/contracts/common";
import { adminModeBody, updateMeBody } from "@/shared/contracts/users";
import { forbidden, invalidRequest, notFound, unauthorized } from "@/shared/errors";
import { clientIp, getPrincipal, requireAuth } from "../middleware/auth";
import type { AppEnv } from "../types";
import { setExternalEmailBody, verifyExternalEmailBody } from "@/shared/contracts/external-email";
import {
	registerExternalEmail,
	resendExternalEmail,
	verifyExternalEmail,
} from "@/services/verification-mail";

const app = new Hono<AppEnv>();

app.use("*", requireAuth);

// 漏れた read/send キー 1 本で無期限の子キーを作られたり、他のキーを全部失効させられたりしないよう、
// キー管理そのものは Cookie セッションか admin スコープ付きキーだけに絞る。
async function requireKeyManagement(principal: Principal, db: Db): Promise<void> {
	if (principal.via === "session") {
		// 仮パスワードのままではキーを発行・失効できない（#64）。
		const [user] = await db
			.select({ mustChangePassword: schema.users.mustChangePassword })
			.from(schema.users)
			.where(eq(schema.users.id, principal.userId))
			.limit(1);
		if (user?.mustChangePassword) {
			throw forbidden("パスワードを変更するまで API キーを発行・失効できません");
		}
		return;
	}
	if (principal.scopes.includes("admin")) return;
	throw forbidden("キーの管理には admin スコープが必要です");
}

app.get("/", async (c) => {
	const principal = getPrincipal(c);
	const db = c.get("db");

	const [user] = await db
		.select({
			id: schema.users.id,
			email: schema.users.externalEmail,
			externalVerifiedAt: schema.users.externalVerifiedAt,
			primaryAddressId: schema.users.primaryAddressId,
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
	const [session] = principal.adminMode && principal.sessionId
		? await db
				.select({ adminModeUntil: schema.sessions.adminModeUntil })
				.from(schema.sessions)
				.where(eq(schema.sessions.id, principal.sessionId))
				.limit(1)
		: [];

	return c.json({
		id: user.id,
		email: user.email,
		externalEmail: user.email,
		externalVerified: user.externalVerifiedAt !== null,
		primaryAddressId: user.primaryAddressId,
		adminMode: principal.adminMode === true,
		adminModeUntil: unixSeconds(session?.adminModeUntil ?? null),
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
		/** 自分に割り当てたアドレス。管理者モードでも変わらない（既読などを変えられる範囲）。 */
		ownAddressIds: principal.ownAddressIds ?? principal.addressIds,
		addresses,
	});
});

// 管理者モードは画面のログインにだけ持つ。読める範囲が全アドレスに広がるので、入った・出たを必ず記録し、1 時間で切る（FR-19）。
export const ADMIN_MODE_SECONDS = 60 * 60;

app.post("/admin-mode", async (c) => {
	const principal = getPrincipal(c);
	if (principal.role !== "owner") throw forbidden("管理者モードはオーナーだけが使えます");
	if (principal.via !== "session" || !principal.sessionId) {
		throw forbidden("管理者モードは画面のログインからだけ切り替えられます");
	}
	const { enabled } = await readJson(c.req, adminModeBody);
	const db = c.get("db");
	const until = enabled ? new Date(Date.now() + ADMIN_MODE_SECONDS * 1000) : null;
	await db.update(schema.sessions).set({ adminModeUntil: until }).where(eq(schema.sessions.id, principal.sessionId));
	await recordAudit(db, {
		actorId: principal.userId,
		action: enabled ? "admin_mode.enter" : "admin_mode.exit",
		targetType: "user",
		targetId: principal.userId,
		meta: { until: unixSeconds(until) },
		ip: clientIp(c),
	});
	return c.json({ adminMode: enabled, adminModeUntil: unixSeconds(until) });
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
	let passwordChanged = false;
	let revokedApiKeys = 0;
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
		// 漏れたキーがそのまま生きないよう、発行済みの API キーも失効させる（#99）。
		await db.delete(schema.sessions).where(eq(schema.sessions.userId, user.id));
		await db.delete(schema.pushDevices).where(eq(schema.pushDevices.userId, user.id));
		const [before] = await db
			.select({ n: sql<number>`count(*)` })
			.from(schema.apiKeys)
			.where(and(eq(schema.apiKeys.userId, user.id), isNull(schema.apiKeys.revokedAt)));
		const now = new Date();
		await db
			.update(schema.apiKeys)
			.set({ revokedAt: now })
			.where(and(eq(schema.apiKeys.userId, user.id), isNull(schema.apiKeys.revokedAt)));
		await revokeKeysIssuedBy(db, user.id, now);
		passwordChanged = true;
		revokedApiKeys = Number(before?.n ?? 0);
	}

	return c.json({
		id: user.id,
		email: user.email,
		name: patch.name ?? user.name,
		role: user.role,
		passwordChanged,
		revokedApiKeys,
	});
});

// 外部アドレスは本人の資格情報（ログイン先）なので、セッションだけに許す（API キーでは 403）。
function requireMeSession(principal: Principal): void {
	if (principal.via !== "session") {
		throw forbidden("外部アドレスの設定は画面からログインして行ってください");
	}
}

app.post("/external-email", async (c) => {
	const principal = getPrincipal(c);
	requireMeSession(principal);
	const body = await readJson(c.req, setExternalEmailBody);
	const db = c.get("db");
	const result = await registerExternalEmail(db, c.env, principal.userId, body.email);
	await recordAudit(db, {
		actorId: principal.userId,
		action: "user.external_email.set",
		targetType: "user",
		targetId: principal.userId,
		meta: { email: body.email.trim().toLowerCase(), sent: result.sent },
		ip: clientIp(c),
	});
	return c.json(result);
});

app.post("/external-email/verify", async (c) => {
	const principal = getPrincipal(c);
	requireMeSession(principal);
	const body = await readJson(c.req, verifyExternalEmailBody);
	const db = c.get("db");
	const email = await verifyExternalEmail(db, principal.userId, body.code);
	await recordAudit(db, {
		actorId: principal.userId,
		action: "user.external_email.verify",
		targetType: "user",
		targetId: principal.userId,
		meta: { email },
		ip: clientIp(c),
	});
	return c.json({ verified: true, email });
});

app.post("/external-email/resend", async (c) => {
	const principal = getPrincipal(c);
	requireMeSession(principal);
	const db = c.get("db");
	const result = await resendExternalEmail(db, c.env, principal.userId);
	await recordAudit(db, {
		actorId: principal.userId,
		action: "user.external_email.resend",
		targetType: "user",
		targetId: principal.userId,
		meta: { sent: result.sent },
		ip: clientIp(c),
	});
	return c.json(result);
});

app.get("/api-keys", async (c) => {
	const principal = getPrincipal(c);
	const db = c.get("db");
	const query = paginationQuery.safeParse(c.req.query());
	if (!query.success) throw invalidRequest("クエリが不正です", query.error.issues);
	const { limit, cursor } = query.data;
	const rows = await db
		.select()
		.from(schema.apiKeys)
		.where(and(eq(schema.apiKeys.userId, principal.userId), afterCursor(schema.apiKeys, cursor, "desc")))
		.orderBy(desc(schema.apiKeys.createdAt), desc(schema.apiKeys.id))
		.limit(limit + 1);
	const page = toPage(rows, limit);
	return c.json({ data: page.rows.map(serializeKey), next_cursor: page.next_cursor });
});

app.post("/api-keys", async (c) => {
	const principal = getPrincipal(c);
	const db = c.get("db");
	await requireKeyManagement(principal, db);
	const body = await readJson(c.req, createApiKeyBody);

	// 発行できる権限は **今のリクエストの権限まで**。
	// これを principal 基準にしておくと、絞られたキーからさらに広いキーを作る抜け道が塞がる。
	const scopes = clampScopes(principal.scopes, body.scopes);
	const addressIds = clampAddressIds(
		principal.addressIds,
		body.addressIds ?? null,
		principal.via === "api_key" && !!principal.keyRestricted,
	);
	if (addressIds) await assertAddressesExist(db, addressIds);
	const expiresAt = await clampExpiresAt(db, principal, body.expiresAt);

	const generated = await generateApiKey();
	const id = newId("apiKey");

	await db.insert(schema.apiKeys).values({
		id,
		userId: principal.userId,
		name: body.name,
		prefix: generated.prefix,
		keyHash: generated.hash,
		scopes,
		addressIds,
		expiresAt,
		parentKeyId: principal.apiKeyId ?? null,
	});

	await recordAudit(db, {
		actorId: principal.userId,
		action: "api_key.create",
		targetType: "api_key",
		targetId: id,
		meta: { name: body.name, scopes, addressIds, apiKeyId: principal.apiKeyId ?? null },
		ip: clientIp(c),
	});

	const [row] = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, id)).limit(1);
	// token はここでしか出てこない。保存しないので再表示もできない。
	return c.json({ ...serializeKey(row!), token: generated.token }, 201);
});

app.delete("/api-keys/:id", async (c) => {
	const principal = getPrincipal(c);
	const db = c.get("db");
	await requireKeyManagement(principal, db);
	const id = c.req.param("id");

	const [key] = await db
		.select()
		.from(schema.apiKeys)
		.where(and(eq(schema.apiKeys.id, id), eq(schema.apiKeys.userId, principal.userId)))
		.limit(1);
	// 他人のキーは「見つからない」で返す（存在を漏らさない）。
	if (!key) throw notFound("キーが見つかりません");
	// 範囲を絞ったキーが漏れても、持ち主の他のキーまで止められないようにする。自分と自分の子孫だけ（#145）。
	if (principal.via === "api_key" && principal.keyRestricted && principal.apiKeyId) {
		if (id !== principal.apiKeyId && !(await isDescendantKey(db, principal.apiKeyId, id))) {
			throw forbidden("範囲を絞った API キーでは、そのキーと、そのキーから発行したキーしか失効できません");
		}
	}

	const revokedAt = key.revokedAt ?? new Date();
	const descendants = await revokeKeyTree(db, id, revokedAt);

	await recordAudit(db, {
		actorId: principal.userId,
		action: "api_key.revoke",
		targetType: "api_key",
		targetId: id,
		meta: { apiKeyId: principal.apiKeyId ?? null, descendants },
		ip: clientIp(c),
	});

	return c.json({ ...serializeKey(key), revokedAt: unixSeconds(revokedAt) });
});

async function isDescendantKey(db: Db, ancestorId: string, id: string): Promise<boolean> {
	const rows = await db.all<{ id: string }>(sql`
		with recursive tree(id) as (
			select id from api_keys where parent_key_id = ${ancestorId}
			union
			select k.id from api_keys k join tree t on k.parent_key_id = t.id
		)
		select id from tree where id = ${id}`);
	return rows.length > 0;
}

/** キーと、そのキーから（孫以降も含めて）発行したキーを失効する。新しく失効した子孫の id を返す。 */
export async function revokeKeyTree(db: Db, id: string, revokedAt: Date): Promise<string[]> {
	await db
		.update(schema.apiKeys)
		.set({ revokedAt })
		.where(and(eq(schema.apiKeys.id, id), isNull(schema.apiKeys.revokedAt)));
	const rows = await db.all<{ id: string }>(sql`
		with recursive tree(id) as (
			select id from api_keys where parent_key_id = ${id}
			union
			select k.id from api_keys k join tree t on k.parent_key_id = t.id
		)
		select id from tree`);
	const ids = rows.map((r) => r.id).filter((d) => d !== id);
	if (ids.length === 0) return [];
	const revoked = await db
		.update(schema.apiKeys)
		.set({ revokedAt })
		.where(and(jsonIdsIn(schema.apiKeys.id, ids), isNull(schema.apiKeys.revokedAt)))
		.returning({ id: schema.apiKeys.id });
	return revoked.map((r) => r.id);
}

/**
 * その利用者のキーから（孫以降も含めて）他の利用者向けに発行したキーを失効する。
 * 本人のキーの失効は呼び出し側が決める（無効化では再有効化で戻すので残す）。#142
 */
export async function revokeKeysIssuedBy(db: Db, userId: string, revokedAt: Date): Promise<string[]> {
	const rows = await db.all<{ id: string }>(sql`
		with recursive tree(id) as (
			select id from api_keys where parent_key_id in (select id from api_keys where user_id = ${userId})
			union
			select k.id from api_keys k join tree t on k.parent_key_id = t.id
		)
		select id from tree`);
	const ids = rows.map((r) => r.id);
	if (ids.length === 0) return [];
	const revoked = await db
		.update(schema.apiKeys)
		.set({ revokedAt })
		.where(
			and(
				jsonIdsIn(schema.apiKeys.id, ids),
				ne(schema.apiKeys.userId, userId),
				isNull(schema.apiKeys.revokedAt),
			),
		)
		.returning({ id: schema.apiKeys.id });
	return revoked.map((r) => r.id);
}

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
		parentKeyId: row.parentKeyId ?? null,
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

export async function assertAddressesExist(db: Db, ids: string[]): Promise<void> {
	if (ids.length === 0) return;
	const found = await db
		.select({ id: schema.addresses.id })
		.from(schema.addresses)
		.where(jsonIdsIn(schema.addresses.id, ids));
	const known = new Set(found.map((r) => r.id));
	const missing = ids.filter((id) => !known.has(id));
	if (missing.length > 0) throw invalidRequest(`存在しないアドレスです: ${missing.join(", ")}`);
}

/** API キーから発行するときは、親キー自身の期限を超えられない（無期限の子キーで持続性を得る抜け道を防ぐ）。 */
export async function clampExpiresAt(
	db: Db,
	principal: Principal,
	requestedUnixSeconds: number | undefined,
): Promise<Date | null> {
	const requested = requestedUnixSeconds ? new Date(requestedUnixSeconds * 1000) : null;
	// 範囲の手前は zod の max で落ちるが、NaN のまま保存すると「無期限」として読まれるのでここでも落とす（#83）。
	if (requested && !Number.isFinite(requested.getTime())) throw invalidRequest("expiresAt が不正です");
	if (principal.via !== "api_key" || !principal.apiKeyId) return requested;

	const [parent] = await db
		.select({ expiresAt: schema.apiKeys.expiresAt })
		.from(schema.apiKeys)
		.where(eq(schema.apiKeys.id, principal.apiKeyId))
		.limit(1);
	const parentExpiresAt = parent?.expiresAt ?? null;
	if (!parentExpiresAt) return requested;
	if (!requested || requested.getTime() > parentExpiresAt.getTime()) return parentExpiresAt;
	return requested;
}

export default app;
