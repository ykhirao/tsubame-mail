import { z } from "zod";
import { paginationQuery } from "./common";

export const webhookEvent = z.enum([
	"message.received",
	"message.sent",
	"message.failed",
]);
export type WebhookEvent = z.infer<typeof webhookEvent>;

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

function parseIpv4(host: string): number[] | null {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (!m) return null;
	const octets = m.slice(1).map(Number);
	return octets.every((o) => o <= 255) ? octets : null;
}

function isNonPublicIpv4([a, b, c]: number[]): boolean {
	if (a === 0 || a === 10 || a === 127 || a! >= 224) return true;
	if (a === 100 && b! >= 64 && b! <= 127) return true;
	if (a === 169 && b === 254) return true;
	if (a === 172 && b! >= 16 && b! <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
	if (a === 198 && (b === 18 || b === 19)) return true;
	if (a === 198 && b === 51 && c === 100) return true;
	if (a === 203 && b === 0 && c === 113) return true;
	return false;
}

/**
 * 8 個の 16 bit 値に展開する。解釈できなければ null。
 * `new URL` が IPv6 を常に 16 進の圧縮表記へ正規化するので、`::ffff:1.2.3.4` の
 * ようなドット表記はここには来ない。
 */
function parseIpv6(host: string): number[] | null {
	const halves = host.split("::");
	if (halves.length > 2) return null;
	const toGroups = (part: string) => (part === "" ? [] : part.split(":"));
	const head = toGroups(halves[0]!);
	const tail = halves.length === 2 ? toGroups(halves[1]!) : [];
	const parsed = [...head, ...tail].map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
	if (parsed.some(Number.isNaN)) return null;
	const missing = 8 - parsed.length;
	if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
	return [...parsed.slice(0, head.length), ...Array<number>(missing).fill(0), ...parsed.slice(head.length)];
}

function embeddedIpv4(hi: number, lo: number): number[] {
	return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
}

function isNonPublicIpv6(g: number[]): boolean {
	const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
	if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0) {
		// ::、::1、IPv4 互換 (::/96)、IPv4 射影 (::ffff:0:0/96)。
		if (g5 === 0 || g5 === 0xffff) return true;
	}
	if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
		return isNonPublicIpv4(embeddedIpv4(g6, g7));
	}
	if (g0 === 0x2002) return isNonPublicIpv4(embeddedIpv4(g1, g2));
	if (g0 === 0x2001 && g1 === 0) return true;
	if (g0 === 0x2001 && g1 === 0xdb8) return true;
	if ((g0 & 0xfe00) === 0xfc00) return true;
	if ((g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0) return true;
	if ((g0 & 0xff00) === 0xff00) return true;
	return false;
}

/**
 * 問題が無ければ null。登録時の検査と配信直前の検査の両方で使う。
 * ホスト名は DNS を引かずに字面だけで見るので、公開名が内部 IP を指す
 * DNS リバインディングまでは防げない。
 */
export function webhookUrlProblem(raw: string): string | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return "URL の形式が不正です";
	}
	if (url.protocol !== "https:") return "Webhook の URL は https:// で始まる必要があります";

	const host = url.hostname.toLowerCase().replace(/\.$/, "");
	if (host.startsWith("[")) {
		const groups = parseIpv6(host.slice(1, -1));
		if (!groups || isNonPublicIpv6(groups)) return "内部・予約済みの IP アドレスには送信できません";
		return null;
	}
	const v4 = parseIpv4(host);
	if (v4) return isNonPublicIpv4(v4) ? "内部・予約済みの IP アドレスには送信できません" : null;
	if (/^[\d.]+$/.test(host)) return "IP アドレスの形式が不正です";
	if (host === "localhost" || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
		return "内部向けのホスト名には送信できません";
	}
	if (!host.includes(".")) return "ホスト名は公開されている完全なドメイン名にしてください";
	return null;
}

const webhookUrl = z
	.string()
	.max(500)
	.superRefine((value, ctx) => {
		const problem = webhookUrlProblem(value);
		if (problem) ctx.addIssue({ code: "custom", message: problem });
	});

const MAX_ADDRESS_IDS = 100;

export const webhookInput = z.object({
	name: z.string().min(1).max(100),
	url: webhookUrl,
	events: z
		.array(webhookEvent)
		.min(1)
		.transform((events) => [...new Set(events)]),
	/** null なら全アドレス。重複は落とし、最大 100 件まで。 */
	addressIds: z
		.array(z.string())
		.max(MAX_ADDRESS_IDS)
		.transform((ids) => [...new Set(ids)])
		.nullable()
		.optional(),
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

export const webhookListQuery = paginationQuery;

export const webhookDeliveriesQuery = paginationQuery;

export const webhookDeliveriesResponse = z.object({
	data: z.array(webhookDelivery),
	next_cursor: z.string().nullable(),
});
export type WebhookDeliveriesResponse = z.infer<typeof webhookDeliveriesResponse>;
