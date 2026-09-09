import { Hono } from "hono";
import { defaultColorFor } from "@/shared/colors";
import { and, count, eq, inArray, isNull, ne } from "drizzle-orm";
import { addresses, domains, messages } from "@/db/schema";
import type { AppEnv } from "@/api/types";
import { ApiError, forbidden, unauthorized } from "@/shared/errors";

const app = new Hono<AppEnv>();

// app.ts でも張っているが、サブアプリ単体でテストしたときも同じ形になるよう重ねて張る。
app.onError((err, c) => {
	if (err instanceof ApiError) return c.json(err.toJSON(), err.status as 400);
	console.error("unhandled error", err);
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

	const includeArchived = c.req.query("includeArchived") === "true";

	const scoped = principal.addressIds === "all" ? null : principal.addressIds;
	if (scoped && scoped.length === 0) {
		return c.json({ data: [], next_cursor: null });
	}

	const rows = await db
		.select({ address: addresses, domainName: domains.name })
		.from(addresses)
		.innerJoin(domains, eq(addresses.domainId, domains.id))
		.where(
			and(
				scoped ? inArray(addresses.id, scoped) : undefined,
				includeArchived ? undefined : isNull(addresses.archivedAt),
			),
		);

	const ids = rows.map((r) => r.address.id);
	const unreadRows = ids.length
		? await db
				.select({ addressId: messages.addressId, n: count() })
				.from(messages)
				.where(
					and(
						inArray(messages.addressId, ids),
						eq(messages.isRead, false),
						ne(messages.status, "trash"),
					),
				)
				.groupBy(messages.addressId)
		: [];
	const unreadBy = new Map(unreadRows.map((r) => [r.addressId, Number(r.n)]));

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
		unreadCount: unreadBy.get(r.address.id) ?? 0,
		archived: r.address.archivedAt !== null,
	}));

	data.sort((a, b) => a.address.localeCompare(b.address));

	return c.json({ data, next_cursor: null });
});

export default app;
