/** いずれのキーも完全一致ではなく部分一致で評価される。 */
export type Matcher = { from?: string; to?: string; subject?: string; contains?: string };

/** ドメインスコープのルールでは from / to しか埋まらない。 */
export type AvailableFields = {
	from?: string;
	to?: string;
	subject?: string | null;
	text?: string | null;
};

function includes(haystack: string | null | undefined, needle: string): boolean {
	if (haystack === null || haystack === undefined) return false;
	return haystack.toLowerCase().includes(needle.toLowerCase());
}

/**
 * 空の matcher は全件一致になる。
 * 条件はあるのに対象フィールドが無い場合（subject 未取得での subject 条件など）は不一致。
 */
export function matchRule(matcher: Matcher, input: AvailableFields): boolean {
	if (matcher.from && !includes(input.from, matcher.from)) return false;
	if (matcher.to && !includes(input.to, matcher.to)) return false;
	if (matcher.subject && !includes(input.subject, matcher.subject)) return false;
	if (matcher.contains && !includes(input.text, matcher.contains)) return false;
	return true;
}
