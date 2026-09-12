import { eq } from "drizzle-orm";
import { getCookie } from "hono/cookie";
import type { MiddlewareHandler } from "hono";
import type { Context } from "hono";
import { getDb, schema } from "@/db/client";
import type { Db } from "@/db/client";
import { hashToken, looksLikeApiKey, parseBearer, SESSION_COOKIE } from "@/lib/tokens";
import { requireOwner as assertOwner, resolvePrincipal } from "@/domain/access/policy";
import type { Principal } from "@/shared/contracts/common";
import { forbidden, unauthorized } from "@/shared/errors";
import type { AppEnv } from "../types";

/** last_used_at の更新間隔。毎リクエスト書くと D1 が重いので間引く。 */
const LAST_USED_GRANULARITY_MS = 60_000;

type Ctx = Context<AppEnv>;

function db(c: Ctx): Db {
	// app.ts が必ず入れているが、単体で使われても動くようにフォールバックする。
	return c.get("db") ?? getDb(c.env);
}

function clientIp(c: Ctx): string | null {
	return c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for") ?? null;
}

// hono の Cookie パーサは同名 Cookie の先頭勝ちなので、セッション固定（#84）の重複を見抜けない。
// 生の Cookie ヘッダを数え、同名のセッション Cookie が 2 つ以上あれば 401 にする。
export function sessionToken(c: Ctx): string | null {
	const raw = c.req.header("cookie") ?? "";
	const prefix = `${SESSION_COOKIE}=`;
	let count = 0;
	for (const part of raw.split(";")) {
		if (part.trim().startsWith(prefix)) count++;
	}
	if (count > 1) throw unauthorized();
	return getCookie(c, SESSION_COOKIE) ?? null;
}

/** 「無効なキー」と「キーが無い」を呼ぶ側で区別できるよう、例外は投げず null を返す。 */
export async function resolveRequestPrincipal(c: Ctx): Promise<Principal | null> {
	const bearer = parseBearer(c.req.header("authorization"));
	if (bearer) {
		return looksLikeApiKey(bearer) ? await principalFromApiKey(c, bearer) : null;
	}

	const cookie = sessionToken(c);
	if (cookie) return await principalFromSession(c, cookie);

	return null;
}

async function principalFromApiKey(c: Ctx, token: string): Promise<Principal | null> {
	const conn = db(c);
	const keyHash = await hashToken(token);

	const [key] = await conn
		.select()
		.from(schema.apiKeys)
		.where(eq(schema.apiKeys.keyHash, keyHash))
		.limit(1);
	if (!key) return null;

	const now = Date.now();
	if (key.revokedAt && key.revokedAt.getTime() <= now) return null;
	if (key.expiresAt && key.expiresAt.getTime() <= now) return null;

	const user = await loadActiveUser(conn, key.userId);
	if (!user) return null;

	await touchLastUsed(c, conn, key.id, key.lastUsedAt, now);

	return await resolvePrincipal(conn, {
		user: { id: user.id, role: user.role },
		apiKey: { id: key.id, scopes: key.scopes ?? [], addressIds: key.addressIds ?? null },
	});
}

async function principalFromSession(c: Ctx, token: string): Promise<Principal | null> {
	const conn = db(c);
	const tokenHash = await hashToken(token);

	const [session] = await conn
		.select()
		.from(schema.sessions)
		.where(eq(schema.sessions.tokenHash, tokenHash))
		.limit(1);
	if (!session) return null;

	if (session.expiresAt.getTime() <= Date.now()) {
		// 期限切れは掃除しておく。紐づくプッシュ端末も一緒に消し、
		// セッションが無いのに通知が届き続けないようにする（#130）。失敗しても認証結果は変わらない。
		// 先に端末を消す（セッションを消すと FK set-null が先に走って sessionId が空になる）。
		try {
			await conn.delete(schema.pushDevices).where(eq(schema.pushDevices.sessionId, session.id));
			await conn.delete(schema.sessions).where(eq(schema.sessions.id, session.id));
		} catch {}
		return null;
	}

	const user = await loadActiveUser(conn, session.userId);
	if (!user) return null;

	return await resolvePrincipal(conn, { user: { id: user.id, role: user.role }, sessionId: session.id });
}

async function loadActiveUser(conn: Db, userId: string) {
	const [user] = await conn
		.select({ id: schema.users.id, role: schema.users.role, status: schema.users.status })
		.from(schema.users)
		.where(eq(schema.users.id, userId))
		.limit(1);
	if (!user || user.status !== "active") return null;
	return user;
}

async function touchLastUsed(
	c: Ctx,
	conn: Db,
	keyId: string,
	lastUsedAt: Date | null,
	now: number,
): Promise<void> {
	if (lastUsedAt && now - lastUsedAt.getTime() < LAST_USED_GRANULARITY_MS) return;

	const write = conn
		.update(schema.apiKeys)
		.set({ lastUsedAt: new Date(now) })
		.where(eq(schema.apiKeys.id, keyId))
		.then(() => undefined)
		.catch((err: unknown) => {
			console.error("last_used_at の更新に失敗", err);
		});

	try {
		c.executionCtx.waitUntil(write);
	} catch {
		await write;
	}
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
	const principal = await resolveRequestPrincipal(c);
	if (!principal) throw unauthorized();
	c.set("principal", principal);
	await next();
};

export const optionalAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
	const principal = await resolveRequestPrincipal(c);
	if (principal) c.set("principal", principal);
	await next();
};

export const requireOwner: MiddlewareHandler<AppEnv> = async (c, next) => {
	let principal = c.get("principal");
	if (!principal) {
		const resolved = await resolveRequestPrincipal(c);
		if (!resolved) throw unauthorized();
		principal = resolved;
		c.set("principal", principal);
	}
	assertOwner(principal);
	await next();
};

// パスワードやロールは API キーの期限・範囲では縛れない資格情報なので、
// ユーザー管理の変更系は画面ログインの Cookie セッションだけに許す（#121）。
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
	let principal = c.get("principal");
	if (!principal) {
		const resolved = await resolveRequestPrincipal(c);
		if (!resolved) throw unauthorized();
		principal = resolved;
		c.set("principal", principal);
	}
	if (principal.via !== "session") throw forbidden("ユーザー管理は画面からログインして行ってください");
	await next();
};

// 範囲を絞った admin キーは、キーより広い範囲（相手先ドメイン全体・全アドレス）を
// 操作できてしまうので、管理者の変更はセッションか addressIds 全開放のキーに限る（#129）。
export const requireUnrestricted: MiddlewareHandler<AppEnv> = async (c, next) => {
	let principal = c.get("principal");
	if (!principal) {
		const resolved = await resolveRequestPrincipal(c);
		if (!resolved) throw unauthorized();
		principal = resolved;
		c.set("principal", principal);
	}
	if (principal.via === "api_key" && principal.addressIds !== "all") {
		throw forbidden("範囲を絞った API キーでは管理の変更はできません");
	}
	await next();
};

export function getPrincipal(c: Ctx): Principal {
	const principal = c.get("principal");
	if (!principal) throw unauthorized();
	return principal;
}

export { clientIp };
