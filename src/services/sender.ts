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

/**
 * 同名のヘッダが何行あっても全部消す。1 行だけ消すと、注入された 2 行目が残る。
 * 折り返し（継続行）も一緒に消し、本文には触らない。
 */
export function stripHeader(raw: string, name: string): string {
	const blank = /(\r?\n)\r?\n/.exec(raw);
	const cut = blank ? blank.index + blank[1]!.length : raw.length;
	const head = raw.slice(0, cut);
	const rest = raw.slice(cut);
	const re = new RegExp(`^${name}:.*(?:\\r?\\n[ \\t].*)*(?:\\r?\\n|$)`, "gim");
	return head.replace(re, "") + rest;
}

// EmailMessage は 1 通につき 1 受信者なので、受信者ごとに 1 回送る。途中で失敗すると
// それまでに送った分は既に届いている。onSent は 1 通送るたびに呼ばれ、呼び出し側が
// 送信済みとして記録する。alreadySent に含まれる宛先は飛ばす（#21 / #59）。
/** 失敗時は即座に throw する。backoff は呼び出し側の責任。 */
export async function sendRawEmail(
	env: CloudflareEnv,
	params: {
		from: SenderMailbox;
		to: SenderMailbox[];
		cc?: SenderMailbox[];
		bcc?: SenderMailbox[];
		raw: string;
		alreadySent?: Set<string>;
		onSent?: (address: string) => void | Promise<void>;
	},
): Promise<{ messageId: string; sentCount: number }> {
	const recipients = collectRecipients({ to: params.to, cc: params.cc, bcc: params.bcc });
	if (recipients.length === 0) throw new Error("送信先が指定されていません");

	// compose.ts は Bcc ヘッダを書かないが、万一混ざっても受信者には見せない。
	const raw = stripHeader(params.raw, "Bcc");

	let lastId = "";
	let sentCount = 0;
	for (const r of recipients) {
		const key = normalizeAddress(r.address) ?? r.address.toLowerCase();
		if (params.alreadySent && params.alreadySent.has(key)) continue;
		const res = await env.EMAIL.send(new EmailMessage(params.from.address, r.address, raw));
		lastId = res.messageId;
		sentCount++;
		if (params.onSent) await params.onSent(key);
	}
	return { messageId: lastId, sentCount };
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
