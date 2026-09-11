import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { schema } from "@/db/client";
import type { Db } from "@/db/client";
import { newId } from "@/lib/id";
import { readJson } from "@/lib/validate";
import { addressSetHas } from "@/domain/access/policy";
import { deviceInput, deviceUpdate } from "@/shared/contracts/notifications";
import { forbidden, notFound } from "@/shared/errors";
import { notificationSessionGuard, serializeDevice } from "./notifications";
import type { AppEnv } from "@/api/types";
import type { Principal } from "@/shared/contracts/common";

const app = new Hono<AppEnv>();
export default app;

app.use("*", notificationSessionGuard);

app.get("/", async (c) => {
	const principal = c.get("principal");
	const db = c.get("db");
	const rows = await db
		.select()
		.from(schema.pushDevices)
		.where(eq(schema.pushDevices.userId, principal.userId))
		.orderBy(desc(schema.pushDevices.createdAt));
	return c.json({ data: rows.map(serializeDevice) });
});

app.post("/", async (c) => {
	const principal = c.get("principal");
	const db = c.get("db");
	const body = await readJson(c.req, deviceInput);

	// 同じ endpoint は同じ端末の再登録（キー再生成や復元）なので上書きする。
	const existing = await db
		.select()
		.from(schema.pushDevices)
		.where(and(eq(schema.pushDevices.endpoint, body.endpoint), eq(schema.pushDevices.userId, principal.userId)))
		.limit(1);

	if (existing.length > 0) {
		const row = existing[0]!;
		await db
			.update(schema.pushDevices)
			.set({
				p256dh: body.keys.p256dh,
				auth: body.keys.auth,
				name: body.name,
				platform: body.platform,
				enabled: true,
				sessionId: principal.sessionId ?? null,
				lastSeenAt: new Date(),
			})
			.where(eq(schema.pushDevices.id, row.id));
		const [updated] = await db.select().from(schema.pushDevices).where(eq(schema.pushDevices.id, row.id)).limit(1);
		return c.json(serializeDevice(updated!), 200);
	}

	const id = newId("device");
	await db.insert(schema.pushDevices).values({
		id,
		userId: principal.userId,
		sessionId: principal.sessionId ?? null,
		endpoint: body.endpoint,
		p256dh: body.keys.p256dh,
		auth: body.keys.auth,
		name: body.name,
		platform: body.platform,
		enabled: true,
		lastSeenAt: new Date(),
	});
	const [row] = await db.select().from(schema.pushDevices).where(eq(schema.pushDevices.id, id)).limit(1);
	return c.json(serializeDevice(row!), 201);
});

app.patch("/:id", async (c) => {
	const principal = c.get("principal");
	const db = c.get("db");
	const id = c.req.param("id");
	const device = await requireOwnDevice(db, principal, id);
	const body = await readJson(c.req, deviceUpdate);
	const set: Record<string, unknown> = {};
	if (body.name !== undefined) set.name = body.name;
	if (body.enabled !== undefined) set.enabled = body.enabled;
	if (body.addressIds !== undefined) {
		if (body.addressIds === null) {
			set.addressIds = null;
		} else {
			set.addressIds = await validateAddressIds(db, principal, body.addressIds);
		}
	}
	await db.update(schema.pushDevices).set(set).where(eq(schema.pushDevices.id, id));
	const [updated] = await db.select().from(schema.pushDevices).where(eq(schema.pushDevices.id, id)).limit(1);
	return c.json(serializeDevice(updated ?? device));
});

app.delete("/:id", async (c) => {
	const principal = c.get("principal");
	const db = c.get("db");
	const id = c.req.param("id");
	await requireOwnDevice(db, principal, id);
	await db.delete(schema.pushDevices).where(and(eq(schema.pushDevices.id, id), eq(schema.pushDevices.userId, principal.userId)));
	return c.body(null, 204);
});

app.post("/:id/test", async (c) => {
	const principal = c.get("principal");
	const db = c.get("db");
	const id = c.req.param("id");
	await requireOwnDevice(db, principal, id);
	await c.env.OUTBOUND_QUEUE.send({ kind: "notify", event: "test", deviceId: id, userId: principal.userId });
	return c.json({ queued: true }, 202);
});

app.post("/:id/seen", async (c) => {
	const principal = c.get("principal");
	const db = c.get("db");
	const id = c.req.param("id");
	await requireOwnDevice(db, principal, id);
	await db.update(schema.pushDevices).set({ lastSeenAt: new Date() }).where(and(eq(schema.pushDevices.id, id), eq(schema.pushDevices.userId, principal.userId)));
	return c.body(null, 204);
});

async function requireOwnDevice(db: Db, principal: Principal, id: string) {
	const [row] = await db
		.select()
		.from(schema.pushDevices)
		.where(and(eq(schema.pushDevices.id, id), eq(schema.pushDevices.userId, principal.userId)))
		.limit(1);
	if (!row) throw notFound("端末が見つかりません");
	return row;
}

async function validateAddressIds(db: Db, principal: Principal, addressIds: string[]): Promise<string[]> {
	const denied = addressIds.filter((id) => !addressSetHas(principal.addressIds, id));
	if (denied.length > 0) throw forbidden("権限の無いメールボックスです");
	return [...new Set(addressIds)];
}
