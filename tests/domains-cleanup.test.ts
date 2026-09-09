import { describe, expect, it } from "vitest";
import { cleanupDomain, isOwnDnsRecord, isOwnRoutingRule } from "@/domain/domains/cleanup";
import { CloudflareApi } from "@/services/cloudflare-api";
import { createFakeCloudflare, testEnv } from "./domains-helpers";

const target = {
	zoneId: "zone1",
	zoneName: "example.com",
	name: "mail.example.com",
	mode: "subdomain" as const,
	workerName: "tsubame",
	catchAllEnabled: false,
};

describe("isOwnRoutingRule", () => {
	it("自分の Worker 宛かつ自分のドメイン宛のものだけ", () => {
		const own = {
			tag: "t1",
			enabled: true,
			matchers: [{ type: "literal", field: "to", value: "ai@mail.example.com" }],
			actions: [{ type: "worker", value: ["tsubame"] }],
		};
		expect(isOwnRoutingRule(own, target)).toBe(true);

		expect(
			isOwnRoutingRule({ ...own, actions: [{ type: "worker", value: ["other-app"] }] }, target),
		).toBe(false);

		expect(
			isOwnRoutingRule({ ...own, actions: [{ type: "forward", value: ["a@b.jp"] }] }, target),
		).toBe(false);

		expect(
			isOwnRoutingRule(
				{ ...own, matchers: [{ type: "literal", field: "to", value: "x@other.llc" }] },
				target,
			),
		).toBe(false);
	});
});

describe("isOwnDnsRecord", () => {
	it("Cloudflare のメール用レコードだけを自分のものと見なす", () => {
		expect(
			isOwnDnsRecord({ type: "MX", name: "mail.example.com", content: "route1.mx.cloudflare.net" }, target),
		).toBe(true);
		expect(
			isOwnDnsRecord(
				{ type: "TXT", name: "mail.example.com", content: "v=spf1 include:_spf.mx.cloudflare.net ~all" },
				target,
			),
		).toBe(true);
		expect(
			isOwnDnsRecord(
				{ type: "TXT", name: "cf-bounce._domainkey.mail.example.com", content: "v=DKIM1; p=AAA" },
				target,
			),
		).toBe(true);
	});

	it("apex と他人のレコードには触らない", () => {
		expect(
			isOwnDnsRecord({ type: "MX", name: "example.com", content: "aspmx.l.google.com" }, target),
		).toBe(false);
		expect(
			isOwnDnsRecord({ type: "MX", name: "mail.example.com", content: "mx.sakura.ne.jp" }, target),
		).toBe(false);
		// Worker を指す A レコード（消すと Web が落ちる）
		expect(isOwnDnsRecord({ type: "A", name: "mail.example.com", content: "192.0.2.1" }, target)).toBe(
			false,
		);
		// DMARC は誰が作ったか分からないので残す
		expect(
			isOwnDnsRecord(
				{ type: "TXT", name: "_dmarc.mail.example.com", content: "v=DMARC1; p=reject" },
				target,
			),
		).toBe(false);
	});
});

describe("cleanupDomain", () => {
	it("自分のものだけ消し、残したものを報告する", async () => {
		const fake = createFakeCloudflare({
			zones: [{ id: "zone1", name: "example.com" }],
			dnsRecords: [
				{ id: "apex-mx", type: "MX", name: "example.com", content: "aspmx.l.google.com", priority: 1 },
				{ id: "mine-mx", type: "MX", name: "mail.example.com", content: "route1.mx.cloudflare.net", priority: 1 },
				{ id: "mine-spf", type: "TXT", name: "mail.example.com", content: "v=spf1 include:_spf.mx.cloudflare.net ~all" },
				{ id: "web-a", type: "A", name: "mail.example.com", content: "192.0.2.1" },
				{ id: "dmarc", type: "TXT", name: "_dmarc.mail.example.com", content: "v=DMARC1; p=reject" },
			],
			routingRules: [
				{
					tag: "mine",
					matchers: [{ type: "literal", field: "to", value: "ai@mail.example.com" }],
					actions: [{ type: "worker", value: ["tsubame"] }],
				},
				{
					tag: "someone-else",
					matchers: [{ type: "literal", field: "to", value: "info@example.com" }],
					actions: [{ type: "forward", value: ["hirao@example.com"] }],
				},
			],
		});

		const result = await cleanupDomain(new CloudflareApi(testEnv, { fetch: fake.fetch }), target);

		expect(result.removedRoutingRules).toEqual(["mine"]);
		expect(fake.routingRules.map((r) => r.tag)).toEqual(["someone-else"]);

		expect(result.removedDnsRecords.sort()).toEqual(["MX mail.example.com", "TXT mail.example.com"]);
		expect(fake.dnsRecords.map((r) => r.id).sort()).toEqual(["apex-mx", "dmarc", "web-a"]);

		expect(result.skippedDnsRecords.sort()).toEqual(["A mail.example.com", "TXT _dmarc.mail.example.com"]);
		expect(result.failures).toEqual([]);
		expect(result.catchAllDisabled).toBe(false);
	});

	it("消せなかったものを failures に残す", async () => {
		const fake = createFakeCloudflare({
			zones: [{ id: "zone1", name: "example.com" }],
			dnsRecords: [
				{ id: "mine-mx", type: "MX", name: "mail.example.com", content: "route1.mx.cloudflare.net" },
			],
			failWith: (req) =>
				req.method === "DELETE" && /dns_records\//.test(req.path)
					? { status: 403, errors: [{ code: 9109, message: "Unauthorized" }] }
					: undefined,
		});

		const result = await cleanupDomain(new CloudflareApi(testEnv, { fetch: fake.fetch }), target);

		expect(result.removedDnsRecords).toEqual([]);
		expect(result.failures).toHaveLength(1);
		expect(result.failures[0]).toMatchObject({ kind: "dns_record", label: "MX mail.example.com" });
		expect(result.failures[0]!.reason).toContain("CF_API_TOKEN");
	});

	it("catch-all を有効にしていたら無効化する", async () => {
		const fake = createFakeCloudflare({ zones: [{ id: "zone1", name: "example.com" }] });
		fake.catchAll.enabled = true;

		const result = await cleanupDomain(new CloudflareApi(testEnv, { fetch: fake.fetch }), {
			...target,
			catchAllEnabled: true,
		});

		expect(result.catchAllDisabled).toBe(true);
		expect(fake.catchAll.enabled).toBe(false);
	});
});
