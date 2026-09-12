import { z } from "zod";

const hexColor = z
	.string()
	.trim()
	.toLowerCase()
	.regex(/^#[0-9a-f]{6}$/, "色は #rrggbb の形で指定してください");

export const addressKind = z.enum(["mailbox", "alias"]);
export type AddressKind = z.infer<typeof addressKind>;

export const accessLevel = z.enum(["read", "write"]);
export type AccessLevel = z.infer<typeof accessLevel>;

export const localPart = z
	.string()
	.trim()
	.toLowerCase()
	.min(1)
	.max(64)
	.regex(/^[a-z0-9._+-]+$/, "ローカル部に使えない文字が含まれています");

export const displayName = z
	.string()
	.trim()
	.max(120)
	.regex(/^[^\r\n\0]*$/, "改行を含められません");

const addressFields = {
	domainId: z.string().min(1),
	localPart,
	displayName: displayName.optional(),
	kind: addressKind.default("mailbox"),
	aliasTargetId: z.string().min(1).optional(),
	/** ドメインあたり 1 件まで。一意制約はサーバ側で確認する。 */
	isCatchAll: z.boolean().default(false),
	signature: z.string().max(2000).optional(),
	color: hexColor.optional(),
	/** true なら作った owner に write で割り当てる。割り当てないアドレスは誰にも見えない。 */
	assignToMe: z.boolean().optional(),
};

const requireAliasTarget = <T extends { kind: AddressKind; aliasTargetId?: string }>(v: T) =>
	v.kind !== "alias" || Boolean(v.aliasTargetId);

export const createAddressInput = z.object(addressFields).refine(requireAliasTarget, {
	message: "kind が alias のときは aliasTargetId が必須です",
	path: ["aliasTargetId"],
});
export type CreateAddressInput = z.infer<typeof createAddressInput>;

export const updateAddressInput = z
	.object({
		displayName: displayName.nullable().optional(),
		signature: z.string().max(2000).nullable().optional(),
		/** null にすると既定色に戻す。 */
		color: hexColor.nullable().optional(),
		kind: addressKind.optional(),
		aliasTargetId: z.string().min(1).nullable().optional(),
		isCatchAll: z.boolean().optional(),
		archived: z.boolean().optional(),
	})
	.refine((v) => v.kind !== "alias" || v.aliasTargetId != null, {
		message: "kind が alias のときは aliasTargetId が必須です",
		path: ["aliasTargetId"],
	});
export type UpdateAddressInput = z.infer<typeof updateAddressInput>;

export const adminAddress = z.object({
	id: z.string(),
	domainId: z.string(),
	domainName: z.string(),
	localPart: z.string(),
	address: z.string(),
	displayName: z.string().nullable(),
	kind: addressKind,
	aliasTargetId: z.string().nullable(),
	aliasTargetAddress: z.string().nullable(),
	isCatchAll: z.boolean(),
	color: z.string().nullable(),
	archivedAt: z.number().nullable(),
	createdAt: z.number(),
	routingRuleId: z.string().nullable(),
});
export type AdminAddress = z.infer<typeof adminAddress>;

export const updateMySignatureInput = z.object({
	signature: z.string().max(2000).nullable(),
});
export type UpdateMySignatureInput = z.infer<typeof updateMySignatureInput>;

export const myAddress = z.object({
	id: z.string(),
	address: z.string(),
	localPart: z.string(),
	displayName: z.string().nullable(),
	domainId: z.string(),
	domainName: z.string(),
	kind: addressKind,
	level: accessLevel,
	isCatchAll: z.boolean(),
	color: z.string(),
	signature: z.string().nullable().optional(),
	unreadCount: z.number(),
	archived: z.boolean(),
	/** 自分（grants）で非表示にしたメールボックス。割り当ての無いアドレスは false。 */
	hidden: z.boolean(),
});
export type MyAddress = z.infer<typeof myAddress>;

export const updateMyHiddenInput = z.object({ hidden: z.boolean() });
export type UpdateMyHiddenInput = z.infer<typeof updateMyHiddenInput>;

/** そのアドレスを「見られる人」。所有者は全員、それ以外は grants の利用者。 */
export const addressViewer = z.object({
	userId: z.string(),
	name: z.string(),
	/** 外部アドレス。まだ登録していない利用者は null。 */
	email: z.string().nullable(),
	level: z.enum(["read", "write"]),
	/** このアドレスがその人のプライマリか。 */
	isPrimary: z.boolean(),
});
export type AddressViewer = z.infer<typeof addressViewer>;

export const listAddressesQuery = z.object({
	domainId: z.string().optional(),
	includeArchived: z
		.enum(["true", "false"])
		.default("false")
		.transform((v) => v === "true"),
});
