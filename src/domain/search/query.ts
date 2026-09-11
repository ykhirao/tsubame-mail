// 不正な値（is:bogus、不正な日付）は黙って無視せず invalid_request を投げる。
import { invalidRequest } from "@/shared/errors";

export type SearchQuery = {
	freeWords: string[];
	from?: string;
	to?: string;
	subject?: string;
	body?: string;
	/** Unix 秒。その日 00:00:00 UTC。 */
	since?: number;
	/** Unix 秒。その日 23:59:59 UTC（末日を含む）。 */
	until?: number;
	isUnread?: boolean;
	isStarred?: boolean;
	hasAttachment?: boolean;
	inAddress?: string;
};

const OPERATOR_RE = /^(from|to|subject|body|since|until|is|has|in):/;
// 語数が増えると LIKE の枝や FTS の式木が太くなり 500 になる（#88）。
export const MAX_QUERY_CHARS = 500;
export const MAX_FREE_WORDS = 10;

export function parseSearchQuery(input: string | null | undefined): SearchQuery {
	if (!input || !input.trim()) return { freeWords: [] };
	if (Array.from(input).length > MAX_QUERY_CHARS) {
		throw invalidRequest(`検索文字列が長すぎます（最大 ${MAX_QUERY_CHARS} 文字）`);
	}
	const q: SearchQuery = { freeWords: [] };
	const s = input;
	let i = 0;
	const n = s.length;

	while (i < n) {
		while (i < n && /\s/.test(s[i]!)) i++;
		if (i >= n) break;

		const remaining = s.slice(i);
		const op = remaining.match(OPERATOR_RE);
		if (op) {
			const name = op[1]!;
			i += op[0].length;
			const { value, consumed } = readValue(s, i);
			i += consumed;
			applyOperator(q, name, value);
			continue;
		}

		const { value, consumed } = readValue(s, i);
		i += consumed;
		if (value) q.freeWords.push(value);
	}

	if (q.freeWords.length > MAX_FREE_WORDS) {
		throw invalidRequest(`検索語が多すぎます（最大 ${MAX_FREE_WORDS} 語）`);
	}
	return q;
}

function readValue(s: string, i: number): { value: string; consumed: number } {
	if (s[i] === '"') {
		const end = s.indexOf('"', i + 1);
		const value = (end === -1 ? s.slice(i + 1) : s.slice(i + 1, end)).trim();
		const consumed = end === -1 ? s.length - i : end - i + 1;
		return { value, consumed };
	}
	let j = i;
	while (j < s.length && !/\s/.test(s[j]!)) j++;
	return { value: s.slice(i, j), consumed: j - i };
}

function applyOperator(q: SearchQuery, name: string, value: string): void {
	switch (name) {
		case "from":
			q.from = value;
			break;
		case "to":
			q.to = value;
			break;
		case "subject":
			q.subject = value;
			break;
		case "body":
			q.body = value;
			break;
		case "since":
			q.since = parseDayStart(value);
			break;
		case "until":
			q.until = parseDayEnd(value);
			break;
		case "is":
			if (value === "unread") q.isUnread = true;
			else if (value === "starred") q.isStarred = true;
			else
				throw invalidRequest(
					`is: には unread か starred を指定してください（指定値: ${value}）`,
				);
			break;
		case "has":
			if (value === "attachment") q.hasAttachment = true;
			else
				throw invalidRequest(
					`has: には attachment を指定してください（指定値: ${value}）`,
				);
			break;
		case "in":
			q.inAddress = value;
			break;
	}
}

export function parseDayStart(value: string): number {
	const ts = parseDate(value);
	return Math.floor(ts / 1000);
}

export function parseDayEnd(value: string): number {
	const ts = parseDate(value);
	return Math.floor(ts / 1000) + 86400 - 1;
}

function parseDate(value: string): number {
	const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (!m)
		throw invalidRequest(
			`日付は YYYY-MM-DD 形式で指定してください（指定値: ${value}）`,
		);
	const year = Number(m[1]);
	const month = Number(m[2]);
	const day = Number(m[3]);
	// Date.UTC は月や日を正規化してしまう（例 2026-13-99 → 2027-04-08）ので範囲を明示検証する。
	if (month < 1 || month > 12 || day < 1 || day > 31)
		throw invalidRequest(`日付が不正です（指定値: ${value}）`);
	const ts = Date.UTC(year, month - 1, day);
	if (Number.isNaN(ts))
		throw invalidRequest(`日付が不正です（指定値: ${value}）`);
	return ts;
}
