export const MAILBOX_COLORS = [
	{ id: "blue", name: "ブルー", hex: "#1a73e8" },
	{ id: "red", name: "レッド", hex: "#d93025" },
	{ id: "green", name: "グリーン", hex: "#188038" },
	{ id: "orange", name: "オレンジ", hex: "#e8710a" },
	{ id: "purple", name: "パープル", hex: "#8430ce" },
	{ id: "teal", name: "ティール", hex: "#00796b" },
	{ id: "pink", name: "ピンク", hex: "#c5221f" },
	{ id: "indigo", name: "インディゴ", hex: "#3f51b5" },
	{ id: "lime", name: "ライム", hex: "#7cb342" },
	{ id: "brown", name: "ブラウン", hex: "#795548" },
	{ id: "cyan", name: "シアン", hex: "#0097a7" },
	{ id: "amber", name: "アンバー", hex: "#b06000" },
	{ id: "magenta", name: "マゼンタ", hex: "#ad1457" },
	{ id: "navy", name: "ネイビー", hex: "#1a237e" },
	{ id: "olive", name: "オリーブ", hex: "#827717" },
	{ id: "violet", name: "バイオレット", hex: "#6a1b9a" },
	{ id: "salmon", name: "サーモン", hex: "#e65100" },
	{ id: "slate", name: "スレート", hex: "#455a64" },
	{ id: "forest", name: "フォレスト", hex: "#2e7d32" },
	{ id: "crimson", name: "クリムゾン", hex: "#b71c1c" },
] as const;

export type MailboxColor = (typeof MAILBOX_COLORS)[number];

export function defaultColorFor(index: number): string {
	const i = ((index % MAILBOX_COLORS.length) + MAILBOX_COLORS.length) % MAILBOX_COLORS.length;
	return MAILBOX_COLORS[i]!.hex;
}

export function isHexColor(value: string): boolean {
	return /^#[0-9a-f]{6}$/i.test(value);
}

export function readableTextOn(hex: string): "#ffffff" | "#1f1f1f" {
	if (!isHexColor(hex)) return "#1f1f1f";
	const r = parseInt(hex.slice(1, 3), 16);
	const g = parseInt(hex.slice(3, 5), 16);
	const b = parseInt(hex.slice(5, 7), 16);
	// 境目は実際に見て決めた。
	const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
	return luminance > 0.6 ? "#1f1f1f" : "#ffffff";
}
