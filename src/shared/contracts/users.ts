import { z } from "zod";
import { role } from "./common";
import { passwordSchema } from "./auth";

export const grantLevel = z.enum(["read", "write"]);
export type GrantLevel = z.infer<typeof grantLevel>;

export const userStatus = z.enum(["active", "disabled"]);
export type UserStatus = z.infer<typeof userStatus>;

/** password を省略すると仮パスワードを発行し、作成のレスポンスで 1 度だけ返す。 */
export const createUserBody = z
	.object({
		email: z.email(),
		name: z.string().min(1).max(100),
		role,
		password: passwordSchema.optional(),
	})
	.superRefine((v, ctx) => {
		void v;
		void ctx;
	});
export type CreateUserBody = z.infer<typeof createUserBody>;

export const updateUserBody = z
	.object({
		name: z.string().min(1).max(100).optional(),
		role: role.optional(),
		status: userStatus.optional(),
		password: passwordSchema.optional(),
	})
	.refine((v) => Object.keys(v).length > 0, { message: "更新する項目がありません" });
export type UpdateUserBody = z.infer<typeof updateUserBody>;

export const grantInput = z.object({
	addressId: z.string().min(1),
	level: grantLevel,
});
export type GrantInput = z.infer<typeof grantInput>;

/** 総入れ替え。裸の配列でも { grants: [...] } でも受ける。 */
export const putGrantsBody = z.union([
	z.array(grantInput),
	z.object({ grants: z.array(grantInput) }),
]);
export type PutGrantsBody = z.infer<typeof putGrantsBody>;

export const updateMeBody = z
	.object({
		name: z.string().min(1).max(100).optional(),
		currentPassword: z.string().min(1).max(200).optional(),
		newPassword: passwordSchema.optional(),
	})
	.superRefine((v, ctx) => {
		if (v.newPassword && !v.currentPassword) {
			ctx.addIssue({
				code: "custom",
				path: ["currentPassword"],
				message: "現在のパスワードが必要です",
			});
		}
		if (!v.name && !v.newPassword) {
			ctx.addIssue({ code: "custom", path: [], message: "更新する項目がありません" });
		}
	});
export type UpdateMeBody = z.infer<typeof updateMeBody>;
