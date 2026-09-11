import { beforeEach, describe, expect } from "vitest";
import { scenario } from "../registry";
import {
	deliverEmail,
	drainQueues,
	freshHarness,
	loginAsOwner,
	mime,
	seedDomain,
	type Client,
	type Harness,
} from "../harness";

describe("FR-9 UI", () => {
	let h: Harness;
	let owner: Client;

	beforeEach(async () => {
		h = await freshHarness();
		owner = await loginAsOwner(h);
	});

	function collectUiPaths(): string[] {
		// worker ランタイムでは node:fs で実ファイルを読めないので、
		// Vite の import.meta.glob でビルド時にソースを raw 文字列として取り込む。
		const modules = import.meta.glob("../../src/ui/**/*.{ts,tsx}", {
			query: "?raw",
			import: "default",
			eager: true,
		});
		const found = new Set<string>();
		for (const text of Object.values(modules)) {
			for (const m of text.matchAll(/\/api\/v1\/[a-z0-9/_-]*/g)) {
				const p = m[0];
				// 単なる BASE_URL や、テンプレートリテラルの切れ端（末尾 /）は除外。
				if (p === "/api/v1" || p === "/api/v1/" || p.endsWith("/")) continue;
				found.add(p);
			}
		}
		return [...found];
	}

	function assertRouteExists(method: string, path: string, res: { status: number; body: any }) {
		const isRouteMissing =
			res.status === 404 &&
			res.body?.error?.code === "not_found" &&
			res.body?.error?.message === "エンドポイントがありません";
		expect(isRouteMissing, `${method} ${path} はルータに存在しない`).toBe(false);
	}

	async function hit(method: string, path: string, body?: unknown) {
		switch (method) {
			case "GET":
				return owner.get(path);
			case "POST":
				return owner.post(path, body);
			case "PATCH":
				return owner.patch(path, body);
			case "PUT":
				return owner.put(path, body);
			case "DELETE":
				return owner.del(path);
			default:
				throw new Error(`未対応のメソッド: ${method}`);
		}
	}

	scenario("FR-9", "UI が叩く静的パスがすべて API に存在する", async () => {
		const paths = collectUiPaths();
		expect(paths.length).toBeGreaterThan(0);

		for (const path of paths) {
			const res = await hit("GET", path);
			assertRouteExists("GET", path, res);
		}
	});

	scenario("FR-9", "UI が叩く動的パス（:id 付き）がすべて API に存在する", async () => {
		const routes: { method: string; path: string; body?: unknown }[] = [
			{ method: "POST", path: "/api/v1/auth/login" },
			{ method: "POST", path: "/api/v1/auth/logout" },
			{ method: "GET", path: "/api/v1/auth/session" },
			{ method: "POST", path: "/api/v1/auth/bootstrap" },
			{ method: "GET", path: "/api/v1/me" },
			{ method: "PATCH", path: "/api/v1/me" },
			{ method: "GET", path: "/api/v1/addresses" },
			{ method: "GET", path: "/api/v1/threads" },
			{ method: "GET", path: "/api/v1/threads/:id" },
			{ method: "GET", path: "/api/v1/messages" },
			{ method: "GET", path: "/api/v1/messages/:id" },
			{ method: "PATCH", path: "/api/v1/messages/:id", body: { isRead: true } },
			{ method: "POST", path: "/api/v1/messages" },
			{ method: "POST", path: "/api/v1/messages/:id/reply" },
			{ method: "GET", path: "/api/v1/attachments/:id" },
			{ method: "GET", path: "/api/v1/messages/:id/raw" },
			{ method: "GET", path: "/api/v1/admin/addresses" },
			{ method: "POST", path: "/api/v1/admin/addresses" },
			{ method: "DELETE", path: "/api/v1/admin/addresses/:id" },
			{ method: "GET", path: "/api/v1/admin/domains/available" },
			{ method: "POST", path: "/api/v1/admin/domains/preview" },
			{ method: "GET", path: "/api/v1/admin/domains" },
			{ method: "POST", path: "/api/v1/admin/domains" },
			{ method: "POST", path: "/api/v1/admin/domains/:id/catch-all" },
			{ method: "DELETE", path: "/api/v1/admin/domains/:id" },
			{ method: "POST", path: "/api/v1/admin/domains/:id/verify" },
			{ method: "GET", path: "/api/v1/admin/api-keys" },
			{ method: "POST", path: "/api/v1/admin/api-keys" },
			{ method: "DELETE", path: "/api/v1/admin/api-keys/:id" },
			{ method: "GET", path: "/api/v1/admin/users" },
			{ method: "POST", path: "/api/v1/admin/users" },
			{ method: "GET", path: "/api/v1/admin/users/:id" },
			{ method: "PATCH", path: "/api/v1/admin/users/:id" },
			{ method: "DELETE", path: "/api/v1/admin/users/:id" },
			{ method: "PUT", path: "/api/v1/admin/users/:id/grants" },
			{ method: "GET", path: "/api/v1/admin/rules" },
			{ method: "POST", path: "/api/v1/admin/rules" },
			{ method: "DELETE", path: "/api/v1/admin/rules/:id" },
			{ method: "GET", path: "/api/v1/webhooks" },
			{ method: "POST", path: "/api/v1/webhooks" },
			{ method: "DELETE", path: "/api/v1/webhooks/:id" },
			{ method: "GET", path: "/api/v1/webhooks/:id/deliveries" },
			{ method: "POST", path: "/api/v1/webhooks/deliveries/:id/retry" },
		];

		for (const r of routes) {
			const path = r.path.replace(":id", "test-id");
			const res = await hit(r.method, path, r.body);
			assertRouteExists(r.method, path, res);
		}
	});

	scenario("FR-9", "送信者が書いた中身を API から開いても、何も読み込ませず埋め込ませない", async () => {
		await seedDomain(h, { addresses: ["ai"] });
		const raw = mime({
			from: "someone@ext.example.jp",
			to: "ai@mail.tsubame.test",
			subject: "HTML を仕込んだメール",
			body: '<script>alert(1)</script><img src="https://attacker.example/p.png">',
		});
		await deliverEmail(h, { from: "someone@ext.example.jp", to: "ai@mail.tsubame.test", raw });
		await drainQueues(h);

		const list = await owner.get("/api/v1/messages?limit=1");
		const res = await owner.get(`/api/v1/messages/${list.body.data[0].id}/raw`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
		expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("x-frame-options")).toBe("DENY");

		const denied = await owner.get("/api/v1/messages/msg_nope");
		expect(denied.status).toBe(404);
		expect(denied.headers.get("content-security-policy")).toContain("default-src 'none'");
	});

	scenario("FR-9", "作成画面が使う差出人の一覧が空にならない", async () => {
		// /v1/me と /v1/addresses が同じ概念を別の形で返していて、
		// 作成画面の差出人が黙って空になっていた。形が揃っていることを固定する。
		const seeded = await seedDomain(h, { addresses: ["sender"] });
		void seeded;

		const me = await owner.get("/api/v1/me");
		const list = await owner.get("/api/v1/addresses");

		expect(me.body.addresses.length).toBeGreaterThan(0);
		for (const a of me.body.addresses) {
			expect(a).toHaveProperty("level");
			expect(["read", "write"]).toContain(a.level);
			expect(a).toHaveProperty("color");
		}
		expect(me.body.addresses.some((a: { level: string }) => a.level === "write")).toBe(true);

		const meKeys = Object.keys(me.body.addresses[0]).sort();
		const listKeys = Object.keys(list.body.data[0]).sort();
		for (const k of ["id", "address", "displayName", "level", "color"]) {
			expect(meKeys).toContain(k);
			expect(listKeys).toContain(k);
		}
	});
});
