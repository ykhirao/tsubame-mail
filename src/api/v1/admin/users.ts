import { Hono } from "hono";
import { and, asc, eq, isNull, ne, or, sql } from "drizzle-orm";
import { schema } from "@/db/client";
import { newId } from "@/lib/id";
import { generateTemporaryPassword, hashPassword } from "@/lib/password";
import { readJson, unixSeconds } from "@/lib/validate";
import { afterCursor, toPage } from "@/lib/paging";
import { jsonIdsIn, recordAudit } from "@/domain/access/policy";
import {
	adminUserListQuery,
	createUserBody,
	putGrantsBody,
	updateUserBody,
} from "@/shared/contracts/users";
import type { GrantInput } from "@/shared/contracts/users";
import { conflict, invalidRequest, notFound } from "@/shared/errors";
import { clientIp, getPrincipal, requireOwner, requireSession } from "../../middleware/auth";
import type { AppEnv } from "../../types";
import { revokeKeyTree, revokeKeysIssuedBy } from "../me";
import { createAddress } from "./addresses";

const app = new Hono<AppEnv>();

app.use("*", requireOwner);

function serializeUser(row: typeof schema.users.$inferSelect, primaryAddress: string | null) {
	return {
		id: row.id,
		email: row.externalEmail,
		externalEmail: row.externalEmail,
		externalVerified: row.externalVerifiedAt !== null,
		primaryAddressId: row.primaryAddressId,
		primaryAddress,
		name: row.name,
		role: row.role,
		status: row.status,
		hasPassword: row.passwordHash !== null,
		lastLoginAt: unixSeconds(row.lastLoginAt),
		createdAt: unixSeconds(row.createdAt),
	};
}

async function loadUser(db: AppEnv["Variables"]["db"], id: string) {
	const [row] = await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
	if (!row) throw notFound("ユーザーが見つかりません");
	return row;
}

async function primaryAddressOf(db: AppEnv["Variables"]["db"], primaryAddressId: string | null) {
	if (!primaryAddressId) return null;
	const addr = await db.query.addresses.findFirst({ where: eq(schema.addresses.id, primaryAddressId) });
	return addr?.address ?? null;
}

async function loadGrants(db: AppEnv["Variables"]["db"], userId: string) {
	return await db
		.select({
			addressId: schema.addressGrants.addressId,
			level: schema.addressGrants.level,
			address: schema.addresses.address,
		})
		.from(schema.addressGrants)
		.leftJoin(schema.addresses, eq(schema.addresses.id, schema.addressGrants.addressId))
		.where(eq(schema.addressGrants.userId, userId));
}

/**
 * 「数えてから更新する」の 2 手順の間に別リクエストが割り込むと、2 人の owner が同時に
 * 互いを降格・無効化・削除して 0 人になりうる（#54）。同じ判定を UPDATE / DELETE の
 * WHERE 句に埋め込み、1 文で完結させる。
 */
function otherActiveOwnersExist(excludeUserId: string) {
	return sql`(select count(*) from ${schema.users} where ${schema.users.role} = 'owner'
		and ${schema.users.status} = 'active' and ${schema.users.id} <> ${excludeUserId}) > 0`;
}

app.get("/", async (c) => {
	const query = adminUserListQuery.safeParse(c.req.query());
	if (!query.success) throw invalidRequest("クエリが不正です", query.error.issues);
	const { limit, cursor } = query.data;
	const db = c.get("db");
	const rows = await db
		.select()
		.from(schema.users)
		.where(afterCursor(schema.users, cursor, "asc"))
		.orderBy(asc(schema.users.createdAt), asc(schema.users.id))
		.limit(limit + 1);
	const page = toPage(rows, limit);
	const primaryIds = page.rows.map((r) => r.primaryAddressId).filter((id): id is string => id !== null);
	const primaryAddrs = primaryIds.length
		? await db
				.select({ id: schema.addresses.id, address: schema.addresses.address })
				.from(schema.addresses)
				.where(jsonIdsIn(schema.addresses.id, [...new Set(primaryIds)]))
		: [];
	const primaryOf = new Map(primaryAddrs.map((a) => [a.id, a.address]));
	return c.json({
		data: page.rows.map((r) => serializeUser(r, r.primaryAddressId ? (primaryOf.get(r.primaryAddressId) ?? null) : null)),
		next_cursor: page.next_cursor,
	});
});

app.get("/:id", async (c) => {
	const db = c.get("db");
	const user = await loadUser(db, c.req.param("id"));
	const primaryAddress = await primaryAddressOf(db, user.primaryAddressId);
	return c.json({
		...serializeUser(user, primaryAddress),
		grants: await loadGrants(db, user.id),
	});
});

// 同時に同じプライマリ・外部アドレスで作られると一意制約で落ちる。500 ではなく 409 にする。
async function insertUniquely(run: () => Promise<unknown>): Promise<void> {
	try {
		await run();
	} catch (err) {
		const text = String((err as { cause?: unknown })?.cause ?? err);
		if (text.includes("UNIQUE")) throw conflict("そのプライマリか外部アドレスは、別のユーザーが使っています");
		throw err;
	}
}

app.post("/", requireSession, async (c) => {
	const principal = getPrincipal(c);
	const body = await readJson(c.req, createUserBody);
	const db = c.get("db");

	const email = body.email?.trim().toLowerCase();
	if (email) {
		// 外部アドレスは他の利用者の外部アドレス・どのアドレスとも重ならない（FR-4-5）。
		const [existing] = await db
			.select({ id: schema.users.id })
			.from(schema.users)
			.where(eq(schema.users.externalEmail, email))
			.limit(1);
		if (existing) throw conflict("そのメールアドレスは既に使われています");
		const [existingAddress] = await db
			.select({ id: schema.addresses.id })
			.from(schema.addresses)
			.where(eq(schema.addresses.address, email))
			.limit(1);
		if (existingAddress) throw conflict("そのメールアドレスはこのアプリのアドレスと重なっています");
	}

	const primary = body.primaryAddress;
	let primaryAddressId: string;
	if ("addressId" in primary) {
		const addr = await db.query.addresses.findFirst({
			where: eq(schema.addresses.id, primary.addressId),
		});
		if (!addr) throw invalidRequest("指定したアドレスが見つかりません");
		if (addr.kind !== "mailbox") throw invalidRequest("プライマリにはメールボックスを選んでください");
		if (addr.archivedAt !== null) throw invalidRequest("アーカイブ済みのアドレスはプライマリにできません");
		const [holder] = await db
			.select({ id: schema.users.id })
			.from(schema.users)
			.where(eq(schema.users.primaryAddressId, addr.id))
			.limit(1);
		if (holder) throw conflict("そのアドレスは別のユーザーのプライマリです");
		if (email === addr.address) throw conflict("プライマリと外部アドレスを同じにできません");
		primaryAddressId = addr.id;
	} else {
		// アドレスを作ってから失敗するとアドレスと Cloudflare のルールが残るので、作る前に確かめられるものは確かめる。
		const domain = await db.query.domains.findFirst({ where: eq(schema.domains.id, primary.domainId) });
		if (domain && email === `${primary.localPart}@${domain.name}`.toLowerCase()) {
			throw conflict("プライマリと外部アドレスを同じにできません");
		}
		const created = await createAddress(c, {
			domainId: primary.domainId,
			localPart: primary.localPart,
			displayName: primary.displayName,
			kind: "mailbox",
			isCatchAll: false,
		});
		primaryAddressId = created.row.id;
	}

	const id = newId("user");

	// password を省略したら仮パスワードを発行し、初回ログイン後の変更を必須にする。
	const isAgent = body.role === "agent";
	const temporaryPassword = isAgent || body.password ? null : generateTemporaryPassword();
	const plain = body.password ?? temporaryPassword;
	const passwordHash = isAgent ? null : await hashPassword(plain as string);

	await insertUniquely(() => db.insert(schema.users).values({
		id,
		email: email ?? `${id}@users.invalid`,
		externalEmail: email ?? null,
		primaryAddressId,
		name: body.name,
		passwordHash,
		role: body.role,
		status: "active",
		mustChangePassword: temporaryPassword !== null,
	}));

	// プライマリは write で割り当てる（FR-4-5）。
	await db.insert(schema.addressGrants).values({
		userId: id,
		addressId: primaryAddressId,
		level: "write",
	});

	await recordAudit(db, {
		actorId: principal.userId,
		action: "user.create",
		targetType: "user",
		targetId: id,
		meta: { email, role: body.role, primaryAddressId },
		ip: clientIp(c),
	});

	// 仮パスワードはここでしか返らない。保存しているのはハッシュだけ。
	const primaryAddress = await primaryAddressOf(db, primaryAddressId);
	return c.json({ ...serializeUser(await loadUser(db, id), primaryAddress), temporaryPassword }, 201);
});

app.patch("/:id", requireSession, async (c) => {
	const principal = getPrincipal(c);
	const id = c.req.param("id");
	const body = await readJson(c.req, updateUserBody);
	const db = c.get("db");

	const user = await loadUser(db, id);
	if (body.password !== undefined && (body.role ?? user.role) === "agent") {
		throw invalidRequest("agent ロールはパスワードを持ちません");
	}

	const patch: Partial<typeof schema.users.$inferInsert> = {};
	if (body.name !== undefined) patch.name = body.name;
	if (body.role !== undefined) patch.role = body.role;
	if (body.status !== undefined) patch.status = body.status;
	if (body.password !== undefined) {
		patch.passwordHash = await hashPassword(body.password);
		// owner が決めたパスワードのまま使い続けられないよう、初回変更を必須にする（#98）。
		patch.mustChangePassword = true;
	}
	if (body.role === "agent") patch.passwordHash = null;
	if (body.primaryAddressId !== undefined) {
		const primaryId = body.primaryAddressId;
		const addr = await db.query.addresses.findFirst({
			where: eq(schema.addresses.id, primaryId),
		});
		if (!addr || addr.kind !== "mailbox" || addr.archivedAt !== null) {
			throw invalidRequest("プライマリには、アーカイブされていないメールボックスを指定してください");
		}
		const grantRow = await db.query.addressGrants.findFirst({
			where: and(eq(schema.addressGrants.userId, id), eq(schema.addressGrants.addressId, primaryId)),
		});
		if (!grantRow || grantRow.level !== "write") {
			throw invalidRequest("その人に write で割り当てたアドレスだけをプライマリにできます");
		}
		const [holder] = await db
			.select({ id: schema.users.id })
			.from(schema.users)
			.where(eq(schema.users.primaryAddressId, primaryId))
			.limit(1);
		if (holder && holder.id !== id) throw conflict("そのアドレスは別のユーザーのプライマリです");
		const [external] = await db
			.select({ id: schema.users.id })
			.from(schema.users)
			.where(eq(schema.users.externalEmail, addr.address))
			.limit(1);
		if (external) throw conflict("そのアドレスは利用者の外部アドレスとして使われています");
		patch.primaryAddressId = primaryId;
	}

	// この PATCH が owner から降ろす／無効化する可能性がある変更かどうかは、
	// リクエストボディだけで決まる（"owner のまま" の role 指定や name だけの更新は対象外）。
	const mayLoseOwnership = (body.role !== undefined && body.role !== "owner") || body.status === "disabled";
	// 「今 owner か」と「他に有効な owner が居るか」を UPDATE の WHERE 句で直接見るので、
	// 確認と更新の間に別リクエストが割り込む隙間が無い（#54）。
	const guard = mayLoseOwnership
		? or(ne(schema.users.role, "owner"), otherActiveOwnersExist(id))
		: undefined;

	const result = await db
		.update(schema.users)
		.set(patch)
		.where(guard ? and(eq(schema.users.id, id), guard) : eq(schema.users.id, id))
		.run();
	if (result.meta.changes === 0) {
		// WHERE 句が絞った理由（行が無い／ガードに落ちた）を UPDATE の結果だけでは区別できないので、
		// 404 と 409 を正しく出し分けるために loadUser を挟む。
		await loadUser(db, id);
		throw conflict("最後のオーナーを降格・無効化することはできません");
	}

	// 無効化・降格・パスワード変更のいずれでも、既存セッションは切る。
	if (body.status === "disabled" || body.role !== undefined || body.password !== undefined) {
		await db.delete(schema.sessions).where(eq(schema.sessions.userId, id));
	}
	// パスワードを変えたら発行済みの API キーも失効させる（#99）。無効化でも、その人のキーから
	// 他の利用者向けに発行したキーは本人の状態と関係なく動き続けるので失効させる（#142）。
	const now = new Date();
	if (body.password !== undefined) {
		await db.delete(schema.pushDevices).where(eq(schema.pushDevices.userId, id));
		await db
			.update(schema.apiKeys)
			.set({ revokedAt: now })
			.where(and(eq(schema.apiKeys.userId, id), isNull(schema.apiKeys.revokedAt)));
	}
	const revokedDescendantKeys =
		body.password !== undefined || body.status === "disabled" ? await revokeKeysIssuedBy(db, id, now) : [];

	await recordAudit(db, {
		actorId: principal.userId,
		action: "user.update",
		targetType: "user",
		targetId: id,
		meta: {
			name: body.name,
			role: body.role,
			status: body.status,
			passwordChanged: body.password !== undefined,
			primaryAddressId: body.primaryAddressId,
			revokedDescendantKeys,
		},
		ip: clientIp(c),
	});

	const updated = await loadUser(db, id);
	return c.json(serializeUser(updated, await primaryAddressOf(db, updated.primaryAddressId)));
});

app.delete("/:id", requireSession, async (c) => {
	const principal = getPrincipal(c);
	const id = c.req.param("id");
	const db = c.get("db");

	const user = await loadUser(db, id);
	const ownKeys = await db
		.select({ id: schema.apiKeys.id })
		.from(schema.apiKeys)
		.where(eq(schema.apiKeys.userId, id));

	// 「今 owner か」と「他に有効な owner が居るか」を DELETE の WHERE 句で直接見るので、
	// 確認と削除の間に別リクエストが割り込む隙間が無い（#54）。
	// sessions / api_keys / address_grants は外部キーの cascade で消える。
	const result = await db
		.delete(schema.users)
		.where(and(eq(schema.users.id, id), or(ne(schema.users.role, "owner"), otherActiveOwnersExist(id))))
		.run();
	if (result.meta.changes === 0) {
		throw conflict("最後のオーナーを削除することはできません");
	}

	// 利用者のキーは cascade で消えるが、そのキーから他の利用者向けに発行したキーは残るので失効させる（#25）。
	const now = new Date();
	const descendants: string[] = [];
	for (const k of ownKeys) descendants.push(...(await revokeKeyTree(db, k.id, now)));

	await recordAudit(db, {
		actorId: principal.userId,
		action: "user.delete",
		targetType: "user",
		targetId: id,
		meta: { email: user.email, role: user.role, revokedDescendantKeys: descendants },
		ip: clientIp(c),
	});

	return c.json({ ok: true, id });
});

app.put("/:id/grants", requireSession, async (c) => {
	const principal = getPrincipal(c);
	const id = c.req.param("id");
	const parsed = await readJson(c.req, putGrantsBody);
	const grants: GrantInput[] = Array.isArray(parsed) ? parsed : parsed.grants;
	const db = c.get("db");

	const user = await loadUser(db, id);

	const merged = new Map<string, GrantInput>();
	for (const g of grants) merged.set(g.addressId, g);
	const wanted = [...merged.values()];

	// プライマリは常に write で割り当てる（FR-4-5）。一覧に無ければ write のまま残し、read に下げる指定だけを 400 にする。
	const currentPrimary = user.primaryAddressId;
	if (currentPrimary) {
		const primaryGrant = merged.get(currentPrimary);
		if (primaryGrant && primaryGrant.level !== "write") {
			throw invalidRequest("プライマリのアドレスは read に下げられません。先にプライマリを変えてください");
		}
		if (!primaryGrant) wanted.push({ addressId: currentPrimary, level: "write" });
	}

	if (wanted.length > 0) {
		const found = await db
			.select({ id: schema.addresses.id })
			.from(schema.addresses)
			.where(jsonIdsIn(schema.addresses.id, wanted.map((g) => g.addressId)));
		const known = new Set(found.map((r) => r.id));
		const missing = wanted.filter((g) => !known.has(g.addressId)).map((g) => g.addressId);
		if (missing.length > 0) throw invalidRequest(`存在しないアドレスです: ${missing.join(", ")}`);
	}

	// 全部入れ直すので、本人が決めた非表示（見え方の設定）を引き継ぐ。
	const hiddenBefore = new Set(
		(
			await db
				.select({ addressId: schema.addressGrants.addressId })
				.from(schema.addressGrants)
				.where(and(eq(schema.addressGrants.userId, id), eq(schema.addressGrants.hidden, true)))
		).map((r) => r.addressId),
	);
	await db.delete(schema.addressGrants).where(eq(schema.addressGrants.userId, id));
	if (wanted.length > 0) {
		// 1 文に全件積むとバインドが 100 を超える（#57）。drizzle は既定値のある列（hidden）もバインドするので 1 行 4 個、20 件=80 個ずつに割る。
		const CHUNK = 20;
		const insertBatches: any[] = [];
		for (let i = 0; i < wanted.length; i += CHUNK) {
			insertBatches.push(
				db.insert(schema.addressGrants).values(
					wanted
						.slice(i, i + CHUNK)
						.map((g) => ({ userId: id, addressId: g.addressId, level: g.level, hidden: hiddenBefore.has(g.addressId) })),
				),
			);
		}
		await db.batch(insertBatches as unknown as Parameters<typeof db.batch>[0]);
	}

	await recordAudit(db, {
		actorId: principal.userId,
		action: "user.grants.replace",
		targetType: "user",
		targetId: id,
		meta: { grants: wanted },
		ip: clientIp(c),
	});

	return c.json({ userId: user.id, grants: await loadGrants(db, id) });
});

export default app;
