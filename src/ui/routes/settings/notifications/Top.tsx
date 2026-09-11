import { useEffect, useState } from "react";
import { useNavigate, Link } from "react-router";
import { DevicesApi, NotificationsApi } from "@/ui/lib/api";
import type { NotificationSettings, Device } from "@/shared/contracts/notifications";
import { getDeviceStatus, getRegisteredDeviceId, subscribeDevice } from "@/ui/lib/push";
import { guessDeviceName } from "@/ui/lib/push";
import { Scaffold, Card, SettingRow, Toggle, Chevron } from "./shared";
import { CatchAllBadge } from "@/ui/components/mobile/CatchAllBadge";

const displayLabel = {
	full: "差出人・件名・冒頭",
	sender_subject: "差出人と件名",
	minimal: "最小限",
} as const;

export function NotificationSettingsTop() {
	const navigate = useNavigate();
	const [settings, setSettings] = useState<NotificationSettings | null>(null);
	const [devices, setDevices] = useState<Device[]>([]);
	const [pausedOpen, setPausedOpen] = useState(false);
	const [presetBusy, setPresetBusy] = useState<"all" | "important" | null>(null);
	const [busySwitch, setBusySwitch] = useState(false);

	const load = () => {
		NotificationsApi.get()
			.then(setSettings)
			.catch(() => {});
		DevicesApi.list()
			.then((res) => setDevices(res.data))
			.catch(() => {});
	};
	useEffect(load, []);

	if (!settings) {
		return <Scaffold title="通知設定">{null}</Scaffold>;
	}

	const status = getDeviceStatus();
	const hasCatchAll = settings.mailboxes.some((m) => m.isCatchAll);
	const notifiedCount = settings.mailboxes.filter((m) => m.level !== "off").length;
	const alwaysRules = settings.rules.filter((r) => r.action === "always").length;
	const brokenDevices = devices.filter((d) => d.failureCount > 0).length;

	const applyPreset = async (preset: "all" | "important") => {
		setPresetBusy(preset);
		try {
			const next = await NotificationsApi.patch({ preset });
			setSettings(next);
		} finally {
			setPresetBusy(null);
		}
	};

	const setEnabled = async (enabled: boolean) => {
		setBusySwitch(true);
		try {
			const next = await NotificationsApi.patch({ enabled });
			setSettings(next);
		} finally {
			setBusySwitch(false);
		}
	};

	const pause = async (until: number | null) => {
		const next = await NotificationsApi.patch({ paused_until: until });
		setSettings(next);
		setPausedOpen(false);
	};

	const deviceStatusLine =
		status === "notifying"
			? `この端末（${guessDeviceName()}）に通知しています`
			: status === "unregistered"
				? "この端末は未登録"
				: status === "blocked"
					? "ブロック中"
					: status === "ios_not_standalone"
						? "この端末からは通知を受け取れません"
						: "このブラウザでは対応していません";

	const allActive = settings.mailboxes.every((m) => !m.assigned || m.level === "all");
	const importantActive = settings.mailboxes.every((m) => !m.assigned || m.level === "direct");
	const presetActive = allActive ? "all" : importantActive ? "important" : "custom";

	const now = Date.now() / 1000;
	const pausedAt = settings.paused_until && settings.paused_until > now ? settings.paused_until : null;
	const pausedTime = pausedAt ? new Date(pausedAt * 1000).toLocaleString("ja-JP") : null;

	let quietSummary = "設定なし";
	if (settings.quiet) {
		quietSummary = settings.quiet.mode === "digest" ? "終わったときにまとめて 1 通" : "通知しない";
	}

	return (
		<Scaffold title="通知設定">
			<Card>
				<div className="flex items-start justify-between gap-3 px-4 py-3">
					<div className="min-w-0">
						<div className="text-sm text-[var(--text)]">{deviceStatusLine}</div>
						{status === "unregistered" && (
							<div className="mt-0.5 text-xs text-[var(--text-muted)]">
								端末名は {guessDeviceName()} で登録されます
							</div>
						)}
					</div>
				</div>
				{status === "unregistered" && (
					<div className="px-4 pb-4">
						<button
							type="button"
							onClick={async () => {
								await subscribeDevice();
								load();
							}}
							className="inline-flex h-12 min-w-44 items-center justify-center gap-2 rounded-full bg-[var(--accent)] px-5 text-sm font-medium text-white hover:opacity-90"
						>
							この端末で受け取る
						</button>
					</div>
				)}
				<SettingRow
					title="通知"
					trailing={<Toggle checked={settings.enabled} disabled={busySwitch} onChange={setEnabled} />}
				/>
				<div className="px-4 py-3">
					{pausedAt ? (
						<div className="flex items-center justify-between gap-3">
							<div className="text-sm text-[var(--text)]">{pausedTime} まで停止中</div>
							<button
								type="button"
								onClick={() => pause(null)}
								className="h-11 rounded-full px-4 text-sm font-medium text-[var(--accent)] hover:bg-[var(--surface-hover)]"
							>
								解除
							</button>
						</div>
					) : (
						<button
							type="button"
							onClick={() => setPausedOpen((v) => !v)}
							className="h-11 rounded-full px-4 text-sm font-medium text-[var(--accent)] hover:bg-[var(--surface-hover)]"
						>
							一時停止
						</button>
					)}
					{pausedOpen && (
						<div className="mt-2 flex flex-wrap gap-2">
							{[
								{ label: "1 時間", until: Math.floor(now) + 3600 },
								{ label: "今日の終わりまで", until: Math.floor(new Date().setHours(24, 0, 0, 0) / 1000) },
								{ label: "明日の朝まで", until: Math.floor(new Date().setHours(24, 0, 0, 0) / 1000) + 7 * 3600 },
							].map((o) => (
								<button
									key={o.label}
									type="button"
									onClick={() => pause(o.until)}
									className="h-11 rounded-full border border-[var(--line)] px-4 text-sm text-[var(--text)] hover:bg-[var(--surface-hover)]"
								>
									{o.label}
								</button>
							))}
						</div>
					)}
					<div className="mt-2 text-xs text-[var(--text-muted)]">
						停止した間の分は、解除しても通知しません（通知欄で見られます）
					</div>
				</div>
			</Card>

			<div className="card p-4">
				<div className="mb-2 text-sm text-[var(--text)]">プリセット</div>
				<div className="flex flex-col gap-1">
					{(
						[
							{ key: "all", label: "すべて", desc: "割り当てられたメールボックスの新着をすべて" },
							{ key: "important", label: "重要なものだけ", desc: "To に入っているものと返信だけ" },
						] as const
					).map((p) => (
						<button
							key={p.key}
							type="button"
							disabled={presetBusy !== null}
							onClick={() => applyPreset(p.key)}
							className={`flex min-h-11 items-center gap-2 rounded-lg px-3 text-left text-sm transition-colors ${
								presetActive === p.key
									? "bg-[var(--surface-selected)] text-[var(--text-on-selected)]"
									: "hover:bg-[var(--surface-hover)] text-[var(--text)]"
							}`}
						>
							<span className="shrink-0 font-medium">{p.label}</span>
							<span className="text-xs opacity-70">{p.desc}</span>
						</button>
					))}
					{presetActive === "custom" && (
						<div className="rounded-lg bg-[var(--surface-hover)] px-3 py-2 text-sm text-[var(--text-muted)]">
							カスタム（細かい設定を変えると自動でカスタムになります）
						</div>
					)}
				</div>
			</div>

			<Card>
				<SettingRow
					title="メールボックスごと"
					subtitle={`${settings.mailboxes.length} 個中 ${notifiedCount} 個で通知`}
					trailing={<Chevron />}
					onClick={() => navigate("/settings/notifications/mailboxes")}
				/>
				<SettingRow
					title="通知ルール"
					subtitle={`${settings.rules.length} 件（うち「必ず通知」${alwaysRules} 件）`}
					trailing={<Chevron />}
					onClick={() => navigate("/settings/notifications/rules")}
				/>
				<SettingRow
					title="おやすみ時間"
					subtitle={quietSummary}
					trailing={<Chevron />}
					onClick={() => navigate("/settings/notifications/quiet")}
				/>
				<SettingRow
					title="表示とまとめ方"
					subtitle={`${displayLabel[settings.display]} / 同じ会話は 1 件`}
					trailing={<Chevron />}
					onClick={() => navigate("/settings/notifications/display")}
				/>
				<SettingRow
					title="端末"
					subtitle={`${devices.length} 台${brokenDevices > 0 ? `（${brokenDevices} 台は届いていません）` : ""}`}
					trailing={<Chevron />}
					onClick={() => navigate("/settings/notifications/devices")}
				/>
			</Card>

			<Card>
				{hasCatchAll && (
					<SettingRow
						title={
							<span className="flex items-center gap-2">
								キャッチオールを通知する
								<CatchAllBadge />
							</span>
						}
						subtitle="宛先が見つからないメールが届いたときに通知します。オフでも「必ず通知」のルールに一致したものは通知します"
						trailing={
							<Toggle
								checked={settings.notify_catch_all}
								disabled={busySwitch}
								onChange={async (v) =>
									setSettings(await NotificationsApi.patch({ notify_catch_all: v }))
								}
							/>
						}
					/>
				)}
				<SettingRow
					title="送信失敗を通知する"
					subtitle="自分が送ったメールが届かなかったときに通知します"
					trailing={
						<Toggle
							checked={settings.notify_send_failure}
							disabled={busySwitch}
							onChange={async (v) =>
								setSettings(await NotificationsApi.patch({ notify_send_failure: v }))
							}
						/>
					}
				/>
			</Card>

			<Card>
				<SettingRow
					title="通知欄"
					subtitle="届いたものを見返す・どうして通知された / されなかったか"
					trailing={<Chevron />}
					onClick={() => navigate("/notifications")}
				/>
			</Card>

			{getRegisteredDeviceId() && (
				<Link
					to="/settings"
					className="mx-auto mt-2 h-11 rounded-full px-4 text-sm text-[var(--text-muted)] hover:bg-[var(--surface-hover)]"
				>
					設定へ戻る
				</Link>
			)}
		</Scaffold>
	);
}
