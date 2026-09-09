import { z } from "zod";
import { paginationQuery } from "./common";

export const webhookEvent = z.enum([
	"message.received",
	"message.sent",
	"message.failed",
]);
export type WebhookEvent = z.infer<typeof webhookEvent>;

export const webhookInput = z.object({
	name: z.string().min(1).max(100),
	url: z.string().url().max(500),
	events: z.array(webhookEvent).min(1),
	/** null なら全アドレス。 */
	addressIds: z.array(z.string()).nullable().optional(),
	enabled: z.boolean().default(true),
});
export type WebhookInput = z.infer<typeof webhookInput>;

/** secret は作成時にのみ生成され、以後は変更できない。 */
export const webhookUpdateInput = webhookInput.partial();
export type WebhookUpdateInput = z.infer<typeof webhookUpdateInput>;

export const webhookResponse = z.object({
	id: z.string(),
	name: z.string(),
	url: z.string(),
	events: z.array(webhookEvent),
	addressIds: z.array(z.string()).nullable(),
	enabled: z.boolean(),
	createdAt: z.number().nullable(),
});
export type Webhook = z.infer<typeof webhookResponse>;

/** secret の平文が出るのはこのときだけ。 */
export const webhookCreateResponse = webhookResponse.extend({ secret: z.string() });
export type WebhookCreateResult = z.infer<typeof webhookCreateResponse>;

export const webhookDeliveryStatus = z.enum(["pending", "success", "failed"]);
export type WebhookDeliveryStatus = z.infer<typeof webhookDeliveryStatus>;

export const webhookDelivery = z.object({
	id: z.string(),
	webhookId: z.string(),
	event: webhookEvent,
	messageId: z.string().nullable(),
	status: webhookDeliveryStatus,
	httpStatus: z.number().nullable(),
	error: z.string().nullable(),
	durationMs: z.number().nullable(),
	attempt: z.number(),
	nextRetryAt: z.number().nullable(),
	createdAt: z.number().nullable(),
});
export type WebhookDelivery = z.infer<typeof webhookDelivery>;

export const webhookDeliveriesQuery = paginationQuery;

export const webhookDeliveriesResponse = z.object({
	data: z.array(webhookDelivery),
	next_cursor: z.string().nullable(),
});
export type WebhookDeliveriesResponse = z.infer<typeof webhookDeliveriesResponse>;
