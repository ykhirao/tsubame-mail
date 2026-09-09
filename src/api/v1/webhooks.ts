import { Hono } from "hono";
import { and, desc, eq, lt } from "drizzle-orm";
import { getDb } from "@/db/client";
import { webhooks, webhookDeliveries } from "@/db/schema";
import { forbidden, invalidRequest, notFound } from "@/shared/errors";
import { paginationQuery } from "@/shared/contracts/common";
import { webhookInput, webhookUpdateInput } from "@/shared/contracts/webhooks";
import { newId } from "@/lib/id";
import { runDelivery } from "@/services/webhooks";
import type { Principal } from "@/shared/contracts/common";
import type { Webhook, WebhookDelivery } from "@/shared/contracts/webhooks";
import type { AppEnv } from "@/api/types";

export const webhookRoutes = new Hono<AppEnv>();
export default webhookRoutes;

function requireAdmin(principal: Principal) {
	if (principal.role === "owner") return;
	if (principal.scopes.includes("admin")) return;
	throw forbidden("Webhook の管理には管理者権限が必要です");
}

/** secret をレスポンスに含めない。 */
function toResponse(w: typeof webhooks.$inferSelect): Webhook {
	return {
		id: w.id,
		name: w.name,
		url: w.url,
		events: w.events as Webhook["events"],
		addressIds: w.addressIds,
		enabled: w.enabled,
		createdAt: w.createdAt ? Math.floor(w.createdAt.getTime() / 1000) : null,
	};
}

function toDeliveryResponse(
	d: typeof webhookDeliveries.$inferSelect,
): WebhookDelivery {
	return {
		id: d.id,
		webhookId: d.webhookId,
		event: d.event as WebhookDelivery["event"],
		messageId: d.messageId,
		status: d.status,
		httpStatus: d.httpStatus,
		error: d.error,
		durationMs: d.durationMs,
		attempt: d.attempt,
		nextRetryAt: d.nextRetryAt ? Math.floor(d.nextRetryAt.getTime() / 1000) : null,
		createdAt: d.createdAt ? Math.floor(d.createdAt.getTime() / 1000) : null,
	};
}

function generateSecret(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

webhookRoutes.get("/", async (c) => {
	requireAdmin(c.get("principal"));
	const db = getDb(c.env);
	const rows = await db.select().from(webhooks).all();
	return c.json(rows.map(toResponse));
});

webhookRoutes.post("/", async (c) => {
	requireAdmin(c.get("principal"));
	const body = await c.req.json().catch(() => {
		throw invalidRequest("JSON ボディをパースできません");
	});
	const parsed = webhookInput.safeParse(body);
	if (!parsed.success) {
		throw invalidRequest("リクエストが不正です", parsed.error.issues);
	}
	const v = parsed.data;
	const db = getDb(c.env);
	const id = newId("webhook");
	const secret = generateSecret();
	const [row] = await db
		.insert(webhooks)
		.values({
			id,
			name: v.name,
			url: v.url,
			events: v.events,
			addressIds: v.addressIds ?? null,
			secret,
			enabled: v.enabled,
		})
		.returning();
	if (!row) throw new Error("webhook の作成に失敗しました");
	return c.json({ ...toResponse(row), secret }, 201);
});

webhookRoutes.get("/:id", async (c) => {
	requireAdmin(c.get("principal"));
	const db = getDb(c.env);
	const row = await db
		.select()
		.from(webhooks)
		.where(eq(webhooks.id, c.req.param("id")))
		.get();
	if (!row) throw notFound("Webhook が見つかりません");
	return c.json(toResponse(row));
});

webhookRoutes.patch("/:id", async (c) => {
	requireAdmin(c.get("principal"));
	const db = getDb(c.env);
	const id = c.req.param("id");
	const existing = await db.select().from(webhooks).where(eq(webhooks.id, id)).get();
	if (!existing) throw notFound("Webhook が見つかりません");

	const body = await c.req.json().catch(() => {
		throw invalidRequest("JSON ボディをパースできません");
	});
	const parsed = webhookUpdateInput.safeParse(body);
	if (!parsed.success) {
		throw invalidRequest("リクエストが不正です", parsed.error.issues);
	}
	const v = parsed.data;

	const changes: Record<string, unknown> = {};
	if (v.name !== undefined) changes.name = v.name;
	if (v.url !== undefined) changes.url = v.url;
	if (v.events !== undefined) changes.events = v.events;
	if (v.addressIds !== undefined) changes.addressIds = v.addressIds ?? null;
	if (v.enabled !== undefined) changes.enabled = v.enabled;

	await db.update(webhooks).set(changes).where(eq(webhooks.id, id));

	const updated = await db.select().from(webhooks).where(eq(webhooks.id, id)).get();
	return c.json(toResponse(updated!));
});

webhookRoutes.delete("/:id", async (c) => {
	requireAdmin(c.get("principal"));
	const db = getDb(c.env);
	const id = c.req.param("id");
	const existing = await db.select().from(webhooks).where(eq(webhooks.id, id)).get();
	if (!existing) throw notFound("Webhook が見つかりません");
	// 配信履歴は onDelete cascade で一緒に消える。
	await db.delete(webhooks).where(eq(webhooks.id, id));
	return c.body(null, 204);
});

webhookRoutes.get("/:id/deliveries", async (c) => {
	requireAdmin(c.get("principal"));
	const db = getDb(c.env);
	const id = c.req.param("id");
	const existing = await db.select().from(webhooks).where(eq(webhooks.id, id)).get();
	if (!existing) throw notFound("Webhook が見つかりません");

	const query = paginationQuery.safeParse(c.req.query());
	if (!query.success) throw invalidRequest("クエリが不正です", query.error.issues);
	const { limit } = query.data;
	const cursorRaw = c.req.query("cursor");
	const cursorDate = cursorRaw ? new Date(Number(cursorRaw)) : null;

	const base = cursorDate
		? and(eq(webhookDeliveries.webhookId, id), lt(webhookDeliveries.createdAt, cursorDate))
		: eq(webhookDeliveries.webhookId, id);

	const rows = await db
		.select()
		.from(webhookDeliveries)
		.where(base)
		.orderBy(desc(webhookDeliveries.createdAt))
		.limit(limit + 1)
		.all();

	const hasMore = rows.length > limit;
	const page = hasMore ? rows.slice(0, limit) : rows;
	const last = page[page.length - 1];
	const next_cursor =
		hasMore && last?.createdAt ? String(last.createdAt.getTime()) : null;

	return c.json({ data: page.map(toDeliveryResponse), next_cursor });
});

webhookRoutes.post("/deliveries/:id/retry", async (c) => {
	requireAdmin(c.get("principal"));
	const db = getDb(c.env);
	const deliveryId = c.req.param("id");
	const delivery = await db
		.select()
		.from(webhookDeliveries)
		.where(eq(webhookDeliveries.id, deliveryId))
		.get();
	if (!delivery) throw notFound("配信履歴が見つかりません");

	await runDelivery(c.env, deliveryId, delivery.attempt);

	const updated = await db
		.select()
		.from(webhookDeliveries)
		.where(eq(webhookDeliveries.id, deliveryId))
		.get();
	return c.json(toDeliveryResponse(updated!));
});
