import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { domains } from "@/db/schema";
import {
	enableSending,
	provisionDomain,
	pickZoneForName,
	readSendingDnsState,
	resolveZone,
	verifyDomain,
} from "@/domain/domains/provision";
import { CloudflareApi } from "@/services/cloudflare-api";
import { applyMigrations, createFakeCloudflare, getTestDb, testEnv } from "./domains-helpers";
import type { FakeCloudflare, RecordedRequest } from "./domains-helpers";

beforeAll(async () => {
	await applyMigrations();
});

const googleApexRecords = [
	{ id: "r1", type: "MX", name: "example.com", content: "aspmx.l.google.com", priority: 1 },
	{ id: "r2", type: "TXT", name: "example.com", content: "google-site-verification=xxxx" },
];

function apiOf(fake: FakeCloudflare) {
	return new CloudflareApi(testEnv, { fetch: fake.fetch });
}

function apexWrites(requests: RecordedRequest[], apex: string): RecordedRequest[] {
	return requests.filter((req) => {
		if (req.method === "GET") return false;
		const name = typeof req.body?.name === "string" ? req.body.name : null;
		if (name === apex) return true;
		if (/\/dns_records$/.test(req.path) && name === apex) return true;
		return false;
	});
}

describe("pickZoneForName", () => {
	it("最も具体的なゾーンを選ぶ", () => {
		const zones = [
			{ id: "a", name: "example.com" },
			{ id: "b", name: "sub.example.com" },
			{ id: "c", name: "other.com" },
		];
		expect(pickZoneForName(zones, "mail.sub.example.com")?.id).toBe("b");
		expect(pickZoneForName(zones, "mail.example.com")?.id).toBe("a");
		expect(pickZoneForName(zones, "nope.example")).toBeNull();
	});
});

describe("readSendingDnsState", () => {
	it("SPF / DKIM / DMARC を読む", () => {
		const state = readSendingDnsState(
			[
				{ type: "TXT", name: "mail.example.com", content: "v=spf1 include:_spf.mx.cloudflare.net ~all" },
				{ type: "TXT", name: "cf-bounce._domainkey.mail.example.com", content: "v=DKIM1; p=AAA" },
				{ type: "TXT", name: "_dmarc.mail.example.com", content: "v=DMARC1; p=reject" },
			],
			"mail.example.com",
		);
		expect(state).toEqual({ spf: true, dkim: true, dmarc: true });
	});

	it("apex のレコードをサブドメインのものと取り違えない", () => {
		const state = readSendingDnsState(
			[{ type: "TXT", name: "example.com", content: "v=spf1 include:_spf.google.com ~all" }],
			"mail.example.com",
		);
		expect(state.spf).toBe(false);
	});
});

describe("resolveZone（#94 アカウント絞り込み）", () => {
	it("他アカウントのゾーンを候補に入れない", async () => {
		const fake = createFakeCloudflare({
			zones: [
				{ id: "mine", name: "example.com", account: { id: "test-account" } },
				{ id: "theirs", name: "evil.example", account: { id: "other-account" } },
			],
		});
		const api = apiOf(fake);

		await expect(resolveZone(api, { name: "mail.example.com" })).resolves.toEqual({
			id: "mine",
			name: "example.com",
		});
		await expect(resolveZone(api, { name: "mail.evil.example" })).rejects.toMatchObject({
			code: "not_found",
		});
	});
});

describe("provisionDomain の接続リクエスト数（#93）", () => {
	it("localParts 50 件でもルール一覧は 1 回しか取得しない", async () => {
		const fake = createFakeCloudflare({ zones: [{ id: "zone1", name: "rate.test" }] });
		const parts = Array.from({ length: 50 }, (_, i) => `u${i}`);

		const result = await provisionDomain({
			db: getTestDb(),
			api: apiOf(fake),
			env: testEnv,
			input: { name: "mail.rate.test", localParts: parts },
		});
		expect(result.createdAddressIds).toHaveLength(50);

		const listCalls = fake.requests.filter(
			(r) => r.method === "GET" && /\/email\/routing\/rules$/.test(r.path),
		);
		expect(listCalls).toHaveLength(1);
	});
});

describe("provisionDomain", () => {
	it("サブドメイン運用では apex の MX を一度も触らない", async () => {
		const fake = createFakeCloudflare({
			zones: [{ id: "zone1", name: "example.com" }],
			dnsRecords: [...googleApexRecords],
		});

		const result = await provisionDomain({
			db: getTestDb(),
			api: apiOf(fake),
			env: testEnv,
			input: { name: "mail.example.com", localParts: ["ai"] },
		});

		expect(result.mode).toBe("subdomain");
		expect(result.routingStatus).toBe("active");

		expect(apexWrites(fake.requests, "example.com")).toEqual([]);

		const routingDns = fake.find((r) => r.method === "POST" && /email\/routing\/dns$/.test(r.path));
		expect(routingDns).toHaveLength(1);
		expect(routingDns[0]!.body).toMatchObject({ name: "mail.example.com" });

		// 3. enable も name 付き（省略すると apex に MX が作られうる）
		const enable = fake.find((r) => /email\/routing\/enable$/.test(r.path));
		expect(enable[0]!.body).toMatchObject({ name: "mail.example.com" });

		expect(fake.dnsRecords.find((r) => r.id === "r1")).toBeTruthy();

		const createdMx = fake.dnsRecords.filter((r) => r.type === "MX" && r.id !== "r1");
		expect(createdMx.every((r) => r.name === "mail.example.com")).toBe(true);

		expect(fake.routingRules).toHaveLength(1);
		expect(fake.routingRules[0]!.actions).toEqual([{ type: "worker", value: ["tsubame"] }]);
		expect(fake.routingRules[0]!.matchers).toEqual([
			{ type: "literal", field: "to", value: "ai@mail.example.com" },
		]);
	});

	it("catch-all は既定で有効化しない", async () => {
		const fake = createFakeCloudflare({
			zones: [{ id: "zone1", name: "example.net" }],
		});

		const result = await provisionDomain({
			db: getTestDb(),
			api: apiOf(fake),
			env: testEnv,
			input: { name: "mail.example.net" },
		});

		expect(result.catchAllEnabled).toBe(false);
		expect(fake.catchAll.enabled).toBe(false);
		expect(fake.find((r) => /catch_all$/.test(r.path) && r.method === "PUT")).toEqual([]);

		const row = await getTestDb().query.domains.findFirst({
			where: eq(domains.name, "mail.example.net"),
		});
		expect(row?.catchAllEnabled).toBe(false);
	});

	it("apex は confirmApex 無しでは拒否する（DB にも Cloudflare にも何もしない）", async () => {
		const fake = createFakeCloudflare({
			zones: [{ id: "zone1", name: "example.com" }],
			dnsRecords: [...googleApexRecords],
		});

		const error = await provisionDomain({
			db: getTestDb(),
			api: apiOf(fake),
			env: testEnv,
			input: { name: "example.com" },
		}).catch((e) => e);

		expect(error.code).toBe("invalid_request");
		expect(error.status).toBe(400);
		expect(error.message).toContain("confirmApex: true");
		expect(error.message).toContain("mail.example.com");

		expect(fake.requests.every((r) => r.method === "GET")).toBe(true);
		const row = await getTestDb().query.domains.findFirst({ where: eq(domains.name, "example.com") });
		expect(row).toBeUndefined();
	});

	it("confirmApex: true なら apex を接続できる", async () => {
		const fake = createFakeCloudflare({ zones: [{ id: "zone1", name: "apex-ok.test" }] });

		const result = await provisionDomain({
			db: getTestDb(),
			api: apiOf(fake),
			env: testEnv,
			input: { name: "apex-ok.test", confirmApex: true },
		});

		expect(result.mode).toBe("apex");
		expect(result.dnsCheck.requiresApexConfirmation).toBe(true);

		// apex は name を渡すと Cloudflare が 2007 で弾く（name はサブドメイン専用の指定子で、
		// apex 自身は「apex のサブドメイン」に当たらない）。apex は既定なので省略して有効化する。
		const enable = fake.find((r) => /email\/routing\/enable$/.test(r.path));
		expect(enable).toHaveLength(1);
		expect(enable[0]!.body).toEqual({});

		const routingDns = fake.find(
			(r) => r.method === "POST" && /email\/routing\/dns$/.test(r.path),
		);
		expect(routingDns).toHaveLength(1);
		expect(routingDns[0]!.body).toEqual({});
	});

	it("同じドメインは二重に接続できない", async () => {
		const fake = createFakeCloudflare({ zones: [{ id: "zone1", name: "dup.test" }] });
		const db = getTestDb();
		await provisionDomain({
			db,
			api: apiOf(fake),
			env: testEnv,
			input: { name: "mail.dup.test" },
		});
		const error = await provisionDomain({
			db,
			api: apiOf(fake),
			env: testEnv,
			input: { name: "mail.dup.test" },
		}).catch((e) => e);
		expect(error.code).toBe("conflict");
	});

	it("途中で失敗したら lastError と error ステータスを残す", async () => {
		const fake = createFakeCloudflare({
			zones: [{ id: "zone1", name: "broken.test" }],
			failWith: (req) =>
				/email\/routing\/enable$/.test(req.path)
					? { status: 403, errors: [{ code: 9109, message: "Unauthorized" }] }
					: undefined,
		});

		const error = await provisionDomain({
			db: getTestDb(),
			api: apiOf(fake),
			env: testEnv,
			input: { name: "mail.broken.test" },
		}).catch((e) => e);

		expect(error.code).toBe("forbidden");
		expect(error.message).toContain("CF_API_TOKEN");

		const row = await getTestDb().query.domains.findFirst({
			where: eq(domains.name, "mail.broken.test"),
		});
		expect(row?.routingStatus).toBe("error");
		expect(row?.lastError).toContain("CF_API_TOKEN");
	});
});

describe("enableSending", () => {
	it("後から有効化すると Email Sending を作り、状態を DB に保存する", async () => {
		const fake = createFakeCloudflare({ zones: [{ id: "zone1", name: "late.test" }] });
		const db = getTestDb();
		await db.insert(domains).values({
			id: "dom_late",
			name: "mail.late.test",
			zoneId: "zone1",
			zoneName: "late.test",
			mode: "subdomain",
			routingStatus: "active",
			sendingStatus: "disabled",
		});

		const result = await enableSending({
			db,
			api: apiOf(fake),
			domain: { id: "dom_late", name: "mail.late.test", zoneId: "zone1", zoneName: "late.test" },
		});

		// 送信用の SPF / DKIM が無いので pending になる。
		expect(["pending", "active"]).toContain(result.sendingStatus);
		expect(fake.find((r) => r.method === "POST" && /email\/sending\/subdomains$/.test(r.path))).toHaveLength(1);
		const row = await db.query.domains.findFirst({ where: eq(domains.id, "dom_late") });
		expect(row?.sendingStatus).toBe(result.sendingStatus);
		expect(row?.lastError).toBeNull();
	});

	it("既に送信用のレコードがあれば active を保存する", async () => {
		const fake = createFakeCloudflare({ zones: [{ id: "zone1", name: "ready.test" }] });
		fake.dnsRecords.push(
			{ id: "r-spf", type: "TXT", name: "mail.ready.test", content: "v=spf1 include:_spf.mx.cloudflare.net ~all" },
			{ id: "r-dkim", type: "TXT", name: "cf-bounce._domainkey.mail.ready.test", content: "v=DKIM1; p=AAA" },
		);
		const db = getTestDb();
		await db.insert(domains).values({
			id: "dom_ready",
			name: "mail.ready.test",
			zoneId: "zone1",
			zoneName: "ready.test",
			mode: "subdomain",
			routingStatus: "active",
			sendingStatus: "disabled",
		});

		const result = await enableSending({
			db,
			api: apiOf(fake),
			domain: { id: "dom_ready", name: "mail.ready.test", zoneId: "zone1", zoneName: "ready.test" },
		});

		expect(result.sendingStatus).toBe("active");
	});

	it("Cloudflare API が失敗したら error と lastError を保存する", async () => {
		const fake = createFakeCloudflare({
			zones: [{ id: "zone1", name: "latefail.test" }],
			failWith: (req) =>
				/email\/sending\/subdomains$/.test(req.path) && req.method === "POST"
					? { status: 403, errors: [{ code: 9109, message: "Unauthorized" }] }
					: undefined,
		});
		const db = getTestDb();
		await db.insert(domains).values({
			id: "dom_latefail",
			name: "mail.latefail.test",
			zoneId: "zone1",
			zoneName: "latefail.test",
			mode: "subdomain",
			routingStatus: "active",
			sendingStatus: "disabled",
		});

		const result = await enableSending({
			db,
			api: apiOf(fake),
			domain: { id: "dom_latefail", name: "mail.latefail.test", zoneId: "zone1", zoneName: "latefail.test" },
		});

		expect(result.sendingStatus).toBe("error");
		const row = await db.query.domains.findFirst({ where: eq(domains.id, "dom_latefail") });
		expect(row?.sendingStatus).toBe("error");
		expect(result.lastError).toBeTruthy();
	});
});

describe("verifyDomain", () => {
	// 接続の途中で routing が失敗すると、再検査しても enable を呼び直さない限り
	// pending のまま直らない（削除して作り直すしかなくなる）。
	it("routing が pending なら enable を呼び直して復旧する", async () => {
		let failRouting = true;
		const fake = createFakeCloudflare({
			zones: [{ id: "zone1", name: "recover.test" }],
			failWith: (req) =>
				failRouting && /email\/routing\/(enable|dns)$/.test(req.path)
					? { status: 400, errors: [{ code: 2007, message: "Invalid Input" }] }
					: undefined,
		});
		const db = getTestDb();

		// 接続は routing で落ちる。行は error のまま残り、あとで再検査に賭けることになる。
		await provisionDomain({
			db,
			api: apiOf(fake),
			env: testEnv,
			input: { name: "recover.test", confirmApex: true, enableSending: false },
		}).catch(() => undefined);

		const before = await db.query.domains.findFirst({
			where: eq(domains.name, "recover.test"),
		});
		expect(before?.routingStatus).toBe("error");

		// Cloudflare 側が直った後に再検査する。
		failRouting = false;
		const result = await verifyDomain({
			db,
			api: apiOf(fake),
			domain: {
				id: before!.id,
				name: before!.name,
				zoneId: before!.zoneId,
				zoneName: before!.zoneName,
				sendingStatus: before!.sendingStatus,
				routingStatus: before!.routingStatus,
				mode: before!.mode,
			},
		});

		expect(result.routingStatus).toBe("active");
		expect(result.lastError).toBeNull();

		// apex なので name を渡さずに呼び直している。
		const enable = fake.find((r) => /email\/routing\/enable$/.test(r.path));
		expect(enable.at(-1)!.body).toEqual({});
	});

	it("routing が既に active なら enable を呼ばない", async () => {
		const fake = createFakeCloudflare({ zones: [{ id: "zone1", name: "stable.test" }] });
		const db = getTestDb();

		await provisionDomain({
			db,
			api: apiOf(fake),
			env: testEnv,
			input: { name: "mail.stable.test", enableSending: false },
		});
		const row = await db.query.domains.findFirst({
			where: eq(domains.name, "mail.stable.test"),
		});
		const before = fake.find((r) => /email\/routing\/enable$/.test(r.path)).length;

		await verifyDomain({
			db,
			api: apiOf(fake),
			domain: {
				id: row!.id,
				name: row!.name,
				zoneId: row!.zoneId,
				zoneName: row!.zoneName,
				sendingStatus: row!.sendingStatus,
				routingStatus: row!.routingStatus,
				mode: row!.mode,
			},
		});

		expect(fake.find((r) => /email\/routing\/enable$/.test(r.path))).toHaveLength(before);
	});
});
