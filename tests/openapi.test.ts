import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import app from "@/api/v1/openapi";
import { createApp } from "@/api/app";

type Spec = {
	openapi: string;
	paths: Record<string, unknown>;
	components: { schemas: Record<string, unknown> };
};

const fetchSpec = async (): Promise<Spec> => (await app.request("/openapi.json")).json();

describe("openapi", () => {
	it("3.1 の仕様を返す", async () => {
		const res = await app.request("/openapi.json");
		expect(res.status).toBe(200);
		const spec = (await res.json()) as Spec;
		expect(spec.openapi).toBe("3.1.0");
		expect(Object.keys(spec.paths)).toContain("/api/v1/messages");
	});

	it("管理 API と Webhook は載せない", async () => {
		const spec = await fetchSpec();
		for (const path of Object.keys(spec.paths)) {
			expect(path).not.toContain("/admin/");
			expect(path).not.toContain("/webhooks");
		}
	});

	it("$ref がすべて解決する", async () => {
		const spec = await fetchSpec();
		for (const m of JSON.stringify(spec).matchAll(/#\/components\/schemas\/(\w+)/g)) {
			const name = m[1] ?? "";
			expect(spec.components.schemas[name], name).toBeDefined();
		}
	});

	it("閲覧ページと描画スクリプトを配る", async () => {
		expect((await app.request("/docs")).status).toBe(200);
		const js = await app.request("/docs.js");
		expect(js.status).toBe(200);
		expect(js.headers.get("content-type")).toContain("javascript");
	});

	it("キーが無くても読める", async () => {
		const mounted = createApp();
		for (const path of ["/api/v1/openapi.json", "/api/v1/docs", "/api/v1/docs.js"]) {
			expect((await mounted.request(path, {}, env)).status, path).toBe(200);
		}
	});

	// /api/* の既定は default-src 'none' で、そのままだと自分の script も fetch も通らない。
	it("閲覧ページは自分の script と fetch を通す CSP で返る", async () => {
		const res = await createApp().request("/api/v1/docs", {}, env);
		const csp = res.headers.get("content-security-policy") ?? "";
		expect(csp).toContain("script-src 'self'");
		expect(csp).toContain("connect-src 'self'");
	});

	// 緩めるのは閲覧ページだけ。添付と生 MIME は送信者の書いた中身を返すので、
	// ここに script-src が漏れると保存された HTML がこのオリジンで動く。
	it("閲覧ページ以外の CSP は緩めない", async () => {
		const res = await createApp().request("/api/v1/openapi.json", {}, env);
		const csp = res.headers.get("content-security-policy") ?? "";
		expect(csp).toContain("default-src 'none'");
		expect(csp).not.toContain("script-src");
	});
});
