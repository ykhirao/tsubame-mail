export type InboundQueueMessage = {
	kind: "inbound";
	addressId: string;
	rawKey: string;
	envelope: { from: string; to: string };
	receivedAt: number;
};

export type OutboundSendMessage = {
	kind: "outbound.send";
	jobId: string;
	messageId: string;
};

export type WebhookRetryMessage = {
	kind: "webhook.retry";
	deliveryId: string;
	webhookId: string;
	attempt: number;
};

export type OutboundQueueMessage = OutboundSendMessage | WebhookRetryMessage;
export type AnyQueueMessage = InboundQueueMessage | OutboundQueueMessage;

export const isInbound = (m: AnyQueueMessage): m is InboundQueueMessage => m.kind === "inbound";
export const isOutboundSend = (m: AnyQueueMessage): m is OutboundSendMessage =>
	m.kind === "outbound.send";
export const isWebhookRetry = (m: AnyQueueMessage): m is WebhookRetryMessage =>
	m.kind === "webhook.retry";
