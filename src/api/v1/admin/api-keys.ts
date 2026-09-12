import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { schema } from "@/db/client";
import { newId } from "@/lib/id";
import { generateApiKey } from "@/lib/tokens";
import { readJson, unixSeconds } from "@/lib/validate";
import { afterCursor, toPage } from "@/lib/paging";
import {
	addressSetHas,
	recordAudit,
	resolveUserAddressAccess,
} from "@/domain/access/policy";
import { adminApiKeyListQuery, adminCreateApiKeyBody } from "@/shared/contracts/api-keys";
import { invalidRequest, notFound } from "@/shared/errors";
import { clientIp, getPrincipal, requireOwner, requireUnrestricted } from "../../middleware/auth";
import {
	assertAddressesExist,
	clampAddressIds,
	clampExpiresAt,
	clampScopes,
	revokeKeyTree,
	serializeKey,
} from "../me";
import type { AppEnv } from "../../types";

const app = new Hono<AppEnv>();

app.use("*", requireOwner);

app.get("/", async (c) => {
	const query = adminApiKeyListQuery.safeParse(c.req.query());
	if (!query.success) throw invalidRequest("クエリが不正です", query.error.issues);
	const { userId, limit, cursor } = query.data;
	const db = c.get("db");
	const rows = await db
		.select()
		.from(schema.apiKeys)
		.where(
			and(
				userId ? eq(schema.apiKeys.userId, userId) : undefined,
				afterCursor(schema.apiKeys, cursor, "desc"),
			),
		)
		.orderBy(desc(schema.apiKeys.createdAt), desc(schema.apiKeys.id))
		.limit(limit + 1);
	const page = toPage(rows, limit);
	return c.json({ data: page.rows.map(serializeKey), next_cursor: page.next_cursor });
});

app.get("/:id", async (c) => {
	const id = c.req.param("id");
	const db = c.get("db");
	const [key] = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, id)).limit(1);
	if (!key) throw notFound("キーが見つかりません");
	return c.json(serializeKey(key));
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

	let scopes = [...new Set(body.scopes)];
	let addressIds = body.addressIds ? [...new Set(body.addressIds)] : null;
	let expiresAt = body.expiresAt ? new Date(body.expiresAt * 1000) : null;
	// zod の max で範囲の手前は落ちるが、NaN のまま保存すると「無期限」として読まれるのでここでも落とす（#83）。
	if (expiresAt && !Number.isFinite(expiresAt.getTime())) throw invalidRequest("expiresAt が不正です");

	// #58 要求者が API キーのとき、作れるキーはそのキーの範囲を超えられない。
	// 絞られた admin キーから全アドレス・全スコープ・無期限のキーが作れてしまうのを塞ぐ。
	if (principal.via === "api_key") {
		scopes = clampScopes(principal.scopes, scopes);
		// 絞っていないキーの範囲は持ち主の割り当てではなく「制限なし」。持ち主の割り当てで凍結すると、他の利用者向けのキーを壊す。
		addressIds = clampAddressIds(principal.keyRestricted ? principal.addressIds : "all", addressIds, true);
		expiresAt = await clampExpiresAt(db, principal, body.expiresAt);
	}

	// キーの addressIds は所有ユーザーの権限との積集合になるので、
	// 権限外のアドレスを入れても無効になるだけ。気づけるようにここで弾く。
	if (addressIds) {
		const access = await resolveUserAddressAccess(db, { id: user.id, role: user.role });
		const outside = addressIds.filter((id) => !addressSetHas(access.readable, id));
		if (outside.length > 0) {
			throw invalidRequest(
				`ユーザーに権限の無いアドレスです。先に grants を付けてください: ${outside.join(", ")}`,
			);
		}
		await assertAddressesExist(db, addressIds);
	}

	const generated = await generateApiKey();
	const id = newId("apiKey");
	await db.insert(schema.apiKeys).values({
		id,
		userId: user.id,
		name: body.name,
		prefix: generated.prefix,
		keyHash: generated.hash,
		scopes,
		addressIds,
		expiresAt,
		parentKeyId: principal.apiKeyId ?? null,
	});

	await recordAudit(db, {
		actorId: principal.userId,
		action: "api_key.create",
		targetType: "api_key",
		targetId: id,
		meta: {
			userId: user.id,
			name: body.name,
			scopes,
			addressIds,
			expiresAt: expiresAt ? unixSeconds(expiresAt) : null,
			apiKeyId: principal.apiKeyId ?? null,
		},
		ip: clientIp(c),
	});

	const [row] = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, id)).limit(1);
	// token は発行時のこのレスポンスにしか出てこない。DB にはハッシュしか無い。
	return c.json({ ...serializeKey(row!), token: generated.token }, 201);
});

// 範囲を絞ったキーで、範囲外の利用者のキーまで止められないようにする（#129 と同じ線）。
app.delete("/:id", requireUnrestricted, async (c) => {
	const principal = getPrincipal(c);
	const id = c.req.param("id");
	const db = c.get("db");

	const [key] = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, id)).limit(1);
	if (!key) throw notFound("キーが見つかりません");

	// 行は消さない。誰がいつ何を失効させたかを追えるようにしておく。
	const revokedAt = key.revokedAt ?? new Date();
	const descendants = await revokeKeyTree(db, id, revokedAt);

	await recordAudit(db, {
		actorId: principal.userId,
		action: "api_key.revoke",
		targetType: "api_key",
		targetId: id,
		meta: { userId: key.userId, name: key.name, descendants },
		ip: clientIp(c),
	});

	return c.json({ ...serializeKey(key), revokedAt: unixSeconds(revokedAt) });
});

export default app;
