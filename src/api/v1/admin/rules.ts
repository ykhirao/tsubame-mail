import { Hono } from "hono";
import { asc, eq } from "drizzle-orm";
import { addresses, domains, routingRules } from "@/db/schema";
import { invalidRequest, notFound } from "@/shared/errors";
import { createRuleSchema, targetMatchesAction, updateRuleSchema } from "@/shared/contracts/rules";
import { readJson } from "@/lib/validate";
import { afterCursor, toPage } from "@/lib/paging";
import { paginationQuery } from "@/shared/contracts/common";
import { newId } from "@/lib/id";
import type { AppEnv } from "@/api/types";
import type { Db } from "@/db/client";
import { clientIp, getPrincipal, requireOwner } from "../../middleware/auth";
import { recordAudit } from "@/domain/access/policy";
import { z } from "zod";

export const rulesRouter = new Hono<AppEnv>();

rulesRouter.use("*", requireOwner);

const order = [asc(routingRules.createdAt), asc(routingRules.id)] as const;

/** scope に応じた domainId / addressId の「実在」を DB で確かめる（#63）。owner 経路なので実在=可視。 */
async function assertRuleScope(
	db: Db,
	v: { scope: "domain" | "address"; domainId: string | null; addressId: string | null },
): Promise<void> {
	if (v.scope === "domain") {
		if (!v.domainId) throw invalidRequest("domain スコープのルールには domainId が必須です");
		if (v.addressId) throw invalidRequest("domain スコープのルールに addressId は指定できません");
		const domain = await db.query.domains.findFirst({ where: eq(domains.id, v.domainId) });
		if (!domain) throw invalidRequest("domainId のドメインが見つかりません");
		return;
	}
	if (!v.addressId) throw invalidRequest("address スコープのルールには addressId が必須です");
	if (v.domainId) throw invalidRequest("address スコープのルールに domainId は指定できません");
	const address = await db.query.addresses.findFirst({ where: eq(addresses.id, v.addressId) });
	if (!address) throw invalidRequest("addressId のアドレスが見つかりません");
}

/** deliver の target は「同じドメインの実在メールボックス」であることを DB で確かめる（#62）。 */
async function assertDeliverTarget(
	db: Db,
	effective: { action: string; domainId: string | null; target: string | null },
): Promise<void> {
	if (effective.action !== "deliver") return;
	if (!effective.target) throw invalidRequest("deliver には target（宛先アドレス id）が必須です");
	if (!effective.domainId) throw invalidRequest("deliver には domainId が必須です");
	const target = await db.query.addresses.findFirst({ where: eq(addresses.id, effective.target) });
	if (!target) throw invalidRequest("target のアドレスが見つかりません");
	if (target.domainId !== effective.domainId) {
		throw invalidRequest("target は同じドメインの実在アドレスを指定してください");
	}
	if (target.kind === "alias") {
		throw invalidRequest("エイリアス行は deliver の宛先に指定できません。実在のメールボックスを指定してください");
	}
	if (target.archivedAt) {
		throw invalidRequest("アーカイブ済みのアドレスは deliver の宛先に指定できません");
	}
}

rulesRouter.get("/", async (c) => {
	const query = paginationQuery.safeParse(c.req.query());
	if (!query.success) throw invalidRequest("クエリが不正です", z.treeifyError(query.error));
	const { limit, cursor } = query.data;
	const rules = await c
		.get("db")
		.select()
		.from(routingRules)
		.where(afterCursor(routingRules, cursor, "asc"))
		.orderBy(...order)
		.limit(limit + 1)
		.all();
	const paged = toPage(rules, limit);
	return c.json({ data: paged.rows, next_cursor: paged.next_cursor });
});

rulesRouter.get("/:id", async (c) => {
	const id = c.req.param("id");
	const rule = await c.get("db").select().from(routingRules).where(eq(routingRules.id, id)).get();
	if (!rule) throw notFound("ルールが見つかりません");
	return c.json(rule);
});

rulesRouter.post("/", async (c) => {
	const body = await readJson(c.req, createRuleSchema);
	const db = c.get("db");
	const domainId = body.domainId ?? null;
	const addressId = body.addressId ?? null;
	await assertRuleScope(db, { scope: body.scope, domainId, addressId });
	await assertDeliverTarget(db, { action: body.action, domainId, target: body.target ?? null });
	const id = newId("rule");
	await db
		.insert(routingRules)
		.values({
			id,
			scope: body.scope,
			domainId,
			addressId,
			name: body.name,
			action: body.action,
			matcher: body.matcher as Record<string, string>,
			target: body.target ?? null,
			priority: body.priority,
			enabled: body.enabled,
		});
	const created = await db.select().from(routingRules).where(eq(routingRules.id, id)).get();
	await recordAudit(db, {
		actorId: getPrincipal(c).userId,
		action: "rule.create",
		targetType: "rule",
		targetId: id,
		meta: {
			scope: body.scope,
			name: body.name,
			action: body.action,
			domainId,
			addressId,
			target: body.target ?? null,
			priority: body.priority,
			enabled: body.enabled,
		},
		ip: clientIp(c),
	});
	return c.json(created, 201);
});

rulesRouter.patch("/:id", async (c) => {
	const id = c.req.param("id");
	const body = await readJson(c.req, updateRuleSchema);
	const db = c.get("db");
	const existing = await db.select().from(routingRules).where(eq(routingRules.id, id)).get();
	if (!existing) throw notFound("ルールが見つかりません");

	const merged = {
		scope: body.scope ?? existing.scope,
		domainId: body.domainId ?? existing.domainId,
		addressId: body.addressId ?? existing.addressId,
		name: body.name ?? existing.name,
		action: body.action ?? existing.action,
		matcher: (body.matcher ?? existing.matcher) as Record<string, string>,
		target: body.target === undefined ? existing.target : body.target,
		priority: body.priority ?? existing.priority,
		enabled: body.enabled ?? existing.enabled,
	};

	if (!targetMatchesAction({ action: merged.action, target: merged.target })) {
		throw invalidRequest("forward の target はメールアドレスの形式である必要があります", [
			{ path: ["target"] },
		]);
	}
	await assertRuleScope(db, {
		scope: merged.scope,
		domainId: merged.domainId ?? null,
		addressId: merged.addressId ?? null,
	});
	await assertDeliverTarget(db, {
		action: merged.action,
		domainId: merged.domainId ?? null,
		target: merged.target,
	});

	await db
		.update(routingRules)
		.set(merged)
		.where(eq(routingRules.id, id));
	const updated = await db.select().from(routingRules).where(eq(routingRules.id, id)).get();
	await recordAudit(db, {
		actorId: getPrincipal(c).userId,
		action: "rule.update",
		targetType: "rule",
		targetId: id,
		meta: {
			scope: merged.scope,
			name: merged.name,
			action: merged.action,
			domainId: merged.domainId,
			addressId: merged.addressId,
			target: merged.target,
			priority: merged.priority,
			enabled: merged.enabled,
		},
		ip: clientIp(c),
	});
	return c.json(updated);
});

rulesRouter.delete("/:id", async (c) => {
	const id = c.req.param("id");
	const db = c.get("db");
	const res = await db.delete(routingRules).where(eq(routingRules.id, id)).returning();
	if (res.length === 0) throw notFound("ルールが見つかりません");
	await recordAudit(db, {
		actorId: getPrincipal(c).userId,
		action: "rule.delete",
		targetType: "rule",
		targetId: id,
		meta: { name: res[0]?.name },
		ip: clientIp(c),
	});
	return c.body(null, 204);
});
