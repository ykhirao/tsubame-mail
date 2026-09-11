import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { NotificationsApi } from "@/ui/lib/api";
import type { NotificationLevel, NotificationSettings } from "@/shared/contracts/notifications";
import { Scaffold, Card, BackLink, MailboxDot, LevelChip, Chevron } from "./shared";
import { CatchAllBadge } from "@/ui/components/mobile/CatchAllBadge";

const LEVELS: { value: NotificationLevel; label: string }[] = [
	{ value: "all", label: "すべての新着" },
	{ value: "new_thread", label: "新しい会話だけ" },
	{ value: "direct", label: "To に入っているときだけ" },
	{ value: "off", label: "通知しない" },
];

export function NotificationMailboxes() {
	const navigate = useNavigate();
	const [settings, setSettings] = useState<NotificationSettings | null>(null);
	const [sameOpen, setSameOpen] = useState(false);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		NotificationsApi.get()
			.then(setSettings)
			.catch(() => {});
	}, []);

	if (!settings) return <Scaffold title="メールボックスごと">{null}</Scaffold>;

	const assigned = settings.mailboxes.filter((m) => m.assigned);
	const unassigned = settings.mailboxes.filter((m) => !m.assigned);

	const applyAll = async (level: NotificationLevel) => {
		setBusy(true);
		try {
			for (const m of settings.mailboxes) {
				await NotificationsApi.setMailboxLevel(m.id, level);
			}
			setSettings(await NotificationsApi.get());
		} finally {
			setBusy(false);
			setSameOpen(false);
		}
	};

	const mailboxes = settings.mailboxes;
	const notified = mailboxes.filter((m) => m.level !== "off").length;

	return (
		<Scaffold
			title="メールボックスごと"
			summary={`${mailboxes.length} 個中 ${notified} 個で通知します`}
		>
			<BackLink to="/settings/notifications" label="通知設定へ戻る" />
			<div className="card p-4">
				<button
					type="button"
					disabled={busy}
					onClick={() => setSameOpen((v) => !v)}
					className="h-11 rounded-full px-4 text-sm font-medium text-[var(--accent)] hover:bg-[var(--surface-hover)]"
				>
					すべてを同じにする
				</button>
				{sameOpen && (
					<div className="mt-2 flex flex-wrap gap-2">
						{LEVELS.map((l) => (
							<button
								key={l.value}
								type="button"
								onClick={() => applyAll(l.value)}
								className="h-11 rounded-full border border-[var(--line)] px-4 text-sm text-[var(--text)] hover:bg-[var(--surface-hover)]"
							>
								{l.label}
							</button>
						))}
					</div>
				)}
			</div>

			<Card>
				{assigned.map((m) => (
					<MailboxRow
						key={m.id}
						mailbox={m}
						onClick={() => navigate(`/settings/notifications/mailboxes/${m.id}`)}
					/>
				))}
			</Card>

			{unassigned.length > 0 && (
				<>
					<h2 className="px-3 text-xs font-medium text-[var(--text-muted)]">
						割り当てなし（オーナーとして見えるだけ）
					</h2>
					<Card>
						{unassigned.map((m) => (
							<MailboxRow
								key={m.id}
								mailbox={m}
								onClick={() => navigate(`/settings/notifications/mailboxes/${m.id}`)}
							/>
						))}
					</Card>
				</>
			)}
		</Scaffold>
	);
}

function MailboxRow({
	mailbox,
	onClick,
}: {
	mailbox: {
		id: string;
		address: string;
		color: string;
		isCatchAll: boolean;
		level: NotificationLevel;
	};
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="flex min-h-[64px] w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--surface-hover)]"
		>
			<MailboxDot color={mailbox.color} />
			<span className="min-w-0 flex-1">
				<span className="flex items-center gap-2">
					<span className={`truncate text-sm ${mailbox.level === "off" ? "text-[var(--text-muted)]" : "text-[var(--text)]"}`}>
						{mailbox.address}
					</span>
					{mailbox.isCatchAll && <CatchAllBadge />}
				</span>
			</span>
			<LevelChip level={mailbox.level} />
			<Chevron />
		</button>
	);
}
