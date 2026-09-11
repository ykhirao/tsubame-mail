import { Hono } from "hono";
import { asc, desc, eq } from "drizzle-orm";
import { addresses, routingRules } from "@/db/schema";
import { invalidRequest, notFound } from "@/shared/errors";
import { createRuleSchema, targetMatchesAction, updateRuleSchema } from "@/shared/contracts/rules";
import { newId } from "@/lib/id";
import type { AppEnv } from "@/api/types";
import type { Db } from "@/db/client";
import { requireOwner } from "../../middleware/auth";
import { z } from "zod";

export const rulesRouter = new Hono<AppEnv>();

rulesRouter.use("*", requireOwner);

function parseOrThrow<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
	const result = schema.safeParse(data);
	if (!result.success) {
		throw invalidRequest("ルールの入力が不正です", result.error.issues);
	}
	return result.data;
}

/** deliver の target は「同じドメインの実在アドレス id」であることを DB で確かめる。 */
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
}

const order = [desc(routingRules.priority), asc(routingRules.createdAt)] as const;

/** priority 優先の順序はカーソルページングと相性が悪いので、上限だけ切る。 */
const rulesListQuery = z.object({
	limit: z.coerce.number().int().min(1).max(200).default(100),
});

rulesRouter.get("/", async (c) => {
	const query = rulesListQuery.safeParse(c.req.query());
	if (!query.success) throw invalidRequest("クエリが不正です", z.treeifyError(query.error));
	const rules = await c
		.get("db")
		.select()
		.from(routingRules)
		.orderBy(...order)
		.limit(query.data.limit)
		.all();
	// next_cursor はカーソル未対応の目印として常に null。UI の getAllPages はこれで 1 回の取得で止まる。
	return c.json({ data: rules, next_cursor: null });
});

rulesRouter.get("/:id", async (c) => {
	const id = c.req.param("id");
	const rule = await c.get("db").select().from(routingRules).where(eq(routingRules.id, id)).get();
	if (!rule) throw notFound("ルールが見つかりません");
	return c.json(rule);
});

rulesRouter.post("/", async (c) => {
	const body = parseOrThrow(createRuleSchema, await c.req.json());
	const db = c.get("db");
	await assertDeliverTarget(db, {
		action: body.action,
		domainId: body.domainId ?? null,
		target: body.target ?? null,
	});
	const id = newId("rule");
	await db
		.insert(routingRules)
		.values({
			id,
			scope: body.scope,
			domainId: body.domainId,
			addressId: body.addressId,
			name: body.name,
			action: body.action,
			matcher: body.matcher as Record<string, string>,
			target: body.target ?? null,
			priority: body.priority,
			enabled: body.enabled,
		});
	const created = await db.select().from(routingRules).where(eq(routingRules.id, id)).get();
	return c.json(created, 201);
});

rulesRouter.patch("/:id", async (c) => {
	const id = c.req.param("id");
	const body = parseOrThrow(updateRuleSchema, await c.req.json());
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
	return c.json(updated);
});

rulesRouter.delete("/:id", async (c) => {
	const id = c.req.param("id");
	const res = await c.get("db").delete(routingRules).where(eq(routingRules.id, id)).returning();
	if (res.length === 0) throw notFound("ルールが見つかりません");
	return c.body(null, 204);
});
