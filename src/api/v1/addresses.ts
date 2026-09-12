import { Hono } from "hono";
import { z } from "zod";
import { defaultColorFor } from "@/shared/colors";
import { and, asc, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { addresses, addressGrants, domains, messages, threads } from "@/db/schema";
import type { AppEnv } from "@/api/types";
import { canRead, canWrite, jsonIdsIn, recordAudit } from "@/domain/access/policy";
import { conflict, forbidden, invalidRequest, notFound, unauthorized, ApiError } from "@/shared/errors";
import { afterCursor, toPage } from "@/lib/paging";
import { clientIp } from "@/api/middleware/auth";
import { readJson } from "@/lib/validate";
import { updateMySignatureInput, updateMyHiddenInput } from "@/shared/contracts/addresses";
import { redactError } from "@/lib/logError";

const app = new Hono<AppEnv>();

// UI はまだ cursor を送らない（一括取得の前提で作られている）ので、既定を大きめにして
// 通常の利用件数では挙動を変えないまま、無制限の一覧取得（#32）だけを塞ぐ。
const addressListQuery = z.object({
	includeArchived: z.enum(["true", "false"]).optional(),
	limit: z.coerce.number().int().min(1).max(200).default(100),
	cursor: z.string().optional(),
});

// app.ts でも張っているが、サブアプリ単体でテストしたときも同じ形になるよう重ねて張る。
app.onError((err, c) => {
	if (err instanceof ApiError) return c.json(err.toJSON(), err.status as 400);
	console.error("unhandled error", redactError(err));
	return c.json({ error: { code: "internal", message: "内部エラーが発生しました" } }, 500);
});

app.get("/", async (c) => {
	const principal = c.get("principal");
	if (!principal) throw unauthorized();
	// API キーはユーザーの権限を超えられない（read スコープが要る）。
	if (principal.via === "api_key" && !principal.scopes.includes("read")) {
		throw forbidden("この API キーには read スコープがありません");
	}
	const db = c.get("db");

	const query = addressListQuery.safeParse(c.req.query());
	if (!query.success) throw invalidRequest("クエリが不正です", query.error.issues);
	const { limit, cursor } = query.data;
	const includeArchived = query.data.includeArchived === "true";

	const scoped = principal.addressIds === "all" ? null : principal.addressIds;
	if (scoped && scoped.length === 0) {
		return c.json({ data: [], next_cursor: null });
	}

	// ページ内のアドレス id を inArray に積むと、バインド変数が id の数 + 2 個になり、
	// D1 の上限（100）をアドレス 99 件以上で超えて 500 になっていた（精査 #32）。
	// 相関サブクエリなら addresses.id は列参照であってバインド変数ではないので、
	// バインド変数の数はページの行数によらず一定になる。
	// 受信箱で濃く出る会話の数をそのまま数える。メールを 1 通ずつ数えたり、ゴミ箱の
	// 会話を含めたりすると、一覧に太字の行が 1 つも無いのにバッジだけ数字が残り、
	// 何を開けば消えるのか分からなくなる。ゴミ箱だけの会話は受信箱に出ないので除く
	// （一覧側の条件は `src/domain/search/sql.ts` の view === "inbox"）。
	const unreadCount = sql<number>`(
		select count(*) from ${threads}
		where ${and(eq(threads.addressId, addresses.id), gt(threads.unreadCount, 0))}
			and exists (
				select 1 from ${messages}
				where ${and(eq(messages.threadId, threads.id), ne(messages.status, "trash"))}
			)
	)`;

	const pageRows = await db
		.select({
			id: addresses.id,
			createdAt: addresses.createdAt,
			address: addresses,
			domainName: domains.name,
			unreadCount,
		})
		.from(addresses)
		.innerJoin(domains, eq(addresses.domainId, domains.id))
		.where(
			and(
				scoped ? jsonIdsIn(addresses.id, scoped) : undefined,
				includeArchived ? undefined : isNull(addresses.archivedAt),
				afterCursor(addresses, cursor, "asc"),
			),
		)
		.orderBy(asc(addresses.createdAt), asc(addresses.id))
		.limit(limit + 1);
	const page = toPage(pageRows, limit);
	const rows = page.rows;

	// hidden は利用者ごとの設定なので、grants の自分の行から引く。
	const grantRows = await db
		.select({ addressId: addressGrants.addressId, hidden: addressGrants.hidden })
		.from(addressGrants)
		.where(eq(addressGrants.userId, principal.userId))
		.all();
	const hiddenById = new Map(grantRows.map((g) => [g.addressId, g.hidden]));

	const writable = principal.writableAddressIds;
	const canWrite = (id: string) => writable === "all" || writable.includes(id);

	const data = rows.map((r, index) => ({
		id: r.address.id,
		address: r.address.address,
		localPart: r.address.localPart,
		displayName: r.address.displayName,
		domainId: r.address.domainId,
		domainName: r.domainName,
		kind: r.address.kind,
		/** read = 読むだけ / write = このアドレスから送信もできる。 */
		level: canWrite(r.address.id) ? ("write" as const) : ("read" as const),
		isCatchAll: r.address.isCatchAll,
		// 色が未設定の古い行でも一覧が壊れないよう、既定色にして返す。
		color: r.address.color ?? defaultColorFor(index),
		signature: r.address.signature,
		unreadCount: Number(r.unreadCount),
		archived: r.address.archivedAt !== null,
		hidden: hiddenById.get(r.address.id) ?? false,
	}));

	// ページ内だけの並び替え。cursor は createdAt 基準なので、ページをまたいだ完全な
	// アルファベット順にはならない（UI がまだ 1 ページ取得の前提のため、page.next_cursor が
	// null になる通常の利用件数では従来と同じ見た目になる）。
	data.sort((a, b) => a.address.localeCompare(b.address));

	return c.json({ data, next_cursor: page.next_cursor });
});

// 署名は共有メールボックスの属性なので、変更を誰がいつしたか残す。
app.patch("/:id/signature", async (c) => {
	const principal = c.get("principal");
	if (!principal) throw unauthorized();
	// 署名は人が作成画面で書くメール全部に差し込まれ、キーを失効しても残る。乗っ取られたエージェントの
	// キーから人のメールに文言やリンクを混ぜられないよう、画面のログインからしか変えさせない（#143）。
	if (principal.via !== "session") {
		throw forbidden("署名は画面から変更してください（API キーでは変更できません）");
	}
	const db = c.get("db");
	const id = c.req.param("id");

	const addr = await db.query.addresses.findFirst({ where: eq(addresses.id, id) });
	if (!addr || !canRead(principal, id)) throw notFound("アドレスが見つかりません");
	if (!canWrite(principal, id)) {
		throw forbidden("このメールボックスの署名を変える権限がありません");
	}
	if (addr.archivedAt) throw conflict("アーカイブ済みのメールボックスの署名は変更できません");

	const { signature } = await readJson(c.req, updateMySignatureInput);
	// 空文字は「署名なし」と同じ。
	const next = signature === "" ? null : signature;
	const before = addr.signature?.length ?? 0;

	await db.update(addresses).set({ signature: next }).where(eq(addresses.id, id));

	await recordAudit(db, {
		actorId: principal.userId,
		action: "address.signature",
		targetType: "address",
		targetId: id,
		meta: {
			address: addr.address,
			before,
			after: next?.length ?? 0,
		},
		ip: clientIp(c),
	});

	return c.json({ data: { id, signature: next } });
});

// 非表示は見え方の設定で権限を変えない。API キーでも扱える（署名と違い秘密を混ぜない操作）。
app.patch("/:id/hidden", async (c) => {
	const principal = c.get("principal");
	if (!principal) throw unauthorized();
	const db = c.get("db");
	const id = c.req.param("id");

	// 自分に割り当てられたアドレスだけ。管理者モードで見えているだけのアドレスは 404（FR-19）。
	const grant = await db
		.select({ userId: addressGrants.userId })
		.from(addressGrants)
		.where(and(eq(addressGrants.userId, principal.userId), eq(addressGrants.addressId, id)))
		.get();
	if (!grant) throw notFound("アドレスが見つかりません");

	const { hidden } = await readJson(c.req, updateMyHiddenInput);
	await db
		.update(addressGrants)
		.set({ hidden })
		.where(and(eq(addressGrants.userId, principal.userId), eq(addressGrants.addressId, id)));

	return c.json({ data: { id, hidden } });
});

export default app;
