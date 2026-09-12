import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import addressRoutes from "@/api/v1/addresses";
import adminAddressRoutes from "@/api/v1/admin/addresses";
import adminDomainRoutes from "@/api/v1/admin/domains";
import { addresses, auditLogs, domains, messages } from "@/db/schema";
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

async function seedDomain(
	id = "dom_test",
	name = "mail.example.com",
	mode: "apex" | "subdomain" = "subdomain",
) {
	await getTestDb()
		.insert(domains)
		.values({
			id,
			name,
			zoneId: "zone1",
			zoneName: "example.com",
			mode,
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

	it("無効化にも confirm が要る（#85）", async () => {
		const id = await seedDomain("dom_disable_no_confirm", "mail.no-confirm.example.com");
		await getTestDb().update(domains).set({ catchAllEnabled: true }).where(eq(domains.id, id));
		fake.catchAll.enabled = true;

		const res = await callJson(adminDomains(), `/${id}/catch-all`, {
			method: "POST",
			body: JSON.stringify({ enabled: false }),
		});

		expect(res.status).toBe(400);
		expect(res.json.error.message).toContain("confirm: true");
	});

	it("他ドメインが有効な間の無効化では、ゾーンの catch-all を落とさない（#85）", async () => {
		const idA = await seedDomain("dom_disable_a", "mail.disable-a.example.com");
		await getTestDb().update(domains).set({ catchAllEnabled: true }).where(eq(domains.id, idA));
		const idB = await seedDomain("dom_disable_b", "mail.disable-b.example.com");
		fake.catchAll.enabled = true;

		const res = await callJson(adminDomains(), `/${idB}/catch-all`, {
			method: "POST",
			body: JSON.stringify({ enabled: false, confirm: true }),
		});

		expect(res.status).toBe(200);
		// ゾーンの catch-all は落ちない（A の受け皿への到達を黙って止めない）。
		expect(fake.catchAll.enabled).toBe(true);
	});

	it("両方「有効」の破綻状態では一方の無効化で抜け出せる（#117）", async () => {
		const idA = await seedDomain("dom_broken_a", "mail.broken-a.example.com");
		const idB = await seedDomain("dom_broken_b", "mail.broken-b.example.com");
		// このファイルの DB は共有で zone1 には他のテストの有効な catch-all があるので、2 つだけのゾーンに移す。
		for (const id of [idA, idB]) {
			await getTestDb()
				.update(domains)
				.set({ zoneId: "zone-broken", catchAllEnabled: true })
				.where(eq(domains.id, id));
		}
		fake.catchAll.enabled = true;

		const res = await callJson(adminDomains(), `/${idB}/catch-all`, {
			method: "POST",
			body: JSON.stringify({ enabled: false, confirm: true }),
		});

		expect(res.status).toBe(200);
		expect(res.json.data.enabled).toBe(false);
		// A がまだ「有効」なので CF の catch-all は落とさない。落とすと A が有効表示のまま届かなくなる。
		expect(fake.catchAll.enabled).toBe(true);

		const last = await callJson(adminDomains(), `/${idA}/catch-all`, {
			method: "POST",
			body: JSON.stringify({ enabled: false, confirm: true }),
		});
		expect(last.status).toBe(200);
		expect(fake.catchAll.enabled).toBe(false);
	});

	it("他ドメインが残らなければ無効化できる（#85）", async () => {
		const id = await seedDomain("dom_disable_ok", "mail.disable-ok.example.com");
		await getTestDb()
			.update(domains)
			// このファイルの DB は共有で、他のテストが zone1 に catch-all を有効にしているので、
			// 「他ドメイン無し」を作るために別ゾーンへ移す。
			.set({ zoneId: "zone-ok", catchAllEnabled: true })
			.where(eq(domains.id, id));
		fake.catchAll.enabled = true;

		const res = await callJson(adminDomains(), `/${id}/catch-all`, {
			method: "POST",
			body: JSON.stringify({ enabled: false, confirm: true }),
		});

		expect(res.status).toBe(200);
		expect(res.json.data.enabled).toBe(false);
		expect(fake.catchAll.enabled).toBe(false);
	});

	it("切断しても、他ドメインが有効な間はゾーンの catch-all を落とさない（#85）", async () => {
		const idA = await seedDomain("dom_delete_a", "mail.delete-a.example.com");
		await getTestDb().update(domains).set({ catchAllEnabled: true }).where(eq(domains.id, idA));
		const idB = await seedDomain("dom_delete_b", "mail.delete-b.example.com");
		await getTestDb().update(domains).set({ catchAllEnabled: true }).where(eq(domains.id, idB));
		fake.catchAll.enabled = true;

		const res = await callJson(adminDomains(), `/${idB}`, { method: "DELETE" });

		expect(res.status).toBe(200);
		expect(fake.catchAll.enabled).toBe(true);
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

	it("apex 切断は配下に別接続のサブドメインがあれば 409（#18）", async () => {
		const apexId = await seedDomain("dom_apex_a", "apex-a.example.com", "apex");
		await seedDomain("dom_sub_a", "mail.apex-a.example.com", "subdomain");

		const res = await callJson(adminDomains(), `/${apexId}`, { method: "DELETE" });

		expect(res.status).toBe(409);
		expect(fake.dnsRecords.some((r) => r.id === "apex-mx")).toBe(true);
	});

	it("apex 切断は配下の接続を先に外せば通る（#18）", async () => {
		const apexId = await seedDomain("dom_apex_b", "apex-b.example.com", "apex");
		const subId = await seedDomain("dom_sub_b", "mail.apex-b.example.com", "subdomain");

		expect((await callJson(adminDomains(), `/${subId}`, { method: "DELETE" })).status).toBe(200);
		expect((await callJson(adminDomains(), `/${apexId}`, { method: "DELETE" })).status).toBe(200);
	});

	it("cleanup クエリが不正なら 400（#18）", async () => {
		const id = await seedDomain("dom_badquery", "mail.badquery.example.com");
		const res = await callJson(adminDomains(), `/${id}?cleanup=maybe`, { method: "DELETE" });
		expect(res.status).toBe(400);
	});
});

describe("POST /admin/domains/:id/sending", () => {
	it("enableSending: false で繋いだドメインを有効化すると pending か active になる", async () => {
		const id = await seedDomain("dom_send_off", "mail.send-off.example.com");
		await getTestDb().update(domains).set({ sendingStatus: "disabled" }).where(eq(domains.id, id));

		const res = await callJson(adminDomains(), `/${id}/sending`, {
			method: "POST",
			body: JSON.stringify({ enabled: true }),
		});

		expect(res.status).toBe(200);
		expect(["pending", "active"]).toContain(res.json.data.sendingStatus);
		const row = await getTestDb().query.domains.findFirst({ where: eq(domains.id, id) });
		expect(row?.sendingStatus).toBe(res.json.data.sendingStatus);
		// 有効化で Email Sending の subdomain を 1 つ作る
		expect(fake.find((r) => r.method === "POST" && /email\/sending\/subdomains$/.test(r.path))).toHaveLength(1);
	});

	it("enabled: false で sending_status を disabled に戻す（DNS は消さない）", async () => {
		const id = await seedDomain("dom_send_off2", "mail.send-off2.example.com");
		await getTestDb().update(domains).set({ sendingStatus: "active" }).where(eq(domains.id, id));
		fake.dnsRecords.push(
			{ id: "s-spf", type: "TXT", name: "mail.send-off2.example.com", content: "v=spf1 include:_spf.mx.cloudflare.net ~all" },
			{ id: "s-dkim", type: "TXT", name: "cf-bounce._domainkey.mail.send-off2.example.com", content: "v=DKIM1; p=AAA" },
		);

		const res = await callJson(adminDomains(), `/${id}/sending`, {
			method: "POST",
			body: JSON.stringify({ enabled: false }),
		});

		expect(res.status).toBe(200);
		expect(res.json.data.sendingStatus).toBe("disabled");
		const row = await getTestDb().query.domains.findFirst({ where: eq(domains.id, id) });
		expect(row?.sendingStatus).toBe("disabled");
		expect(fake.dnsRecords.some((r) => r.id === "s-spf")).toBe(true);
		expect(fake.dnsRecords.some((r) => r.id === "s-dkim")).toBe(true);
	});

	it("監査ログに domain.sending を記録する", async () => {
		const id = await seedDomain("dom_send_audit", "mail.send-audit.example.com");
		await getTestDb().update(domains).set({ sendingStatus: "disabled" }).where(eq(domains.id, id));

		await callJson(adminDomains(), `/${id}/sending`, {
			method: "POST",
			body: JSON.stringify({ enabled: true }),
		});

		const rows = await getTestDb().select().from(auditLogs).all();
		expect(rows.find((r) => r.targetId === id && r.action === "domain.sending")).toBeTruthy();
	});
});

describe("GET /admin/domains/:id", () => {
	it("配下のアドレスを返す", async () => {
		const id = await seedDomain("dom_detail", "mail.detail.example.com");
		await getTestDb().insert(addresses).values({
			id: "adr_detail",
			domainId: id,
			localPart: "inbox",
			address: "inbox@mail.detail.example.com",
		});

		const res = await callJson(adminDomains(), `/${id}`);
		expect(res.status).toBe(200);
		expect(res.json.data.addresses[0].address).toBe("inbox@mail.detail.example.com");
	});
});

describe("管理系ルータの門（#31）", () => {
	it.each([
		["domains", adminDomainRoutes],
		["addresses", adminAddressRoutes],
	] as const)("%s のルータ単体でも、admin スコープの無い owner は 403", async (_name, router) => {
		const app = mountRouter("/", router, {
			...ownerPrincipal,
			via: "api_key",
			scopes: ["read", "send"],
		});
		const res = await callJson(app, "/");
		expect(res.status).toBe(403);
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

describe("PATCH /admin/addresses/:id でエイリアスの連鎖を作れない（#36）", () => {
	it("A→B の状態で B を alias→C にはできない", async () => {
		const id = await seedDomain("dom_chain", "mail.chain.example.com");
		const b = await callJson(adminAddresses(), "/", {
			method: "POST",
			body: JSON.stringify({ domainId: id, localPart: "b" }),
		});
		const c = await callJson(adminAddresses(), "/", {
			method: "POST",
			body: JSON.stringify({ domainId: id, localPart: "c" }),
		});
		const a = await callJson(adminAddresses(), "/", {
			method: "POST",
			body: JSON.stringify({
				domainId: id,
				localPart: "a",
				kind: "alias",
				aliasTargetId: b.json.data.id,
			}),
		});
		expect(a.status).toBe(201);

		// B を alias→C にすると、A 宛のメールが宛先を失う（連鎖）。拒否する。
		const res = await callJson(adminAddresses(), `/${b.json.data.id}`, {
			method: "PATCH",
			body: JSON.stringify({ kind: "alias", aliasTargetId: c.json.data.id }),
		});
		expect(res.status).toBe(409);
	});

	it("誰もエイリアス先にしていないアドレスは alias 化できる", async () => {
		const id = await seedDomain("dom_chain2", "mail.chain2.example.com");
		const target = await callJson(adminAddresses(), "/", {
			method: "POST",
			body: JSON.stringify({ domainId: id, localPart: "target" }),
		});
		const solo = await callJson(adminAddresses(), "/", {
			method: "POST",
			body: JSON.stringify({ domainId: id, localPart: "solo" }),
		});

		const res = await callJson(adminAddresses(), `/${solo.json.data.id}`, {
			method: "PATCH",
			body: JSON.stringify({ kind: "alias", aliasTargetId: target.json.data.id }),
		});
		expect(res.status).toBe(200);
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

describe("subdomain 同士の入れ子切断（#60）", () => {
	it("配下に別接続があれば cleanup 付き切断は 409 で、配下の MX / TXT は残る", async () => {
		const parentId = await seedDomain("dom_parent", "mail.p60a.example.com", "subdomain");
		const deepId = await seedDomain("dom_deep", "deep.mail.p60a.example.com", "subdomain");
		fake.dnsRecords.push(
			{ id: "deep-mx", type: "MX", name: "deep.mail.p60a.example.com", content: "route1.mx.cloudflare.net" },
			{ id: "deep-spf", type: "TXT", name: "deep.mail.p60a.example.com", content: "v=spf1 include:_spf.mx.cloudflare.net ~all" },
		);

		const res = await callJson(adminDomains(), `/${parentId}`, { method: "DELETE" });

		expect(res.status).toBe(409);
		expect(fake.dnsRecords.some((r) => r.id === "deep-mx")).toBe(true);
		expect(fake.dnsRecords.some((r) => r.id === "deep-spf")).toBe(true);
		// deep 側も DB に残っている
		const deepRow = (await getTestDb().select().from(domains).where(eq(domains.id, deepId)).get())!;
		expect(deepRow.id).toBe(deepId);
	});

	it("無関係な兄弟（other.example.com）は影響しない", async () => {
		const parentId = await seedDomain("dom_sib_parent", "mail.p60b.example.com", "subdomain");
		const siblingId = await seedDomain("dom_sib", "other.p60b.example.com", "subdomain");
		fake.dnsRecords.push({
			id: "other-mx",
			type: "MX",
			name: "other.p60b.example.com",
			content: "route1.mx.cloudflare.net",
		});

		const res = await callJson(adminDomains(), `/${parentId}`, { method: "DELETE" });

		expect(res.status).toBe(200);
		// 兄弟のレコードは消さない
		expect(fake.dnsRecords.some((r) => r.id === "other-mx")).toBe(true);
	});
});

describe("別ドメインへのエイリアス（#61）", () => {
	it("別ドメインのアドレスを aliasTarget にすると 400", async () => {
		const domA = await seedDomain("dom_61a", "mail.a61.example.com");
		const domB = await seedDomain("dom_61b", "mail.b61.example.com");
		const mailboxB = await callJson(adminAddresses(), "/", {
			method: "POST",
			body: JSON.stringify({ domainId: domB, localPart: "inbox" }),
		});
		expect(mailboxB.status).toBe(201);
		const baselineRules = fake.routingRules.length;

		const res = await callJson(adminAddresses(), "/", {
			method: "POST",
			body: JSON.stringify({
				domainId: domA,
				localPart: "sales",
				kind: "alias",
				aliasTargetId: mailboxB.json.data.id,
			}),
		});
		expect(res.status).toBe(400);
		// 失敗した作成でルーティングルールは増えない
		expect(fake.routingRules.length).toBe(baselineRules);
	});

	it("PATCH で別ドメインへエイリアス化すると 400", async () => {
		const domA = await seedDomain("dom_61p", "mail.p61.example.com");
		const domB = await seedDomain("dom_bp", "mail.bp61.example.com");
		const targetB = await callJson(adminAddresses(), "/", {
			method: "POST",
			body: JSON.stringify({ domainId: domB, localPart: "inbox" }),
		});
		const solo = await callJson(adminAddresses(), "/", {
			method: "POST",
			body: JSON.stringify({ domainId: domA, localPart: "solo" }),
		});

		const res = await callJson(adminAddresses(), `/${solo.json.data.id}`, {
			method: "PATCH",
			body: JSON.stringify({ kind: "alias", aliasTargetId: targetB.json.data.id }),
		});
		expect(res.status).toBe(400);
	});

	it("別ドメインのエイリアスが向き先のドメインの DELETE は 409（#61）", async () => {
		const domA = await seedDomain("dom_61del", "mail.del61.example.com");
		const domB = await seedDomain("dom_61delb", "mail.del61b.example.com");
		const mailboxA = await callJson(adminAddresses(), "/", {
			method: "POST",
			body: JSON.stringify({ domainId: domA, localPart: "inbox" }),
		});
		// 修正前の越境エイリアスを疑似的に再現（この操作自体は今は API で拒否される）。
		await getTestDb().insert(addresses).values({
			id: "adr_cross_alias",
			domainId: domB,
			localPart: "sales",
			address: `sales@mail.del61b.example.com`,
			kind: "alias",
			aliasTargetId: mailboxA.json.data.id,
		});

		const res = await callJson(adminDomains(), `/${domA}`, { method: "DELETE" });
		expect(res.status).toBe(409);
	});
});

describe("管理 API の監査（#95）", () => {
	it("ドメイン接続が domain.connect として記録される", async () => {
		const res = await callJson(adminDomains(), "/", {
			method: "POST",
			body: JSON.stringify({ name: "mail.audit.example.net", localParts: ["ai"] }),
		});
		expect(res.status).toBe(201);
		const rows = await getTestDb().select().from(auditLogs).all();
		expect(rows.map((r) => r.action)).toContain("domain.connect");
	});

	it("アドレス作成が address.create として記録される", async () => {
		const id = await seedDomain("dom_audit_addr", "mail.auditaddr.example.com");
		const res = await callJson(adminAddresses(), "/", {
			method: "POST",
			body: JSON.stringify({ domainId: id, localPart: "inbox" }),
		});
		expect(res.status).toBe(201);
		const rows = await getTestDb().select().from(auditLogs).all();
		expect(rows.map((r) => r.action)).toContain("address.create");
	});

	it("アドレスの更新と削除が address.update / address.delete として記録される", async () => {
		const id = await seedDomain("dom_audit_adr2", "mail.auditadr2.example.com");
		const created = await callJson(adminAddresses(), "/", {
			method: "POST",
			body: JSON.stringify({ domainId: id, localPart: "inbox" }),
		});
		const addressId = created.json.data.id;

		expect(
			(
				await callJson(adminAddresses(), `/${addressId}`, {
					method: "PATCH",
					body: JSON.stringify({ displayName: "更新" }),
				})
			).status,
		).toBe(200);

		let rows = await getTestDb().select().from(auditLogs).all();
		expect(rows.find((r) => r.targetId === addressId && r.action === "address.update")).toBeTruthy();

		expect((await callJson(adminAddresses(), `/${addressId}`, { method: "DELETE" })).status).toBe(200);
		rows = await getTestDb().select().from(auditLogs).all();
		expect(rows.find((r) => r.targetId === addressId && r.action === "address.delete")).toBeTruthy();
	});

	it("catch-all の変更が domain.catchall として記録される", async () => {
		const id = await seedDomain("dom_audit_ca", "mail.auditca.example.com");
		await getTestDb().insert(addresses).values({
			id: "adr_audit_ca",
			domainId: id,
			localPart: "any",
			address: "any@mail.auditca.example.com",
			isCatchAll: true,
		});

		const res = await callJson(adminDomains(), `/${id}/catch-all`, {
			method: "POST",
			body: JSON.stringify({ enabled: true, confirm: true }),
		});
		expect(res.status).toBe(200);
		const rows = await getTestDb().select().from(auditLogs).all();
		expect(rows.find((r) => r.targetId === id && r.action === "domain.catchall")).toBeTruthy();
	});

	it("ドメイン切断が domain.disconnect として記録される", async () => {
		const id = await seedDomain("dom_audit_del", "mail.auditdel.example.com");
		const res = await callJson(adminDomains(), `/${id}`, { method: "DELETE" });
		expect(res.status).toBe(200);
		const rows = await getTestDb().select().from(auditLogs).all();
		expect(rows.find((r) => r.targetId === id && r.action === "domain.disconnect")).toBeTruthy();
	});
});
