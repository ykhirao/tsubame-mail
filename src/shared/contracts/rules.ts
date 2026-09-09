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

export const createRuleSchema = z.object({
	/** domain: 受信時の配送前判定 / address: 配信後の振り分け。 */
	scope: scopeSchema,
	domainId: z.string().optional(),
	addressId: z.string().optional(),
	name: z.string().min(1).max(200),
	action: ruleActionSchema,
	matcher: matcherSchema,
	/** action ごとの引数（forward の宛先、mark の対象など）。 */
	target: z.string().max(500).nullable().optional(),
	priority: z.number().int().default(0),
	enabled: z.boolean().default(true),
});
export type CreateRule = z.infer<typeof createRuleSchema>;

export const updateRuleSchema = createRuleSchema.partial();
export type UpdateRule = z.infer<typeof updateRuleSchema>;

export const ruleParamsSchema = z.object({ id: z.string() });
