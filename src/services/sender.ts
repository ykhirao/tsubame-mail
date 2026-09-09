import { EmailMessage } from "cloudflare:email";
import { normalizeAddress, parseAddressList } from "@/domain/mail/address";

export type SenderMailbox = { address: string; name?: string };

/**
 * `new EmailMessage(from, to, raw)` の `to` は単一の文字列しか受け取れない。
 * compose.ts は自前の MIME を使うため、1 受信者ごとに 1 回送る。
 */
export function collectRecipients(params: {
	to: SenderMailbox[];
	cc?: SenderMailbox[];
	bcc?: SenderMailbox[];
}): SenderMailbox[] {
	const seen = new Set<string>();
	const out: SenderMailbox[] = [];
	for (const m of [...(params.to ?? []), ...(params.cc ?? []), ...(params.bcc ?? [])]) {
		const key = normalizeAddress(m.address) ?? m.address.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(m);
	}
	return out;
}

export function parseMailboxes(csv: string | null | undefined): SenderMailbox[] {
	return parseAddressList(csv).map((a) => (a.name ? { address: a.address, name: a.name } : { address: a.address }));
}

/** 折り返し（継続行）も一緒に消す。 */
export function stripHeader(raw: string, name: string): string {
	const re = new RegExp(`^${name}:[ \\t].*(?:\\r?\\n[ \\t].*)*\\r?\\n?`, "im");
	return raw.replace(re, "");
}

/** 失敗時は即座に throw する。backoff は呼び出し側の責任。 */
export async function sendRawEmail(
	env: CloudflareEnv,
	params: {
		from: SenderMailbox;
		to: SenderMailbox[];
		cc?: SenderMailbox[];
		bcc?: SenderMailbox[];
		raw: string;
	},
): Promise<{ messageId: string }> {
	const recipients = collectRecipients({ to: params.to, cc: params.cc, bcc: params.bcc });
	if (recipients.length === 0) throw new Error("送信先が指定されていません");

	// Bcc はエンベロープ宛先にだけ入れ、ヘッダは誰にも見せない。
	const raw = stripHeader(params.raw, "Bcc");

	let lastId = "";
	for (const r of recipients) {
		const res = await env.EMAIL.send(
			new EmailMessage(params.from.address, r.address, raw),
		);
		lastId = res.messageId;
	}
	return { messageId: lastId };
}

/** from 詐称の防止。`"all"` は owner。 */
export function canSendFrom(
	writableAddressIds: string[] | "all",
	addressId: string,
): boolean {
	return writableAddressIds === "all" || writableAddressIds.includes(addressId);
}

export function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}
