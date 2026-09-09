/**
 * ADR-2: キーはユーザー単位ではなくキー単位でスコープと対象アドレスを絞る。
 * どちらにせよキーがユーザーの権限を超えることは無い。
 */
import { z } from "zod";
import { scope } from "./common";

export const createApiKeyBody = z.object({
	name: z.string().min(1).max(100),
	scopes: z.array(scope).min(1),
	/** null なら所有ユーザーの権限そのまま。値があるとその積集合になる。 */
	addressIds: z.array(z.string().min(1)).nullish(),
	/** Unix 秒。省略なら無期限。 */
	expiresAt: z.number().int().positive().optional(),
});
export type CreateApiKeyBody = z.infer<typeof createApiKeyBody>;

export const adminCreateApiKeyBody = createApiKeyBody.extend({
	userId: z.string().min(1),
});
export type AdminCreateApiKeyBody = z.infer<typeof adminCreateApiKeyBody>;

export const apiKeySummary = z.object({
	id: z.string(),
	userId: z.string(),
	name: z.string(),
	prefix: z.string(),
	scopes: z.array(scope),
	addressIds: z.array(z.string()).nullable(),
	expiresAt: z.number().nullable(),
	revokedAt: z.number().nullable(),
	lastUsedAt: z.number().nullable(),
	createdAt: z.number(),
});
export type ApiKeySummary = z.infer<typeof apiKeySummary>;

/** `token` が出てくるのはこの 1 回だけ。 */
export const createdApiKey = apiKeySummary.extend({ token: z.string() });
export type CreatedApiKey = z.infer<typeof createdApiKey>;
