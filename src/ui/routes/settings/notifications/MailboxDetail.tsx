import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router";
import { NotificationsApi } from "@/ui/lib/api";
import type { NotificationLevel, NotificationSettings } from "@/shared/contracts/notifications";
import { Scaffold, Card, BackLink, Toggle, MailboxDot } from "./shared";
import { CatchAllBadge } from "@/ui/components/mobile/CatchAllBadge";

const LEVELS: { value: NotificationLevel; label: string; desc: string }[] = [
	{ value: "all", label: "すべての新着", desc: "返信や新しい会話をすべて通知" },
	{ value: "new_thread", label: "新しい会話だけ", desc: "返信は通知しない（フォロー中は例外）" },
	{ value: "direct", label: "To に入っているときだけ", desc: "CC・一斉配信を除く" },
	{ value: "off", label: "通知しない", desc: "このメールボックスは通知しない" },
];

export function NotificationMailboxDetail() {
	const { id } = useParams();
	const navigate = useNavigate();
	const [settings, setSettings] = useState<NotificationSettings | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		NotificationsApi.get()
			.then(setSettings)
			.catch(() => {});
	}, []);

	if (!id) return <Scaffold title="メールボックス">{null}</Scaffold>;
	if (!settings) return <Scaffold title="メールボックス">{null}</Scaffold>;

	const mailbox = settings.mailboxes.find((m) => m.id === id);
	if (!mailbox) {
		return (
			<Scaffold title="メールボックス">
				<BackLink to="/settings/notifications/mailboxes" label="メールボックスへ戻る" />
				<div className="card p-4 text-sm text-[var(--text-muted)]">このメールボックスが見つかりません。</div>
			</Scaffold>
		);
	}

	const setLevel = async (level: NotificationLevel) => {
		setBusy(true);
		try {
			await NotificationsApi.setMailboxLevel(mailbox.id, level);
			setSettings(await NotificationsApi.get());
		} finally {
			setBusy(false);
		}
	};

	const setSpam = async (v: boolean) => {
		setBusy(true);
		try {
			setSettings(await NotificationsApi.patch({ spam_suspicious: v ? "notify" : "drop" }));
		} finally {
			setBusy(false);
		}
	};

	// メールボックス未指定のルールは全アドレスを対象にするので、ここでも効いている。
	const affectingRules = settings.rules.filter(
		(r) => !r.matcher.mailboxIds || r.matcher.mailboxIds.length === 0 || r.matcher.mailboxIds.includes(mailbox.id),
	);

	const levelLabel = LEVELS.find((l) => l.value === mailbox.level)?.label ?? mailbox.level;

	return (
		<Scaffold title="メールボックスの通知" summary={`${levelLabel} で通知しています`}>
			<BackLink to="/settings/notifications/mailboxes" label="メールボックス一覧へ戻る" />
			<div className="card overflow-hidden">
				<div className="flex items-center gap-3 px-4 py-3">
					<MailboxDot color={mailbox.color} />
					<span className="flex items-center gap-2">
						<span className="text-sm font-medium text-[var(--text)]">{mailbox.address}</span>
						{mailbox.isCatchAll && <CatchAllBadge />}
					</span>
				</div>

				{mailbox.isCatchAll && !settings.notify_catch_all && (
					<div className="border-t border-[var(--line-soft)] px-4 py-3 text-xs text-[var(--text-muted)]">
						キャッチオールの通知がオフです（全体のスイッチが上位。オフの間はこの設定は効きません）
					</div>
				)}

				<div className="space-y-1 border-t border-[var(--line-soft)] p-4">
					{LEVELS.map((l) => (
						<button
							key={l.value}
							type="button"
							disabled={busy || (mailbox.isCatchAll && !settings.notify_catch_all)}
							onClick={() => setLevel(l.value)}
							className={`flex min-h-11 w-full flex-col justify-center rounded-lg px-3 py-2 text-left transition-colors ${
								mailbox.level === l.value
									? "bg-[var(--surface-selected)] text-[var(--text-on-selected)]"
									: "hover:bg-[var(--surface-hover)] text-[var(--text)]"
							}`}
						>
							<span className="text-sm font-medium">{l.label}</span>
							<span className="text-xs opacity-70">{l.desc}</span>
						</button>
					))}
				</div>
			</div>

			<Card>
				<div className="flex items-start gap-3 px-4 py-3">
					<div className="min-w-0 flex-1">
						<div className="text-sm text-[var(--text)]">スパムの疑いのあるメール</div>
						<div className="mt-0.5 text-xs text-[var(--text-muted)]">
							通知する / しない（既定は通知しない）。この設定は全メールボックスに共通です
						</div>
					</div>
					<Toggle checked={settings.spam_suspicious === "notify"} disabled={busy} onChange={setSpam} />
				</div>
			</Card>

			{affectingRules.length > 0 && (
				<div className="card p-4">
					<div className="mb-2 text-sm text-[var(--text)]">このメールボックスに効いているルール</div>
					{affectingRules.map((r) => (
						<button
							key={r.id}
							type="button"
							onClick={() => navigate(`/settings/notifications/rules/${r.id}`)}
							className="flex min-h-11 w-full items-center justify-between rounded-lg px-3 text-left text-sm text-[var(--text)] hover:bg-[var(--surface-hover)]"
						>
							<span className="truncate">{r.name}</span>
							<span className="shrink-0 text-xs text-[var(--text-muted)]">
								{r.action === "always"
									? "必ず通知（おやすみ時間も）"
									: r.action === "normal"
										? "通知"
										: r.action === "silent"
											? "音なし"
											: "通知しない"}
							</span>
						</button>
					))}
					<div className="mt-2 text-xs text-[var(--text-muted)]">ルールの追加・編集は通知ルールで行います</div>
				</div>
			)}
		</Scaffold>
	);
}
