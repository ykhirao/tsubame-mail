/**
 * 他社の MX が刺さった apex を奪うと、そのドメイン宛の全メールがこのアプリに流れ込む。
 * だから既定はサブドメイン運用で、apex は明示の確認（confirmApex）がないと選べない。
 */
import type { CfDnsRecord, CloudflareApi, ZoneRef } from "@/services/cloudflare-api";

export type MxProvider = "cloudflare" | "google" | "microsoft" | "other";

export type MxFinding = {
	name: string;
	content: string;
	priority?: number;
	provider: MxProvider;
};

export type TxtFinding = {
	name: string;
	content: string;
};

export type DnsWarningLevel = "danger" | "warn" | "info";

export type DnsWarning = {
	level: DnsWarningLevel;
	code:
		| "apex_has_foreign_mx"
		| "apex_takeover"
		| "already_routed_here"
		| "mx_conflict"
		| "spf_missing"
		| "dmarc_missing"
		| "catch_all_is_zone_wide";
	message: string;
};

export type DnsCheckResult = {
	name: string;
	zoneId: string;
	zoneName: string;
	isApex: boolean;
	recommendedMode: "apex" | "subdomain";
	requiresApexConfirmation: boolean;
	mx: MxFinding[];
	apexMx: MxFinding[];
	hasForeignMx: boolean;
	hasCloudflareMx: boolean;
	spf: TxtFinding | null;
	dmarc: TxtFinding | null;
	warnings: DnsWarning[];
};

const CLOUDFLARE_MX_SUFFIXES = ["mx.cloudflare.net"];
const GOOGLE_MX_PATTERNS = ["google.com", "googlemail.com", "aspmx"];
const MICROSOFT_MX_PATTERNS = ["outlook.com", "protection.outlook.com", "office365.com"];

export function classifyMx(content: string): MxProvider {
	const value = content.trim().toLowerCase().replace(/\.$/, "");
	if (CLOUDFLARE_MX_SUFFIXES.some((s) => value.endsWith(s))) return "cloudflare";
	if (GOOGLE_MX_PATTERNS.some((s) => value.includes(s))) return "google";
	if (MICROSOFT_MX_PATTERNS.some((s) => value.includes(s))) return "microsoft";
	return "other";
}

export function providerLabel(provider: MxProvider): string {
	switch (provider) {
		case "cloudflare":
			return "Cloudflare Email Routing";
		case "google":
			return "Google Workspace";
		case "microsoft":
			return "Microsoft 365";
		default:
			return "他社のメールサービス";
	}
}

export function normalizeDnsName(name: string): string {
	return name.trim().toLowerCase().replace(/\.$/, "");
}

export function isZoneApex(name: string, zoneName: string): boolean {
	return normalizeDnsName(name) === normalizeDnsName(zoneName);
}

export function isWithinZone(name: string, zoneName: string): boolean {
	const n = normalizeDnsName(name);
	const z = normalizeDnsName(zoneName);
	return n === z || n.endsWith(`.${z}`);
}

export function inspectDnsRecords(input: {
	name: string;
	zoneId: string;
	zoneName: string;
	records: Pick<CfDnsRecord, "type" | "name" | "content" | "priority">[];
}): DnsCheckResult {
	const name = normalizeDnsName(input.name);
	const zoneName = normalizeDnsName(input.zoneName);
	const isApex = isZoneApex(name, zoneName);

	const at = (target: string, type: string) =>
		input.records.filter(
			(r) => r.type.toUpperCase() === type && normalizeDnsName(r.name) === target,
		);

	const toMx = (records: typeof input.records): MxFinding[] =>
		records.map((r) => ({
			name: normalizeDnsName(r.name),
			content: normalizeDnsName(r.content),
			priority: r.priority,
			provider: classifyMx(r.content),
		}));

	const mx = toMx(at(name, "MX"));
	const apexMx = isApex ? mx : toMx(at(zoneName, "MX"));

	const hasCloudflareMx = mx.some((m) => m.provider === "cloudflare");
	const hasForeignMx = mx.some((m) => m.provider !== "cloudflare");
	const apexHasForeignMx = apexMx.some((m) => m.provider !== "cloudflare");

	const spfRecord =
		at(name, "TXT").find((r) => r.content.toLowerCase().includes("v=spf1")) ?? null;
	const dmarcRecord =
		at(`_dmarc.${name}`, "TXT").find((r) => r.content.toLowerCase().includes("v=dmarc1")) ?? null;

	const warnings: DnsWarning[] = [];

	if (isApex && apexHasForeignMx) {
		const providers = [
			...new Set(apexMx.filter((m) => m.provider !== "cloudflare").map((m) => m.provider)),
		]
			.map(providerLabel)
			.join(" / ");
		warnings.push({
			level: "danger",
			code: "apex_has_foreign_mx",
			message:
				`${zoneName} の apex には既に ${providers} の MX が設定されています。` +
				`apex を接続すると MX が Cloudflare に置き換わり、**${zoneName} 宛の全メールがこのアプリに流れ込みます**（既存のメールは届かなくなります）。` +
				`サブドメイン運用（例: mail.${zoneName}）を強く推奨します。`,
		});
	} else if (isApex) {
		warnings.push({
			level: "warn",
			code: "apex_takeover",
			message:
				`apex（${zoneName}）を接続すると、このゾーン宛のメールの受け口がこのアプリになります。` +
				`後からメールサービスを戻すには MX を張り直す必要があります。既定はサブドメイン運用です。`,
		});
	}

	if (!isApex && apexHasForeignMx) {
		warnings.push({
			level: "info",
			code: "mx_conflict",
			message:
				`apex（${zoneName}）の MX は他社のままです（このアプリは触りません）。` +
				`${name} 配下にだけ MX を作ります。`,
		});
	}

	if (hasCloudflareMx) {
		warnings.push({
			level: "info",
			code: "already_routed_here",
			message: `${name} には既に Cloudflare Email Routing の MX があります。設定を上書きします。`,
		});
	}

	if (!isApex && hasForeignMx) {
		warnings.push({
			level: "danger",
			code: "mx_conflict",
			message:
				`${name} には既に別のメールサービスの MX があります（${mx
					.filter((m) => m.provider !== "cloudflare")
					.map((m) => m.content)
					.join(", ")}）。接続すると置き換わります。`,
		});
	}

	if (!spfRecord) {
		warnings.push({
			level: "warn",
			code: "spf_missing",
			message: `${name} に SPF（TXT の v=spf1）がありません。接続時に Cloudflare の SPF を追加します。`,
		});
	}
	if (!dmarcRecord) {
		warnings.push({
			level: "warn",
			code: "dmarc_missing",
			message: `_dmarc.${name} に DMARC がありません。到達性のために設定を推奨します。`,
		});
	}

	warnings.push({
		level: "info",
		code: "catch_all_is_zone_wide",
		message:
			"catch-all は Cloudflare の仕様上**ゾーン単位**です。既定では有効化しません。" +
			"有効にすると、apex の MX を Cloudflare に向けた時点でゾーン宛の全メールを飲み込みます。",
	});

	return {
		name,
		zoneId: input.zoneId,
		zoneName,
		isApex,
		recommendedMode: apexMx.length === 0 && isApex ? "apex" : "subdomain",
		requiresApexConfirmation: isApex,
		mx,
		apexMx,
		hasForeignMx,
		hasCloudflareMx,
		spf: spfRecord ? { name: normalizeDnsName(spfRecord.name), content: spfRecord.content } : null,
		dmarc: dmarcRecord
			? { name: normalizeDnsName(dmarcRecord.name), content: dmarcRecord.content }
			: null,
		warnings,
	};
}

export async function checkDomainDns(
	api: CloudflareApi,
	zone: ZoneRef & { name: string },
	name: string,
): Promise<DnsCheckResult> {
	const records = await api.listDnsRecords(zone);
	return inspectDnsRecords({ name, zoneId: zone.id, zoneName: zone.name, records });
}

export function hasBlockingWarning(result: DnsCheckResult): boolean {
	return result.warnings.some((w) => w.level === "danger");
}
