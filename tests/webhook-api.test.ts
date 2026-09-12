import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { addresses, auditLogs, domains, webhooks, webhookDeliveries } from "@/db/schema";
import { createApp } from "@/api/app";
import { webhookRoutes } from "@/api/v1/webhooks";
import { runDelivery } from "@/services/webhooks";
import { rulesRouter } from "@/api/v1/admin/rules";
import { webhookUrlProblem } from "@/shared/contracts/webhooks";
import { ApiError } from "@/shared/errors";
import { newId } from "@/lib/id";
import type { Principal } from "@/shared/contracts/common";
import type { AppEnv } from "@/api/types";
import { applyMigrations } from "./helpers/migrate";
import { createApiKeyFor, createUser } from "./auth-helpers";

const app = createApp();

function call(path: string, token: string | null, init: { method?: string; body?: unknown } = {}) {
	const headers = new Headers();
	if (token) headers.set("authorization", `Bearer ${token}`);
	if (init.body !== undefined) headers.set("content-type", "application/json");
	return app.request(
		path,
		{
			method: init.method ?? "GET",
			headers,
			body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
		},
		env,
	);
}

async function ownerToken(): Promise<string> {
	const owner = await createUser({ role: "owner" });
	return (await createApiKeyFor({ userId: owner.id, scopes: ["read", "send", "admin"] })).token;
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

type Page<T> = { data: T[]; next_cursor: string | null };

describe("webhook API（owner）", () => {
	useCleanState();

	it("作成時にのみ secret を平文で返し、一覧・詳細には含めない", async () => {
		const token = await ownerToken();
		const res = await call("/api/v1/webhooks", token, { method: "POST", body: validPayload });
		expect(res.status).toBe(201);
		const created = (await res.json()) as { id: string; secret: string };
		expect(created.secret).toBeTruthy();
		expect(created.id).toMatch(/^whk_/);

		const list = (await (await call("/api/v1/webhooks", token)).json()) as Page<Record<string, unknown>>;
		expect(list.data).toHaveLength(1);
		expect(list.data[0]).not.toHaveProperty("secret");
		expect(list.next_cursor).toBeNull();

		const detail = (await (await call(`/api/v1/webhooks/${created.id}`, token)).json()) as Record<
			string,
			unknown
		>;
		expect(detail).not.toHaveProperty("secret");
		expect(detail.id).toBe(created.id);
	});

	it("一覧の作成結果が保存されている", async () => {
		const token = await ownerToken();
		await call("/api/v1/webhooks", token, { method: "POST", body: validPayload });
		const list = (await (await call("/api/v1/webhooks", token)).json()) as Page<Record<string, unknown>>;
		expect(list.data[0]).toMatchObject({
			name: "受信通知",
			url: "https://example.com/hooks/inbox",
			events: ["message.received", "message.sent"],
			enabled: true,
		});
	});

	it("更新・削除ができる", async () => {
		const token = await ownerToken();
		const created = (await (
			await call("/api/v1/webhooks", token, { method: "POST", body: validPayload })
		).json()) as { id: string };

		const patchRes = await call(`/api/v1/webhooks/${created.id}`, token, {
			method: "PATCH",
			body: { enabled: false, name: "更新後" },
		});
		expect(patchRes.status).toBe(200);
		const patched = (await patchRes.json()) as { enabled: boolean; name: string };
		expect(patched.enabled).toBe(false);
		expect(patched.name).toBe("更新後");

		expect((await call(`/api/v1/webhooks/${created.id}`, token, { method: "DELETE" })).status).toBe(204);
		expect((await call(`/api/v1/webhooks/${created.id}`, token)).status).toBe(404);
	});

	it("不正なペイロードは 400 になる", async () => {
		const token = await ownerToken();
		const res = await call("/api/v1/webhooks", token, {
			method: "POST",
			body: { name: "", url: "not-a-url", events: [] },
		});
		expect(res.status).toBe(400);
	});

	it("一覧は limit と cursor でページングする（同じ秒に作られた行も落とさない）", async () => {
		const token = await ownerToken();
		const ids: string[] = [];
		for (let i = 0; i < 3; i++) {
			const res = await call("/api/v1/webhooks", token, {
				method: "POST",
				body: { ...validPayload, name: `hook-${i}` },
			});
			ids.push(((await res.json()) as { id: string }).id);
		}

		const first = (await (await call("/api/v1/webhooks?limit=2", token)).json()) as Page<{ id: string }>;
		expect(first.data).toHaveLength(2);
		expect(first.next_cursor).toBeTruthy();

		const second = (await (
			await call(`/api/v1/webhooks?limit=2&cursor=${first.next_cursor}`, token)
		).json()) as Page<{ id: string }>;
		expect(second.data).toHaveLength(1);
		expect(second.next_cursor).toBeNull();

		expect([...first.data, ...second.data].map((w) => w.id).sort()).toEqual([...ids].sort());
	});

	it("壊れた cursor と上限超えの limit は 400", async () => {
		const token = await ownerToken();
		expect((await call("/api/v1/webhooks?cursor=%%%", token)).status).toBe(400);
		expect((await call("/api/v1/webhooks?limit=1000", token)).status).toBe(400);
	});
});

describe("webhook の URL 検査（#12 SSRF）", () => {
	useCleanState();

	const rejected = [
		"http://hooks.example.com/h",
		"https://127.0.0.1/h",
		"https://0x7f000001/h",
		"https://2130706433/h",
		"https://10.1.2.3/h",
		"https://172.16.0.1/h",
		"https://192.168.1.1/h",
		"https://169.254.169.254/latest/meta-data",
		"https://100.64.0.1/h",
		"https://0.0.0.0/h",
		"https://[::1]/h",
		"https://[::ffff:127.0.0.1]/h",
		"https://[::ffff:8.8.8.8]/h",
		"https://[fe80::1]/h",
		"https://[fd00::1]/h",
		"https://[64:ff9b::a00:1]/h",
		"https://localhost/h",
		"https://api.localhost/h",
		"https://printer.local/h",
		"https://metadata.google.internal/h",
		"https://intranet/h",
	];

	it.each(rejected)("%s は登録できない", async (url) => {
		expect(webhookUrlProblem(url)).not.toBeNull();
		const token = await ownerToken();
		const res = await call("/api/v1/webhooks", token, { method: "POST", body: { ...validPayload, url } });
		expect(res.status).toBe(400);
	});

	it.each(["https://hooks.example.com/tsubame", "https://8.8.8.8/h", "https://[2606:4700::1111]/h"])(
		"%s は登録できる",
		(url) => {
			expect(webhookUrlProblem(url)).toBeNull();
		},
	);

	it("更新で内部向けの URL に書き換えることもできない", async () => {
		const token = await ownerToken();
		const created = (await (
			await call("/api/v1/webhooks", token, { method: "POST", body: validPayload })
		).json()) as { id: string };
		const res = await call(`/api/v1/webhooks/${created.id}`, token, {
			method: "PATCH",
			body: { url: "https://127.0.0.1/h" },
		});
		expect(res.status).toBe(400);
	});
});

describe("webhook の addressIds / events の検査（#44）", () => {
	useCleanState();

	async function seedAddress(id: string): Promise<void> {
		const db = getDb(env);
		const domainId = `dom_${id}`;
		await db.insert(domains).values({
			id: domainId,
			name: `${id}.ex.com`,
			zoneId: "zone_1",
			zoneName: `${id}.ex.com`,
			mode: "subdomain",
		});
		await db.insert(addresses).values({ id, domainId, localPart: id, address: `${id}@${id}.ex.com` });
	}

	it("存在しない addressId は 400", async () => {
		const token = await ownerToken();
		const res = await call("/api/v1/webhooks", token, {
			method: "POST",
			body: { ...validPayload, addressIds: ["adr_no_such_id"] },
		});
		expect(res.status).toBe(400);
	});

	it("実在する addressId なら作成できる", async () => {
		await seedAddress("adr_ok");
		const token = await ownerToken();
		const res = await call("/api/v1/webhooks", token, {
			method: "POST",
			body: { ...validPayload, addressIds: ["adr_ok"] },
		});
		expect(res.status).toBe(201);
	});

	it("addressIds は重複を除いて保存する", async () => {
		await seedAddress("adr_dup");
		const token = await ownerToken();
		const res = await call("/api/v1/webhooks", token, {
			method: "POST",
			body: { ...validPayload, addressIds: ["adr_dup", "adr_dup", "adr_dup"] },
		});
		expect(res.status).toBe(201);
		const created = (await res.json()) as { addressIds: string[] };
		expect(created.addressIds).toEqual(["adr_dup"]);
	});

	it("addressIds が 100 件を超えると 400", async () => {
		const token = await ownerToken();
		const res = await call("/api/v1/webhooks", token, {
			method: "POST",
			body: { ...validPayload, addressIds: Array.from({ length: 101 }, (_, i) => `adr_${i}`) },
		});
		expect(res.status).toBe(400);
	});

	it("events は重複を除いて保存する", async () => {
		const token = await ownerToken();
		const res = await call("/api/v1/webhooks", token, {
			method: "POST",
			body: { ...validPayload, events: ["message.received", "message.received", "message.sent"] },
		});
		expect(res.status).toBe(201);
		const created = (await res.json()) as { events: string[] };
		expect(created.events.sort()).toEqual(["message.received", "message.sent"]);
	});

	it("PATCH でも存在しない addressId は 400 で、既存の値を変えない", async () => {
		await seedAddress("adr_patch_ok");
		const token = await ownerToken();
		const created = (await (
			await call("/api/v1/webhooks", token, {
				method: "POST",
				body: { ...validPayload, addressIds: ["adr_patch_ok"] },
			})
		).json()) as { id: string };

		const res = await call(`/api/v1/webhooks/${created.id}`, token, {
			method: "PATCH",
			body: { addressIds: ["adr_no_such_id"] },
		});
		expect(res.status).toBe(400);

		const after = (await (await call(`/api/v1/webhooks/${created.id}`, token)).json()) as {
			addressIds: string[];
		};
		expect(after.addressIds).toEqual(["adr_patch_ok"]);
	});

	it("絞った admin キーは addressIds を指定した webhook 作成も 403（#129）", async () => {
		await seedAddress("adr_visible");
		await seedAddress("adr_hidden");
		const scopedPrincipal: Principal = {
			userId: "usr_member",
			role: "owner",
			via: "api_key",
			scopes: ["read", "send", "admin"],
			addressIds: ["adr_visible"],
			writableAddressIds: ["adr_visible"],
		};
		const bare = new Hono<AppEnv>();
		bare.onError((err, c) =>
			err instanceof ApiError ? c.json(err.toJSON(), err.status as 400) : c.text("boom", 500),
		);
		bare.use("*", async (c, next) => {
			c.set("db", getDb(c.env));
			c.set("principal", scopedPrincipal);
			await next();
		});
		bare.route("/", webhookRoutes);

		const res = await bare.request(
			"/",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ ...validPayload, addressIds: ["adr_hidden"] }),
			},
			env,
		);
		expect(res.status).toBe(403);
	});
});

describe("管理系の門は owner ロール かつ admin スコープ（#13）", () => {
	useCleanState();

	const gated = ["/api/v1/webhooks", "/api/v1/admin/rules"];

	it.each(gated)("%s: owner でも admin スコープの無いキーは 403", async (path) => {
		const owner = await createUser({ role: "owner" });
		const { token } = await createApiKeyFor({ userId: owner.id, scopes: ["read", "send"] });
		expect((await call(path, token)).status).toBe(403);
	});

	it.each(gated)("%s: admin スコープ付きでも member は 403", async (path) => {
		const member = await createUser({ role: "member" });
		const { token } = await createApiKeyFor({ userId: member.id, scopes: ["read", "send", "admin"] });
		expect((await call(path, token)).status).toBe(403);
	});

	it.each(gated)("%s: owner + admin スコープなら通る", async (path) => {
		expect((await call(path, await ownerToken())).status).toBe(200);
	});

	it.each(gated)("%s: 未認証は 401", async (path) => {
		expect((await call(path, null)).status).toBe(401);
	});

	// app.ts の requireOwner を外しても穴にならないことを、ルータ単体で確かめる。
	it.each([
		["webhooks", webhookRoutes],
		["rules", rulesRouter],
	] as const)("%s のルータ単体でも、admin スコープの無い owner は 403", async (_name, router) => {
		const ownerWithoutAdmin: Principal = {
			userId: "usr_owner",
			role: "owner",
			via: "api_key",
			scopes: ["read", "send"],
			addressIds: "all",
			writableAddressIds: "all",
		};
		const bare = new Hono<AppEnv>();
		bare.onError((err, c) =>
			err instanceof ApiError ? c.json(err.toJSON(), err.status as 400) : c.text("boom", 500),
		);
		bare.use("*", async (c, next) => {
			c.set("db", getDb(c.env));
			c.set("principal", ownerWithoutAdmin);
			await next();
		});
		bare.route("/", router);
		expect((await bare.request("/", {}, env)).status).toBe(403);
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

		const token = await ownerToken();
		const res = await call(`/api/v1/webhooks/${webhookId}/deliveries?limit=2`, token);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Page<{ id: string; status: string; httpStatus: number | null }>;
		expect(body.data).toHaveLength(2);
		expect(body.next_cursor).toBeTruthy();
		expect(body.data[0]!.id).toBe(ids[2]);
		expect(body.data[1]!.id).toBe(ids[1]);

		const body2 = (await (
			await call(`/api/v1/webhooks/${webhookId}/deliveries?limit=2&cursor=${body.next_cursor}`, token)
		).json()) as Page<{ id: string }>;
		expect(body2.data).toHaveLength(1);
		expect(body2.data[0]!.id).toBe(ids[0]);
		expect(body2.next_cursor).toBeNull();
	});

	it("同一秒に作られた行も limit をまたいで欠落しない（#32）", async () => {
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
		const sameSecond = new Date(1_700_000_000_000);
		const ids: string[] = [];
		for (let i = 0; i < 3; i++) {
			const id = newId("delivery");
			ids.push(id);
			await db.insert(webhookDeliveries).values({
				id,
				webhookId,
				event: "message.received",
				status: "failed",
				httpStatus: 500,
				attempt: 1,
				createdAt: sameSecond,
			});
		}

		const token = await ownerToken();
		const seen: string[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < 3; page++) {
			const url = `/api/v1/webhooks/${webhookId}/deliveries?limit=2${cursor ? `&cursor=${cursor}` : ""}`;
			const body = (await (await call(url, token)).json()) as Page<{ id: string }>;
			seen.push(...body.data.map((d) => d.id));
			cursor = body.next_cursor ?? undefined;
			if (!body.next_cursor) break;
		}
		expect(seen.length).toBe(3);
		expect(new Set(seen).size).toBe(3);
		expect(seen.sort()).toEqual([...ids].sort());
	});

	it("壊れた cursor は 400", async () => {
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
		const token = await ownerToken();
		expect(
			(await call(`/api/v1/webhooks/${webhookId}/deliveries?cursor=%%%`, token)).status,
		).toBe(400);
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

		const token = await ownerToken();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("ok", { status: 200 })),
		);

		const res = await call(`/api/v1/webhooks/deliveries/${deliveryId}/retry`, token, { method: "POST" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { status: string; httpStatus: number; attempt: number };
		expect(body.status).toBe("success");
		expect(body.httpStatus).toBe(200);
		// claim に合わせて attempt を 1 繰り上げて再送する（#69）。
		expect(body.attempt).toBe(4);
	});

	// #42: 手動再送が status を見ずに実行すると、success を再送して受け手に二重に届いたり、
	// pending を再送してチェーンが並走したりする。failed 以外は 409 で止める。
	it.each(["success", "pending"] as const)(
		"status が %s の配信は再送すると 409 になり fetch も呼ばれない",
		async (status) => {
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
				status,
				httpStatus: status === "success" ? 200 : null,
				attempt: 1,
			});

			const token = await ownerToken();
			const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
			vi.stubGlobal("fetch", fetchMock);

			const res = await call(`/api/v1/webhooks/deliveries/${deliveryId}/retry`, token, { method: "POST" });
			expect(res.status).toBe(409);
			expect(fetchMock).not.toHaveBeenCalled();

			const after = await db
				.select()
				.from(webhookDeliveries)
				.where(eq(webhookDeliveries.id, deliveryId))
				.get();
			expect(after!.status).toBe(status);
		},
	);
});

describe("手動再送の claim（#69）", () => {
	useCleanState();

	async function seedFailedDelivery(opts: { attempt?: number; enabled?: boolean } = {}) {
		const db = getDb(env);
		const webhookId = newId("webhook");
		await db.insert(webhooks).values({
			id: webhookId,
			name: "h",
			url: "https://ok.example/hook",
			secret: "s",
			events: ["message.received"],
			addressIds: null,
			enabled: opts.enabled ?? true,
		});
		const deliveryId = newId("delivery");
		await db.insert(webhookDeliveries).values({
			id: deliveryId,
			webhookId,
			event: "message.received",
			status: "failed",
			httpStatus: 500,
			error: "HTTP 500",
			attempt: opts.attempt ?? 3,
		});
		return { webhookId, deliveryId };
	}

	it("無効化した webhook の failed 配信の再送は 409 で fetch されない", async () => {
		const { deliveryId } = await seedFailedDelivery({ enabled: false });
		const token = await ownerToken();
		const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		const res = await call(`/api/v1/webhooks/deliveries/${deliveryId}/retry`, token, { method: "POST" });
		expect(res.status).toBe(409);
		expect(fetchMock).not.toHaveBeenCalled();

		const after = await getDb(env)
			.select()
			.from(webhookDeliveries)
			.where(eq(webhookDeliveries.id, deliveryId))
			.get();
		expect(after!.status).toBe("failed");
	});

	it("同時 2 回の再送は片方だけが取り、fetch は 1 回", async () => {
		const { deliveryId } = await seedFailedDelivery();
		const token = await ownerToken();
		const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		const [r1, r2] = await Promise.all([
			call(`/api/v1/webhooks/deliveries/${deliveryId}/retry`, token, { method: "POST" }),
			call(`/api/v1/webhooks/deliveries/${deliveryId}/retry`, token, { method: "POST" }),
		]);

		expect([r1.status, r2.status].sort()).toEqual([200, 409]);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		const after = await getDb(env)
			.select()
			.from(webhookDeliveries)
			.where(eq(webhookDeliveries.id, deliveryId))
			.get();
		expect(after!.status).toBe("success");
	});
});

describe("手動再送はキューの重複配達と違う（#118）", () => {
	useCleanState();

	it("failed 配信への再配達は re-POST せず、手動再送は従来どおり 1 回 POST する", async () => {
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
			httpStatus: 503,
			error: "HTTP 503",
			attempt: 5,
		});

		const token = await ownerToken();
		const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		// キューが最終試行の {deliveryId, attempt:5} を重複配達してくる。
		await runDelivery(env, deliveryId, 5);
		expect(fetchMock).not.toHaveBeenCalled();

		// 手動再送は failed → pending にして attempt+1 を渡し、1 回 POST する。
		const res = await call(`/api/v1/webhooks/deliveries/${deliveryId}/retry`, token, {
			method: "POST",
		});
		expect(res.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const body = (await res.json()) as { status: string; attempt: number };
		expect(body.status).toBe("success");
		expect(body.attempt).toBe(6);
	});
});

describe("管理 API の監査（#95）", () => {
	useCleanState();

	it("webhook の作成が webhook.create として記録される", async () => {
		const token = await ownerToken();
		const res = await call("/api/v1/webhooks", token, { method: "POST", body: validPayload });
		const { id } = (await res.json()) as { id: string };

		const rows = await getDb(env).select().from(auditLogs).all();
		const created = rows.find((r) => r.targetId === id);
		expect(created).toBeTruthy();
		expect(created!.action).toBe("webhook.create");
		expect(created!.meta).toMatchObject({ name: "受信通知", enabled: true });
		expect(JSON.stringify(created!.meta)).not.toContain("secret");
	});

	it("ルールの作成が rule.create として記録される", async () => {
		const db = getDb(env);
		const domainId = newId("domain");
		await db.insert(domains).values({
			id: domainId,
			name: "mail.audit.example.com",
			zoneId: "zone1",
			zoneName: "example.com",
			mode: "subdomain",
		});
		const token = await ownerToken();
		const res = await call("/api/v1/admin/rules", token, {
			method: "POST",
			body: { scope: "domain", domainId, name: "監査用", action: "drop", matcher: {} },
		});
		expect(res.status).toBe(201);

		const rows = await db.select().from(auditLogs).all();
		expect(rows.map((r) => r.action)).toContain("rule.create");
	});

	it("webhook の更新が webhook.update として記録される", async () => {
		const token = await ownerToken();
		const created = (await (
			await call("/api/v1/webhooks", token, { method: "POST", body: validPayload })
		).json()) as { id: string };

		await call(`/api/v1/webhooks/${created.id}`, token, {
			method: "PATCH",
			body: { name: "改名", enabled: false },
		});

		const rows = await getDb(env).select().from(auditLogs).all();
		const updated = rows.find((r) => r.targetId === created.id && r.action === "webhook.update");
		expect(updated).toBeTruthy();
		expect(JSON.stringify(updated!.meta)).not.toContain("secret");
	});

	it("webhook の削除が webhook.delete として記録される", async () => {
		const token = await ownerToken();
		const created = (await (
			await call("/api/v1/webhooks", token, { method: "POST", body: validPayload })
		).json()) as { id: string };

		expect((await call(`/api/v1/webhooks/${created.id}`, token, { method: "DELETE" })).status).toBe(204);

		const rows = await getDb(env).select().from(auditLogs).all();
		expect(rows.find((r) => r.targetId === created.id && r.action === "webhook.delete")).toBeTruthy();
	});

	it("手動再送が webhook.retry として記録される", async () => {
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
		const token = await ownerToken();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("ok", { status: 200 })),
		);

		const res = await call(`/api/v1/webhooks/deliveries/${deliveryId}/retry`, token, { method: "POST" });
		expect(res.status).toBe(200);

		const rows = await db.select().from(auditLogs).all();
		expect(rows.find((r) => r.action === "webhook.retry" && r.targetId === webhookId)).toBeTruthy();
	});

	it("ルールの更新と削除が rule.update / rule.delete として記録される", async () => {
		const db = getDb(env);
		const domainId = newId("domain");
		await db.insert(domains).values({
			id: domainId,
			name: "mail.audit.example.com",
			zoneId: "zone1",
			zoneName: "example.com",
			mode: "subdomain",
		});
		const token = await ownerToken();
		const created = (await (
			await call("/api/v1/admin/rules", token, {
				method: "POST",
				body: { scope: "domain", domainId, name: "監査用", action: "drop", matcher: {} },
			})
		).json()) as { id: string };

		expect(
			(
				await call(`/api/v1/admin/rules/${created.id}`, token, {
					method: "PATCH",
					body: { name: "改名後", enabled: false },
				})
			).status,
		).toBe(200);

		let rows = await db.select().from(auditLogs).all();
		expect(rows.find((r) => r.targetId === created.id && r.action === "rule.update")).toBeTruthy();

		expect((await call(`/api/v1/admin/rules/${created.id}`, token, { method: "DELETE" })).status).toBe(204);
		rows = await db.select().from(auditLogs).all();
		expect(rows.find((r) => r.targetId === created.id && r.action === "rule.delete")).toBeTruthy();
	});
});
