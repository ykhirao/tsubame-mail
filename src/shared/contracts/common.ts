import { z } from "zod";

export const paginationQuery = z.object({
	limit: z.coerce.number().int().min(1).max(100).default(25),
	cursor: z.string().optional(),
});
export type PaginationQuery = z.infer<typeof paginationQuery>;

export function page<T extends z.ZodTypeAny>(item: T) {
	return z.object({ data: z.array(item), next_cursor: z.string().nullable() });
}

export const errorResponse = z.object({
	error: z.object({
		code: z.string(),
		message: z.string(),
		details: z.unknown().optional(),
	}),
});

export const scope = z.enum(["read", "send", "admin"]);
export type Scope = z.infer<typeof scope>;

export const role = z.enum(["owner", "member", "agent"]);
export type Role = z.infer<typeof role>;

/** ハンドラは addressIds が "all" でない限り WHERE address_id IN (...) を付ける。 */
export type Principal = {
	userId: string;
	role: Role;
	via: "session" | "api_key";
	scopes: Scope[];
	/** "all" は管理者モードの owner だけ（FR-19）。それ以外は割り当てたアドレス。 */
	addressIds: string[] | "all";
	/** addressIds の部分集合。管理者モードでも割り当てたアドレスだけ。 */
	writableAddressIds: string[] | "all";
	/** 管理者モードで全アドレスを読めるとき true。 */
	adminMode?: boolean;
	/** 管理者モードのとき、自分に割り当てたアドレス（既読などの変更はここだけ）。 */
	ownAddressIds?: string[];
	/** API キーが対象アドレスを絞っているとき true。管理の変更を止める判定に使う（#129）。 */
	keyRestricted?: boolean;
	apiKeyId?: string;
	/** セッションで入ったときだけ。端末の購読をログアウトで消すのに使う。 */
	sessionId?: string;
};
