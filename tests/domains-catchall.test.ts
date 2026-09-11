import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import adminDomainRoutes from "@/api/v1/admin/domains";
import { domains } from "@/db/schema";
import {
	applyMigrations,
	callJson,
	createFakeCloudflare,
	getTestDb,
	mountRouter,
	ownerPrincipal,
} from "./domains-helpers";
import type { FakeCloudflare } from "./domains-helpers";

beforeAll(async () => {
	await applyMigrations();
});

let fake: FakeCloudflare;
let seq = 0;

beforeEach(async () => {
	seq += 1;
	await getTestDb().delete(domains);
	fake = createFakeCloudflare({ zones: [{ id: "zone1", name: "example.com" }] });
	vi.stubGlobal("fetch", fake.fetch);
});

const adminDomains = () => mountRouter("/", adminDomainRoutes, ownerPrincipal);

async function seedDomain(id: string, name: string, catchAllEnabled = false) {
	await getTestDb()
		.insert(domains)
		.values({
			id,
			name,
			zoneId: "zone1",
			zoneName: "example.com",
			mode: "subdomain",
			routingStatus: "active",
			sendingStatus: "active",
			catchAllEnabled,
		});
	return id;
}

describe("POST /admin/domains/:id/catch-all（#85 ゾーン単位の食い違い）", () => {
	it("無効化にも confirm を要求する（有効化と同じ）", async () => {
		const id = await seedDomain(`dom_off${seq}`, `send${seq}.example.com`, true);

		const res = await callJson(adminDomains(), `/${id}/catch-all`, {
			method: "POST",
			body: JSON.stringify({ enabled: false }),
		});

		expect(res.status).toBe(400);
		expect(res.json.error.message).toContain("confirm: true");
		expect(fake.catchAll.enabled).toBe(false);
	});

	it("同じゾーンで他ドメインが有効な間は無効化できない（409・CF は触らない）", async () => {
		await seedDomain(`dom_a${seq}`, `mail${seq}.example.com`, true);
		const b = await seedDomain(`dom_b${seq}`, `send${seq}.example.com`, false);

		const res = await callJson(adminDomains(), `/${b}/catch-all`, {
			method: "POST",
			body: JSON.stringify({ enabled: false, confirm: true }),
		});

		expect(res.status).toBe(409);
		expect(fake.catchAll.enabled).toBe(false);
		const a = await getTestDb().query.domains.findFirst({ where: eq(domains.id, `dom_a${seq}`) });
		expect(a?.catchAllEnabled).toBe(true);
	});

	it("他ドメインが無ければ confirm 付きで無効化できる", async () => {
		const id = await seedDomain(`dom_c${seq}`, `mail${seq}.example.com`, true);

		const res = await callJson(adminDomains(), `/${id}/catch-all`, {
			method: "POST",
			body: JSON.stringify({ enabled: false, confirm: true }),
		});

		expect(res.status).toBe(200);
		expect(fake.catchAll.enabled).toBe(false);
	});
});

describe("DELETE cleanup と catch-all（#85）", () => {
	it("別ドメインが有効な間は cleanup で catch-all を落とさない（409・行も残る）", async () => {
		const a = await seedDomain(`dom_ea${seq}`, `mail${seq}.example.com`, true);
		await seedDomain(`dom_eb${seq}`, `send${seq}.example.com`, true);

		const res = await callJson(adminDomains(), `/${a}`, { method: "DELETE" });

		expect(res.status).toBe(409);
		expect(fake.catchAll.enabled).toBe(false);
		const row = await getTestDb().query.domains.findFirst({ where: eq(domains.id, a) });
		expect(row).toBeTruthy();
	});

	it("単独で有効なら DELETE cleanup で catch-all を無効化する", async () => {
		const a = await seedDomain(`dom_fa${seq}`, `mail${seq}.example.com`, true);

		const res = await callJson(adminDomains(), `/${a}`, { method: "DELETE" });

		expect(res.status).toBe(200);
		expect(fake.catchAll.enabled).toBe(false);
	});
});
