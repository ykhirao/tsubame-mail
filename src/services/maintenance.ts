import { lt, sql } from "drizzle-orm";
import { getDb, schema } from "@/db/client";

// 年に 1 度の見直しでも前年分が手元に残る長さ。設定は増やさず常設の方針にする（#95）。
export const AUDIT_LOG_RETENTION_DAYS = 400;
// 1 回の cron で消す上限。D1 の 1 クエリの時間に収め、残りは次の回に回す。
const DELETE_BATCH = 1000;

export async function pruneAuditLogs(env: CloudflareEnv, now = Date.now()): Promise<number> {
	const db = getDb(env);
	const cutoff = new Date(now - AUDIT_LOG_RETENTION_DAYS * 86_400_000);
	const result = await db.run(
		sql`DELETE FROM audit_logs WHERE id IN (SELECT id FROM audit_logs WHERE ${lt(schema.auditLogs.createdAt, cutoff)} LIMIT ${DELETE_BATCH})`,
	);
	return result.meta.changes ?? 0;
}
