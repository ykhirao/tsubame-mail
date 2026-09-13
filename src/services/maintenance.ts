import { lt, sql } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { pruneAuthFailures } from "@/domain/access/auth-failures";

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
	// 認証の失敗カウンタも一緒に掃除する。worker.ts（共有ファイル）を触らずに済むよう、
	// 同じ cron の中で呼ぶ。失敗しても監査ログの掃除は落とさない。
	await pruneAuthFailures(db, now).catch(() => 0);
	return result.meta.changes ?? 0;
}
