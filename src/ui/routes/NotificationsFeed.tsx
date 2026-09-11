import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import type { FeedEntry, FeedItem, NotificationSettings } from "@/shared/contracts/notifications";
import { NotificationsApi, MessagesApi } from "@/ui/lib/api";
import { formatDate } from "@/ui/lib/format";
import { SwitchRow } from "@/ui/routes/settings/notifications/ruleShared";

function reasonLabel(reason: string, rules: NotificationSettings["rules"] | []): string {
	if (reason.startsWith("rule:")) {
		const id = reason.slice("rule:".length);
		const rule = rules.find((r) => r.id === id);
		return rule ? `通知ルール「${rule.name}」に一致しました` : "通知ルールに一致しました";
	}
	const map: Record<string, string> = {
		user_ineligible: "対象外のアカウントでした",
		not_assigned: "このメールボックスに割り当てられていません",
		privilege_only: "オーナーにしか見えないため通知しません",
		disabled: "通知がオフになっています",
		paused: "一時停止中でした",
		rule_trashed: "ルーティングルールで破棄されました",
		rule_read: "ルーティングルールで既読にされました",
		spam: "スパム判定のため通知しません",
		thread_muted: "この会話は通知しない設定です",
		thread_followed: "フォロー中の会話です",
		mailbox_level: "メールボックスの通知設定に従いました",
		catch_all_off: "キャッチオールを通知しない設定です",
		quiet_drop: "おやすみ時間のため通知しませんでした",
		quiet_digest: "おやすみ時間のため、終わったときにまとめて通知します",
		coalesced: "続けて届いたため 1 件にまとめました",
		send_failure: "送信に失敗しました",
	};
	return map[reason] ?? reason;
}

const decisionLabel: Record<FeedEntry["decision"], string> = {
	sent: "通知",
	held: "保留",
	digest: "後で通知",
	dropped: "対象外",
};

function bundleTitle(reason: string): string {
	if (reason === "paused") return "一時停止中に届きました";
	if (reason === "quiet_drop" || reason === "quiet_digest") {
		return reason === "quiet_digest" ? "おやすみ中（まとめて通知）" : "おやすみ中";
	}
	return "保留";
}

function EntryRow({
	entry,
	rules,
	onOpen,
}: {
	entry: FeedEntry;
	rules: NotificationSettings["rules"] | [];
	onOpen: (messageId: string | null) => void;
}) {
	return (
		<button
			type="button"
			onClick={() => onOpen(entry.messageId)}
			disabled={entry.messageId === null}
			className="flex w-full items-center gap-3 px-4 py-3 text-left disabled:cursor-default"
		>
			<div className="min-w-0 flex-1">
				<p className="text-sm font-medium text-[var(--text)]">{reasonLabel(entry.reason, rules)}</p>
				<p className="mt-0.5 text-xs text-[var(--text-muted)]">
					{formatDate(entry.createdAt)} ・ {decisionLabel[entry.decision]}
				</p>
			</div>
		</button>
	);
}

export function NotificationsFeed() {
	const navigate = useNavigate();
	const [items, setItems] = useState<FeedItem[]>([]);
	const [rules, setRules] = useState<NotificationSettings["rules"] | []>([]);
	const [nextCursor, setNextCursor] = useState<string | null>(null);
	const [feedSeenAt, setFeedSeenAt] = useState<number | null>(null);
	const [showDropped, setShowDropped] = useState(false);
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [loading, setLoading] = useState(true);
	const [loadMoreBusy, setLoadMoreBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(
		async (cursor?: string) => {
			try {
				const res = await NotificationsApi.feed({
					limit: 50,
					cursor,
					include_dropped: showDropped ? 1 : undefined,
				});
				if (!cursor) {
					setItems(res.data);
				} else {
					setItems((prev) => [...prev, ...res.data]);
				}
				setNextCursor(res.next_cursor);
			} catch (e) {
				setError(e instanceof Error ? e.message : "通知欄の取得に失敗しました");
			} finally {
				setLoading(false);
				setLoadMoreBusy(false);
			}
		},
		[showDropped],
	);

	useEffect(() => {
		void load();
	}, [load]);

	useEffect(() => {
		void (async () => {
			try {
				const s = await NotificationsApi.get();
				setRules(s.rules);
				setFeedSeenAt(s.feed_seen_at);
				if (s.unseen_count > 0) {
					await NotificationsApi.markFeedSeen();
					setFeedSeenAt(Date.now() / 1000);
				}
			} catch {
				/* 未確認数の更新に失敗しても一覧は見られる */
			}
		})();
	}, []);

	const openThread = async (messageId: string | null) => {
		if (!messageId) return;
		try {
			const m = await MessagesApi.get(messageId);
			if (m.threadId) navigate(`/threads/${m.threadId}`);
		} catch {
			/* 行先が見つからなければ何もしない */
		}
	};

	const openBundle = (bundle: FeedItem & { type: "bundle" }) => {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(bundle.id)) next.delete(bundle.id);
			else next.add(bundle.id);
			return next;
		});
	};

	const sorted = [...items].sort((a, b) => b.createdAt - a.createdAt);

	return (
		<div className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 py-4">
			<div>
				<h1 className="text-lg font-bold text-[var(--text)]">通知欄</h1>
				<p className="mt-1 text-sm text-[var(--text-muted)]">
					届いたものを振り返り、なぜ通知された・されなかったかを確認できます。
					30 日より前のものは残りません。
				</p>
			</div>

			<SwitchRow checked={showDropped} onChange={setShowDropped} label="対象外も表示">
				<span className="block text-xs text-[var(--text-muted)]">
					メールボックスのレベルやルールで対象外になったものも理由つきで出します
				</span>
			</SwitchRow>

			{error && (
				<div className="rounded-md border border-[var(--danger)] bg-[var(--surface-hover)] px-4 py-3 text-sm text-[var(--danger)]">
					{error}
				</div>
			)}

			{loading ? (
				<div className="text-sm text-[var(--text-muted)]">読み込み中…</div>
			) : (
				<div className="flex flex-col gap-2">
					{sorted.length === 0 && (
						<div className="card px-5 py-10 text-center text-sm text-[var(--text-muted)]">
							通知がまだありません
							{showDropped && "（対象外も含めてありません）"}
						</div>
					)}
					{sorted.map((item) => {
						if (item.type === "entry") {
							return (
								<div key={item.id} className="card relative overflow-hidden">
									{feedSeenAt !== null && item.createdAt > feedSeenAt && item.decision === "sent" && (
										<span className="absolute left-0 top-0 h-full w-1 bg-[var(--accent)]" />
									)}
									<EntryRow entry={item} rules={rules} onOpen={openThread} />
								</div>
							);
						}
						const open = expanded.has(item.id);
						return (
							<div key={item.id} className="card flex flex-col">
								<button
									type="button"
									onClick={() => openBundle(item)}
									className="flex min-h-11 items-center justify-between px-4 py-3 text-left"
								>
									<div className="min-w-0 flex-1">
										<p className="text-sm font-semibold text-[var(--text)]">
											{item.count} 件 ・ {bundleTitle(item.reason)}
										</p>
										<p className="mt-0.5 text-xs text-[var(--text-muted)]">
											{formatDate(item.createdAt)} ・ {decisionLabel[item.decision]}
										</p>
									</div>
									<span className="shrink-0 px-2 text-sm text-[var(--text-muted)]">
										{open ? "閉じる" : `${item.count - item.items.length} 件を表示`}
									</span>
								</button>
								{(open || item.count <= item.items.length) && (
									<div className="flex flex-col">
										{item.items.map((e) => (
											<EntryRow key={e.id} entry={e} rules={rules} onOpen={openThread} />
										))}
										{item.count > item.items.length && !open && (
											<p className="px-4 pb-3 text-xs text-[var(--text-muted)]">
												ほか {item.count - item.items.length} 件（解除後も通知しません）
											</p>
										)}
									</div>
								)}
							</div>
						);
					})}
					{nextCursor && (
						<button
							type="button"
							disabled={loadMoreBusy}
							onClick={() => {
								setLoadMoreBusy(true);
								void load(nextCursor ?? undefined);
							}}
							className="h-11 rounded-full border border-[var(--line)] text-sm text-[var(--accent)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
						>
							{loadMoreBusy ? "読み込み中…" : "もっと読み込む"}
						</button>
					)}
				</div>
			)}
		</div>
	);
}
