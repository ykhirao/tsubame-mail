import { Hono } from "hono";
import { asc, desc, eq } from "drizzle-orm";
import { routingRules } from "@/db/schema";
import { forbidden, invalidRequest, notFound } from "@/shared/errors";
import { createRuleSchema, updateRuleSchema } from "@/shared/contracts/rules";
import { newId } from "@/lib/id";
import type { AppEnv } from "@/api/types";
import { z } from "zod";

export const rulesRouter = new Hono<AppEnv>();

rulesRouter.use("*", async (c, next) => {
	if (c.get("principal").role !== "owner") throw forbidden("この操作は owner のみ行えます");
	await next();
});

function parseOrThrow<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
	const result = schema.safeParse(data);
	if (!result.success) {
		throw invalidRequest("ルールの入力が不正です", result.error.issues);
	}
	return result.data;
}

const order = [desc(routingRules.priority), asc(routingRules.createdAt)] as const;

rulesRouter.get("/", async (c) => {
	const rules = await c.get("db").select().from(routingRules).orderBy(...order).all();
	return c.json({ data: rules });
});

rulesRouter.get("/:id", async (c) => {
	const id = c.req.param("id");
	const rule = await c.get("db").select().from(routingRules).where(eq(routingRules.id, id)).get();
	if (!rule) throw notFound("ルールが見つかりません");
	return c.json(rule);
});

rulesRouter.post("/", async (c) => {
	const body = parseOrThrow(createRuleSchema, await c.req.json());
	const id = newId("rule");
	await c
		.get("db")
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
	const created = await c.get("db").select().from(routingRules).where(eq(routingRules.id, id)).get();
	return c.json(created, 201);
});

rulesRouter.patch("/:id", async (c) => {
	const id = c.req.param("id");
	const body = parseOrThrow(updateRuleSchema, await c.req.json());
	const existing = await c.get("db").select().from(routingRules).where(eq(routingRules.id, id)).get();
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

	await c
		.get("db")
		.update(routingRules)
		.set(merged)
		.where(eq(routingRules.id, id));
	const updated = await c.get("db").select().from(routingRules).where(eq(routingRules.id, id)).get();
	return c.json(updated);
});

rulesRouter.delete("/:id", async (c) => {
	const id = c.req.param("id");
	const res = await c.get("db").delete(routingRules).where(eq(routingRules.id, id)).returning();
	if (res.length === 0) throw notFound("ルールが見つかりません");
	return c.body(null, 204);
});
