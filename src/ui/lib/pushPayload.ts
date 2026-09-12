// push ペイロードの URL・id を SW が検証せず使うと、外部ナビゲーションや第三者への画像読込につながる。
// http(s) の URL は `\` を `/` と読むので、`/\evil.example` も別オリジンになる（#138）。
export function isSafePath(raw: unknown): raw is string {
	return typeof raw === "string" && raw.startsWith("/") && !/^\/[/\\]/.test(raw);
}

export function sameOriginHref(raw: unknown, base: string): string | undefined {
	if (typeof raw !== "string") return undefined;
	try {
		const url = new URL(raw, base);
		return url.protocol === "https:" || url.protocol === "http:" ? (url.origin === new URL(base).origin ? url.href : undefined) : undefined;
	} catch {
		return undefined;
	}
}

export function validMessageId(raw: unknown): string | undefined {
	return typeof raw === "string" && /^msg_/.test(raw) ? raw : undefined;
}
