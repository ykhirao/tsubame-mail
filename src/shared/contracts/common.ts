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
	/** "all" は owner のみ。 */
	addressIds: string[] | "all";
	/** addressIds の部分集合。 */
	writableAddressIds: string[] | "all";
	apiKeyId?: string;
};
