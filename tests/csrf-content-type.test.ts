import { SELF, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "@/worker";
import { OWNER, freshHarness, type Harness } from "../e2e/harness";
import { createApiKeyFor, createUser } from "./auth-helpers";

async function post(path: string, contentType: string | null, body: string) {
	const h = await freshHarness();
	const headers = new Headers();
	if (contentType) headers.set("content-type", contentType);
	const req = new Request(`https://tsubame.test${path}`, { method: "POST", headers, body });
	const ctx = createExecutionContext();
	const res = await worker.fetch(req as Parameters<typeof worker.fetch>[0], h.env, ctx);
	await waitOnExecutionContext(ctx);
	return { status: res.status, body: (await res.json()) as { error?: { code: string } } };
}

/** `SELF` は service binding 経由の fetch で、workerd の実 HTTP に近い経路を通る。 */
async function selfPost(init: RequestInit) {
	const req = new Request("https://tsubame.test/api/v1/auth/logout", { method: "POST", ...init });
	const res = await SELF.fetch(req);
	return { status: res.status, body: (await res.json()) as { error?: { code: string }; ok?: boolean } };
}

async function bootstrapOwnerCookie(h: Harness): Promise<string> {
	const req = new Request("https://tsubame.test/api/v1/auth/bootstrap", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(OWNER),
	});
	const ctx = createExecutionContext();
	const res = await worker.fetch(req as Parameters<typeof worker.fetch>[0], h.env, ctx);
	await waitOnExecutionContext(ctx);
	const m = /__Host-tsb_session=[^;]+/.exec(res.headers.get("set-cookie") ?? "");
	if (!m) throw new Error(`bootstrap に失敗: ${res.status}`);
	return m[0];
}

describe("変更系 API の Content-Type 検査（#50）", () => {
	const json = JSON.stringify({ email: "x@example.com", password: "irrelevant-password" });

	it("text/plain の JSON 風ボディは認証より前に 400 で止まる", async () => {
		for (const path of ["/api/v1/auth/login", "/api/v1/messages", "/api/v1/webhooks"]) {
			const res = await post(path, "text/plain", json);
			expect(res.status, path).toBe(400);
			expect(res.body.error?.code).toBe("invalid_request");
		}
	});

	it("Content-Type が無いボディ付き POST も 400", async () => {
		const res = await post("/api/v1/auth/login", null, json);
		expect(res.status).toBe(400);
	});

	it("application/json; charset=utf-8 は通る", async () => {
		const res = await post("/api/v1/auth/login", "application/json; charset=utf-8", json);
		expect(res.status).toBe(401);
	});
});

describe("管理 API の変更系も readJson を通る（#75）", () => {
	it("認証済みでも Content-Type が JSON でなければ 400", async () => {
		for (const path of ["/api/v1/admin/rules", "/api/v1/admin/domains", "/api/v1/admin/addresses", "/api/v1/webhooks"]) {
			const h = await freshHarness();
			const cookie = await bootstrapOwnerCookie(h);
			const req = new Request(`https://tsubame.test${path}`, {
				method: "POST",
				headers: { "content-type": "text/plain", cookie },
				body: '{"name":"x"}',
			});
			const ctx = createExecutionContext();
			const res = await worker.fetch(req as Parameters<typeof worker.fetch>[0], h.env, ctx);
			await waitOnExecutionContext(ctx);
			expect(res.status, path).toBe(400);
		}
	});
});

describe("ボディ無し POST の Content-Type 検査（#55: #50 の修正が実 HTTP で持ち込んだ退行）", () => {
	it("直接 worker.fetch に渡す経路（body キー無し）はボディ無し POST が通る", async () => {
		const ctx = createExecutionContext();
		const req = new Request("https://tsubame.test/api/v1/auth/logout", { method: "POST" });
		const res = await worker.fetch(req as Parameters<typeof worker.fetch>[0], (await freshHarness()).env, ctx);
		await waitOnExecutionContext(ctx);
		expect(res.status).toBe(200);
	});

	it("SELF（実 HTTP に近い経路）でも、Content-Type を付けないボディ無し POST が通る", async () => {
		const res = await selfPost({ headers: { "content-length": "0" } });
		expect(res.status).toBe(200);
		expect(res.body.ok).toBe(true);
	});

	it("Content-Type: application/json を明示したボディ無し POST も通る", async () => {
		const res = await selfPost({ headers: { "content-length": "0", "content-type": "application/json" } });
		expect(res.status).toBe(200);
		expect(res.body.ok).toBe(true);
	});

	it("型の無い Blob（Content-Type 無し）でも中身が 0 バイトなら通る", async () => {
		const res = await selfPost({ body: new Blob([]) });
		expect(res.status).toBe(200);
	});

	it("空ボディの form 風 POST（Content-Length: 0 だが Content-Type が JSON でない）は 400 のまま", async () => {
		for (const contentType of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
			const res = await selfPost({ body: "", headers: { "content-type": contentType } });
			expect(res.status, contentType).toBe(400);
		}
	});
});

describe("同一登録ドメインの別サブドメインからの no-cors CSRF（#55 差し戻し: Content-Type 無しのボディ付き POST）", () => {
	it("type の無い Blob で送ったボディ付き POST は webhooks / admin/rules で 400 になる", async () => {
		// no-cors な fetch は Content-Type を安全なリスト以外にできないが、
		// type が空文字の Blob なら Content-Type ヘッダ自体を送らずボディだけ送れる。
		// #50 が塞いだはずの「Content-Type を JSON と偽れない CSRF」がこの形で素通りしていた。
		const h = await freshHarness();
		const cookie = await bootstrapOwnerCookie(h);

		const targets = [
			{
				path: "/api/v1/webhooks",
				body: JSON.stringify({ name: "csrf", url: "https://example.com/hook", events: ["message.received"] }),
			},
			{
				path: "/api/v1/admin/rules",
				body: JSON.stringify({ scope: "domain", name: "csrf-rule", action: "drop", matcher: {} }),
			},
		];

		for (const { path, body } of targets) {
			const req = new Request(`https://tsubame.test${path}`, {
				method: "POST",
				headers: { cookie },
				body: new Blob([body]),
			});
			const res = await SELF.fetch(req);
			expect(res.status, path).toBe(400);
		}
	});
});

describe("Cookie 認証の変更系にだけ Fetch Metadata を要求する（#76）", () => {
	async function doWorker(h: Harness, path: string, init: RequestInit): Promise<Response> {
		const req = new Request(`https://tsubame.test${path}`, init);
		const ctx = createExecutionContext();
		const res = await worker.fetch(req as Parameters<typeof worker.fetch>[0], h.env, ctx);
		await waitOnExecutionContext(ctx);
		return res;
	}

	it("Sec-Fetch-Site: same-site のログアウトは 403（Cookie 認証）", async () => {
		const h = await freshHarness();
		const cookie = await bootstrapOwnerCookie(h);
		const res = await doWorker(h, "/api/v1/auth/logout", {
			method: "POST",
			headers: { cookie, "sec-fetch-site": "same-site" },
		});
		expect(res.status).toBe(403);
	});

	it("Sec-Fetch-Site: cross-site のログアウトは 403", async () => {
		const h = await freshHarness();
		const cookie = await bootstrapOwnerCookie(h);
		const res = await doWorker(h, "/api/v1/auth/logout", {
			method: "POST",
			headers: { cookie, "sec-fetch-site": "cross-site" },
		});
		expect(res.status).toBe(403);
	});

	it("Cookie + same-site の送信（POST /messages）も 403", async () => {
		const h = await freshHarness();
		const cookie = await bootstrapOwnerCookie(h);
		const res = await doWorker(h, "/api/v1/messages", {
			method: "POST",
			headers: { cookie, "content-type": "application/json", "sec-fetch-site": "same-site" },
			body: JSON.stringify({ to: ["a@b.test"], subject: "x", text: "y" }),
		});
		expect(res.status).toBe(403);
	});

	it("Sec-Fetch-Site: same-origin のログアウトは通る", async () => {
		const h = await freshHarness();
		const cookie = await bootstrapOwnerCookie(h);
		const res = await doWorker(h, "/api/v1/auth/logout", {
			method: "POST",
			headers: { cookie, "sec-fetch-site": "same-origin" },
		});
		expect(res.status).toBe(200);
	});

	it("Sec-Fetch-Site が無く Origin が異なるログアウトは 403", async () => {
		const h = await freshHarness();
		const cookie = await bootstrapOwnerCookie(h);
		const res = await doWorker(h, "/api/v1/auth/logout", {
			method: "POST",
			headers: { cookie, origin: "https://evil.example.com" },
		});
		expect(res.status).toBe(403);
	});

	it("Sec-Fetch-Site が無く Origin: null のログアウトは 500 でなく 403", async () => {
		const h = await freshHarness();
		const cookie = await bootstrapOwnerCookie(h);
		const res = await doWorker(h, "/api/v1/auth/logout", {
			method: "POST",
			headers: { cookie, origin: "null" },
		});
		expect(res.status).toBe(403);
	});

	it("API キー（Bearer）は cross-site でも通る", async () => {
		const h = await freshHarness();
		const owner = await createUser({ role: "owner", email: "apikey@example.test" });
		const key = await createApiKeyFor({ userId: owner.id });
		const res = await doWorker(h, "/api/v1/me/api-keys", {
			method: "POST",
			headers: {
				authorization: `Bearer ${key.token}`,
				"content-type": "application/json",
				"sec-fetch-site": "cross-site",
			},
			body: JSON.stringify({ name: "cross", scopes: ["read"] }),
		});
		expect(res.status).toBe(201);
	});
});
