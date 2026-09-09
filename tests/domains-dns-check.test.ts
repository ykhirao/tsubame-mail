import { describe, expect, it } from "vitest";
import {
	classifyMx,
	hasBlockingWarning,
	inspectDnsRecords,
	isWithinZone,
	isZoneApex,
} from "@/domain/domains/dns-check";

/** legacy-deployment-notes.md の example.com を模した現実的なゾーン。 */
const exampleRecords = [
	{ type: "MX", name: "example.com", content: "aspmx.l.google.com", priority: 1 },
	{ type: "MX", name: "example.com", content: "alt1.aspmx.l.google.com", priority: 5 },
	{ type: "TXT", name: "example.com", content: "google-site-verification=xxxx" },
	{ type: "A", name: "mail.example.com", content: "192.0.2.1" },
];

describe("classifyMx", () => {
	it("提供元を見分ける", () => {
		expect(classifyMx("route1.mx.cloudflare.net")).toBe("cloudflare");
		expect(classifyMx("aspmx.l.google.com.")).toBe("google");
		expect(classifyMx("example-com.mail.protection.outlook.com")).toBe("microsoft");
		expect(classifyMx("mx.sakura.ne.jp")).toBe("other");
	});
});

describe("ゾーンの判定", () => {
	it("apex と配下を区別する", () => {
		expect(isZoneApex("example.com", "example.com")).toBe(true);
		expect(isZoneApex("mail.example.com", "example.com")).toBe(false);
		expect(isWithinZone("mail.example.com", "example.com")).toBe(true);
		expect(isWithinZone("evilexample.com", "example.com")).toBe(false);
	});
});

describe("inspectDnsRecords", () => {
	it("他社 MX がある apex には danger の警告を返す", () => {
		const result = inspectDnsRecords({
			name: "example.com",
			zoneId: "z1",
			zoneName: "example.com",
			records: exampleRecords,
		});

		expect(result.isApex).toBe(true);
		expect(result.hasForeignMx).toBe(true);
		expect(result.requiresApexConfirmation).toBe(true);
		expect(result.recommendedMode).toBe("subdomain");

		const danger = result.warnings.find((w) => w.code === "apex_has_foreign_mx");
		expect(danger?.level).toBe("danger");
		expect(danger?.message).toContain("Google Workspace");
		expect(danger?.message).toContain("全メールがこのアプリに流れ込みます");
		expect(danger?.message).toContain("mail.example.com");
		expect(hasBlockingWarning(result)).toBe(true);
	});

	it("サブドメインなら apex の他社 MX は info どまり", () => {
		const result = inspectDnsRecords({
			name: "mail.example.com",
			zoneId: "z1",
			zoneName: "example.com",
			records: exampleRecords,
		});

		expect(result.isApex).toBe(false);
		expect(result.requiresApexConfirmation).toBe(false);
		expect(result.mx).toEqual([]);
		expect(result.apexMx.map((m) => m.provider)).toEqual(["google", "google"]);
		expect(hasBlockingWarning(result)).toBe(false);
		expect(result.warnings.find((w) => w.code === "mx_conflict")?.level).toBe("info");
	});

	it("SPF / DMARC の有無を見る", () => {
		const withAuth = inspectDnsRecords({
			name: "mail.example.com",
			zoneId: "z1",
			zoneName: "example.com",
			records: [
				{ type: "TXT", name: "mail.example.com", content: "v=spf1 include:_spf.mx.cloudflare.net ~all" },
				{ type: "TXT", name: "_dmarc.mail.example.com", content: "v=DMARC1; p=reject" },
			],
		});
		expect(withAuth.spf?.content).toContain("v=spf1");
		expect(withAuth.dmarc?.content).toContain("v=DMARC1");
		expect(withAuth.warnings.some((w) => w.code === "spf_missing")).toBe(false);
		expect(withAuth.warnings.some((w) => w.code === "dmarc_missing")).toBe(false);

		const without = inspectDnsRecords({
			name: "mail.example.com",
			zoneId: "z1",
			zoneName: "example.com",
			records: [],
		});
		expect(without.warnings.some((w) => w.code === "spf_missing")).toBe(true);
		expect(without.warnings.some((w) => w.code === "dmarc_missing")).toBe(true);
	});

	it("既に Cloudflare の MX があることを伝える", () => {
		const result = inspectDnsRecords({
			name: "mail.example.com",
			zoneId: "z1",
			zoneName: "example.com",
			records: [
				{ type: "MX", name: "mail.example.com", content: "route1.mx.cloudflare.net", priority: 1 },
			],
		});
		expect(result.hasCloudflareMx).toBe(true);
		expect(result.hasForeignMx).toBe(false);
		expect(result.warnings.some((w) => w.code === "already_routed_here")).toBe(true);
	});

	it("catch-all がゾーン単位であることを必ず添える", () => {
		const result = inspectDnsRecords({
			name: "mail.example.com",
			zoneId: "z1",
			zoneName: "example.com",
			records: [],
		});
		const note = result.warnings.find((w) => w.code === "catch_all_is_zone_wide");
		expect(note?.message).toContain("ゾーン単位");
		expect(note?.message).toContain("既定では有効化しません");
	});
});
