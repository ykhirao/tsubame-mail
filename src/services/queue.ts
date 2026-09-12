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

/** 通知は受信処理と別のメッセージにする。push サービスの遅延で受信の再試行を起こさないため。 */
export type NotifyMessage =
	| {
			kind: "notify";
			event: "received";
			messageId: string;
			userId?: string;
			/** アドレスルールが既読にした。messages.is_read は後で利用者が読んでも立つので、受信時の判定を運ぶ。 */
			ruleRead?: boolean;
	  }
	| { kind: "notify"; event: "send_failed"; messageId: string; userId?: string }
	| { kind: "notify"; event: "test"; deviceId: string; userId: string };

export type OutboundQueueMessage = OutboundSendMessage | WebhookRetryMessage | NotifyMessage;
export type AnyQueueMessage = InboundQueueMessage | OutboundQueueMessage;

export const isInbound = (m: AnyQueueMessage): m is InboundQueueMessage => m.kind === "inbound";
export const isOutboundSend = (m: AnyQueueMessage): m is OutboundSendMessage =>
	m.kind === "outbound.send";
export const isNotify = (m: AnyQueueMessage): m is NotifyMessage => m.kind === "notify";
export const isWebhookRetry = (m: AnyQueueMessage): m is WebhookRetryMessage =>
	m.kind === "webhook.retry";
