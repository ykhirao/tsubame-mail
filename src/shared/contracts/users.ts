import { z } from "zod";
import { paginationQuery, role } from "./common";
import { passwordSchema } from "./auth";
import { displayName, localPart } from "./addresses";

export const grantLevel = z.enum(["read", "write"]);
export type GrantLevel = z.infer<typeof grantLevel>;

export const userStatus = z.enum(["active", "disabled"]);
export type UserStatus = z.infer<typeof userStatus>;

/** 既存のメールボックスを選ぶか、その場で作る。作る場合は kind はメールボックスに固定される。 */
export const primaryAddressSource = z.union([
	z.object({ addressId: z.string().min(1) }),
	z.object({ domainId: z.string().min(1), localPart, displayName: displayName.optional() }),
]);
export type PrimaryAddressSource = z.infer<typeof primaryAddressSource>;

/**
 * password を省略すると仮パスワードを発行し、作成のレスポンスで 1 度だけ返す。
 * primaryAddress は必須。member / agent の email（外部アドレス）は省略できて、
 * その場合ログインはプライマリで行う。
 */
export const createUserBody = z
	.object({
		email: z.email().optional(),
		name: z.string().min(1).max(100),
		role,
		password: passwordSchema.optional(),
		primaryAddress: primaryAddressSource,
	})
	.superRefine((v, ctx) => {
		// agent はパスワードを持たない（PATCH /admin/users/:id と同じ制約）。
		// 以前はここが no-op で、POST に password を付けると黙って捨てられていた。
		if (v.role === "agent" && v.password !== undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["password"],
				message: "agent ロールはパスワードを持ちません",
			});
		}
		if (v.role === "owner" && !v.email) {
			ctx.addIssue({
				code: "custom",
				path: ["email"],
				message: "owner には外部アドレス（email）が必須です",
			});
		}
	});
export type CreateUserBody = z.infer<typeof createUserBody>;

export const updateUserBody = z
	.object({
		name: z.string().min(1).max(100).optional(),
		role: role.optional(),
		status: userStatus.optional(),
		password: passwordSchema.optional(),
		/** その人に write で割り当てたメールボックスの中から選ぶ。 */
		primaryAddressId: z.string().min(1).optional(),
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

export const adminUserListQuery = paginationQuery;

export const adminModeBody = z.object({ enabled: z.boolean() });
export type AdminModeBody = z.infer<typeof adminModeBody>;
