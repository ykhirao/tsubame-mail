import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import { schema } from "@/db/client";
import { newId } from "@/lib/id";
import { generateApiKey } from "@/lib/tokens";
import { readJson, unixSeconds } from "@/lib/validate";
import {
	addressSetHas,
	recordAudit,
	resolveUserAddressAccess,
} from "@/domain/access/policy";
import { adminCreateApiKeyBody } from "@/shared/contracts/api-keys";
import { invalidRequest, notFound } from "@/shared/errors";
import { clientIp, getPrincipal, requireOwner } from "../../middleware/auth";
import { serializeKey } from "../me";
import type { AppEnv } from "../../types";

const app = new Hono<AppEnv>();

app.use("*", requireOwner);

app.get("/", async (c) => {
	const db = c.get("db");
	const userId = c.req.query("userId");
	const rows = await db
		.select()
		.from(schema.apiKeys)
		.where(userId ? eq(schema.apiKeys.userId, userId) : undefined)
		.orderBy(desc(schema.apiKeys.createdAt));
	return c.json({ data: rows.map(serializeKey), next_cursor: null });
});

app.post("/", async (c) => {
	const principal = getPrincipal(c);
	const body = await readJson(c.req, adminCreateApiKeyBody);
	const db = c.get("db");

	const [user] = await db
		.select({ id: schema.users.id, role: schema.users.role, status: schema.users.status })
		.from(schema.users)
		.where(eq(schema.users.id, body.userId))
		.limit(1);
	if (!user) throw notFound("ユーザーが見つかりません");

	// キーの addressIds は所有ユーザーの権限との積集合になるので、
	// 権限外のアドレスを入れても無効になるだけ。気づけるようにここで弾く。
	const access = await resolveUserAddressAccess(db, { id: user.id, role: user.role });
	const requested = body.addressIds ?? null;
	if (requested) {
		const outside = requested.filter((id) => !addressSetHas(access.readable, id));
		if (outside.length > 0) {
			throw invalidRequest(
				`ユーザーに権限の無いアドレスです。先に grants を付けてください: ${outside.join(", ")}`,
			);
		}
	}

	const generated = await generateApiKey();
	const id = newId("apiKey");
	const addressIds = requested ? [...new Set(requested)] : null;

	await db.insert(schema.apiKeys).values({
		id,
		userId: user.id,
		name: body.name,
		prefix: generated.prefix,
		keyHash: generated.hash,
		scopes: [...new Set(body.scopes)],
		addressIds,
		expiresAt: body.expiresAt ? new Date(body.expiresAt * 1000) : null,
	});

	await recordAudit(db, {
		actorId: principal.userId,
		action: "api_key.create",
		targetType: "api_key",
		targetId: id,
		meta: { userId: user.id, name: body.name, scopes: body.scopes, addressIds },
		ip: clientIp(c),
	});

	const [row] = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, id)).limit(1);
	// token は発行時のこのレスポンスにしか出てこない。DB にはハッシュしか無い。
	return c.json({ ...serializeKey(row!), token: generated.token }, 201);
});

app.delete("/:id", async (c) => {
	const principal = getPrincipal(c);
	const id = c.req.param("id");
	const db = c.get("db");

	const [key] = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, id)).limit(1);
	if (!key) throw notFound("キーが見つかりません");

	// 行は消さない。誰がいつ何を失効させたかを追えるようにしておく。
	const revokedAt = key.revokedAt ?? new Date();
	await db.update(schema.apiKeys).set({ revokedAt }).where(eq(schema.apiKeys.id, id));

	await recordAudit(db, {
		actorId: principal.userId,
		action: "api_key.revoke",
		targetType: "api_key",
		targetId: id,
		meta: { userId: key.userId, name: key.name },
		ip: clientIp(c),
	});

	return c.json({ ...serializeKey(key), revokedAt: unixSeconds(revokedAt) });
});

export default app;
