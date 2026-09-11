/**
 * Cloudflare 側のレコード ID を保存していないため、自分が作ったものかはパターンで見分ける。
 * 判定は必ず保守的に（迷ったら消さず、戻り値で報告する）。他人のメールを止めるより残す方がまし。
 * catch-all はゾーン単位の単一ルールなので削除できない。無効化するだけ。
 */
import {
	type CfDnsRecord,
	type CfEmailRoutingRule,
	type CloudflareApi,
	type ZoneRef,
	routingRuleId,
	workerAction,
} from "@/services/cloudflare-api";
import { ApiError } from "@/shared/errors";
import { isZoneApex, normalizeDnsName } from "./dns-check";

export type CleanupTarget = {
	zoneId: string;
	zoneName: string;
	name: string;
	mode: "apex" | "subdomain";
	workerName: string;
	catchAllEnabled: boolean;
};

export type CleanupFailure = {
	kind: "routing_rule" | "dns_record" | "catch_all" | "list";
	id: string;
	label: string;
	reason: string;
};

export type CleanupResult = {
	removedRoutingRules: string[];
	removedDnsRecords: string[];
	/** 自分のものと判定できず、残したもの。 */
	skippedDnsRecords: string[];
	catchAllDisabled: boolean;
	failures: CleanupFailure[];
};

export function isOwnRoutingRule(
	rule: CfEmailRoutingRule,
	target: { name: string; workerName: string },
): boolean {
	const suffix = `@${normalizeDnsName(target.name)}`;
	const toWorker = rule.actions.some(
		(a) => a.type === "worker" && a.value.includes(target.workerName),
	);
	if (!toWorker) return false;
	const matchers = rule.matchers.filter((m) => m.type === "literal" && m.field === "to");
	if (matchers.length === 0) return false;
	// 1 つでも自分のドメイン以外を含むなら触らない。
	return matchers.every((m) => (m.value ?? "").trim().toLowerCase().endsWith(suffix));
}

export function isOwnDnsRecord(
	record: Pick<CfDnsRecord, "type" | "name" | "content">,
	target: { name: string; zoneName: string; mode: "apex" | "subdomain" },
): boolean {
	const name = normalizeDnsName(record.name);
	const mailName = normalizeDnsName(target.name);
	const zoneName = normalizeDnsName(target.zoneName);
	const content = normalizeDnsName(record.content);
	const type = record.type.toUpperCase();

	// サブドメイン運用なら apex には一切触らない。
	if (target.mode === "subdomain" && (name === zoneName || isZoneApex(name, zoneName))) {
		return false;
	}
	// 名前の完全一致（と DKIM の固定ホスト名）だけを対象にする。配下の別接続の
	// MX / TXT を巻き込まないため、`endsWith(.$mailName)` にはしない（#60）。
	const isMailHost = name === mailName || name === `cf-bounce._domainkey.${mailName}`;
	if (!isMailHost) return false;

	if (type === "MX") return content.endsWith("mx.cloudflare.net");
	if (type === "TXT") {
		if (/v=spf1/i.test(record.content) && /_spf\.mx\.cloudflare\.net/i.test(record.content)) {
			return true;
		}
		// Cloudflare が張る DKIM は cf-bounce._domainkey.<name> だけ。
		if (name.includes("_domainkey.") && /v=dkim1/i.test(record.content)) {
			return name.startsWith("cf-bounce._domainkey.");
		}
		// DMARC は Cloudflare が張ったものか判別できないので触らない。
		return false;
	}
	return false;
}

export async function cleanupDomain(
	api: CloudflareApi,
	target: CleanupTarget,
): Promise<CleanupResult> {
	const zone: ZoneRef = { id: target.zoneId, name: target.zoneName };
	const result: CleanupResult = {
		removedRoutingRules: [],
		removedDnsRecords: [],
		skippedDnsRecords: [],
		catchAllDisabled: false,
		failures: [],
	};

	let rules: CfEmailRoutingRule[] = [];
	try {
		rules = await api.listEmailRoutingRules(zone);
	} catch (err) {
		result.failures.push({
			kind: "list",
			id: target.zoneId,
			label: "Email Routing ルールの一覧",
			reason: messageOf(err),
		});
	}

	for (const rule of rules) {
		if (!isOwnRoutingRule(rule, { name: target.name, workerName: target.workerName })) continue;
		const id = routingRuleId(rule);
		if (!id) continue;
		try {
			await api.deleteEmailRoutingRule(zone, id);
			result.removedRoutingRules.push(id);
		} catch (err) {
			result.failures.push({
				kind: "routing_rule",
				id,
				label: rule.name ?? id,
				reason: messageOf(err),
			});
		}
	}

	if (target.catchAllEnabled) {
		try {
			await api.updateCatchAllRule(zone, {
				enabled: false,
				name: `tsubame catch-all (${target.name})`,
				matchers: [{ type: "all" }],
				actions: [workerAction(target.workerName)],
			});
			result.catchAllDisabled = true;
		} catch (err) {
			result.failures.push({
				kind: "catch_all",
				id: target.zoneId,
				label: "catch-all の無効化",
				reason: messageOf(err),
			});
		}
	}

	let records: CfDnsRecord[] = [];
	try {
		records = await api.listDnsRecords(zone);
	} catch (err) {
		result.failures.push({
			kind: "list",
			id: target.zoneId,
			label: "DNS レコードの一覧",
			reason: messageOf(err),
		});
	}

	for (const record of records) {
		const name = normalizeDnsName(record.name);
		const mailName = normalizeDnsName(target.name);
		const underMailName = name === mailName || name === `cf-bounce._domainkey.${mailName}`;
		if (!underMailName) continue;

		if (!isOwnDnsRecord(record, target)) {
			result.skippedDnsRecords.push(`${record.type} ${name}`);
			continue;
		}
		try {
			await api.deleteDnsRecord(zone, record.id);
			result.removedDnsRecords.push(`${record.type} ${name}`);
		} catch (err) {
			result.failures.push({
				kind: "dns_record",
				id: record.id,
				label: `${record.type} ${name}`,
				reason: messageOf(err),
			});
		}
	}

	return result;
}

function messageOf(err: unknown): string {
	if (err instanceof ApiError) return err.message;
	return err instanceof Error ? err.message : String(err);
}
