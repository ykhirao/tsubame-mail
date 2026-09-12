import { Hono } from "hono";
import type { Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import type { CookieOptions } from "hono/utils/cookie";
import { eq, sql } from "drizzle-orm";
import { schema } from "@/db/client";
import type { Db } from "@/db/client";
import { newId } from "@/lib/id";
import { DUMMY_PASSWORD_HASH, hashPassword, needsRehash, verifyPassword } from "@/lib/password";
import {
	generateSessionToken,
	hashToken,
	LEGACY_SESSION_COOKIE,
	SESSION_COOKIE,
	SESSION_TTL_SECONDS,
	secretEquals,
} from "@/lib/tokens";
import { readJson, unixSeconds } from "@/lib/validate";
import { recordAudit } from "@/domain/access/policy";
import { bootstrapBody, loginBody } from "@/shared/contracts/auth";
import { ApiError, conflict, unauthorized } from "@/shared/errors";
import { clientIp, getPrincipal, requireAuth, sessionToken } from "../middleware/auth";
import type { AppEnv } from "../types";

const app = new Hono<AppEnv>();

/** Cookie の属性はここ 1 か所で決める。発行と失効で食い違わせない。 */
function sessionCookieOptions(maxAge?: number): CookieOptions {
	return {
		httpOnly: true,
		secure: true,
		sameSite: "Lax",
		path: "/",
		...(maxAge === undefined ? {} : { maxAge }),
	};
}

// login / logout / bootstrap で旧名 tsb_session も消す。新名は __Host- 接頭辞でサブドメインからは書けないが、
// 名前変更前に残った値はここで確実に落とす（#84）。
function clearLegacyCookie(c: Context<AppEnv>): void {
	deleteCookie(c, LEGACY_SESSION_COOKIE, sessionCookieOptions());
}

/** メールアドレスの存在を漏らさないための一律のメッセージ。 */
const loginFailed = () => unauthorized("メールアドレスまたはパスワードが違います");

/**
 * `ip:email` の組だけだと、1 IP から N メール（列挙）にも N IP から 1 メール（分散総当たり）にも
 * 上限が無い。同じ回数窓を ip 単独・email 単独でも消費させ、どちらの形の攻撃も頭打ちにする。
 */
async function checkRateLimit(limiter: RateLimit | undefined, keys: string[]): Promise<void> {
	if (!limiter) return;
	for (const key of keys) {
		const { success } = await limiter.limit({ key });
		if (!success) {
			throw new ApiError("rate_limited", "試行が多すぎます。しばらく待ってからやり直してください");
		}
	}
}

async function createSession(
	db: Db,
	userId: string,
	userAgent: string | null,
	ip: string | null,
): Promise<{ token: string; expiresAt: Date }> {
	const token = generateSessionToken();
	const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
	await db.insert(schema.sessions).values({
		id: newId("session"),
		userId,
		tokenHash: await hashToken(token),
		expiresAt,
		userAgent,
		ip,
	});
	return { token, expiresAt };
}

// ログインに使えるのはプライマリアドレスと確認済みの外部アドレス。プライマリの無い利用者（ドメインを繋ぐ前の
// 最初の owner）だけは、確認前の外部アドレスでも入れる（FR-4）。
async function findLoginUser(db: Db, identifier: string) {
	const [byExternal] = await db
		.select()
		.from(schema.users)
		.where(eq(schema.users.externalEmail, identifier))
		.limit(1);
	if (
		byExternal &&
		(byExternal.externalVerifiedAt || (byExternal.role === "owner" && !byExternal.primaryAddressId))
	) {
		return byExternal;
	}
	const [byPrimary] = await db
		.select({ user: schema.users })
		.from(schema.users)
		.innerJoin(schema.addresses, eq(schema.addresses.id, schema.users.primaryAddressId))
		.where(eq(schema.addresses.address, identifier))
		.limit(1);
	return byPrimary?.user;
}

app.post("/login", async (c) => {
	const body = await readJson(c.req, loginBody);
	const email = body.email.trim().toLowerCase();
	const ip = clientIp(c);

	// 「IP + メールアドレス」の組に加え、IP 単独・メール単独でも同じ回数窓を消費させる。
	// 組だけだと 1 IP から多数のメールを試す列挙にも、多数の IP から 1 メールを試す分散総当たりにも
	// 上限が無いため。
	await checkRateLimit(c.env.LOGIN_RATE_LIMIT, [
		`login:${ip ?? "unknown"}:${email}`,
		`login:ip:${ip ?? "unknown"}`,
		`login:email:${email}`,
	]);

	const db = c.get("db");
	const user = await findLoginUser(db, email);

	// 「居ない」「無効」「agent（パスワード無し）」「パスワード不一致」は全部同じ応答にする。
	// 応答時間も揃えるため、user が居ない／passwordHash が無いときも同じ形のダミーハッシュに対して
	// verifyPassword を必ず走らせる（早期 return すると PBKDF2 1 回分の時間差でメールの存在が漏れる）。
	const ok = await verifyPassword(body.password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
	if (!user || !ok || user.status !== "active") throw loginFailed();

	// 反復回数を上げたあとの初回ログインで静かに貼り替える。
	if (needsRehash(user.passwordHash)) {
		await db
			.update(schema.users)
			.set({ passwordHash: await hashPassword(body.password) })
			.where(eq(schema.users.id, user.id));
	}

	const { token, expiresAt } = await createSession(
		db,
		user.id,
		c.req.header("user-agent") ?? null,
		ip,
	);
	await db.update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, user.id));

	setCookie(c, SESSION_COOKIE, token, sessionCookieOptions(SESSION_TTL_SECONDS));
	clearLegacyCookie(c);

	return c.json({
		userId: user.id,
		email: user.externalEmail,
		name: user.name,
		role: user.role,
		expiresAt: unixSeconds(expiresAt),
	});
});

app.post("/logout", async (c) => {
	const token = sessionToken(c);
	if (token) {
		const db = c.get("db");
		const tokenHash = await hashToken(token);
		// ログアウトした端末に通知が届き続けないよう、その端末の購読も消す。
		const session = await db
			.select({ id: schema.sessions.id })
			.from(schema.sessions)
			.where(eq(schema.sessions.tokenHash, tokenHash))
			.get();
		if (session) {
			await db.delete(schema.pushDevices).where(eq(schema.pushDevices.sessionId, session.id));
		}
		await db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, tokenHash));
	}
	deleteCookie(c, SESSION_COOKIE, sessionCookieOptions());
	clearLegacyCookie(c);
	return c.json({ ok: true });
});

app.get("/session", requireAuth, async (c) => {
	const principal = getPrincipal(c);
	const db = c.get("db");
	const [user] = await db
		.select({ id: schema.users.id, email: schema.users.externalEmail, name: schema.users.name })
		.from(schema.users)
		.where(eq(schema.users.id, principal.userId))
		.limit(1);
	if (!user) throw unauthorized();

	return c.json({
		userId: user.id,
		email: user.email,
		name: user.name,
		role: principal.role,
		via: principal.via,
		scopes: principal.scopes,
	});
});

app.get("/setup-state", async (c) => {
	const db = c.get("db");
	const [owners] = await db
		.select({ count: sql<number>`count(*)` })
		.from(schema.users)
		.where(eq(schema.users.role, "owner"));
	return c.json({ needsSetup: Number(owners?.count ?? 0) === 0 });
});

/**
 * テスト・ローカル用に配布している既知の値。運用者がそのまま `wrangler secret put` すると、
 * 誰でも知っている合言葉でオーナーを取れてしまう（vitest.config.ts / scripts/seed-local.mjs）。
 */
const KNOWN_DEV_SECRETS = new Set([
	"test-internal-secret-0123456789",
	"local-dev-internal-secret-0123456789",
]);

app.post("/bootstrap", async (c) => {
	const body = await readJson(c.req, bootstrapBody);
	const db = c.get("db");
	const ip = clientIp(c);

	// オーナーが 1 人も居ない窓（デプロイ直後〜初回セットアップ）は認証前なので、
	// ログインと同じ IP 単位のレート制限を掛ける。
	await checkRateLimit(c.env.LOGIN_RATE_LIMIT, [`bootstrap:ip:${ip ?? "unknown"}`]);

	const [owners] = await db
		.select({ count: sql<number>`count(*)` })
		.from(schema.users)
		.where(eq(schema.users.role, "owner"));
	if (Number(owners?.count ?? 0) > 0) {
		throw conflict("すでにオーナーが存在します。オーナーにユーザー作成を依頼してください");
	}

	// オーナーは Cloudflare の DNS とメールルーティングまで触れる。
	// デプロイ直後に URL を見つけただけの相手に取られないよう、
	// デプロイできる人だけが知っている合言葉を一致条件にする。
	//
	// メールで使い捨てのパスワードを送る案は使えない。この時点ではまだ
	// 送信ドメインを 1 つも繋いでいないので、アプリからメールを出せないため。
	const secret = c.env.INTERNAL_SECRET ?? "";
	if (secret.length < 20) {
		throw new ApiError(
			"forbidden",
			"INTERNAL_SECRET が未設定か短すぎます（20 文字以上）。Worker のシークレットに設定してください",
		);
	}
	if (KNOWN_DEV_SECRETS.has(secret)) {
		throw new ApiError(
			"forbidden",
			"INTERNAL_SECRET にテスト・ローカル用の既知の値が設定されています。本番用の乱数に変えてください",
		);
	}
	if (!secretEquals(body.secret, secret)) {
		throw new ApiError("forbidden", "セットアップの合言葉が違います");
	}

	const userId = newId("user");
	const email = body.email.trim().toLowerCase();
	await db.insert(schema.users).values({
		id: userId,
		email,
		externalEmail: email,
		name: body.name,
		passwordHash: await hashPassword(body.password),
		role: "owner",
		status: "active",
	});

	await recordAudit(db, {
		actorId: userId,
		action: "auth.bootstrap",
		targetType: "user",
		targetId: userId,
		meta: { email },
		ip,
	});

	const { token, expiresAt } = await createSession(
		db,
		userId,
		c.req.header("user-agent") ?? null,
		ip,
	);
	setCookie(c, SESSION_COOKIE, token, sessionCookieOptions(SESSION_TTL_SECONDS));
	clearLegacyCookie(c);

	return c.json(
		{ userId, email, name: body.name, role: "owner", expiresAt: unixSeconds(expiresAt) },
		201,
	);
});

export default app;
