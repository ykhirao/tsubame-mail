import { eq, lt, sql } from "drizzle-orm";
import { schema } from "@/db/client";
import type { Db } from "@/db/client";
import { hashToken } from "@/lib/tokens";

/** 数え直すまでの窓。 */
const WINDOW_MS = 10 * 60 * 1000;
/** この回数を超えて失敗したら門前で返す。 */
const MAX_FAILURES = 20;
/** 門前で返す長さ。 */
const BLOCK_MS = 15 * 60 * 1000;

/**
 * API キーは 32 バイトの乱数なので、総当たりで当てられる心配は無い。
 * ここで止めたいのは「当てられること」ではなく、**無効なキーで D1 を引き続ける負荷**。
 *
 * 数えるのは**失敗したときだけ**。通っている相手（正しいキー）は一度も書き込まないので、
 * ふつうの利用では書き込みがまったく増えない。
 */
export async function isBlocked(db: Db, ip: string | null, now = Date.now()): Promise<boolean> {
	if (!ip) return false;
	const ipHash = await hashToken(ip);
	const [row] = await db
		.select({ blockedUntil: schema.authFailures.blockedUntil })
		.from(schema.authFailures)
		.where(eq(schema.authFailures.ipHash, ipHash))
		.limit(1);
	return Boolean(row?.blockedUntil && row.blockedUntil.getTime() > now);
}

/**
 * 失敗を 1 つ数える。窓が切れていれば 1 から数え直し、上限を超えたら期限を入れる。
 *
 * **記録に失敗しても認証の結果は変えない**（呼び出し側が握りつぶす）。数える側の
 * 不具合で、正しいキーを持つ相手を締め出す方が害が大きい。
 */
export async function recordFailure(db: Db, ip: string | null, now = Date.now()): Promise<void> {
	if (!ip) return;
	const ipHash = await hashToken(ip);
	const windowEndsAt = new Date(now + WINDOW_MS);
	const blockedUntil = new Date(now + BLOCK_MS);

	// 1 文で済ませる。読んでから書くと、同時に来た失敗を数え落とす。
	await db
		.insert(schema.authFailures)
		.values({ ipHash, failures: 1, windowEndsAt, blockedUntil: null })
		.onConflictDoUpdate({
			target: schema.authFailures.ipHash,
			set: {
				// 窓が切れていれば 1 から。切れていなければ積む。
				failures: sql`case when ${schema.authFailures.windowEndsAt} <= ${now} then 1 else ${schema.authFailures.failures} + 1 end`,
				windowEndsAt: sql`case when ${schema.authFailures.windowEndsAt} <= ${now} then ${windowEndsAt.getTime()} else ${schema.authFailures.windowEndsAt} end`,
				blockedUntil: sql`case
					when ${schema.authFailures.windowEndsAt} > ${now} and ${schema.authFailures.failures} + 1 > ${MAX_FAILURES}
					then ${blockedUntil.getTime()}
					else null
				end`,
			},
		});
}

/** 認証が通った相手の記録は消す。正しいキーを使い始めたら、過去の失敗を引きずらない。 */
export async function clearFailures(db: Db, ip: string | null): Promise<void> {
	if (!ip) return;
	await db.delete(schema.authFailures).where(eq(schema.authFailures.ipHash, await hashToken(ip)));
}

/** 窓も期限も切れた行を掃除する（cron から呼ぶ）。 */
export async function pruneAuthFailures(db: Db, now = Date.now()): Promise<number> {
	const result = await db.run(
		sql`DELETE FROM auth_failures WHERE ip_hash IN (
			SELECT ip_hash FROM auth_failures
			WHERE ${lt(schema.authFailures.windowEndsAt, new Date(now))}
			  AND (blocked_until IS NULL OR blocked_until <= ${now})
			LIMIT 1000
		)`,
	);
	return result.meta.changes ?? 0;
}

export { MAX_FAILURES, WINDOW_MS, BLOCK_MS };
