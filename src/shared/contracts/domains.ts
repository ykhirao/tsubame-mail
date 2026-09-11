import { z } from "zod";

export const domainMode = z.enum(["apex", "subdomain"]);
export type DomainMode = z.infer<typeof domainMode>;

export const routingStatus = z.enum(["pending", "active", "error"]);
export const sendingStatus = z.enum(["disabled", "pending", "active", "error"]);

/** DNS ラベル 2 つ以上。既定はサブドメイン運用で、apex は confirmApex が要る。 */
export const hostname = z
	.string()
	.trim()
	.toLowerCase()
	.min(3)
	.max(253)
	.regex(
		/^(?!-)[a-z0-9-]{1,63}(?:\.(?!-)[a-z0-9-]{1,63})+$/,
		"ホスト名の形式が正しくありません（例: mail.example.com）",
	);

export const dnsWarningLevel = z.enum(["danger", "warn", "info"]);

export const dnsWarning = z.object({
	level: dnsWarningLevel,
	code: z.string(),
	message: z.string(),
});

export const mxFinding = z.object({
	name: z.string(),
	content: z.string(),
	priority: z.number().optional(),
	provider: z.enum(["cloudflare", "google", "microsoft", "other"]),
});

export const dnsCheckResult = z.object({
	name: z.string(),
	zoneId: z.string(),
	zoneName: z.string(),
	isApex: z.boolean(),
	recommendedMode: domainMode,
	requiresApexConfirmation: z.boolean(),
	mx: z.array(mxFinding),
	apexMx: z.array(mxFinding),
	hasForeignMx: z.boolean(),
	hasCloudflareMx: z.boolean(),
	spf: z.object({ name: z.string(), content: z.string() }).nullable(),
	dmarc: z.object({ name: z.string(), content: z.string() }).nullable(),
	warnings: z.array(dnsWarning),
});
export type DnsCheckResultDto = z.infer<typeof dnsCheckResult>;

export const previewDomainInput = z.object({
	name: hostname,
	zoneId: z.string().min(1).optional(),
});
export type PreviewDomainInput = z.infer<typeof previewDomainInput>;

export const createDomainInput = z.object({
	name: hostname,
	zoneId: z.string().min(1).optional(),
	/** apex を奪うとそのドメイン宛の全メールがこのアプリに流れ込むので、明示を要求する。 */
	confirmApex: z.boolean().default(false),
	enableSending: z.boolean().default(true),
	localParts: z
		.array(
			z
				.string()
				.trim()
				.toLowerCase()
				.min(1)
				.max(64)
				.regex(/^[a-z0-9._+-]+$/, "ローカル部に使えない文字が含まれています"),
		)
		.max(50)
		.default([]),
});
export type CreateDomainInput = z.infer<typeof createDomainInput>;

export const catchAllInput = z.object({
	enabled: z.boolean(),
	/** 有効化・無効化とも必須。ゾーン単位で効くので明示を要求する。 */
	confirm: z.boolean().default(false),
});
export type CatchAllInput = z.infer<typeof catchAllInput>;

export const deleteDomainQuery = z.object({
	cleanup: z
		.enum(["true", "false"])
		.default("true")
		.transform((v) => v === "true"),
});

export const domainSummary = z.object({
	id: z.string(),
	name: z.string(),
	zoneId: z.string(),
	zoneName: z.string(),
	mode: domainMode,
	routingStatus,
	sendingStatus,
	catchAllEnabled: z.boolean(),
	lastError: z.string().nullable(),
	addressCount: z.number(),
	createdAt: z.number(),
});
export type DomainSummary = z.infer<typeof domainSummary>;

export const availableZone = z.object({
	zoneId: z.string(),
	zoneName: z.string(),
	status: z.string().nullable(),
	connectedNames: z.array(z.string()),
	suggestedName: z.string(),
});
export type AvailableZone = z.infer<typeof availableZone>;
