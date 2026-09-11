import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import adminDomainRoutes from "@/api/v1/admin/domains";
import { addresses, domains } from "@/db/schema";
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

async function seedEnabled(id: string, name: string) {
	await seedDomain(id, name, true);
	await getTestDb().insert(addresses).values({
		id: `adr_${id}`,
		domainId: id,
		localPart: "any",
		address: `any@${name}`,
		isCatchAll: true,
	});
	fake.catchAll.enabled = true;
	return id;
}

async function seedReceivable(id: string, name: string) {
	await seedDomain(id, name);
	await getTestDb().insert(addresses).values({
		id: `adr_${id}`,
		domainId: id,
		localPart: "any",
		address: `any@${name}`,
		isCatchAll: true,
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

	// CF のルールはゾーンに 1 本しかないので、他ドメインが握っている間に落とすと
	// そちらの配送が黙って止まる。自分の記録だけ下ろして CF には触らない。
	it("同じゾーンで他ドメインが有効な間は、無効化しても CF のルールは残す", async () => {
		await seedEnabled(`dom_a${seq}`, `mail${seq}.example.com`);
		const b = await seedEnabled(`dom_b${seq}`, `send${seq}.example.com`);

		const res = await callJson(adminDomains(), `/${b}/catch-all`, {
			method: "POST",
			body: JSON.stringify({ enabled: false, confirm: true }),
		});

		expect(res.status).toBe(200);
		expect(fake.catchAll.enabled).toBe(true);
		const a = await getTestDb().query.domains.findFirst({ where: eq(domains.id, `dom_a${seq}`) });
		expect(a?.catchAllEnabled).toBe(true);
		const bRow = await getTestDb().query.domains.findFirst({ where: eq(domains.id, b) });
		expect(bRow?.catchAllEnabled).toBe(false);
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

describe("POST catch-all の有効化（#117 ゾーンで 1 本）", () => {
	// 受け皿はドメインごとに持てる。宛先のドメインで振り分けるのは resolveIncoming の
	// 仕事なので、CF 側はゾーンに 1 本立っていれば足りる。
	it("同じゾーンの別ドメインでも catch-all を持てる", async () => {
		const a = await seedEnabled(`dom_ea${seq}`, `mail${seq}.example.com`);
		const b = await seedReceivable(`dom_eb${seq}`, `send${seq}.example.com`);

		const res = await callJson(adminDomains(), `/${b}/catch-all`, {
			method: "POST",
			body: JSON.stringify({ enabled: true, confirm: true }),
		});

		expect(res.status).toBe(200);
		expect(fake.catchAll.enabled).toBe(true);
		const bRow = await getTestDb().query.domains.findFirst({ where: eq(domains.id, b) });
		expect(bRow?.catchAllEnabled).toBe(true);
		const aRow = await getTestDb().query.domains.findFirst({ where: eq(domains.id, a) });
		expect(aRow?.catchAllEnabled).toBe(true);
	});

	it("最後の 1 つを無効化したときだけ CF のルールを落とす", async () => {
		const a = await seedEnabled(`dom_la${seq}`, `mail${seq}.example.com`);
		const b = await seedEnabled(`dom_lb${seq}`, `send${seq}.example.com`);

		await callJson(adminDomains(), `/${a}/catch-all`, {
			method: "POST",
			body: JSON.stringify({ enabled: false, confirm: true }),
		});
		expect(fake.catchAll.enabled).toBe(true); // b がまだ握っている

		const res = await callJson(adminDomains(), `/${b}/catch-all`, {
			method: "POST",
			body: JSON.stringify({ enabled: false, confirm: true }),
		});
		expect(res.status).toBe(200);
		expect(fake.catchAll.enabled).toBe(false);
	});

	it("片方を無効化してからもう片方を有効化しても、CF のルールは立ったまま", async () => {
		const a = await seedEnabled(`dom_ca${seq}`, `mail${seq}.example.com`);
		const b = await seedReceivable(`dom_cb${seq}`, `send${seq}.example.com`);

		const off = await callJson(adminDomains(), `/${a}/catch-all`, {
			method: "POST",
			body: JSON.stringify({ enabled: false, confirm: true }),
		});
		expect(off.status).toBe(200);

		const on = await callJson(adminDomains(), `/${b}/catch-all`, {
			method: "POST",
			body: JSON.stringify({ enabled: true, confirm: true }),
		});
		expect(on.status).toBe(200);
		const bRow = await getTestDb().query.domains.findFirst({ where: eq(domains.id, b) });
		expect(bRow?.catchAllEnabled).toBe(true);
		const aRow = await getTestDb().query.domains.findFirst({ where: eq(domains.id, a) });
		expect(aRow?.catchAllEnabled).toBe(false);
	});

	it("両方「有効」の破綻状態からは、どちらか一方を無効化して抜け出せる（#117）", async () => {
		const a = await seedEnabled(`dom_da${seq}`, `mail${seq}.example.com`);
		const b = await seedDomain(`dom_db${seq}`, `send${seq}.example.com`, true);
		fake.catchAll.enabled = true;

		const res = await callJson(adminDomains(), `/${b}/catch-all`, {
			method: "POST",
			body: JSON.stringify({ enabled: false, confirm: true }),
		});

		expect(res.status).toBe(200);
		expect(fake.catchAll.enabled).toBe(true);
		const bRow = await getTestDb().query.domains.findFirst({ where: eq(domains.id, b) });
		expect(bRow?.catchAllEnabled).toBe(false);
		const aRow = await getTestDb().query.domains.findFirst({ where: eq(domains.id, a) });
		expect(aRow?.catchAllEnabled).toBe(true);
	});
});

describe("DELETE cleanup と catch-all（#85）", () => {
	// 削除は通るが、残る側の配送を止めないよう CF のルールには触らない。
	it("別ドメインが有効な間は cleanup で catch-all を落とさない", async () => {
		const a = await seedDomain(`dom_ea${seq}`, `mail${seq}.example.com`, true);
		await seedDomain(`dom_eb${seq}`, `send${seq}.example.com`, true);
		fake.catchAll.enabled = true;

		const res = await callJson(adminDomains(), `/${a}`, { method: "DELETE" });

		expect(res.status).toBe(200);
		expect(fake.catchAll.enabled).toBe(true);
	});

	it("単独で有効なら DELETE cleanup で catch-all を無効化する", async () => {
		const a = await seedDomain(`dom_fa${seq}`, `mail${seq}.example.com`, true);

		const res = await callJson(adminDomains(), `/${a}`, { method: "DELETE" });

		expect(res.status).toBe(200);
		expect(fake.catchAll.enabled).toBe(false);
	});
});
