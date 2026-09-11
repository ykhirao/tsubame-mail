import { Hono } from "hono";
import type { Context } from "hono";
import { asc, count, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { addresses, domains } from "@/db/schema";
import { cleanupDomain } from "@/domain/domains/cleanup";
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
import { requireOwner } from "@/api/middleware/auth";
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

async function readBody<T extends z.ZodType>(c: Context<AppEnv>, schema: T): Promise<z.infer<T>> {
	let raw: unknown;
	try {
		raw = await c.req.json();
	} catch {
		throw invalidRequest("JSON の本文が必要です");
	}
	const parsed = schema.safeParse(raw);
	if (!parsed.success) throw invalidRequest("入力が不正です", z.treeifyError(parsed.error));
	return parsed.data;
}

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
	const input = await readBody(c, previewDomainInput);
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

app.post("/", async (c) => {
	const input = await readBody(c, createDomainInput);
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

app.delete("/:id", async (c) => {
	const domain = await loadDomain(c, c.req.param("id"));
	const query = deleteDomainQuery.safeParse(c.req.query());
	if (!query.success) throw invalidRequest("クエリが不正です", z.treeifyError(query.error));
	const doCleanup = query.data.cleanup;

	if (domain.mode === "apex") {
		const rows = await c.get("db").select().from(domains).where(ne(domains.id, domain.id));
		const below = rows.find((d) => d.name.toLowerCase().endsWith(`.${domain.name.toLowerCase()}`));
		if (below) {
			throw conflict(
				`${below.name} がこのドメインの配下で接続されています。先にそちらを切断してください。`,
			);
		}
	}

	let cleanup = null;
	if (doCleanup) {
		if (domain.catchAllEnabled) {
			await assertZoneCatchAllSafe(c.get("db"), { zoneId: domain.zoneId, domainId: domain.id });
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

	await c.get("db").delete(domains).where(eq(domains.id, domain.id));

	return c.json({
		data: { id: domain.id, deleted: true, cleanup },
		note: cleanup?.failures.length
			? "Cloudflare 側で消せなかったものがあります。failures を確認してください。"
			: null,
	});
});

app.post("/:id/catch-all", async (c) => {
	const domain = await loadDomain(c, c.req.param("id"));
	const input = await readBody(c, catchAllInput);

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

	return c.json({ data: result, warning: CATCH_ALL_WARNING });
});

app.post("/:id/verify", async (c) => {
	const domain = await loadDomain(c, c.req.param("id"));
	const api = createCloudflareApi(c.env);
	// ゾーンが動いていることも確認しておく（トークンのスコープ切れをここで拾う）。
	await resolveZone(api, { name: domain.name, zoneId: domain.zoneId });
	const result = await verifyDomain({ db: c.get("db"), api, domain });
	return c.json({ data: result });
});

export default app;
