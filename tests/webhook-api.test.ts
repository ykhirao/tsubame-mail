import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { getDb } from "@/db/client";
import { webhooks, webhookDeliveries } from "@/db/schema";
import { webhookRoutes } from "@/api/v1/webhooks";
import { ApiError } from "@/shared/errors";
import { newId } from "@/lib/id";
import type { Principal } from "@/shared/contracts/common";
import type { AppEnv } from "@/api/types";
import { applyMigrations } from "./helpers/migrate";

const owner: Principal = {
	userId: "usr_owner",
	role: "owner",
	via: "session",
	scopes: [],
	addressIds: "all",
	writableAddressIds: "all",
};

function makeApp(principal: Principal) {
	const app = new Hono<AppEnv>();
	app.use("*", async (c, next) => {
		c.set("principal", principal);
		await next();
	});
	// エラーを { error: { code, message } } に揃える（app.ts の errorHandler 相当）。
	app.onError((err, c) => {
		if (err instanceof ApiError) return c.json(err.toJSON(), err.status as 400);
		console.error("unhandled error", err);
		return c.json({ error: { code: "internal", message: "内部エラーが発生しました" } }, 500);
	});
	app.route("/", webhookRoutes);
	return app;
}

function useCleanState() {
	afterEach(async () => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});
	beforeEach(async () => {
		await applyMigrations();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});
}

const validPayload = {
	name: "受信通知",
	url: "https://example.com/hooks/inbox",
	events: ["message.received", "message.sent"],
	enabled: true,
};

describe("webhook API（owner）", () => {
	useCleanState();

	it("作成時にのみ secret を平文で返し、一覧・詳細には含めない", async () => {
		const app = makeApp(owner);
		const res = await app.request("/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(validPayload),
		}, env);
		expect(res.status).toBe(201);
		const created = (await res.json()) as { id: string; secret: string };
		expect(created.secret).toBeTruthy();
		expect(created.id).toMatch(/^whk_/);

		const listRes = await app.request("/", {}, env);
		const list = (await listRes.json()) as Array<Record<string, unknown>>;
		expect(list).toHaveLength(1);
		expect(list[0]).not.toHaveProperty("secret");

		const detailRes = await app.request(`/${created.id}`, {}, env);
		const detail = (await detailRes.json()) as Record<string, unknown>;
		expect(detail).not.toHaveProperty("secret");
		expect(detail.id).toBe(created.id);
	});

	it("一覧の作成結果が保存されている", async () => {
		const app = makeApp(owner);
		await app.request("/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(validPayload),
		}, env);
		const listRes = await app.request("/", {}, env);
		const list = (await listRes.json()) as Array<Record<string, unknown>>;
		expect(list[0]).toMatchObject({
			name: "受信通知",
			url: "https://example.com/hooks/inbox",
			events: ["message.received", "message.sent"],
			enabled: true,
		});
	});

	it("更新・削除ができる", async () => {
		const app = makeApp(owner);
		const created = (await (
			await app.request("/", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(validPayload),
			}, env)
		).json()) as { id: string };

		const patchRes = await app.request(`/${created.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ enabled: false, name: "更新後" }),
		}, env);
		expect(patchRes.status).toBe(200);
		const patched = (await patchRes.json()) as { enabled: boolean; name: string };
		expect(patched.enabled).toBe(false);
		expect(patched.name).toBe("更新後");

		const delRes = await app.request(`/${created.id}`, { method: "DELETE" }, env);
		expect(delRes.status).toBe(204);

		const detailRes = await app.request(`/${created.id}`, {}, env);
		expect(detailRes.status).toBe(404);
	});

	it("不正なペイロードは 400 になる", async () => {
		const app = makeApp(owner);
		const res = await app.request("/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "", url: "not-a-url", events: [] }),
		}, env);
		expect(res.status).toBe(400);
	});
});

describe("webhook API（権限）", () => {
	useCleanState();

	it("admin スコープが無いと 403", async () => {
		const member: Principal = {
			userId: "usr_member",
			role: "member",
			via: "session",
			scopes: [],
			addressIds: [],
			writableAddressIds: [],
		};
		const app = makeApp(member);
		const res = await app.request("/", { method: "GET" }, env);
		expect(res.status).toBe(403);
	});
});

describe("配信履歴 API", () => {
	useCleanState();

	it("deliveries を新しい順・カーソルページングで返す", async () => {
		const db = getDb(env);
		const webhookId = newId("webhook");
		await db.insert(webhooks).values({
			id: webhookId,
			name: "h",
			url: "https://example.com/h",
			secret: "s",
			events: ["message.received"],
			addressIds: null,
		});
		const ids: string[] = [];
		for (let i = 0; i < 3; i++) {
			const id = newId("delivery");
			ids.push(id);
			await db.insert(webhookDeliveries).values({
				id,
				webhookId,
				event: "message.received",
				status: i === 0 ? "success" : "failed",
				httpStatus: i === 0 ? 200 : 500,
				attempt: 1,
				createdAt: new Date(1_700_000_000_000 + i * 1000),
			});
		}

		const app = makeApp(owner);
		const res = await app.request(`/${webhookId}/deliveries?limit=2`, {}, env);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			data: Array<{ id: string; status: string; httpStatus: number | null }>;
			next_cursor: string | null;
		};
		expect(body.data).toHaveLength(2);
		expect(body.next_cursor).toBeTruthy();
		expect(body.data[0]!.id).toBe(ids[2]);
		expect(body.data[1]!.id).toBe(ids[1]);

		const page2 = await app.request(
			`/${webhookId}/deliveries?limit=2&cursor=${body.next_cursor}`,
			{},
			env,
		);
		const body2 = (await page2.json()) as {
			data: Array<{ id: string }>;
			next_cursor: string | null;
		};
		expect(body2.data).toHaveLength(1);
		expect(body2.data[0]!.id).toBe(ids[0]);
		expect(body2.next_cursor).toBeNull();
	});

	it("手動再送は runDelivery を実行して状態を更新する", async () => {
		const db = getDb(env);
		const webhookId = newId("webhook");
		await db.insert(webhooks).values({
			id: webhookId,
			name: "h",
			url: "https://ok.example/h",
			secret: "s",
			events: ["message.received"],
			addressIds: null,
		});

		const deliveryId = newId("delivery");
		await db.insert(webhookDeliveries).values({
			id: deliveryId,
			webhookId,
			event: "message.received",
			status: "failed",
			httpStatus: 500,
			error: "HTTP 500",
			attempt: 3,
		});

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("ok", { status: 200 })),
		);

		const app = makeApp(owner);
		const res = await app.request(`/deliveries/${deliveryId}/retry`, {
			method: "POST",
		}, env);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { status: string; httpStatus: number; attempt: number };
		expect(body.status).toBe("success");
		expect(body.httpStatus).toBe(200);
		expect(body.attempt).toBe(3);
	});
});
