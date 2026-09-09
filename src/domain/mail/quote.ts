export type QuoteSource = {
	fromName?: string | null;
	fromAddr: string;
	receivedAt: Date;
	textBody?: string | null;
	htmlBody?: string | null;
};

export function quoteHeader(source: QuoteSource): string {
	const d = source.receivedAt;
	const pad = (n: number) => String(n).padStart(2, "0");
	const datePart =
		`${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ` +
		`${pad(d.getHours())}:${pad(d.getMinutes())}`;
	const name = source.fromName?.trim() ? source.fromName : "";
	const who = `${name} <${source.fromAddr}>`;
	return `${datePart} ${who}:`;
}

export function quoteText(header: string, body: string): string {
	const quoted = body
		.split(/\r?\n/)
		.map((line) => (line.trim() === "" ? ">" : `> ${line}`))
		.join("\n");
	return `${header}\n${quoted}`;
}

export function quoteHtml(header: string, bodyHtml: string): string {
	return `<blockquote>${escapeHtml(header).replace(/\n/g, "<br />")}<br />${bodyHtml}</blockquote>`;
}

/** 簡易な除去。サニタイズ目的には使えない。 */
export function stripHtml(html: string): string {
	return html
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, "\n")
		.replace(/<[^>]*>/g, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

export function buildReplyQuote(source: QuoteSource): { text: string; html: string } {
	const header = quoteHeader(source);

	let textSource: string;
	if (source.textBody) textSource = source.textBody;
	else if (source.htmlBody) textSource = stripHtml(source.htmlBody) || "（HTML 形式のメッセージです）";
	else textSource = "（本文なし）";
	const text = quoteText(header, textSource);

	let htmlSource: string;
	if (source.htmlBody) htmlSource = source.htmlBody;
	else if (source.textBody)
		htmlSource = `<pre>${escapeHtml(source.textBody)}</pre>`;
	else htmlSource = "（本文なし）";
	const html = quoteHtml(header, htmlSource);

	return { text, html };
}

export function replySubject(originalSubject?: string | null): string {
	const s = (originalSubject ?? "").trim();
	if (!s) return "Re: ";
	const cleaned = s.replace(/^\s*Re:\s*/i, "");
	return cleaned === s ? `Re: ${s}` : `Re: ${cleaned}`;
}

export function referencesFor(
	referencesHeader?: string | null,
	inReplyTo?: string | null,
): string {
	const list: string[] = [];
	if (referencesHeader) list.push(...referencesHeader.trim().split(/\s+/).filter(Boolean));
	if (inReplyTo) list.push(inReplyTo);
	// 重複は除くが順序は保つ。References は古い順である必要がある。
	const seen = new Set<string>();
	const out: string[] = [];
	for (const id of list) {
		if (seen.has(id)) continue;
		seen.add(id);
		out.push(id);
	}
	return out.join(" ");
}
