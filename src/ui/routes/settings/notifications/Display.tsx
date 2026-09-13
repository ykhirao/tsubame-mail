import { useEffect, useState } from "react";
import { NotificationsApi } from "@/ui/lib/api";
import type { NotificationDisplay } from "@/shared/contracts/notifications";
import type { NotificationSettings } from "@/shared/contracts/notifications";
import { Scaffold, Card, BackLink, Toggle } from "./shared";

const DISPLAYS: { value: NotificationDisplay; label: string; title: string; body: string }[] = [
	{ value: "full", label: "差出人・件名・冒頭", title: "山田 太郎", body: "議事録のご相談 ／ 先日お送りした件ですが…" },
	{ value: "sender_subject", label: "差出人と件名", title: "山田 太郎", body: "議事録のご相談" },
	{ value: "minimal", label: "最小限", title: "Tsubamail", body: "新着メール（受信箱）" },
];

const BADGES = [
	{ value: "all" as const, label: "全メールボックスの未読" },
	{ value: "notified" as const, label: "通知するメールボックスの未読" },
	{ value: "off" as const, label: "出さない" },
];

const BURSTS = [
	{ sec: 0, label: "まとめない" },
	{ sec: 60, label: "1 分" },
	{ sec: 300, label: "5 分" },
	{ sec: 900, label: "15 分" },
];

export function NotificationDisplaySettings() {
	const [settings, setSettings] = useState<NotificationSettings | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		NotificationsApi.get()
			.then(setSettings)
			.catch(() => {});
	}, []);

	if (!settings) return <Scaffold title="表示とまとめ方">{null}</Scaffold>;

	const patch = async (body: Parameters<typeof NotificationsApi.patch>[0]) => {
		setBusy(true);
		try {
			setSettings(await NotificationsApi.patch(body));
		} finally {
			setBusy(false);
		}
	};

	const display = DISPLAYS.find((d) => d.value === settings.display) ?? DISPLAYS[0]!;

	return (
		<Scaffold
			title="表示とまとめ方"
			summary={settings.group_by_thread ? `${display.label} / 同じ会話は 1 件` : display.label}
		>
			<BackLink to="/settings/notifications" label="通知設定へ戻る" />

			<div className="card p-4">
				<div className="mb-2 text-sm text-[var(--text)]">ロック画面の表示</div>
				<div className="space-y-1">
					{DISPLAYS.map((d) => (
						<button
							key={d.value}
							type="button"
							disabled={busy}
							onClick={() => patch({ display: d.value })}
							className={`flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors ${
								settings.display === d.value
									? "bg-[var(--surface-selected)] text-[var(--text-on-selected)]"
									: "hover:bg-[var(--surface-hover)] text-[var(--text)]"
							}`}
						>
							<span className="min-w-0 flex-1">
								<span className="block text-sm font-medium">{d.label}</span>
							</span>
						</button>
					))}
				</div>
				<div className="mt-3 rounded-lg border border-[var(--line-soft)] bg-[var(--surface-hover)] p-3">
					<div className="text-lg font-semibold text-[var(--text)]">{display.title}</div>
					<div className="text-sm text-[var(--text-muted)]">{display.body}</div>
					<div className="mt-1 text-[10px] text-[var(--text-muted)]">ロック画面の見本</div>
				</div>
			</div>

			<div className="card p-4">
				<div className="mb-2 text-sm text-[var(--text)]">バッジ</div>
				<div className="space-y-1">
					{BADGES.map((b) => (
						<button
							key={b.value}
							type="button"
							disabled={busy}
							onClick={() => patch({ badge: b.value })}
							className={`flex min-h-11 w-full items-center rounded-lg px-3 text-left text-sm transition-colors ${
								settings.badge === b.value
									? "bg-[var(--surface-selected)] font-medium text-[var(--text-on-selected)]"
									: "hover:bg-[var(--surface-hover)] text-[var(--text)]"
							}`}
						>
							{b.label}
						</button>
					))}
				</div>
				<div className="mt-2 text-xs text-[var(--text-muted)]">
					Android のバッジは数字ではなく点になります
				</div>
			</div>

			<Card>
				<div className="flex items-start gap-3 px-4 py-3">
					<div className="min-w-0 flex-1">
						<div className="text-sm text-[var(--text)]">同じ会話は 1 件にまとめる</div>
						<div className="mt-0.5 text-xs text-[var(--text-muted)]">続けて届いた返信を 1 件にまとめます</div>
					</div>
					<Toggle checked={settings.group_by_thread} disabled={busy} onChange={(v) => patch({ group_by_thread: v })} />
				</div>
				<div className="flex items-start gap-3 px-4 py-3">
					<div className="min-w-0 flex-1">
						<div className="text-sm text-[var(--text)]">続けて届いたらまとめる</div>
						<div className="mt-0.5 text-xs text-[var(--text-muted)]">まとめると「新着 5 件」の 1 通になります</div>
					</div>
				</div>
				<div className="flex flex-wrap gap-2 px-4 pb-4">
					{BURSTS.map((b) => (
						<button
							key={b.sec}
							type="button"
							disabled={busy}
							onClick={() => patch({ burst_window_sec: b.sec })}
							className={`h-11 rounded-full border px-4 text-sm transition-colors ${
								settings.burst_window_sec === b.sec
									? "border-[var(--accent)] bg-[var(--accent-weak)] text-[var(--accent-text)]"
									: "border-[var(--line)] text-[var(--text)] hover:bg-[var(--surface-hover)]"
							}`}
						>
							{b.label}
						</button>
					))}
				</div>
			</Card>

			<Card>
				<div className="flex items-start gap-3 px-4 py-3">
					<div className="min-w-0 flex-1">
						<div className="text-sm text-[var(--text)]">他の端末で Tsubamail を開いている間は送らない</div>
						<div className="mt-0.5 text-xs text-[var(--text-muted)]">
							この端末の利用中は他の端末への通知を止めます（既定オフ）
						</div>
					</div>
					<Toggle
						checked={settings.suppress_when_active}
						disabled={busy}
						onChange={(v) => patch({ suppress_when_active: v })}
					/>
				</div>
			</Card>

			<div className="card border-l-4 border-l-[var(--warning)] p-4 text-xs text-[var(--text-muted)]">
				<p className="mb-1 font-medium text-[var(--text)]">このアプリでできないこと</p>
				<p>iPhone では「音なし」と通知のボタン（Chrome / Firefox の「既読にする」など）が効きません。</p>
				<p className="mt-1">Android のバッジは数字でなく点で表示されます。</p>
				<p className="mt-1">集中モード中は「必ず通知」も OS の設定に従います（即時通知にはできません）。</p>
			</div>
		</Scaffold>
	);
}
