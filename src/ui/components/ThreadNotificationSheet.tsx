import { useEffect, useState } from "react";
import type { MailboxNotification, NotificationLevel } from "@/shared/contracts/notifications";
import { NotificationsApi } from "@/ui/lib/api";
import { useIsMobile } from "@/ui/lib/useIsMobile";

const STROKE = {
	fill: "none",
	stroke: "currentColor",
	strokeWidth: 2,
	strokeLinecap: "round",
	strokeLinejoin: "round",
} as const;

const CloseIcon = () => (
	<svg className="h-5 w-5" viewBox="0 0 24 24" {...STROKE}>
		<path d="M6 6l12 12M18 6 6 18" />
	</svg>
);

function explanation(level: NotificationLevel | undefined): string {
	switch (level) {
		case "new_thread":
			return "新しい会話だけ通知する設定のため、この会話の返信は通知されません";
		case "direct":
			return "To に入っているときだけ通知する設定です";
		case "off":
			return "このメールボックスは通知しない設定です";
		case "all":
		case undefined:
			return "このメールボックスの新着はすべて通知される設定です";
	}
}

export function ThreadNotificationSheet({
	threadId,
	mailboxId,
	onClose,
}: {
	threadId: string;
	mailboxId: string | null;
	onClose: () => void;
}) {
	const isMobile = useIsMobile();
	const [mode, setMode] = useState<"follow" | "mute" | null | undefined>(undefined);
	const [mailboxes, setMailboxes] = useState<MailboxNotification[]>([]);

	useEffect(() => {
		let alive = true;
		void (async () => {
			try {
				const [t, s] = await Promise.all([NotificationsApi.getThread(threadId), NotificationsApi.get()]);
				if (!alive) return;
				setMode(t.mode);
				setMailboxes(s.mailboxes);
			} catch {
				if (alive) setMode(null);
			}
		})();
		return () => {
			alive = false;
		};
	}, [threadId]);

	const select = async (next: "follow" | "mute" | null) => {
		if (next === null) await NotificationsApi.clearThread(threadId);
		else await NotificationsApi.setThread(threadId, next);
		onClose();
	};

	const mailbox = mailboxes.find((m) => m.id === mailboxId);
	const level = mailbox?.level;
	const current = mode ?? null;

	const options: { key: "default" | "follow" | "mute"; title: string; line: string }[] = [
		{
			key: "default",
			title: "いつもどおり",
			line:
				mode === undefined
					? "確認中…"
					: explanation(level),
		},
		{ key: "follow", title: "返信を毎回通知", line: "この会話の返信を毎回通知します（フォロー）" },
		{ key: "mute", title: "この会話は通知しない", line: "この会話の返信を通知しません（ミュート）" },
	];

	const panel = (
		<div
			className={`bg-[var(--surface)] p-2 ${
				isMobile
					? "max-h-[80vh] overflow-y-auto rounded-t-2xl"
					: "w-full max-w-md rounded-2xl shadow-xl"
			}`}
			style={isMobile ? { paddingBottom: "calc(1rem + env(safe-area-inset-bottom))" } : undefined}
		>
			<div className="flex items-center justify-between px-4 py-2">
				<h3 className="text-base font-semibold text-[var(--text)]">この会話の通知</h3>
				<button
					type="button"
					onClick={onClose}
					aria-label="閉じる"
					className="grid h-11 w-11 place-items-center rounded-full text-[var(--text-muted)] hover:bg-[var(--surface-hover)]"
				>
					<CloseIcon />
				</button>
			</div>
			<div className="flex flex-col">
				{options.map((o) => {
					const selected = o.key === "default" ? current === null : current === o.key;
					return (
						<button
							key={o.key}
							type="button"
							disabled={mode === undefined}
							onClick={() => void select(o.key === "default" ? null : o.key)}
							className={`flex min-h-14 flex-col items-start gap-0.5 rounded-xl px-4 py-3 text-left transition-colors disabled:opacity-50 ${
								selected ? "bg-[var(--surface-selected)]" : "hover:bg-[var(--surface-hover)]"
							}`}
						>
							<span
								className={`text-sm font-medium ${selected ? "text-[var(--text-on-selected)]" : "text-[var(--text)]"}`}
							>
								{o.title}
							</span>
							<span
								className={`text-xs ${selected ? "text-[var(--text-on-selected)]" : "text-[var(--text-muted)]"}`}
							>
								{o.line}
							</span>
						</button>
					);
				})}
			</div>
		</div>
	);

	return (
		<div className="fixed inset-0 z-50">
			<div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
			{isMobile ? (
				<div className="absolute inset-x-0 bottom-0">{panel}</div>
			) : (
				<div className="absolute inset-0 flex items-start justify-center px-4 pt-20">
					{panel}
				</div>
			)}
		</div>
	);
}
