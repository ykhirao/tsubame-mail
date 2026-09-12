import { useEffect, useState } from "react";
import { DevicesApi, NotificationsApi } from "@/ui/lib/api";
import type { Device } from "@/shared/contracts/notifications";
import type { NotificationSettings } from "@/shared/contracts/notifications";
import { getRegisteredDeviceId } from "@/ui/lib/push";
import { Scaffold, Card, BackLink, Toggle, MailboxDot } from "./shared";
import { formatFullDate } from "@/ui/lib/format";

export function NotificationDevices() {
	const [devices, setDevices] = useState<Device[]>([]);
	const [settings, setSettings] = useState<NotificationSettings | null>(null);
	const [busy, setBusy] = useState(false);
	const [expanded, setExpanded] = useState<string | null>(null);

	const reload = () => {
		DevicesApi.list()
			.then((res) => setDevices(res.data))
			.catch(() => {});
		NotificationsApi.get()
			.then(setSettings)
			.catch(() => {});
	};
	useEffect(reload, []);

	const currentId = getRegisteredDeviceId();

	if (!settings) return <Scaffold title="端末">{null}</Scaffold>;

	return (
		<Scaffold title="端末" summary={`${devices.length} 台の端末で通知を受ける設定です`}>
			<BackLink to="/settings/notifications" label="通知設定へ戻る" />
			<div className="flex flex-col gap-3">
				{devices.map((d) => (
					<DeviceCard
						key={d.id}
						device={d}
						mailboxes={settings.mailboxes}
						isCurrent={d.id === currentId}
						expanded={expanded === d.id}
						busy={busy}
						onToggleExpand={() => setExpanded(expanded === d.id ? null : d.id)}
						onChanged={async () => {
							await reload();
						}}
						setBusy={setBusy}
					/>
				))}
				{devices.length === 0 && (
					<div className="card p-4 text-sm text-[var(--text-muted)]">
						登録された端末がありません。
					</div>
				)}
			</div>
			<p className="px-1 text-xs text-[var(--text-muted)]">
				90 日開かれていない端末は自動で削除されます。
			</p>
		</Scaffold>
	);
}

function DeviceCard({
	device,
	mailboxes,
	isCurrent,
	expanded,
	busy,
	onToggleExpand,
	onChanged,
	setBusy,
}: {
	device: Device;
	mailboxes: { id: string; address: string; color: string; isCatchAll: boolean }[];
	isCurrent: boolean;
	expanded: boolean;
	busy: boolean;
	onToggleExpand: () => void;
	onChanged: () => void;
	setBusy: (v: boolean) => void;
}) {
	const [name, setName] = useState(device.name);

	const platformLabel =
		device.platform === "ios"
			? "iOS"
			: device.platform === "android"
				? "Android"
				: "PC";

	const broken = device.failureCount > 0;

	const save = async (body: { name?: string; enabled?: boolean; addressIds?: string[] | null }) => {
		setBusy(true);
		try {
			await DevicesApi.update(device.id, body);
			await onChanged();
		} finally {
			setBusy(false);
		}
	};

	const allMailboxes = device.addressIds === null;
	const selected = device.addressIds ?? [];

	return (
		<div className="card overflow-hidden">
			<button
				type="button"
				onClick={onToggleExpand}
				className="flex min-h-11 w-full items-center gap-3 px-4 py-3 text-left hover:bg-[var(--surface-hover)]"
			>
				<span className="min-w-0 flex-1">
					<span className="flex items-center gap-2">
						<span className="truncate text-sm text-[var(--text)]">{device.name}</span>
						{isCurrent && (
							<span className="shrink-0 rounded-full bg-[var(--surface-selected)] px-2 py-0.5 text-[10px] text-[var(--text-on-selected)]">
								この端末
							</span>
						)}
					</span>
					<span className="mt-0.5 block text-xs text-[var(--text-muted)]">
						{platformLabel}
						{broken
							? `・届いていません（最後の成功: ${
									device.lastSuccessAt ? formatFullDate(device.lastSuccessAt) : "不明"
								}）`
							: device.lastSuccessAt
								? `・最後に届いた: ${formatFullDate(device.lastSuccessAt)}`
								: ""}
					</span>
				</span>
				<span className="shrink-0 text-[var(--text-muted)]" aria-hidden>
					{expanded ? "︿" : "﹀"}
				</span>
			</button>

			{expanded && (
				<div className="space-y-4 border-t border-[var(--line-soft)] p-4">
					<div>
						<label className="mb-1 block text-xs font-medium text-[var(--text-muted)]">名前</label>
						<div className="flex items-center gap-2">
							<input
								value={name}
								onChange={(e) => setName(e.target.value)}
								className="h-11 min-w-0 flex-1 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 text-sm text-[var(--text)] focus:border-[var(--accent)] focus:outline-none"
							/>
							<button
								type="button"
								disabled={busy || name === device.name}
								onClick={() => save({ name })}
								className="h-11 rounded-full px-4 text-sm font-medium text-[var(--accent)] hover:bg-[var(--surface-hover)] disabled:opacity-40"
							>
								変更
							</button>
						</div>
					</div>

					<div className="flex items-center gap-3">
						<span className="min-w-0 flex-1 text-sm text-[var(--text)]">通知を受け取る</span>
						<Toggle checked={device.enabled} disabled={busy} onChange={(v) => save({ enabled: v })} />
					</div>

					<div>
						<div className="mb-1 text-xs font-medium text-[var(--text-muted)]">受け取るメールボックス</div>
						<div className="flex flex-wrap gap-2">
							<button
								type="button"
								disabled={busy}
								onClick={() => save({ addressIds: null })}
								className={`h-11 rounded-full border px-4 text-sm transition-colors ${
									allMailboxes
										? "border-[var(--accent)] bg-[var(--accent-weak)] text-[var(--accent-text)]"
										: "border-[var(--line)] text-[var(--text)] hover:bg-[var(--surface-hover)]"
								}`}
							>
								すべて
							</button>
							<button
								type="button"
								disabled={busy}
								onClick={() => allMailboxes && save({ addressIds: mailboxes.map((m) => m.id) })}
								className={`h-11 rounded-full border px-4 text-sm transition-colors ${
									!allMailboxes
										? "border-[var(--accent)] bg-[var(--accent-weak)] text-[var(--accent-text)]"
										: "border-[var(--line)] text-[var(--text)] hover:bg-[var(--surface-hover)]"
								}`}
							>
								選ぶ
							</button>
						</div>
						{!allMailboxes && (
							<div className="mt-2 flex flex-col gap-1">
								{mailboxes.map((m) => {
									const on = selected.includes(m.id);
									return (
										<button
											key={m.id}
											type="button"
											disabled={busy}
											onClick={() =>
												save({
													addressIds: on
														? selected.filter((x) => x !== m.id)
														: [...selected, m.id],
												})
											}
											className="flex min-h-11 items-center gap-2 rounded-lg px-2 text-left hover:bg-[var(--surface-hover)]"
										>
											<MailboxDot color={m.color} />
											<span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">{m.address}</span>
											<span className={`text-sm ${on ? "text-[var(--accent)]" : "text-[var(--line)]"}`}>✓</span>
										</button>
									);
								})}
							</div>
						)}
					</div>

					<div className="flex items-center gap-2">
						<button
							type="button"
							disabled={busy}
							onClick={async () => {
								setBusy(true);
								try {
									await DevicesApi.test(device.id);
								} finally {
									setBusy(false);
								}
							}}
							className="h-11 rounded-full border border-[var(--line)] px-4 text-sm text-[var(--text)] hover:bg-[var(--surface-hover)]"
						>
							テスト通知
						</button>
						<button
							type="button"
							disabled={busy}
							onClick={async () => {
								if (!window.confirm(`${device.name} を削除しますか？`)) return;
								setBusy(true);
								try {
									await DevicesApi.remove(device.id);
									await onChanged();
								} finally {
									setBusy(false);
								}
							}}
							className="h-11 rounded-full border border-[var(--danger)] px-4 text-sm text-[var(--danger)] hover:bg-[var(--surface-hover)]"
						>
							削除
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
