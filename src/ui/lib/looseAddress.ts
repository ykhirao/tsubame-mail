import { baseAddressOf, normalizeAddress } from "@/domain/mail/address";

// 表示専用の簡易パース。実際の重複除去・自分除外はサーバ側（outbound.ts）が行う。
function rawAddress(entry: string): string {
	const angle = entry.match(/<([^>]+)>\s*$/);
	return (angle ? angle[1]! : entry).trim();
}

/** 引用ローカル部・末尾ドットを剥がして比べられる形にする。壊れた入力はそのまま小文字化して返す。 */
export function looseAddressOf(entry: string): string {
	const raw = rawAddress(entry);
	return normalizeAddress(raw) ?? raw.toLowerCase();
}

/**
 * own（表示中のメールボックス）に +タグ が無ければ、タグ付きの candidate も同じメールボックス
 * として自分に含める。own 側の +タグ は落とさないので、own に +タグ がある（box+a@x）ときの
 * box@x・box+b@x は別人のまま残る（精査 #23。outbound.ts の isSelf と同じ基準）。
 */
export function isSelfAddress(candidate: string, own: string): boolean {
	const n = looseAddressOf(candidate);
	const o = looseAddressOf(own);
	if (!n || !o) return false;
	if (n === o) return true;
	return baseAddressOf(n) === o;
}
