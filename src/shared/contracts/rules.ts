import { z } from "zod";

/** いずれも部分一致・大文字小文字を無視。空オブジェクトなら全件一致。 */
export const matcherSchema = z.object({
	from: z.string().max(300).optional(),
	to: z.string().max(300).optional(),
	subject: z.string().max(500).optional(),
	contains: z.string().max(2000).optional(),
});
export type RuleMatcher = z.infer<typeof matcherSchema>;

export const scopeSchema = z.enum(["domain", "address"]);
export const ruleActionSchema = z.enum(["deliver", "forward", "reject", "drop", "mark"]);

/** target の存在検査（deliver の宛先 id など）は DB が要るのでルータ側で行う。 */
const emailShape = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const targetMatchesAction = (v: { action: z.infer<typeof ruleActionSchema>; target?: string | null }) => {
	if (v.action !== "forward") return true;
	return typeof v.target === "string" && emailShape.test(v.target);
};

const baseRuleSchema = z.object({
	/** domain: 受信時の配送前判定 / address: 配信後の振り分け。 */
	scope: scopeSchema,
	domainId: z.string().optional(),
	addressId: z.string().optional(),
	name: z.string().min(1).max(200),
	action: ruleActionSchema,
	matcher: matcherSchema,
	/** action ごとの引数（forward の宛先、deliver の宛先アドレス id、mark の対象など）。 */
	target: z.string().max(500).nullable().optional(),
	priority: z.number().int().default(0),
	enabled: z.boolean().default(true),
});

export const createRuleSchema = baseRuleSchema.refine(targetMatchesAction, {
	message: "forward の target はメールアドレスの形式である必要があります",
	path: ["target"],
});
export type CreateRule = z.infer<typeof createRuleSchema>;

export const updateRuleSchema = baseRuleSchema.partial();
export type UpdateRule = z.infer<typeof updateRuleSchema>;

/** PATCH は部分入力なので、既存値とマージした実効値に対してルータ側で呼ぶ。 */
export { targetMatchesAction };

export const ruleParamsSchema = z.object({ id: z.string() });
