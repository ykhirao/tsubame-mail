import { Link } from "react-router";
import type { ReactNode } from "react";
import type { NotificationAction } from "@/shared/contracts/notifications";

export function SettingsPage({
	title,
	summary,
	children,
}: {
	title: string;
	summary: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 py-4">
			<div>
				<Link
					to="/settings/notifications"
					className="mb-2 inline-flex h-11 items-center text-sm text-[var(--text-muted)] hover:text-[var(--text)]"
				>
					← 通知設定
				</Link>
				<h1 className="text-lg font-bold text-[var(--text)]">{title}</h1>
				<p className="mt-1 text-sm text-[var(--text-muted)]">{summary}</p>
			</div>
			{children}
		</div>
	);
}

export function Toggle({
	checked,
	onChange,
	label,
	disabled = false,
}: {
	checked: boolean;
	onChange: (next: boolean) => void;
	label: string;
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			disabled={disabled}
			onClick={() => onChange(!checked)}
			className={`relative h-8 w-14 shrink-0 rounded-full transition-colors ${
				checked ? "bg-[var(--accent)]" : "bg-[var(--line)]"
			} disabled:cursor-not-allowed disabled:opacity-40`}
		>
			<span
				className={`absolute top-1 h-6 w-6 rounded-full bg-white shadow transition-all ${
					checked ? "left-7" : "left-1"
				}`}
			/>
		</button>
	);
}

export function SwitchRow({
	checked,
	onChange,
	label,
	children,
	disabled = false,
}: {
	checked: boolean;
	onChange: (next: boolean) => void;
	label: string;
	children?: ReactNode;
	disabled?: boolean;
}) {
	return (
		<label className={`card flex w-full items-center gap-3 p-4 ${disabled ? "opacity-60" : ""}`}>
			<div className="min-w-0 flex-1">
				<span className="block text-sm font-medium text-[var(--text)]">{label}</span>
				{children}
			</div>
			<Toggle checked={checked} onChange={onChange} label={label} disabled={disabled} />
		</label>
	);
}

export const actionLabels: Record<NotificationAction, string> = {
	always: "必ず通知",
	normal: "通知",
	silent: "音なし",
	never: "通知しない",
};

const actionBadge: Record<NotificationAction, string> = {
	always: "bg-[var(--surface-hover)] text-[var(--success)]",
	normal: "bg-[var(--surface-hover)] text-[var(--accent)]",
	silent: "bg-[var(--surface-hover)] text-[var(--text-muted)]",
	never: "bg-[var(--surface-hover)] text-[var(--danger)]",
};

export function ActionBadge({ action }: { action: NotificationAction }) {
	return (
		<span
			className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ${actionBadge[action]}`}
		>
			{actionLabels[action]}
		</span>
	);
}

export const RULE_TEMPLATES: {
	key: string;
	name: string;
	action: NotificationAction;
	matcher: { from?: string; to?: string; subject?: string; body?: string };
}[] = [
	{
		key: "important-person",
		name: "この人からは必ず通知",
		action: "always",
		matcher: { from: "" },
	},
	{
		key: "newsletter",
		name: "ニュースレターを通知しない",
		action: "never",
		matcher: { subject: "" },
	},
	{
		key: "urgent-subject",
		name: "件名に「至急」",
		action: "normal",
		matcher: { subject: "至急" },
	},
];

export type RuleTemplateKey = (typeof RULE_TEMPLATES)[number]["key"];

export function ruleTemplateByKey(key: string | null) {
	return RULE_TEMPLATES.find((t) => t.key === key);
}

const DAY_NAMES = ["日", "月", "火", "水", "木", "金", "土"] as const;

export function daysLabel(days: number[]): string {
	const weekdays = [1, 2, 3, 4, 5].map(String);
	const weekend = ["0", "6"];
	const sorted = [...days].sort();
	const key = sorted.map(String);
	if (key.length === 7) return "毎日";
	if (weekdays.every((d) => key.includes(d)) && key.length === weekdays.length) return "平日";
	if (weekend.every((d) => key.includes(d)) && key.length === weekend.length) return "土日";
	return sorted.map((d) => DAY_NAMES[d]).join("・");
}

export function formatQuietRange(r: { days: number[]; start: string; end: string }): string {
	return `${daysLabel(r.days)} ${r.start}〜${r.end}`;
}

/** 空 matcher なら全件一致。条件を日本語で短く繋げる。 */
export function matcherSummary(
	m: {
		from?: string;
		to?: string;
		subject?: string;
		body?: string;
		mailboxIds?: string[];
		hasAttachment?: boolean;
		replyToOwn?: boolean;
		ccOnly?: boolean;
	},
	mailboxNames: (id: string) => string | undefined,
): string {
	const parts: string[] = [];
	if (m.from) parts.push(`差出人が「${m.from}」`);
	if (m.to) parts.push(`宛先が「${m.to}」`);
	if (m.subject) parts.push(`件名が「${m.subject}」`);
	if (m.body) parts.push(`本文が「${m.body}」`);
	if (m.mailboxIds?.length) {
		parts.push(`メールボックス: ${m.mailboxIds.map((id) => mailboxNames(id) ?? id).join("、")}`);
	}
	if (m.hasAttachment) parts.push("添付あり");
	if (m.replyToOwn) parts.push("返信");
	if (m.ccOnly) parts.push("CC のみ");
	return parts.length ? parts.join("・") : "全件一致";
}
