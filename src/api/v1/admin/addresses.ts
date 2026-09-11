import { Hono } from "hono";
import type { Context } from "hono";
import { and, asc, eq, inArray, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { addresses, domains } from "@/db/schema";
import {
	emailWorkerName,
	ensureAddressRoutingRule,
	removeAddressRoutingRule,
} from "@/domain/domains/provision";
import { newId } from "@/lib/id";
import { afterCursor, toPage } from "@/lib/paging";
import { defaultColorFor } from "@/shared/colors";
import { createCloudflareApi } from "@/services/cloudflare-api";
import { requireOwner } from "@/api/middleware/auth";
import { clientIp, getPrincipal } from "@/api/middleware/auth";
import { readJson } from "@/lib/validate";
import { recordAudit } from "@/domain/access/policy";
import type { AppEnv } from "@/api/types";
import { paginationQuery } from "@/shared/contracts/common";
import {
	createAddressInput,
	listAddressesQuery,
	updateAddressInput,
} from "@/shared/contracts/addresses";
import { ApiError, conflict, invalidRequest, notFound } from "@/shared/errors";

const app = new Hono<AppEnv>();

app.use("*", requireOwner);

const listAddressesQueryWithPaging = listAddressesQuery.and(paginationQuery);

app.onError((err, c) => {
	if (err instanceof ApiError) return c.json(err.toJSON(), err.status as 400);
	console.error("unhandled error", err);
	return c.json({ error: { code: "internal", message: "内部エラーが発生しました" } }, 500);
});

const toSeconds = (value: Date | null | undefined): number | null =>
	value ? Math.floor(value.getTime() / 1000) : null;

type AddressRow = typeof addresses.$inferSelect;

function present(row: AddressRow, domainName: string, aliasTargetAddress: string | null) {
	return {
		id: row.id,
		domainId: row.domainId,
		domainName,
		localPart: row.localPart,
		address: row.address,
		displayName: row.displayName,
		kind: row.kind,
		aliasTargetId: row.aliasTargetId,
		aliasTargetAddress,
		isCatchAll: row.isCatchAll,
		signature: row.signature,
		color: row.color,
		archivedAt: toSeconds(row.archivedAt),
		createdAt: toSeconds(row.createdAt),
	};
}

app.get("/", async (c) => {
	const query = listAddressesQueryWithPaging.safeParse(c.req.query());
	if (!query.success) throw invalidRequest("クエリが不正です", z.treeifyError(query.error));
	const { domainId, includeArchived, limit, cursor } = query.data;

	const db = c.get("db");
	const conditions = [
		domainId ? eq(addresses.domainId, domainId) : undefined,
		includeArchived ? undefined : isNull(addresses.archivedAt),
		afterCursor(addresses, cursor, "asc"),
	].filter((v): v is NonNullable<typeof v> => v !== undefined);

	const rows = await db
		.select({ address: addresses, domainName: domains.name })
		.from(addresses)
		.innerJoin(domains, eq(addresses.domainId, domains.id))
		.where(conditions.length ? and(...conditions) : undefined)
		.orderBy(asc(addresses.createdAt), asc(addresses.id))
		.limit(limit + 1);

	const paged = toPage(
		rows.map((r) => r.address),
		limit,
	);
	const byRowId = new Map(rows.map((r) => [r.address.id, r]));

	const aliasTargetIds = [
		...new Set(
			paged.rows.map((r) => r.aliasTargetId).filter((id): id is string => id !== null),
		),
	];
	const aliasTargets = aliasTargetIds.length
		? await db
				.select({ id: addresses.id, address: addresses.address })
				.from(addresses)
				.where(inArray(addresses.id, aliasTargetIds))
		: [];

	const data = paged.rows.map((row) => {
		const domainName = byRowId.get(row.id)?.domainName ?? "";
		const aliasTargetAddress =
			row.aliasTargetId != null
				? (aliasTargets.find((t) => t.id === row.aliasTargetId)?.address ?? null)
				: null;
		return present(row, domainName, aliasTargetAddress);
	});

	return c.json({ data, next_cursor: paged.next_cursor });
});

app.post("/", async (c) => {
	const input = await readJson(c.req, createAddressInput);
	const db = c.get("db");

	const domain = await db.query.domains.findFirst({ where: eq(domains.id, input.domainId) });
	if (!domain) throw notFound("ドメインが見つかりません");

	const address = `${input.localPart}@${domain.name}`;
	const duplicate = await db.query.addresses.findFirst({ where: eq(addresses.address, address) });
	if (duplicate) throw conflict(`${address} は既に存在します。`);

	if (input.kind === "alias") {
		if (!input.aliasTargetId) throw invalidRequest("kind が alias のときは aliasTargetId が必須です");
		const target = await db.query.addresses.findFirst({
			where: eq(addresses.id, input.aliasTargetId),
		});
		if (!target) throw invalidRequest("aliasTargetId のアドレスが見つかりません");
		if (target.kind === "alias") {
			throw invalidRequest("エイリアスのエイリアスは作れません。実在のメールボックスを指定してください。");
		}
		// エイリアス先は同じドメインに限る。越境させると向き先ドメインの削除で宙に浮く。（#61・API 側）
		if (target.domainId !== domain.id) {
			throw invalidRequest("エイリアス先は同じドメインのアドレスを指定してください");
		}
	}

	if (input.isCatchAll) {
		const existing = await db.query.addresses.findFirst({
			where: and(eq(addresses.domainId, domain.id), eq(addresses.isCatchAll, true)),
		});
		if (existing) {
			throw conflict(
				`${domain.name} には既に catch-all の受け皿（${existing.address}）があります。ドメインあたり 1 件までです。`,
			);
		}
	}

	// Cloudflare 側のルールを先に作る。失敗したら D1 に行を残さない。
	const api = createCloudflareApi(c.env);
	const routingRuleId = await ensureAddressRoutingRule(api, {
		zone: { id: domain.zoneId, name: domain.zoneName },
		address,
		workerName: emailWorkerName(c.env),
	});

	const existingCount = await db.$count(addresses);
	const color = input.color ?? defaultColorFor(existingCount);

	const id = newId("address");
	await db.insert(addresses).values({
		id,
		domainId: domain.id,
		localPart: input.localPart,
		address,
		displayName: input.displayName ?? null,
		kind: input.kind,
		aliasTargetId: input.kind === "alias" ? (input.aliasTargetId ?? null) : null,
		isCatchAll: input.isCatchAll,
		signature: input.signature ?? null,
		color,
	});

	const row = await db.query.addresses.findFirst({ where: eq(addresses.id, id) });
	if (!row) throw notFound("作成したアドレスを読み直せませんでした");

	await recordAudit(db, {
		actorId: getPrincipal(c).userId,
		action: "address.create",
		targetType: "address",
		targetId: id,
		meta: {
			address,
			localPart: input.localPart,
			domainId: domain.id,
			kind: input.kind,
			aliasTargetId: input.kind === "alias" ? (input.aliasTargetId ?? null) : null,
			isCatchAll: input.isCatchAll,
		},
		ip: clientIp(c),
	});

	return c.json({ data: { ...present(row, domain.name, null), routingRuleId } }, 201);
});

async function loadAddress(c: Context<AppEnv>, id: string) {
	const db = c.get("db");
	const row = await db.query.addresses.findFirst({ where: eq(addresses.id, id) });
	if (!row) throw notFound("アドレスが見つかりません");
	const domain = await db.query.domains.findFirst({ where: eq(domains.id, row.domainId) });
	if (!domain) throw notFound("アドレスのドメインが見つかりません");
	return { row, domain };
}

app.get("/:id", async (c) => {
	const { row, domain } = await loadAddress(c, c.req.param("id"));
	let aliasTargetAddress: string | null = null;
	if (row.aliasTargetId) {
		const target = await c
			.get("db")
			.query.addresses.findFirst({ where: eq(addresses.id, row.aliasTargetId) });
		aliasTargetAddress = target?.address ?? null;
	}
	return c.json({ data: present(row, domain.name, aliasTargetAddress) });
});

app.patch("/:id", async (c) => {
	const { row, domain } = await loadAddress(c, c.req.param("id"));
	const input = await readJson(c.req, updateAddressInput);
	const db = c.get("db");

	const nextKind = input.kind ?? row.kind;
	const nextAliasTargetId =
		input.aliasTargetId === undefined ? row.aliasTargetId : input.aliasTargetId;

	if (nextKind === "alias") {
		if (!nextAliasTargetId) throw invalidRequest("kind が alias のときは aliasTargetId が必須です");
		if (nextAliasTargetId === row.id) throw invalidRequest("自分自身をエイリアス先にはできません");
		const target = await db.query.addresses.findFirst({
			where: eq(addresses.id, nextAliasTargetId),
		});
		if (!target) throw invalidRequest("aliasTargetId のアドレスが見つかりません");
		if (target.kind === "alias") throw invalidRequest("エイリアスのエイリアスは作れません");
		if (target.domainId !== row.domainId) {
			throw invalidRequest("エイリアス先は同じドメインのアドレスを指定してください");
		}

		// 自分をエイリアス先にしている行があると、そちらが宛先の無いエイリアスになる（連鎖）。
		if (row.kind !== "alias") {
			const dependent = await db.query.addresses.findFirst({
				where: eq(addresses.aliasTargetId, row.id),
			});
			if (dependent) {
				throw conflict(
					`${dependent.address} がこのアドレスをエイリアス先にしています。先にそちらを外してください。`,
				);
			}
		}
	}

	if (input.isCatchAll === true && !row.isCatchAll) {
		const existing = await db.query.addresses.findFirst({
			where: and(
				eq(addresses.domainId, row.domainId),
				eq(addresses.isCatchAll, true),
				ne(addresses.id, row.id),
			),
		});
		if (existing) {
			throw conflict(
				`${domain.name} には既に catch-all の受け皿（${existing.address}）があります。ドメインあたり 1 件までです。`,
			);
		}
	}

	await db
		.update(addresses)
		.set({
			displayName: input.displayName === undefined ? row.displayName : input.displayName,
			signature: input.signature === undefined ? row.signature : input.signature,
			color: input.color === undefined ? row.color : input.color,
			kind: nextKind,
			aliasTargetId: nextKind === "alias" ? nextAliasTargetId : null,
			isCatchAll: input.isCatchAll ?? row.isCatchAll,
			archivedAt:
				input.archived === undefined ? row.archivedAt : input.archived ? new Date() : null,
		})
		.where(eq(addresses.id, row.id));

	const updated = await db.query.addresses.findFirst({ where: eq(addresses.id, row.id) });
	if (!updated) throw notFound("更新したアドレスを読み直せませんでした");
	await recordAudit(db, {
		actorId: getPrincipal(c).userId,
		action: "address.update",
		targetType: "address",
		targetId: row.id,
		meta: {
			address: row.address,
			kind: nextKind,
			aliasTargetId: nextKind === "alias" ? nextAliasTargetId : null,
			isCatchAll: input.isCatchAll ?? row.isCatchAll,
			archived: input.archived,
		},
		ip: clientIp(c),
	});
	return c.json({ data: present(updated, domain.name, null) });
});

app.delete("/:id", async (c) => {
	const { row, domain } = await loadAddress(c, c.req.param("id"));
	const db = c.get("db");

	const dependent = await db.query.addresses.findFirst({
		where: eq(addresses.aliasTargetId, row.id),
	});
	if (dependent) {
		throw conflict(`${dependent.address} がこのアドレスをエイリアス先にしています。先に外してください。`);
	}

	const api = createCloudflareApi(c.env);
	const removed = await removeAddressRoutingRule(api, {
		zone: { id: domain.zoneId, name: domain.zoneName },
		address: row.address,
		workerName: emailWorkerName(c.env),
	});

	await db.delete(addresses).where(eq(addresses.id, row.id));

	await recordAudit(db, {
		actorId: getPrincipal(c).userId,
		action: "address.delete",
		targetType: "address",
		targetId: row.id,
		meta: { address: row.address, domainId: row.domainId, kind: row.kind },
		ip: clientIp(c),
	});

	return c.json({
		data: { id: row.id, deleted: true, routingRuleRemoved: removed },
		note: removed ? null : "Cloudflare 側に対応するルーティングルールが見つかりませんでした。",
	});
});

export default app;
