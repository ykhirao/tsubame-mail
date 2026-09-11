import { env } from "cloudflare:test";
import { Hono } from "hono";
import { getDb, schema } from "@/db/client";
import type { Db } from "@/db/client";
import { newId } from "@/lib/id";
import { hashPassword } from "@/lib/password";
import { generateApiKey } from "@/lib/tokens";
import { ApiError } from "@/shared/errors";
import authRoutes from "@/api/v1/auth";
import meRoutes from "@/api/v1/me";
import adminUserRoutes from "@/api/v1/admin/users";
import adminApiKeyRoutes from "@/api/v1/admin/api-keys";
import type { AppEnv } from "@/api/types";
import type { Role } from "@/shared/contracts/common";

export const testEnv = env as unknown as CloudflareEnv;

export function db(): Db {
	return getDb(testEnv);
}

/**
 * Hono の compose はハンドラの throw をその場で `app.onError` に回すので、
 * `app.use("*", errorHandler)` のミドルウェア形では ApiError を握れず全部 500 になる。
 * 組み立てを変えるときは onError の形を崩さないこと。
 */
export function buildTestApp() {
	const app = new Hono<AppEnv>();
	app.onError((err, c) => {
		if (err instanceof ApiError) return c.json(err.toJSON(), err.status as 400);
		console.error("unhandled error", err);
		return c.json({ error: { code: "internal", message: "内部エラーが発生しました" } }, 500);
	});
	app.use("*", async (c, next) => {
		c.set("db", getDb(c.env));
		c.set("requestId", "test");
		await next();
	});
	app.route("/api/v1/auth", authRoutes);
	app.route("/api/v1/me", meRoutes);
	app.route("/api/v1/admin/users", adminUserRoutes);
	app.route("/api/v1/admin/api-keys", adminApiKeyRoutes);
	return app;
}

export type TestApp = ReturnType<typeof buildTestApp>;

export function request(
	app: TestApp,
	path: string,
	init?: RequestInit & { cookie?: string; bearer?: string; env?: Partial<CloudflareEnv> },
) {
	const headers = new Headers(init?.headers);
	if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
	if (init?.cookie) headers.set("cookie", init.cookie);
	if (init?.bearer) headers.set("authorization", `Bearer ${init.bearer}`);
	// LOGIN_RATE_LIMIT は #52 で ip 単独の鍵も見るようになった。cf-connecting-ip を指定しない呼び出しが
	// 全部同じ "unknown" 扱いになると、無関係なテスト同士がバケットを取り合って 429 で落ちる。
	// 呼び出し側が明示的に ip を模したいとき（総当たりテストなど）だけ、ヘッダを渡して固定できる。
	if (!headers.has("cf-connecting-ip")) headers.set("cf-connecting-ip", crypto.randomUUID());
	const env = init?.env ? { ...testEnv, ...init.env } : testEnv;
	return app.request(path, { ...init, headers }, env);
}

export function json(body: unknown): RequestInit {
	return { method: "POST", body: JSON.stringify(body) };
}

export function sessionCookie(res: Response): string {
	const raw = res.headers.get("set-cookie") ?? "";
	const m = /__Host-tsb_session=([^;]+)/.exec(raw);
	if (!m) throw new Error(`set-cookie に __Host-tsb_session がない: ${raw}`);
	return `__Host-tsb_session=${m[1]}`;
}

export async function resetDb() {
	const d = db();
	await d.delete(schema.auditLogs);
	await d.delete(schema.sessions);
	await d.delete(schema.apiKeys);
	await d.delete(schema.addressGrants);
	await d.delete(schema.messages);
	await d.delete(schema.addresses);
	await d.delete(schema.domains);
	await d.delete(schema.users);
}

export async function createUser(opts: {
	role: Role;
	email?: string;
	name?: string;
	password?: string;
	status?: "active" | "disabled";
}) {
	const id = newId("user");
	const email = opts.email ?? `${id}@example.test`;
	await db()
		.insert(schema.users)
		.values({
			id,
			email,
			name: opts.name ?? "テスト",
			passwordHash: opts.password ? await hashPassword(opts.password, 1000) : null,
			role: opts.role,
			status: opts.status ?? "active",
		});
	return { id, email, role: opts.role };
}

export async function createDomain(name = `example-${crypto.randomUUID().slice(0, 8)}.test`) {
	const id = newId("domain");
	await db()
		.insert(schema.domains)
		.values({ id, name, zoneId: "zone", zoneName: name, mode: "subdomain" });
	return id;
}

export async function createAddress(domainId: string, localPart: string, domainName?: string) {
	const id = newId("address");
	// address は一意なので、ドメイン名を指定しないときは id で衝突を避ける。
	const domain = domainName ?? `${id}.test`;
	await db()
		.insert(schema.addresses)
		.values({ id, domainId, localPart, address: `${localPart}@${domain}`.toLowerCase() });
	return id;
}

export async function grant(userId: string, addressId: string, level: "read" | "write") {
	await db().insert(schema.addressGrants).values({ userId, addressId, level });
}

export async function createApiKeyFor(opts: {
	userId: string;
	scopes?: string[];
	addressIds?: string[] | null;
	expiresAt?: Date | null;
	revokedAt?: Date | null;
}) {
	const generated = await generateApiKey();
	const id = newId("apiKey");
	await db()
		.insert(schema.apiKeys)
		.values({
			id,
			userId: opts.userId,
			name: "テストキー",
			prefix: generated.prefix,
			keyHash: generated.hash,
			scopes: opts.scopes ?? ["read", "send", "admin"],
			addressIds: opts.addressIds ?? null,
			expiresAt: opts.expiresAt ?? null,
			revokedAt: opts.revokedAt ?? null,
		});
	return { id, token: generated.token };
}
