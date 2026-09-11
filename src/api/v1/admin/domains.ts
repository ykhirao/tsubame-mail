import { Hono } from "hono";
import type { Context } from "hono";
import { and, asc, count, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { addresses, domains } from "@/db/schema";
import { cleanupDomain, cleanupFailureNote } from "@/domain/domains/cleanup";
import {
	CATCH_ALL_WARNING,
	assertZoneCatchAllSafe,
	emailWorkerName,
	previewDomain,
	provisionDomain,
	resolveZone,
	setCatchAll,
	verifyDomain,
} from "@/domain/domains/provision";
import { createCloudflareApi } from "@/services/cloudflare-api";
import { requireOwner, requireUnrestricted } from "@/api/middleware/auth";
import { clientIp, getPrincipal } from "@/api/middleware/auth";
import { readJson } from "@/lib/validate";
import { recordAudit } from "@/domain/access/policy";
import { afterCursor, toPage } from "@/lib/paging";
import type { AppEnv } from "@/api/types";
import { paginationQuery } from "@/shared/contracts/common";
import {
	catchAllInput,
	createDomainInput,
	deleteDomainQuery,
	previewDomainInput,
} from "@/shared/contracts/domains";
import { ApiError, conflict, invalidRequest, notFound } from "@/shared/errors";

const app = new Hono<AppEnv>();

app.use("*", requireOwner);

app.onError((err, c) => {
	if (err instanceof ApiError) return c.json(err.toJSON(), err.status as 400);
	console.error("unhandled error", err);
	return c.json({ error: { code: "internal", message: "内部エラーが発生しました" } }, 500);
});

const toSeconds = (value: Date | null | undefined): number | null =>
	value ? Math.floor(value.getTime() / 1000) : null;

app.get("/available", async (c) => {
	const api = createCloudflareApi(c.env);
	const zones = await api.listAllZones();
	const connected = await c.get("db").select().from(domains);

	const data = zones.map((zone) => {
		const zoneName = zone.name.toLowerCase();
		const names = connected
			.filter((d) => d.zoneId === zone.id || d.zoneName === zoneName)
			.map((d) => d.name);
		return {
			zoneId: zone.id,
			zoneName,
			status: zone.status ?? null,
			connectedNames: names,
			suggestedName: `mail.${zoneName}`,
		};
	});

	return c.json({
		data,
		next_cursor: null,
		note:
			"CF_API_TOKEN のスコープに入っているゾーンだけが見えます。" +
			"目的のゾーンが出てこない場合はトークンの Zone リソースを広げてください。",
	});
});

app.post("/preview", async (c) => {
	const input = await readJson(c.req, previewDomainInput);
	const api = createCloudflareApi(c.env);
	const result = await previewDomain(api, input);

	return c.json({
		data: result,
		requiresApexConfirmation: result.requiresApexConfirmation,
		catchAllWarning: CATCH_ALL_WARNING,
	});
});

app.get("/", async (c) => {
	const query = paginationQuery.safeParse(c.req.query());
	if (!query.success) throw invalidRequest("クエリが不正です", z.treeifyError(query.error));
	const { limit, cursor } = query.data;

	const db = c.get("db");
	const fetched = await db
		.select()
		.from(domains)
		.where(afterCursor(domains, cursor, "asc"))
		.orderBy(asc(domains.createdAt), asc(domains.id))
		.limit(limit + 1);
	const paged = toPage(fetched, limit);

	const counts = paged.rows.length
		? await db
				.select({ domainId: addresses.domainId, n: count() })
				.from(addresses)
				.where(
					inArray(
						addresses.domainId,
						paged.rows.map((r) => r.id),
					),
				)
				.groupBy(addresses.domainId)
		: [];
	const countBy = new Map(counts.map((r) => [r.domainId, Number(r.n)]));

	return c.json({
		data: paged.rows.map((d) => ({
			id: d.id,
			name: d.name,
			zoneId: d.zoneId,
			zoneName: d.zoneName,
			mode: d.mode,
			routingStatus: d.routingStatus,
			sendingStatus: d.sendingStatus,
			catchAllEnabled: d.catchAllEnabled,
			lastError: d.lastError,
			addressCount: countBy.get(d.id) ?? 0,
			createdAt: toSeconds(d.createdAt),
		})),
		next_cursor: paged.next_cursor,
	});
});

app.post("/", requireUnrestricted, async (c) => {
	const input = await readJson(c.req, createDomainInput);
	const api = createCloudflareApi(c.env);

	const result = await provisionDomain({
		db: c.get("db"),
		api,
		env: c.env,
		input: {
			name: input.name,
			zoneId: input.zoneId,
			confirmApex: input.confirmApex,
			enableSending: input.enableSending,
			localParts: input.localParts,
		},
	});

	await recordAudit(c.get("db"), {
		actorId: getPrincipal(c).userId,
		action: "domain.connect",
		targetType: "domain",
		targetId: result.domainId,
		meta: {
			name: result.name,
			zoneId: result.zoneId,
			mode: result.mode,
			confirmApex: input.confirmApex,
			enableSending: input.enableSending,
			localParts: input.localParts,
		},
		ip: clientIp(c),
	});

	return c.json(
		{
			data: result,
			// catch-all は接続では有効化しない。有効化したいときは別 API を明示的に叩かせる。
			catchAllWarning: CATCH_ALL_WARNING,
		},
		201,
	);
});

async function loadDomain(c: Context<AppEnv>, id: string) {
	const domain = await c.get("db").query.domains.findFirst({ where: eq(domains.id, id) });
	if (!domain) throw notFound("ドメインが見つかりません");
	return domain;
}

app.get("/:id", async (c) => {
	const domain = await loadDomain(c, c.req.param("id"));
	const rows = await c
		.get("db")
		.select()
		.from(addresses)
		.where(eq(addresses.domainId, domain.id));

	return c.json({
		data: {
			id: domain.id,
			name: domain.name,
			zoneId: domain.zoneId,
			zoneName: domain.zoneName,
			mode: domain.mode,
			routingStatus: domain.routingStatus,
			sendingStatus: domain.sendingStatus,
			catchAllEnabled: domain.catchAllEnabled,
			lastError: domain.lastError,
			createdAt: toSeconds(domain.createdAt),
			addresses: rows.map((a) => ({
				id: a.id,
				address: a.address,
				kind: a.kind,
				isCatchAll: a.isCatchAll,
				archivedAt: toSeconds(a.archivedAt),
			})),
		},
	});
});

app.delete("/:id", requireUnrestricted, async (c) => {
	const domain = await loadDomain(c, c.req.param("id"));
	const query = deleteDomainQuery.safeParse(c.req.query());
	if (!query.success) throw invalidRequest("クエリが不正です", z.treeifyError(query.error));
	const doCleanup = query.data.cleanup;
	const db = c.get("db");

	// #61: 他ドメインのエイリアスがこのドメインのアドレスを向いていると、切断で宙に浮く。
	const domainAddressIds = db
		.select({ id: addresses.id })
		.from(addresses)
		.where(eq(addresses.domainId, domain.id));
	const crossAlias = await db
		.select()
		.from(addresses)
		.where(
			and(
				ne(addresses.domainId, domain.id),
				inArray(addresses.aliasTargetId, domainAddressIds),
			),
		)
		.limit(1);
	if (crossAlias.length > 0) {
		throw conflict(
			`${crossAlias[0]!.address} がこのドメインのアドレスをエイリアス先にしています。先にそちらを外してください。`,
		);
	}

	let cleanup = null;
	if (doCleanup) {
		// #18/#60: 配下に別接続があると、cleanup がその接続の MX / TXT を巻き込むので 409。
		const rows = await db.select().from(domains).where(ne(domains.id, domain.id));
		const below = rows.find((d) => d.name.toLowerCase().endsWith(`.${domain.name.toLowerCase()}`));
		if (below) {
			throw conflict(
				`${below.name} がこのドメインの配下で接続されています。先にそちらを切断してください。`,
			);
		}
		if (domain.catchAllEnabled) {
			await assertZoneCatchAllSafe(db, { zoneId: domain.zoneId, domainId: domain.id });
		}
		const api = createCloudflareApi(c.env);
		cleanup = await cleanupDomain(api, {
			zoneId: domain.zoneId,
			zoneName: domain.zoneName,
			name: domain.name,
			mode: domain.mode,
			workerName: emailWorkerName(c.env),
			catchAllEnabled: domain.catchAllEnabled,
		});
	}

	await db.delete(domains).where(eq(domains.id, domain.id));

	await recordAudit(db, {
		actorId: getPrincipal(c).userId,
		action: "domain.disconnect",
		targetType: "domain",
		targetId: domain.id,
		meta: {
			name: domain.name,
			zoneId: domain.zoneId,
			cleanup: doCleanup,
			removedRoutingRules: cleanup?.removedRoutingRules ?? [],
			removedDnsRecords: cleanup?.removedDnsRecords ?? [],
			failures: cleanup?.failures.map((f) => f.label) ?? [],
		},
		ip: clientIp(c),
	});

	return c.json({
		data: { id: domain.id, deleted: true, cleanup },
		note: cleanup?.failures.length ? cleanupFailureNote(cleanup.failures) : null,
	});
});

app.post("/:id/catch-all", requireUnrestricted, async (c) => {
	const domain = await loadDomain(c, c.req.param("id"));
	const input = await readJson(c.req, catchAllInput);

	if (!input.confirm) {
		throw invalidRequest(
			`catch-all を変更するには confirm: true が必要です（有効化・無効化とも）。${CATCH_ALL_WARNING}`,
			{ warning: CATCH_ALL_WARNING, zoneName: domain.zoneName, mode: domain.mode },
		);
	}

	const api = createCloudflareApi(c.env);
	const result = await setCatchAll({
		db: c.get("db"),
		api,
		env: c.env,
		domain,
		enabled: input.enabled,
	});

	await recordAudit(c.get("db"), {
		actorId: getPrincipal(c).userId,
		action: "domain.catchall",
		targetType: "domain",
		targetId: domain.id,
		meta: { name: domain.name, zoneId: domain.zoneId, enabled: input.enabled },
		ip: clientIp(c),
	});

	return c.json({ data: result, warning: CATCH_ALL_WARNING });
});

app.post("/:id/verify", requireUnrestricted, async (c) => {
	const domain = await loadDomain(c, c.req.param("id"));
	const api = createCloudflareApi(c.env);
	// ゾーンが動いていることも確認しておく（トークンのスコープ切れをここで拾う）。
	await resolveZone(api, { name: domain.name, zoneId: domain.zoneId });
	const result = await verifyDomain({ db: c.get("db"), api, domain });
	await recordAudit(c.get("db"), {
		actorId: getPrincipal(c).userId,
		action: "domain.verify",
		targetType: "domain",
		targetId: domain.id,
		meta: {
			name: domain.name,
			zoneId: domain.zoneId,
			routingStatus: result.routingStatus,
			sendingStatus: result.sendingStatus,
		},
		ip: clientIp(c),
	});
	return c.json({ data: result });
});

export default app;
