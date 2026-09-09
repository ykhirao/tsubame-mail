// to / cc は「リストでありうる」。単一アドレスを前提にした処理を書かないこと。

export type ParsedAddress = { address: string; name?: string };

/** 引用符・山括弧の中のカンマでは区切らない。 */
export function parseAddressList(input: string | null | undefined): ParsedAddress[] {
	if (!input) return [];
	const parts: string[] = [];
	let buf = "";
	let inQuote = false;
	let inAngle = false;
	for (const ch of input) {
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

function parseSingleAddress(input: string): ParsedAddress | null {
	const angle = input.match(/^(.*)<([^>]+)>\s*$/);
	if (angle) {
		const name = angle[1]!.trim().replace(/^"(.*)"$/, "$1").trim();
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
	const local = trimmed.slice(0, at);
	const domain = trimmed.slice(at + 1);
	if (!local || !domain || domain.includes(" ") || local.includes(" ")) return null;
	return `${local}@${domain}`;
}

export function formatAddress(a: ParsedAddress): string {
	if (!a.name) return a.address;
	const needsQuote = /[",<>@]/.test(a.name);
	const name = needsQuote ? `"${a.name.replace(/"/g, '\\"')}"` : a.name;
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
