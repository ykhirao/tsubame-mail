import { getDb, schema } from "@/db/client";
import type { Db } from "@/db/client";
import type { VapidTokenCache } from "@/services/webpush";

const KEY_PREFIX = "vapid_jwt:";
const TOKEN_LIFETIME_SEC = 3600;

export type VapidCache = VapidTokenCache & { flush(): Promise<void> };

/**
 * Apple は VAPID JWT の作り直しを 1 時間に 1 回までにするよう求めている。isolate ごとの
 * メモリに置くと共有されないので、origin ごとに D1 の settings へ有効期限つきで置いて使い回す。
 */
export async function createVapidTokenCache(db: Db): Promise<VapidCache> {
	const mem = new Map<string, string>();
	const nowSec = Math.floor(Date.now() / 1000);
	for (const row of await db.select().from(schema.settings).all()) {
		if (typeof row.key !== "string" || !row.key.startsWith(KEY_PREFIX)) continue;
		const value = row.value as { token?: unknown; exp?: number } | null;
		if (value && typeof value.token === "string" && typeof value.exp === "number" && value.exp > nowSec) {
			mem.set(row.key.slice(KEY_PREFIX.length), value.token);
		}
	}

	const pending: Promise<unknown>[] = [];
	return {
		get: (origin) => mem.get(origin) ?? null,
		set: (origin, token) => {
			mem.set(origin, token);
			const exp = Math.floor(Date.now() / 1000) + TOKEN_LIFETIME_SEC;
			pending.push(
				db
					.insert(schema.settings)
					.values({ key: `${KEY_PREFIX}${origin}`, value: { token, exp }, updatedAt: new Date() })
					.onConflictDoUpdate({
						target: schema.settings.key,
						set: { value: { token, exp }, updatedAt: new Date() },
					}),
			);
		},
		flush: async () => {
			await Promise.all(pending);
		},
	};
}
