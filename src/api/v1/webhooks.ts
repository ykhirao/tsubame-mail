import { Hono } from "hono";
import { and, asc, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { getDb } from "@/db/client";
import { addresses, webhooks, webhookDeliveries } from "@/db/schema";
import { conflict, invalidRequest, notFound } from "@/shared/errors";
import { paginationQuery } from "@/shared/contracts/common";
import { webhookInput, webhookListQuery, webhookUpdateInput } from "@/shared/contracts/webhooks";
import { newId } from "@/lib/id";
import { readJson } from "@/lib/validate";
import { runDelivery } from "@/services/webhooks";
import { afterCursor, toPage } from "@/lib/paging";
import type { Webhook, WebhookDelivery } from "@/shared/contracts/webhooks";
import type { AppEnv } from "@/api/types";
import { clientIp, getPrincipal, requireOwner, requireUnrestricted } from "../middleware/auth";
import { recordAudit } from "@/domain/access/policy";

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

webhookRoutes.post("/", requireUnrestricted, async (c) => {
	const db = getDb(c.env);
	const v = await readJson(c.req, webhookInput);
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
	await recordAudit(db, {
		actorId: getPrincipal(c).userId,
		action: "webhook.create",
		targetType: "webhook",
		targetId: id,
		meta: {
			name: v.name,
			url: v.url,
			events: v.events,
			addressIds: v.addressIds ?? null,
			enabled: v.enabled,
		},
		ip: clientIp(c),
	});
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

webhookRoutes.patch("/:id", requireUnrestricted, async (c) => {
	const db = getDb(c.env);
	const id = c.req.param("id");
	const existing = await db.select().from(webhooks).where(eq(webhooks.id, id)).get();
	if (!existing) throw notFound("Webhook が見つかりません");

	const v = await readJson(c.req, webhookUpdateInput);
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
	await recordAudit(db, {
		actorId: getPrincipal(c).userId,
		action: "webhook.update",
		targetType: "webhook",
		targetId: id,
		meta: { name: existing.name, url: existing.url },
		ip: clientIp(c),
	});
	return c.json(toResponse(updated!));
});

webhookRoutes.delete("/:id", requireUnrestricted, async (c) => {
	const db = getDb(c.env);
	const id = c.req.param("id");
	const existing = await db.select().from(webhooks).where(eq(webhooks.id, id)).get();
	if (!existing) throw notFound("Webhook が見つかりません");
	// 配信履歴は onDelete cascade で一緒に消える。
	await db.delete(webhooks).where(eq(webhooks.id, id));
	await recordAudit(db, {
		actorId: getPrincipal(c).userId,
		action: "webhook.delete",
		targetType: "webhook",
		targetId: id,
		meta: { name: existing.name },
		ip: clientIp(c),
	});
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

webhookRoutes.post("/deliveries/:id/retry", requireUnrestricted, async (c) => {
	const db = getDb(c.env);
	const deliveryId = c.req.param("id");
	const delivery = await db
		.select()
		.from(webhookDeliveries)
		.where(eq(webhookDeliveries.id, deliveryId))
		.get();
	if (!delivery) throw notFound("配信履歴が見つかりません");
	const webhook = await db.select().from(webhooks).where(eq(webhooks.id, delivery.webhookId)).get();
	if (!webhook) throw notFound("Webhook が見つかりません");
	if (!webhook.enabled) throw conflict("無効化した Webhook の配信は再送できません");

	// 条件付き更新で取り分け、同時に投げた 2 回目は 409 になる。claim の直後は next_retry_at が
	// 今なのですぐには再送対象にならず、30 分経って止まった pending はまた再送できる（#69 / B-20）。
	// next_retry_at が null の pending は初回の POST 中なので、作成から 30 分経つまで待つ。
	const retryableBefore = new Date(Date.now() - 1800 * 1000);
	const claimed = await db
		.update(webhookDeliveries)
		.set({ status: "pending", nextRetryAt: new Date() })
		.where(
			and(
				eq(webhookDeliveries.id, deliveryId),
				or(
					eq(webhookDeliveries.status, "failed"),
					and(
						eq(webhookDeliveries.status, "pending"),
						or(
							lt(webhookDeliveries.nextRetryAt, retryableBefore),
							and(isNull(webhookDeliveries.nextRetryAt), lt(webhookDeliveries.createdAt, retryableBefore)),
						),
					),
				),
			),
		)
		.returning();
	if (claimed.length === 0) throw conflict("この配信は今は再送できません");

	// runDelivery は pending かつ attempt が与えた値以上だと「次の試行をキューに投入」する
	// ので、この再送を実際に POST させるには attempt を 1 繰り上げて渡す必要がある。
	await runDelivery(c.env, deliveryId, delivery.attempt + 1);

	const updated = await db
		.select()
		.from(webhookDeliveries)
		.where(eq(webhookDeliveries.id, deliveryId))
		.get();
	await recordAudit(db, {
		actorId: getPrincipal(c).userId,
		action: "webhook.retry",
		targetType: "webhook",
		targetId: delivery.webhookId,
		meta: { deliveryId, attempt: delivery.attempt + 1 },
		ip: clientIp(c),
	});
	return c.json(toDeliveryResponse(updated!));
});
