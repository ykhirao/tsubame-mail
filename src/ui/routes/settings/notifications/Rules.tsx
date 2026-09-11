import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import type { MailboxNotification, NotificationRule } from "@/shared/contracts/notifications";
import { NotificationsApi } from "@/ui/lib/api";
import {
	SettingsPage,
	Toggle,
	ActionBadge,
	matcherSummary,
	RULE_TEMPLATES,
	type RuleTemplateKey,
} from "./ruleShared";

const chevron = "h-5 w-5";
const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;

const UpIcon = () => (
	<svg className={chevron} viewBox="0 0 24 24" {...stroke}>
		<path d="m6 15 6-6 6 6" />
	</svg>
);
const DownIcon = () => (
	<svg className={chevron} viewBox="0 0 24 24" {...stroke}>
		<path d="m6 9 6 6 6-6" />
	</svg>
);

export function NotificationsRules() {
	const [rules, setRules] = useState<NotificationRule[] | null>(null);
	const [mailboxes, setMailboxes] = useState<MailboxNotification[]>([]);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const s = await NotificationsApi.get();
			setRules(s.rules);
			setMailboxes(s.mailboxes);
		} catch (e) {
			setError(e instanceof Error ? e.message : "ルールの取得に失敗しました");
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const mailboxName = useCallback((id: string) => mailboxes.find((m) => m.id === id)?.address, [mailboxes]);

	const setEnabled = async (rule: NotificationRule, enabled: boolean) => {
		setRules((prev) => prev?.map((r) => (r.id === rule.id ? { ...r, enabled } : r)) ?? prev);
		try {
			const updated = await NotificationsApi.updateRule(rule.id, { enabled });
			setRules((prev) => prev?.map((r) => (r.id === rule.id ? updated : r)) ?? prev);
		} catch (e) {
			setRules((prev) => prev?.map((r) => (r.id === rule.id ? { ...r, enabled: !enabled } : r)) ?? prev);
			setError(e instanceof Error ? e.message : "更新に失敗しました");
		}
	};

	const move = async (index: number, dir: -1 | 1) => {
		if (!rules) return;
		const next = [...rules];
		const j = index + dir;
		if (j < 0 || j >= next.length) return;
		[next[index], next[j]] = [next[j]!, next[index]!];
		setRules(next);
		try {
			const res = await NotificationsApi.reorderRules(next.map((r) => r.id));
			setRules(res.data);
		} catch (e) {
			setError(e instanceof Error ? e.message : "並べ替えに失敗しました");
			void load();
		}
	};

	const templateHref = (key: RuleTemplateKey) =>
		`/settings/notifications/rules/new?template=${encodeURIComponent(key)}`;

	const alwaysCount = rules?.filter((r) => r.action === "always").length ?? 0;

	return (
		<SettingsPage
			title="通知ルール"
			summary={
				rules
					? `${rules.length} 件（うち「必ず通知」${alwaysCount} 件）`
					: "読み込み中…"
			}
		>
			<p className="text-sm text-[var(--text-muted)]">
				上にあるルールほど先に効きます。最初に一致した 1 つだけが適用されます。
			</p>

			{error && (
				<div className="rounded-md border border-[var(--danger)] bg-[var(--surface-hover)] px-4 py-3 text-sm text-[var(--danger)]">
					{error}
				</div>
			)}

			<Link
				to="/settings/notifications/rules/new"
				className="flex h-11 items-center justify-center rounded-full bg-[var(--accent)] text-sm font-medium text-white hover:opacity-90"
			>
				ルールを追加
			</Link>

			<div className="flex flex-col gap-2">
				{rules?.map((rule, i) => (
					<div key={rule.id} className="card flex items-center gap-3 p-4">
						<div className="flex shrink-0 flex-col">
							<button
								type="button"
								aria-label="上へ移動"
								onClick={() => void move(i, -1)}
								disabled={i === 0}
								className="grid h-11 w-11 place-items-center rounded-full text-[var(--text-muted)] hover:bg-[var(--surface-hover)] disabled:pointer-events-none disabled:opacity-30"
							>
								<UpIcon />
							</button>
							<button
								type="button"
								aria-label="下へ移動"
								onClick={() => void move(i, 1)}
								disabled={i === (rules?.length ?? 1) - 1}
								className="grid h-11 w-11 place-items-center rounded-full text-[var(--text-muted)] hover:bg-[var(--surface-hover)] disabled:pointer-events-none disabled:opacity-30"
							>
								<DownIcon />
							</button>
						</div>

						<Link
							to={`/settings/notifications/rules/${rule.id}`}
							className="min-w-0 flex-1"
						>
							<div className="flex items-center gap-2">
								<span className="truncate text-sm font-semibold text-[var(--text)]">
									{rule.name}
								</span>
								<ActionBadge action={rule.action} />
							</div>
							<p className="mt-0.5 break-words text-xs text-[var(--text-muted)]">
								{matcherSummary(rule.matcher, mailboxName)}
							</p>
						</Link>

						<Toggle
							checked={rule.enabled}
							onChange={(next) => void setEnabled(rule, next)}
							label={`${rule.name} を有効にする`}
						/>
					</div>
				))}
				{rules && rules.length === 0 && (
					<div className="card px-5 py-10 text-center text-sm text-[var(--text-muted)]">
						通知ルールはまだありません。上から追加してください。
					</div>
				)}
			</div>

			<div className="mt-2 flex flex-col gap-2">
				{!rules && <div className="text-sm text-[var(--text-muted)]">読み込み中…</div>}
				{rules && (
					<>
						<p className="text-sm font-medium text-[var(--text)]">よく使うルールから追加</p>
						<div className="grid grid-cols-1 gap-2">
							{RULE_TEMPLATES.map((t) => (
								<Link
									key={t.key}
									to={templateHref(t.key)}
									className="flex h-11 items-center rounded-full border border-[var(--line)] px-4 text-sm text-[var(--text)] transition-colors hover:bg-[var(--surface-hover)]"
								>
									{t.name}
								</Link>
							))}
						</div>
					</>
				)}
			</div>
		</SettingsPage>
	);
}
