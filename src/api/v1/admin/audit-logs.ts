import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { schema } from "@/db/client";
import { afterCursor, toPage } from "@/lib/paging";
import { unixSeconds } from "@/lib/validate";
import { auditLogQuery, type AuditLogEntry } from "@/shared/contracts/audit-logs";
import { invalidRequest } from "@/shared/errors";
import { requireOwner, requireUnrestricted } from "../../middleware/auth";
import type { AppEnv } from "../../types";

const app = new Hono<AppEnv>();

// 監査ログはキーの範囲外のアドレスの操作も含むので、絞ったキーには読ませない（#129 と同じ線）。
app.use("*", requireOwner, requireUnrestricted);

app.get("/", async (c) => {
	const query = auditLogQuery.safeParse(c.req.query());
	if (!query.success) throw invalidRequest("クエリが不正です", query.error.issues);
	const { targetType, targetId, actorId, action, limit, cursor } = query.data;
	const t = schema.auditLogs;
	const rows = await c
		.get("db")
		.select()
		.from(t)
		.where(
			and(
				targetType ? eq(t.targetType, targetType) : undefined,
				targetId ? eq(t.targetId, targetId) : undefined,
				actorId ? eq(t.actorId, actorId) : undefined,
				action ? eq(t.action, action) : undefined,
				afterCursor(t, cursor, "desc"),
			),
		)
		.orderBy(desc(t.createdAt), desc(t.id))
		.limit(limit + 1);
	const page = toPage(rows, limit);
	const data: AuditLogEntry[] = page.rows.map((r) => ({
		id: r.id,
		actorId: r.actorId,
		action: r.action,
		targetType: r.targetType,
		targetId: r.targetId,
		meta: r.meta ?? null,
		ip: r.ip,
		createdAt: unixSeconds(r.createdAt) ?? 0,
	}));
	return c.json({ data, next_cursor: page.next_cursor });
});

export default app;
