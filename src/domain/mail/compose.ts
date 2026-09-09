// Message-ID は送信前に自前で採番する。返信がスレッドに刺さるために必要。
import { createMimeMessage } from "mimetext";
import { formatAddressList, parseAddressList } from "./address";

export type ComposeAttachment = {
	filename: string;
	contentType: string;
	/** base64 エンコード済みであること。mimetext は生バイト列を受け付けない。 */
	base64: string;
};

export function addressListToCsv(value: string | string[]): string {
	const raw = Array.isArray(value) ? value.join(", ") : value;
	return formatAddressList(parseAddressList(raw));
}
export type ComposeInput = {
	messageId: string;
	fromAddr: string;
	fromName?: string | null;
	toAddr: string;
	ccAddr?: string | null;
	bccAddr?: string | null;
	subject?: string | null;
	textBody?: string | null;
	htmlBody?: string | null;
	inReplyTo?: string | null;
	referencesHeader?: string | null;
};

export function generateMessageId(messageId: string, fromAddr: string): string {
	const at = fromAddr.lastIndexOf("@");
	const domain = at >= 0 ? fromAddr.slice(at + 1) : "localhost";
	return `<${messageId}@${domain}>`;
}

export function toMailboxObjects(csv: string): { addr: string; name?: string }[] {
	return parseAddressList(csv).map((a) => (a.name ? { addr: a.address, name: a.name } : { addr: a.address }));
}

export function composeMime(
	input: ComposeInput,
	attachments: ComposeAttachment[] = [],
): string {
	const msg = createMimeMessage();

	msg.setSender({ addr: input.fromAddr, name: input.fromName ?? undefined });
	msg.setTo(toMailboxObjects(input.toAddr));
	if (input.ccAddr) msg.setCc(toMailboxObjects(input.ccAddr));
	if (input.bccAddr) msg.setBcc(toMailboxObjects(input.bccAddr));

	const rfcMessageId = generateMessageId(input.messageId, input.fromAddr);
	msg.setHeader("Message-ID", rfcMessageId);
	if (input.inReplyTo) msg.setHeader("In-Reply-To", input.inReplyTo);
	if (input.referencesHeader) msg.setHeader("References", input.referencesHeader);

	const subject = (input.subject ?? "").trim() || "(件名なし)";
	msg.setSubject(subject);

	if (input.textBody && input.htmlBody) {
		msg.addMessage({ contentType: "text/plain", data: input.textBody, charset: "UTF-8" });
		msg.addMessage({ contentType: "text/html", data: input.htmlBody, charset: "UTF-8" });
	} else if (input.htmlBody) {
		msg.addMessage({ contentType: "text/html", data: input.htmlBody, charset: "UTF-8" });
	} else if (input.textBody) {
		msg.addMessage({ contentType: "text/plain", data: input.textBody, charset: "UTF-8" });
	} else {
		throw new Error("送信する本文（text / html）がありません");
	}

	for (const a of attachments) {
		msg.addAttachment({
			filename: a.filename,
			contentType: a.contentType,
			data: a.base64,
		});
	}

	return msg.asRaw();
}

export { parseAddressList as parseAddressCsv };
