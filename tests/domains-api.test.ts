import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import addressRoutes from "@/api/v1/addresses";
import adminAddressRoutes from "@/api/v1/admin/addresses";
import adminDomainRoutes from "@/api/v1/admin/domains";
import { addresses, domains, messages } from "@/db/schema";
import {
	applyMigrations,
	callJson,
	createFakeCloudflare,
	getTestDb,
	memberPrincipal,
	mountRouter,
	ownerPrincipal,
} from "./domains-helpers";
import type { FakeCloudflare } from "./domains-helpers";

beforeAll(async () => {
	await applyMigrations();
});

let fake: FakeCloudflare;

beforeEach(() => {
	fake = createFakeCloudflare({
		zones: [
			{ id: "zone1", name: "example.com", status: "active" },
			{ id: "zone2", name: "example.net", status: "active" },
		],
		dnsRecords: [
			{ id: "apex-mx", type: "MX", name: "example.com", content: "aspmx.l.google.com", priority: 1 },
		],
	});
	vi.stubGlobal("fetch", fake.fetch);
});

const adminDomains = () => mountRouter("/", adminDomainRoutes, ownerPrincipal);
const adminAddresses = () => mountRouter("/", adminAddressRoutes, ownerPrincipal);

async function seedDomain(id = "dom_test", name = "mail.example.com") {
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

describe("GET /admin/domains/available", () => {
	it("接続済みに印を付け、トークンのスコープの注意を添える", async () => {
		await seedDomain("dom_avail", "mail.example.com");
		const res = await callJson(adminDomains(), "/available");

		expect(res.status).toBe(200);
		const example = res.json.data.find((z: any) => z.zoneId === "zone1");
		expect(example.connectedNames).toEqual(["mail.example.com"]);
		expect(example.suggestedName).toBe("mail.example.com");
		const other = res.json.data.find((z: any) => z.zoneId === "zone2");
		expect(other.connectedNames).toEqual([]);
		expect(res.json.note).toContain("CF_API_TOKEN のスコープ");
	});

	it("owner でなければ 403", async () => {
		const app = mountRouter("/", adminDomainRoutes, memberPrincipal([]));
		const res = await callJson(app, "/available");
		expect(res.status).toBe(403);
		expect(res.json.error.code).toBe("forbidden");
	});

	it("admin スコープの無い API キーは owner でも 403", async () => {
		const app = mountRouter("/", adminDomainRoutes, {
			...ownerPrincipal,
			via: "api_key",
			scopes: ["read"],
		});
		const res = await callJson(app, "/available");
		expect(res.status).toBe(403);
		expect(res.json.error.message).toContain("admin スコープ");
	});
});

describe("POST /admin/domains/preview", () => {
	it("apex の他社 MX を danger で返す", async () => {
		const res = await callJson(adminDomains(), "/preview", {
			method: "POST",
			body: JSON.stringify({ name: "example.com" }),
		});

		expect(res.status).toBe(200);
		expect(res.json.requiresApexConfirmation).toBe(true);
		expect(res.json.data.warnings.some((w: any) => w.level === "danger")).toBe(true);
		expect(res.json.catchAllWarning).toContain("ゾーン単位");
	});

	it("ホスト名が不正なら 400", async () => {
		const res = await callJson(adminDomains(), "/preview", {
			method: "POST",
			body: JSON.stringify({ name: "not a host" }),
		});
		expect(res.status).toBe(400);
		expect(res.json.error.code).toBe("invalid_request");
	});
});

describe("POST /admin/domains", () => {
	it("apex は confirmApex 無しで 400", async () => {
		const res = await callJson(adminDomains(), "/", {
			method: "POST",
			body: JSON.stringify({ name: "example.com" }),
		});
		expect(res.status).toBe(400);
		expect(res.json.error.message).toContain("confirmApex: true");
	});

	it("サブドメインは接続でき、catch-all は無効のまま", async () => {
		const res = await callJson(adminDomains(), "/", {
			method: "POST",
			body: JSON.stringify({ name: "mail.example.net", localParts: ["ai"] }),
		});

		expect(res.status).toBe(201);
		expect(res.json.data.mode).toBe("subdomain");
		expect(res.json.data.catchAllEnabled).toBe(false);
		expect(res.json.catchAllWarning).toContain("既定は無効");
		expect(fake.catchAll.enabled).toBe(false);
	});
});

describe("POST /admin/domains/:id/catch-all", () => {
	it("confirm が無ければ 400 で危険を説明する", async () => {
		const id = await seedDomain("dom_catch", "mail.catch.example.com");
		const res = await callJson(adminDomains(), `/${id}/catch-all`, {
			method: "POST",
			body: JSON.stringify({ enabled: true }),
		});

		expect(res.status).toBe(400);
		expect(res.json.error.message).toContain("confirm: true");
		expect(res.json.error.message).toContain("ゾーン単位");
		expect(fake.catchAll.enabled).toBe(false);
	});

	it("受け皿のアドレスが無ければ有効化できない", async () => {
		const id = await seedDomain("dom_catch2", "mail.catch2.example.com");
		const res = await callJson(adminDomains(), `/${id}/catch-all`, {
			method: "POST",
			body: JSON.stringify({ enabled: true, confirm: true }),
		});
		expect(res.status).toBe(400);
		expect(res.json.error.message).toContain("isCatchAll");
	});

	it("受け皿があり confirm があれば有効化する", async () => {
		const id = await seedDomain("dom_catch3", "mail.catch3.example.com");
		await getTestDb().insert(addresses).values({
			id: "adr_catch",
			domainId: id,
			localPart: "any",
			address: `any@mail.catch3.example.com`,
			isCatchAll: true,
		});

		const res = await callJson(adminDomains(), `/${id}/catch-all`, {
			method: "POST",
			body: JSON.stringify({ enabled: true, confirm: true }),
		});

		expect(res.status).toBe(200);
		expect(res.json.data.enabled).toBe(true);
		expect(res.json.warning).toContain("ゾーン単位");
		expect(fake.catchAll.enabled).toBe(true);
		expect(fake.catchAll.actions).toEqual([{ type: "worker", value: ["tsubame"] }]);
	});
});

describe("POST /admin/domains/:id/verify と DELETE", () => {
	it("verify で DNS を取り直して status を更新する", async () => {
		const id = await seedDomain("dom_verify", "mail.verify.example.com");
		fake.dnsRecords.push(
			{ id: "v-mx", type: "MX", name: "mail.verify.example.com", content: "route1.mx.cloudflare.net", priority: 1 },
			{ id: "v-spf", type: "TXT", name: "mail.verify.example.com", content: "v=spf1 include:_spf.mx.cloudflare.net ~all" },
			{ id: "v-dkim", type: "TXT", name: "cf-bounce._domainkey.mail.verify.example.com", content: "v=DKIM1; p=AAA" },
		);

		const res = await callJson(adminDomains(), `/${id}/verify`, { method: "POST" });

		expect(res.status).toBe(200);
		expect(res.json.data.routingStatus).toBe("active");
		expect(res.json.data.sendingStatus).toBe("active");
		expect(res.json.data.sending).toEqual({ spf: true, dkim: true, dmarc: false });
	});

	it("削除で Cloudflare の後始末をし、apex は残す", async () => {
		const id = await seedDomain("dom_gone", "mail.gone.example.com");
		fake.dnsRecords.push({
			id: "g-mx",
			type: "MX",
			name: "mail.gone.example.com",
			content: "route1.mx.cloudflare.net",
			priority: 1,
		});

		const res = await callJson(adminDomains(), `/${id}`, { method: "DELETE" });

		expect(res.status).toBe(200);
		expect(res.json.data.cleanup.removedDnsRecords).toEqual(["MX mail.gone.example.com"]);
		expect(fake.dnsRecords.some((r) => r.id === "apex-mx")).toBe(true);
	});
});

describe("POST /admin/addresses", () => {
	it("alias には aliasTargetId が必須", async () => {
		const id = await seedDomain("dom_alias", "mail.alias.example.com");
		const res = await callJson(adminAddresses(), "/", {
			method: "POST",
			body: JSON.stringify({ domainId: id, localPart: "sales", kind: "alias" }),
		});

		expect(res.status).toBe(400);
		expect(JSON.stringify(res.json.error.details)).toContain("aliasTargetId が必須");
		expect(fake.routingRules).toEqual([]);
	});

	it("alias を作ると Cloudflare のルールも作られる", async () => {
		const id = await seedDomain("dom_alias2", "mail.alias2.example.com");
		const mailbox = await callJson(adminAddresses(), "/", {
			method: "POST",
			body: JSON.stringify({ domainId: id, localPart: "hirao" }),
		});
		expect(mailbox.status).toBe(201);

		const alias = await callJson(adminAddresses(), "/", {
			method: "POST",
			body: JSON.stringify({
				domainId: id,
				localPart: "sales",
				kind: "alias",
				aliasTargetId: mailbox.json.data.id,
			}),
		});

		expect(alias.status).toBe(201);
		expect(alias.json.data.aliasTargetId).toBe(mailbox.json.data.id);
		expect(fake.routingRules.map((r) => r.matchers[0]?.value)).toEqual([
			"hirao@mail.alias2.example.com",
			"sales@mail.alias2.example.com",
		]);
	});

	it("エイリアスのエイリアスは作れない", async () => {
		const id = await seedDomain("dom_alias3", "mail.alias3.example.com");
		const mailbox = await callJson(adminAddresses(), "/", {
			method: "POST",
			body: JSON.stringify({ domainId: id, localPart: "a" }),
		});
		const alias = await callJson(adminAddresses(), "/", {
			method: "POST",
			body: JSON.stringify({ domainId: id, localPart: "b", kind: "alias", aliasTargetId: mailbox.json.data.id }),
		});
		const nested = await callJson(adminAddresses(), "/", {
			method: "POST",
			body: JSON.stringify({ domainId: id, localPart: "c", kind: "alias", aliasTargetId: alias.json.data.id }),
		});
		expect(nested.status).toBe(400);
	});

	it("catch-all はドメインあたり 1 件まで", async () => {
		const id = await seedDomain("dom_unique", "mail.unique.example.com");
		const first = await callJson(adminAddresses(), "/", {
			method: "POST",
			body: JSON.stringify({ domainId: id, localPart: "any", isCatchAll: true }),
		});
		expect(first.status).toBe(201);

		const second = await callJson(adminAddresses(), "/", {
			method: "POST",
			body: JSON.stringify({ domainId: id, localPart: "other", isCatchAll: true }),
		});
		expect(second.status).toBe(409);
		expect(second.json.error.message).toContain("1 件までです");

		const plain = await callJson(adminAddresses(), "/", {
			method: "POST",
			body: JSON.stringify({ domainId: id, localPart: "plain" }),
		});
		const patched = await callJson(adminAddresses(), `/${plain.json.data.id}`, {
			method: "PATCH",
			body: JSON.stringify({ isCatchAll: true }),
		});
		expect(patched.status).toBe(409);
	});

	it("同じアドレスは二重に作れない", async () => {
		const id = await seedDomain("dom_dup", "mail.dup.example.com");
		const body = JSON.stringify({ domainId: id, localPart: "same" });
		expect((await callJson(adminAddresses(), "/", { method: "POST", body })).status).toBe(201);
		expect((await callJson(adminAddresses(), "/", { method: "POST", body })).status).toBe(409);
	});
});

describe("DELETE /admin/addresses/:id", () => {
	it("Cloudflare のルールも消す", async () => {
		const id = await seedDomain("dom_del", "mail.del.example.com");
		const created = await callJson(adminAddresses(), "/", {
			method: "POST",
			body: JSON.stringify({ domainId: id, localPart: "gone" }),
		});
		expect(fake.routingRules).toHaveLength(1);

		const res = await callJson(adminAddresses(), `/${created.json.data.id}`, { method: "DELETE" });
		expect(res.status).toBe(200);
		expect(res.json.data.routingRuleRemoved).toBe(true);
		expect(fake.routingRules).toEqual([]);
	});

	it("エイリアス先になっているアドレスは消せない", async () => {
		const id = await seedDomain("dom_dep", "mail.dep.example.com");
		const mailbox = await callJson(adminAddresses(), "/", {
			method: "POST",
			body: JSON.stringify({ domainId: id, localPart: "target" }),
		});
		await callJson(adminAddresses(), "/", {
			method: "POST",
			body: JSON.stringify({ domainId: id, localPart: "alias", kind: "alias", aliasTargetId: mailbox.json.data.id }),
		});

		const res = await callJson(adminAddresses(), `/${mailbox.json.data.id}`, { method: "DELETE" });
		expect(res.status).toBe(409);
	});
});

describe("GET /addresses（全ユーザー）", () => {
	it("触れるアドレスだけを level と未読件数付きで返す", async () => {
		const db = getTestDb();
		await seedDomain("dom_mine", "mail.mine.example.com");
		await db.insert(addresses).values([
			{ id: "adr_a", domainId: "dom_mine", localPart: "a", address: "a@mail.mine.example.com" },
			{ id: "adr_b", domainId: "dom_mine", localPart: "b", address: "b@mail.mine.example.com" },
			{ id: "adr_c", domainId: "dom_mine", localPart: "c", address: "c@mail.mine.example.com" },
		]);
		await db.insert(messages).values([
			{
				id: "msg1",
				addressId: "adr_a",
				direction: "inbound",
				status: "received",
				fromAddr: "x@example.com",
				isRead: false,
				receivedAt: new Date(),
			},
			{
				id: "msg2",
				addressId: "adr_a",
				direction: "inbound",
				status: "trash",
				fromAddr: "x@example.com",
				isRead: false,
				receivedAt: new Date(),
			},
			{
				id: "msg3",
				addressId: "adr_c",
				direction: "inbound",
				status: "received",
				fromAddr: "x@example.com",
				isRead: false,
				receivedAt: new Date(),
			},
		]);

		const app = mountRouter("/", addressRoutes, memberPrincipal(["adr_a", "adr_b"], ["adr_a"]));
		const res = await callJson(app, "/");

		expect(res.status).toBe(200);
		expect(res.json.data.map((a: any) => a.address)).toEqual([
			"a@mail.mine.example.com",
			"b@mail.mine.example.com",
		]);
		const a = res.json.data[0];
		expect(a.level).toBe("write");
		expect(a.unreadCount).toBe(1);
		expect(a.domainName).toBe("mail.mine.example.com");
		expect(res.json.data[1].level).toBe("read");
	});

	it("owner は全部見える", async () => {
		await seedDomain("dom_all", "mail.all.example.com");
		await getTestDb()
			.insert(addresses)
			.values({ id: "adr_all", domainId: "dom_all", localPart: "z", address: "z@mail.all.example.com" });

		const res = await callJson(mountRouter("/", addressRoutes, ownerPrincipal), "/");
		expect(res.json.data.some((a: any) => a.id === "adr_all")).toBe(true);
	});

	it("触れるアドレスが無ければ空", async () => {
		const res = await callJson(mountRouter("/", addressRoutes, memberPrincipal([])), "/");
		expect(res.json.data).toEqual([]);
	});
});
