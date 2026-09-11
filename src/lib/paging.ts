import { and, eq, gt, lt, or } from "drizzle-orm";
import type { Column, SQL } from "drizzle-orm";
import { invalidRequest } from "@/shared/errors";

type Row = { id: string; createdAt: Date };

function encode(row: Row): string {
	const raw = `${Math.floor(row.createdAt.getTime() / 1000)}:${row.id}`;
	return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decode(cursor: string): { seconds: number; id: string } {
	try {
		const m = /^(\d+):(.+)$/.exec(atob(cursor.replace(/-/g, "+").replace(/_/g, "/")));
		if (m) {
			const seconds = Number(m[1]);
			// Date の上限（8.64e15 ms）を超えた cursor は Invalid Date になり静かに空ページを返すので、
			// 範囲内の値だけを accept する。#83 と同じ形。
			if (Number.isFinite(seconds) && Number.isFinite(new Date(seconds * 1000).getTime())) {
				return { seconds, id: m[2]! };
			}
		}
	} catch {
		/* 下で invalid_request にする */
	}
	throw invalidRequest("cursor が不正です");
}

/**
 * `(created_at, id)` のキーセット。created_at は秒単位で同時刻の行が普通にあるので、
 * id を第 2 キーにしないとページの境目で行が落ちたり重複したりする。
 */
export function afterCursor(
	columns: { createdAt: Column; id: Column },
	cursor: string | undefined,
	direction: "asc" | "desc",
): SQL | undefined {
	if (!cursor) return undefined;
	const { seconds, id } = decode(cursor);
	const at = new Date(seconds * 1000);
	const beyond = direction === "asc" ? gt : lt;
	return or(beyond(columns.createdAt, at), and(eq(columns.createdAt, at), beyond(columns.id, id)));
}

/** `limit + 1` 件読んだ結果を渡すこと。余分な 1 件の有無で次があるかを判断する。 */
export function toPage<T extends Row>(rows: T[], limit: number): { rows: T[]; next_cursor: string | null } {
	const page = rows.slice(0, limit);
	const last = page[page.length - 1];
	return { rows: page, next_cursor: rows.length > limit && last ? encode(last) : null };
}
