import { beforeEach, describe, expect, vi } from "vitest";
import { scenario } from "../registry";
import { freshHarness, loginAsOwner, type Client, type Harness } from "../harness";
import { createFakeCloudflare, type FakeCloudflare } from "../../tests/domains-helpers";

describe("FR-6 ドメイン管理", () => {
	let h: Harness;
	let owner: Client;
	let fake: FakeCloudflare;

	beforeEach(async () => {
		h = await freshHarness();
		owner = await loginAsOwner(h);
		// createCloudflareApi(c.env) はトークンが無いと missingTokenError になる。
		(h.env as unknown as Record<string, unknown>).CF_API_TOKEN = "test-token";
		(h.env as unknown as Record<string, unknown>).CF_ACCOUNT_ID = "test-account";
		fake = createFakeCloudflare({
			zones: [{ id: "zone1", name: "example.com", status: "active" }],
			dnsRecords: [
				// apex に他社（Google Workspace）の MX が刺さっている。
				{ id: "apex-mx", type: "MX", name: "example.com", content: "aspmx.l.google.com", priority: 1 },
			],
		});
		vi.stubGlobal("fetch", fake.fetch);
	});

	scenario("FR-6", "接続前のプレビューが既存 MX の情報と警告を返す", async () => {
		const res = await owner.post("/api/v1/admin/domains/preview", { name: "example.com" });

		expect(res.status).toBe(200);
		expect(res.body.requiresApexConfirmation).toBe(true);
		const mx = res.body.data.mx as { content: string; provider: string }[];
		expect(mx.some((m) => m.content === "aspmx.l.google.com" && m.provider === "google")).toBe(true);
		const warnings = res.body.data.warnings as { level: string; code: string }[];
		expect(warnings.some((w) => w.level === "danger" && w.code === "apex_has_foreign_mx")).toBe(true);
		expect(res.body.catchAllWarning).toContain("ゾーン単位");
	});

	scenario("FR-6", "apex に他社 MX があるとき confirmApex 無しでは接続できない", async () => {
		const res = await owner.post("/api/v1/admin/domains", { name: "example.com" });

		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe("invalid_request");
		expect(res.body.error.message).toContain("confirmApex: true");
		const list = await owner.get("/api/v1/admin/domains");
		expect(list.body.data).toHaveLength(0);
	});

	scenario("FR-6", "既定はサブドメイン運用で apex の DNS を一度も触らない", async () => {
		const res = await owner.post("/api/v1/admin/domains", {
			name: "mail.example.com",
			localParts: ["ai"],
		});

		expect(res.status).toBe(201);
		expect(res.body.data.mode).toBe("subdomain");

		const apexCfMx = fake.dnsRecords.some(
			(r) => r.type === "MX" && r.name === "example.com" && r.content.includes("cloudflare"),
		);
		expect(apexCfMx).toBe(false);
		const subMx = fake.dnsRecords.filter((r) => r.type === "MX" && r.name === "mail.example.com");
		expect(subMx.length).toBeGreaterThan(0);
		expect(fake.dnsRecords.some((r) => r.id === "apex-mx")).toBe(true);
	});

	scenario("FR-6", "catch-all は既定で無効のまま", async () => {
		await owner.post("/api/v1/admin/domains", {
			name: "mail.example.com",
			localParts: ["ai"],
		});

		expect(fake.catchAll.enabled).toBe(false);
		const list = await owner.get("/api/v1/admin/domains");
		expect(list.body.data[0].catchAllEnabled).toBe(false);
	});

	scenario("FR-6", "トークンの権限不足が日本語の分かりやすいメッセージになる", async () => {
		vi.stubGlobal(
			"fetch",
			createFakeCloudflare({
				zones: [{ id: "zone1", name: "example.com", status: "active" }],
				failWith: (req) =>
					req.path.endsWith("/zones")
						? { status: 403, errors: [{ code: 9109, message: "not authorized" }] }
						: undefined,
			}).fetch,
		);

		const res = await owner.post("/api/v1/admin/domains/preview", { name: "mail.example.com" });

		expect(res.status).toBe(403);
		expect(res.body.error.code).toBe("forbidden");
		expect(res.body.error.message).toContain("CF_API_TOKEN のスコープに");
		expect(res.body.error.message).toContain("追加してください");
	});
});
