import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { rulesRouter } from "@/api/v1/admin/rules";
import { addresses, domains } from "@/db/schema";
import { applyMigrations, callJson, getTestDb, mountRouter, ownerPrincipal } from "./domains-helpers";

beforeAll(async () => {
	await applyMigrations();
});

const app = () => mountRouter("/", rulesRouter, ownerPrincipal);

async function seedDomain(id: string, name: string) {
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
			catchAllEnabled: false,
		});
	return id;
}

async function seedAddress(id: string, domainId: string, localPart: string, domainName: string) {
	await getTestDb()
		.insert(addresses)
		.values({ id, domainId, localPart, address: `${localPart}@${domainName}` });
	return id;
}

let seq = 0;
beforeEach(() => {
	seq += 1;
});

describe("POST /admin/rules の target 検証（#38）", () => {
	it("deliver の target は同じドメインの実在アドレス id である必要がある", async () => {
		const domA = await seedDomain(`dom_r${seq}a`, `r${seq}a.example.com`);
		const domB = await seedDomain(`dom_r${seq}b`, `r${seq}b.example.com`);
		const addrInA = await seedAddress(`adr_r${seq}a`, domA, "inbox", `r${seq}a.example.com`);
		const addrInB = await seedAddress(`adr_r${seq}b`, domB, "inbox", `r${seq}b.example.com`);

		const ok = await callJson(app(), "/", {
			method: "POST",
			body: JSON.stringify({
				scope: "domain",
				domainId: domA,
				name: "deliver ok",
				action: "deliver",
				matcher: {},
				target: addrInA,
			}),
		});
		expect(ok.status).toBe(201);

		// 他ドメインの実在アドレス id は拒否する。
		const crossDomain = await callJson(app(), "/", {
			method: "POST",
			body: JSON.stringify({
				scope: "domain",
				domainId: domA,
				name: "deliver cross-domain",
				action: "deliver",
				matcher: {},
				target: addrInB,
			}),
		});
		expect(crossDomain.status).toBe(400);

		// 存在しない id は拒否する。
		const missing = await callJson(app(), "/", {
			method: "POST",
			body: JSON.stringify({
				scope: "domain",
				domainId: domA,
				name: "deliver missing",
				action: "deliver",
				matcher: {},
				target: "adr_does_not_exist",
			}),
		});
		expect(missing.status).toBe(400);
	});

	it("forward の target はメールアドレス形式である必要がある", async () => {
		const dom = await seedDomain(`dom_r${seq}f`, `r${seq}f.example.com`);

		const bad = await callJson(app(), "/", {
			method: "POST",
			body: JSON.stringify({
				scope: "domain",
				domainId: dom,
				name: "forward bad",
				action: "forward",
				matcher: {},
				target: "not-an-email",
			}),
		});
		expect(bad.status).toBe(400);

		const ok = await callJson(app(), "/", {
			method: "POST",
			body: JSON.stringify({
				scope: "domain",
				domainId: dom,
				name: "forward ok",
				action: "forward",
				matcher: {},
				target: "someone@external.example",
			}),
		});
		expect(ok.status).toBe(201);
	});

	it("PATCH でも実効値（既存値とのマージ後）を検証する", async () => {
		const domA = await seedDomain(`dom_r${seq}p`, `r${seq}p.example.com`);
		const addr = await seedAddress(`adr_r${seq}p`, domA, "inbox", `r${seq}p.example.com`);

		const created = await callJson(app(), "/", {
			method: "POST",
			body: JSON.stringify({
				scope: "domain",
				domainId: domA,
				name: "patch target",
				action: "deliver",
				matcher: {},
				target: addr,
			}),
		});
		expect(created.status).toBe(201);
		const id = created.json.id;

		// action は据え置きで target だけ壊れた id に変えようとすると拒否する。
		const patched = await callJson(app(), `/${id}`, {
			method: "PATCH",
			body: JSON.stringify({ target: "adr_does_not_exist" }),
		});
		expect(patched.status).toBe(400);
	});
});
