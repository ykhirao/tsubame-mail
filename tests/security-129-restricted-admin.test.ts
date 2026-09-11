import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { getDb } from "@/db/client";
import { webhookDeliveries } from "@/db/schema";
import { newId } from "@/lib/id";
import { createApp } from "@/api/app";
import { applyMigrations } from "./helpers/migrate";
import {
	createAddress,
	createApiKeyFor,
	createDomain,
	createUser,
} from "./auth-helpers";
import { createFakeCloudflare } from "./domains-helpers";

const app = createApp();

const testEnv = {
	...(env as unknown as Record<string, unknown>),
	CF_API_TOKEN: "test-token",
	CF_ACCOUNT_ID: "test-account",
	EMAIL_WORKER_NAME: "tsubame",
} as unknown as CloudflareEnv;

const PASSWORD = "correct-horse-1234";
const SESSION_RE = /__Host-tsb_session=([^;]+)/;

type Auth = { token?: string; cookie?: string };

function call(path: string, auth: Auth, init: { method?: string; body?: unknown } = {}) {
	const headers = new Headers();
	if (auth.token) headers.set("authorization", `Bearer ${auth.token}`);
	if (auth.cookie) headers.set("cookie", auth.cookie);
	if (init.body !== undefined) headers.set("content-type", "application/json");
	return app.request(
		path,
		{
			method: init.method ?? "GET",
			headers,
			body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
		},
		testEnv,
	);
}

async function ownerCookie(email: string): Promise<string> {
	const res = await app.request(
		"/api/v1/auth/login",
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				"cf-connecting-ip": crypto.randomUUID(),
			},
			body: JSON.stringify({ email, password: PASSWORD }),
		},
		testEnv,
	);
	const raw = res.headers.get("set-cookie") ?? "";
	const m = SESSION_RE.exec(raw);
	if (!m) throw new Error("ログイン Cookie が取得できません");
	return `__Host-tsb_session=${m[1]}`;
}

describe("#129 絞った admin キーは管理の変更系が 403", () => {
	let domainId: string;
	let addressId: string;
	let cookie: string;
	let restricted: string;
	let unrestricted: string;

	beforeEach(async () => {
		await applyMigrations();
		domainId = await createDomain();
		addressId = await createAddress(domainId, "box");
		const owner = await createUser({
			role: "owner",
			email: `owner-${crypto.randomUUID()}@example.test`,
			password: PASSWORD,
		});
		cookie = await ownerCookie(owner.email);
		restricted = (
			await createApiKeyFor({
				userId: owner.id,
				scopes: ["read", "send", "admin"],
				addressIds: [addressId],
			})
		).token;
		unrestricted = (
			await createApiKeyFor({ userId: owner.id, scopes: ["read", "send", "admin"] })
		).token;
		vi.stubGlobal("fetch", createFakeCloudflare().fetch);
	});

	it("webhook を addressIds 省略（null = 全アドレス）で作成すると 403", async () => {
		const body = { name: "届く", url: "https://example.com/h", events: ["message.received"], enabled: true };
		expect((await call("/api/v1/webhooks", { token: restricted }, { method: "POST", body })).status).toBe(403);
	});

	it("webhook をアドレス範囲内に絞って作っても、更新・削除・再送は 403", async () => {
		const body = {
			name: "h",
			url: "https://example.com/h",
			events: ["message.received"],
			addressIds: [addressId],
			enabled: true,
		};
		const created = (await (
			await call("/api/v1/webhooks", { token: unrestricted }, { method: "POST", body })
		).json()) as { id: string };

		expect((await call(`/api/v1/webhooks/${created.id}`, { token: restricted }, { method: "PATCH", body: { enabled: false } })).status).toBe(403);
		expect((await call(`/api/v1/webhooks/${created.id}`, { token: restricted }, { method: "DELETE" })).status).toBe(403);

		const deliveryId = newId("delivery");
		await getDb(env).insert(webhookDeliveries).values({
			id: deliveryId,
			webhookId: created.id,
			event: "message.received",
			status: "failed",
			httpStatus: 500,
			attempt: 1,
		});
		expect((await call(`/api/v1/webhooks/deliveries/${deliveryId}/retry`, { token: restricted }, { method: "POST" })).status).toBe(403);
	});

	it("ドメインスコープの forward ルール作成は 403", async () => {
		const body = {
			scope: "domain",
			domainId,
			name: "外へ転送",
			action: "forward",
			target: "ext@example.net",
			matcher: {},
		};
		expect((await call("/api/v1/admin/rules", { token: restricted }, { method: "POST", body })).status).toBe(403);
	});

	it("アドレス作成は 403", async () => {
		const body = { domainId, localPart: "newbox" };
		expect((await call("/api/v1/admin/addresses", { token: restricted }, { method: "POST", body })).status).toBe(403);
	});

	it("GET だけは絞ったキーでも 200", async () => {
		expect((await call("/api/v1/webhooks", { token: restricted })).status).toBe(200);
		expect((await call("/api/v1/admin/rules", { token: restricted })).status).toBe(200);
		expect((await call("/api/v1/admin/addresses", { token: restricted })).status).toBe(200);
		expect((await call("/api/v1/admin/domains", { token: restricted })).status).toBe(200);
	});

	it("読むだけの POST /admin/domains/preview は絞ったキーでも通る", async () => {
		const res = await call("/api/v1/admin/domains/preview", { token: restricted }, {
			method: "POST",
			body: { name: "mail.example.com", zoneId: "zone1" },
		});
		expect(res.status).toBe(200);
	});

	it("owner セッションと無制限キーなら webhook 作成・ルール作成・アドレス作成が通る", async () => {
		const webhookBody = { name: "h", url: "https://example.com/h", events: ["message.received"], enabled: true };
		expect((await call("/api/v1/webhooks", { token: unrestricted }, { method: "POST", body: webhookBody })).status).toBe(201);
		expect((await call("/api/v1/webhooks", { cookie }, { method: "POST", body: webhookBody })).status).toBe(201);

		const ruleBody = {
			scope: "domain",
			domainId,
			name: "外へ転送",
			action: "forward",
			target: "ext@example.net",
			matcher: {},
		};
		expect((await call("/api/v1/admin/rules", { token: unrestricted }, { method: "POST", body: ruleBody })).status).toBe(201);
		expect((await call("/api/v1/admin/rules", { cookie }, { method: "POST", body: ruleBody })).status).toBe(201);

		const addressBody = { domainId, localPart: "newbox" };
		expect((await call("/api/v1/admin/addresses", { token: unrestricted }, { method: "POST", body: addressBody })).status).toBe(201);
		expect((await call("/api/v1/admin/addresses", { cookie }, { method: "POST", body: { domainId, localPart: "newbox2" } })).status).toBe(201);
	});
});
