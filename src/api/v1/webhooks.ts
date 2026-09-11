import { Hono } from "hono";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { addresses, webhooks, webhookDeliveries } from "@/db/schema";
import { conflict, invalidRequest, notFound } from "@/shared/errors";
import { paginationQuery } from "@/shared/contracts/common";
import { webhookInput, webhookListQuery, webhookUpdateInput } from "@/shared/contracts/webhooks";
import { newId } from "@/lib/id";
import { runDelivery } from "@/services/webhooks";
import { afterCursor, toPage } from "@/lib/paging";
import type { Webhook, WebhookDelivery } from "@/shared/contracts/webhooks";
import type { AppEnv } from "@/api/types";
import { requireOwner } from "../middleware/auth";

export const webhookRoutes = new Hono<AppEnv>();
export default webhookRoutes;

webhookRoutes.use("*", requireOwner);

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

/**
 * 存在しない id、または owner が member に開放されたときに権限外の id を
 * webhook に登録できないよう、DB に実在し principal から見える id だけを許す（#44）。
 * owner は addressIds が "all" なので可視性の側は今は常に通る。
 */
async function assertAddressIdsValid(
	db: ReturnType<typeof getDb>,
	addressIds: string[] | null | undefined,
	principal: { addressIds: string[] | "all" },
): Promise<void> {
	if (!addressIds || addressIds.length === 0) return;

	if (principal.addressIds !== "all") {
		const visible = new Set(principal.addressIds);
		const denied = addressIds.filter((id) => !visible.has(id));
		if (denied.length > 0) {
			throw invalidRequest("権限の無いアドレスが addressIds に含まれています", { denied });
		}
	}

	const found = await db
		.select({ id: addresses.id })
		.from(addresses)
		.where(inArray(addresses.id, addressIds))
		.all();
	const foundIds = new Set(found.map((r) => r.id));
	const missing = addressIds.filter((id) => !foundIds.has(id));
	if (missing.length > 0) {
		throw invalidRequest("存在しないアドレスが addressIds に含まれています", { missing });
	}
}

webhookRoutes.get("/", async (c) => {
	const query = webhookListQuery.safeParse(c.req.query());
	if (!query.success) throw invalidRequest("クエリが不正です", query.error.issues);
	const { limit, cursor } = query.data;

	const db = getDb(c.env);
	const rows = await db
		.select()
		.from(webhooks)
		.where(afterCursor(webhooks, cursor, "asc"))
		.orderBy(asc(webhooks.createdAt), asc(webhooks.id))
		.limit(limit + 1)
		.all();

	const page = toPage(rows, limit);
	return c.json({ data: page.rows.map(toResponse), next_cursor: page.next_cursor });
});

webhookRoutes.post("/", async (c) => {
	const body = await c.req.json().catch(() => {
		throw invalidRequest("JSON ボディをパースできません");
	});
	const parsed = webhookInput.safeParse(body);
	if (!parsed.success) {
		throw invalidRequest("リクエストが不正です", parsed.error.issues);
	}
	const v = parsed.data;
	const db = getDb(c.env);
	await assertAddressIdsValid(db, v.addressIds, c.get("principal"));
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
	if (v.addressIds !== undefined) {
		await assertAddressIdsValid(db, v.addressIds, c.get("principal"));
	}

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
	const db = getDb(c.env);
	const id = c.req.param("id");
	const existing = await db.select().from(webhooks).where(eq(webhooks.id, id)).get();
	if (!existing) throw notFound("Webhook が見つかりません");
	// 配信履歴は onDelete cascade で一緒に消える。
	await db.delete(webhooks).where(eq(webhooks.id, id));
	return c.body(null, 204);
});

webhookRoutes.get("/:id/deliveries", async (c) => {
	const db = getDb(c.env);
	const id = c.req.param("id");
	const existing = await db.select().from(webhooks).where(eq(webhooks.id, id)).get();
	if (!existing) throw notFound("Webhook が見つかりません");

	const query = paginationQuery.safeParse(c.req.query());
	if (!query.success) throw invalidRequest("クエリが不正です", query.error.issues);
	const { limit, cursor } = query.data;

	const scope = eq(webhookDeliveries.webhookId, id);
	const cursorClause = afterCursor(webhookDeliveries, cursor, "desc");
	const where = cursorClause ? and(scope, cursorClause) : scope;

	const rows = await db
		.select()
		.from(webhookDeliveries)
		.where(where)
		.orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
		.limit(limit + 1)
		.all();

	const page = toPage(rows, limit);
	return c.json({ data: page.rows.map(toDeliveryResponse), next_cursor: page.next_cursor });
});

webhookRoutes.post("/deliveries/:id/retry", async (c) => {
	const db = getDb(c.env);
	const deliveryId = c.req.param("id");
	const delivery = await db
		.select()
		.from(webhookDeliveries)
		.where(eq(webhookDeliveries.id, deliveryId))
		.get();
	if (!delivery) throw notFound("配信履歴が見つかりません");
	if (delivery.status !== "failed") {
		throw conflict("failed の配信のみ再送できます");
	}

	await runDelivery(c.env, deliveryId, delivery.attempt);

	const updated = await db
		.select()
		.from(webhookDeliveries)
		.where(eq(webhookDeliveries.id, deliveryId))
		.get();
	return c.json(toDeliveryResponse(updated!));
});
