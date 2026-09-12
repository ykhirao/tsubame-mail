import { beforeEach, describe, expect, vi } from "vitest";
import { scenario } from "../registry";
import { drainQueues, freshHarness, loginAsOwner, seedDomain, type Client, type Harness } from "../harness";
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

	scenario("FR-6-2", "接続前のプレビューが既存 MX の情報と警告を返す", async () => {
		const res = await owner.post("/api/v1/admin/domains/preview", { name: "example.com" });

		expect(res.status).toBe(200);
		expect(res.body.requiresApexConfirmation).toBe(true);
		const mx = res.body.data.mx as { content: string; provider: string }[];
		expect(mx.some((m) => m.content === "aspmx.l.google.com" && m.provider === "google")).toBe(true);
		const warnings = res.body.data.warnings as { level: string; code: string }[];
		expect(warnings.some((w) => w.level === "danger" && w.code === "apex_has_foreign_mx")).toBe(true);
		expect(res.body.catchAllWarning).toContain("ゾーン単位");
	});

	scenario("FR-6-2", "apex に他社 MX があるとき confirmApex 無しでは接続できない", async () => {
		const res = await owner.post("/api/v1/admin/domains", { name: "example.com" });

		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe("invalid_request");
		expect(res.body.error.message).toContain("confirmApex: true");
		const list = await owner.get("/api/v1/admin/domains");
		expect(list.body.data).toHaveLength(0);
	});

	scenario(["FR-6-1", "FR-6-2", "FR-6-4"], "既定はサブドメイン運用で apex の DNS を一度も触らない", async () => {
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

	scenario("FR-6-3", "catch-all は既定で無効のまま", async () => {
		await owner.post("/api/v1/admin/domains", {
			name: "mail.example.com",
			localParts: ["ai"],
		});

		expect(fake.catchAll.enabled).toBe(false);
		const list = await owner.get("/api/v1/admin/domains");
		expect(list.body.data[0].catchAllEnabled).toBe(false);
	});

	scenario("FR-6-1", "トークンの権限不足が日本語の分かりやすいメッセージになる", async () => {
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

	scenario("FR-6-5", "Email Sending を接続後にドメインごとに有効化できる", async () => {
		const res = await owner.post("/api/v1/admin/domains", {
			name: "mail.example.com",
			enableSending: false,
		});
		expect(res.status).toBe(201);
		expect(res.body.data.sendingStatus).toBe("disabled");

		const list = await owner.get("/api/v1/admin/domains");
		const domainId = list.body.data[0].id;

		const enable = await owner.post(`/api/v1/admin/domains/${domainId}/sending`, {
			enabled: true,
		});
		expect(enable.status).toBe(200);
		expect(["pending", "active"]).toContain(enable.body.data.sendingStatus);

		const detail = await owner.get(`/api/v1/admin/domains/${domainId}`);
		expect(["pending", "active"]).toContain(detail.body.data.sendingStatus);

		const disable = await owner.post(`/api/v1/admin/domains/${domainId}/sending`, {
			enabled: false,
		});
		expect(disable.status).toBe(200);
		expect(disable.body.data.sendingStatus).toBe("disabled");
	});

	scenario("FR-6-5", "送信を無効にしたドメインからは送れず、無効にする前に積まれた送信も送らない", async () => {
		const { domainId } = await seedDomain(h, { addresses: ["ai"] });
		const sent: unknown[] = [];
		(h.env as unknown as { EMAIL: unknown }).EMAIL = {
			send: async (m: unknown) => {
				sent.push(m);
				return { messageId: "mock-message-id" };
			},
		};
		const mail = { from: "ai@mail.tsubame.test", to: ["dest@example.net"], subject: "件名", text: "本文" };

		const queued = await owner.post("/api/v1/messages", mail);
		expect(queued.status).toBe(202);

		const off = await owner.post(`/api/v1/admin/domains/${domainId}/sending`, { enabled: false });
		expect(off.status).toBe(200);

		const refused = await owner.post("/api/v1/messages", mail);
		expect(refused.status).toBe(409);
		expect(refused.body.error.message).toContain("送信が無効");

		await drainQueues(h);
		expect(sent).toHaveLength(0);
		const job = await owner.get(`/api/v1/messages/${queued.body.id}`);
		expect(job.body.status).toBe("failed");
	});

	scenario("FR-6-4", "cleanup 付きで切断すると接続が張ったサブドメインの MX/TXT だけ消え、他人の apex MX は残る", async () => {
		const res = await owner.post("/api/v1/admin/domains", {
			name: "mail.example.com",
			localParts: ["ai"],
		});
		expect(res.status).toBe(201);
		const domainId = res.body.data.domainId;
		expect(fake.dnsRecords.some((r) => r.type === "MX" && r.name === "mail.example.com")).toBe(true);

		const del = await owner.del(`/api/v1/admin/domains/${domainId}?cleanup=true`);
		expect(del.status).toBe(200);
		expect(del.body.data.deleted).toBe(true);
		expect(
			(del.body.data.cleanup.removedDnsRecords as string[]).some((s) => s.includes("MX") && s.includes("mail.example.com")),
		).toBe(true);
		expect(fake.dnsRecords.some((r) => r.name === "mail.example.com")).toBe(false);
		expect(fake.dnsRecords.some((r) => r.id === "apex-mx")).toBe(true);

		const list = await owner.get("/api/v1/admin/domains");
		expect(list.body.data).toHaveLength(0);
	});

	scenario("FR-6-4", "cleanup=false の切断は後始末せず DNS を残し、DB からだけ消える", async () => {
		const res = await owner.post("/api/v1/admin/domains", {
			name: "mail.example.com",
			localParts: ["ai"],
		});
		expect(res.status).toBe(201);
		const domainId = res.body.data.domainId;

		const del = await owner.del(`/api/v1/admin/domains/${domainId}?cleanup=false`);
		expect(del.status).toBe(200);
		expect(fake.dnsRecords.some((r) => r.type === "MX" && r.name === "mail.example.com")).toBe(true);

		const list = await owner.get("/api/v1/admin/domains");
		expect(list.body.data).toHaveLength(0);
	});

	scenario("FR-6-4", "verify が DNS の実態を読み直し、MX が無くなれば routingStatus が pending に転ぶ", async () => {
		const res = await owner.post("/api/v1/admin/domains", {
			name: "mail.example.com",
			localParts: ["ai"],
		});
		expect(res.status).toBe(201);
		const domainId = res.body.data.domainId;

		const before = await owner.post(`/api/v1/admin/domains/${domainId}/verify`);
		expect(before.status).toBe(200);
		expect(before.body.data.routingStatus).toBe("active");
		// verify は routingStatus / sendingStatus を返す。値は環境依存なので型だけ見る。
		expect(["pending", "active", "disabled", "error"]).toContain(before.body.data.sendingStatus);

		// 接続後の MX が DNS から失われた（設定を踏み潰された）状態を再現する。
		for (const r of fake.dnsRecords.filter((r) => r.type === "MX" && r.name === "mail.example.com")) {
			fake.dnsRecords.splice(fake.dnsRecords.indexOf(r), 1);
		}

		const after = await owner.post(`/api/v1/admin/domains/${domainId}/verify`);
		expect(after.status).toBe(200);
		expect(after.body.data.routingStatus).toBe("pending");
	});
});
