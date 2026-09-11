// to / cc は「リストでありうる」。単一アドレスを前提にした処理を書かないこと。

export type ParsedAddress = { address: string; name?: string };

/**
 * 引用符・山括弧の中のカンマでは区切らない。formatAddress が表示名の `"` を `\"` に
 * エスケープして保存するので、ここで `\` を解さないと、逆にエスケープされた `"` を
 * 引用の終端と誤認してカンマの内外を見失い、保存済みの行が読めなくなる（精査 #39）。
 */
export function parseAddressList(input: string | null | undefined): ParsedAddress[] {
	if (!input) return [];
	const parts: string[] = [];
	let buf = "";
	let inQuote = false;
	let inAngle = false;
	let escaped = false;
	for (const ch of input) {
		if (escaped) {
			escaped = false;
			buf += ch;
			continue;
		}
		if (ch === "\\" && inQuote) {
			escaped = true;
			buf += ch;
			continue;
		}
		if (ch === '"') inQuote = !inQuote;
		else if (ch === "<") inAngle = true;
		else if (ch === ">") inAngle = false;
		if (ch === "," && !inQuote && !inAngle) {
			parts.push(buf);
			buf = "";
			continue;
		}
		buf += ch;
	}
	parts.push(buf);

	return parts
		.map((p) => p.trim())
		.filter(Boolean)
		.map(parseSingleAddress)
		.filter((a): a is ParsedAddress => a !== null);
}

/** `"…"` の引用符を外し、`\"` / `\\` のエスケープを戻す。引用されていなければそのまま。 */
function unquoteDisplayName(raw: string): string {
	const quoted = raw.match(/^"([\s\S]*)"$/);
	if (!quoted) return raw;
	return quoted[1]!.replace(/\\(.)/g, "$1");
}

function parseSingleAddress(input: string): ParsedAddress | null {
	const angle = input.match(/^(.*)<([^>]+)>\s*$/);
	if (angle) {
		const name = unquoteDisplayName(angle[1]!.trim()).trim();
		const address = normalizeAddress(angle[2]!);
		if (!address) return null;
		return name ? { address, name } : { address };
	}
	const address = normalizeAddress(input);
	return address ? { address } : null;
}

export function normalizeAddress(input: string): string | null {
	const trimmed = input.trim().replace(/^<|>$/g, "").trim().toLowerCase();
	if (!trimmed.includes("@")) return null;
	const at = trimmed.lastIndexOf("@");
	// 引用ローカル部 "victim"@ と末尾ドット victim.@ / @domain. は reject ルールを回避できてしまうので剥がす。
	const local = trimmed.slice(0, at).replace(/^"(.*)"$/, "$1").replace(/\.+$/, "");
	const domain = trimmed.slice(at + 1).replace(/\.+$/, "");
	// ローカル部のカンマは、保存文字列をカンマ区切りで読み直したとき宛先が分かれる（精査 #82）。
	if (!local || !domain || local.includes(",") || /[\s\x00-\x1f\x7f]/.test(trimmed)) return null;
	return `${local}@${domain}`;
}

export function formatAddress(a: ParsedAddress): string {
	// 表示名は受信メールの生の値をそのまま渡されうる。改行を残すと "Alice\r\nX: 1 <bob@…>" のように
	// 保存文字列が別のアドレスへ分裂し、返信時に parseAddressList が黙って宛先を落とす。
	const safeName = a.name?.replace(/[\r\n]+/g, " ").trim();
	if (!safeName) return a.address;
	const needsQuote = /[",<>@\\]/.test(safeName);
	// `"` だけでなく `\` 自身も escape しないと、名前が `\` で終わるとき閉じ引用符の直前に
	// 生の `\` が残り、parseAddressList がその引用符を「エスケープされた文字」と読み違えて
	// 引用が閉じないまま後続のカンマも飲み込み、宛先ごと消えてしまう（精査 #39 再検査での退行）。
	const name = needsQuote ? `"${safeName.replace(/[\\"]/g, "\\$&")}"` : safeName;
	return `${name} <${a.address}>`;
}

export function formatAddressList(list: ParsedAddress[]): string {
	return list.map(formatAddress).join(", ");
}

/**
 * `+タグ` が無ければ null。タグは送信者が勝手に付けられるので、別のメールボックスに
 * 化けないよう、落とすのはローカル部の最初の `+` 以降だけでドメインには触らない。
 */
export function baseAddressOf(address: string): string | null {
	const normalized = normalizeAddress(address);
	if (!normalized) return null;
	const at = normalized.lastIndexOf("@");
	const local = normalized.slice(0, at);
	const plus = local.indexOf("+");
	if (plus <= 0) return null; // `+` が無い、または先頭が `+` なら基本アドレスは無い
	return `${local.slice(0, plus)}${normalized.slice(at)}`;
}

export function domainOf(address: string): string | null {
	const normalized = normalizeAddress(address);
	return normalized ? normalized.slice(normalized.lastIndexOf("@") + 1) : null;
}

export function localPartOf(address: string): string | null {
	const normalized = normalizeAddress(address);
	return normalized ? normalized.slice(0, normalized.lastIndexOf("@")) : null;
}
