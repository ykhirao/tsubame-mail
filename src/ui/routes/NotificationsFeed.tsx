import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { FeedEntry, FeedItem, NotificationSettings } from "@/shared/contracts/notifications";
import { NotificationsApi, MessagesApi } from "@/ui/lib/api";
import { formatDate } from "@/ui/lib/format";
import { SwitchRow } from "@/ui/routes/settings/notifications/ruleShared";

const reasonLabelMap: Record<string, string> = {
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
	catch_all_off: "キャッチオールを通知しない設定です",
	quiet_drop: "おやすみ時間のため通知しませんでした",
	quiet_digest: "おやすみ時間のため、終わったときにまとめて通知しました",
	coalesced: "続けて届いたため 1 件にまとめました",
	send_failure: "送信に失敗しました",
};

function reasonLabel(entry: FeedEntry, rules: NotificationSettings["rules"] | []): string {
	if (entry.reason.startsWith("rule:")) {
		const id = entry.reason.slice("rule:".length);
		const rule = rules.find((r) => r.id === id);
		return rule ? `通知ルール「${rule.name}」に一致しました` : "通知ルールに一致しました";
	}
	if (entry.reason === "mailbox_level") {
		return entry.mailboxAddress
			? `${entry.mailboxAddress} のメールボックス設定に従いました`
			: "メールボックスの通知設定に従いました";
	}
	return reasonLabelMap[entry.reason] ?? entry.reason;
}

function reasonHref(reason: string): string | null {
	if (reason.startsWith("rule:")) return "/settings/notifications/rules";
	switch (reason) {
		case "paused":
		case "disabled":
			return "/settings/notifications";
		case "quiet_drop":
		case "quiet_digest":
			return "/settings/notifications/quiet";
		case "mailbox_level":
		case "catch_all_off":
			return "/settings/notifications/mailboxes";
		default:
			return null;
	}
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
	const href = reasonHref(entry.reason);
	const label = reasonLabel(entry, rules);
	return (
		<div className="px-4 py-3">
			{entry.fromAddr && (
				<p className="truncate text-sm font-medium text-[var(--text)]">{entry.fromAddr}</p>
			)}
			<button
				type="button"
				onClick={() => onOpen(entry.messageId)}
				disabled={entry.messageId === null}
				className="flex w-full items-center gap-3 text-left disabled:cursor-default"
			>
				<div className="min-w-0 flex-1">
					{entry.subject && <p className="truncate text-sm text-[var(--text)]">{entry.subject}</p>}
					<p className="mt-0.5 truncate text-xs text-[var(--text-muted)]">
						{entry.mailboxAddress || "—"} ・ {formatDate(entry.createdAt)} ・ {decisionLabel[entry.decision]}
					</p>
				</div>
			</button>
			<div className="mt-1">
				{href ? (
					<Link
						to={href}
						className="text-xs text-[var(--accent)] underline-offset-2 hover:underline"
					>
						{label}
					</Link>
				) : (
					<span className="text-xs text-[var(--text-muted)]">{label}</span>
				)}
			</div>
		</div>
	);
}

function bundleTimeRange(items: FeedEntry[]): string | null {
	if (!items.length) return null;
	const fmt = new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit" });
	const times = items.map((e) => fmt.format(new Date(e.createdAt * 1000)));
	const first = times[0]!;
	const last = times[times.length - 1]!;
	return first === last ? null : `（${first}〜${last}）`;
}

export function NotificationsFeed() {
	const navigate = useNavigate();
	const [items, setItems] = useState<FeedItem[]>([]);
	const [rules, setRules] = useState<NotificationSettings["rules"] | []>([]);
	const [nextCursor, setNextCursor] = useState<string | null>(null);
	const [feedSeenAt, setFeedSeenAt] = useState<number | null>(null);
	const [showDropped, setShowDropped] = useState(false);
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [bundleExtra, setBundleExtra] = useState<Record<string, FeedEntry[]>>({});
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
		const wasOpen = expanded.has(bundle.id);
		setExpanded((prev) => {
			const next = new Set(prev);
			if (wasOpen) next.delete(bundle.id);
			else next.add(bundle.id);
			return next;
		});
		if (!wasOpen && bundle.count > bundle.items.length && !bundleExtra[bundle.id]) {
			void (async () => {
				try {
					const res = await NotificationsApi.feed({
						hold_group: bundle.id,
						limit: 200,
						include_dropped: showDropped ? 1 : undefined,
					});
					setBundleExtra((prev) => ({ ...prev, [bundle.id]: res.data as FeedEntry[] }));
				} catch {
					/* 残りが取れなくても開いたものは見られる */
				}
			})();
		}
	};

	const sorted = [...items].sort((a, b) => b.createdAt - a.createdAt);

	return (
		<div className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 py-4">
			<div>
				<div className="flex items-center justify-between gap-2">
					<h1 className="text-lg font-bold text-[var(--text)]">通知欄</h1>
					<Link
						to="/settings/notifications"
						aria-label="通知設定"
						className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm text-[var(--accent)] hover:bg-[var(--surface-hover)]"
					>
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
							<circle cx="12" cy="12" r="3" />
							<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
						</svg>
						通知設定
					</Link>
				</div>
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
									{feedSeenAt !== null && item.createdAt > feedSeenAt && (
										<span className="absolute left-0 top-0 h-full w-1 bg-[var(--accent)]" />
									)}
									<EntryRow entry={item} rules={rules} onOpen={openThread} />
								</div>
							);
						}
						const open = expanded.has(item.id);
						const loaded = bundleExtra[item.id];
						const shown = loaded ?? item.items;
						const range = bundleTimeRange(shown);
						const hasMore = item.count > item.items.length && !loaded;
						const unseen = feedSeenAt !== null && shown.some((e) => e.createdAt > feedSeenAt);
						return (
							<div key={item.id} className="card relative flex flex-col overflow-hidden">
								{unseen && <span className="absolute left-0 top-0 h-full w-1 bg-[var(--accent)]" />}
								<button
									type="button"
									onClick={() => openBundle(item)}
									className="flex min-h-11 items-center justify-between px-4 py-3 text-left"
								>
									<div className="min-w-0 flex-1">
										<p className="text-sm font-semibold text-[var(--text)]">
											{item.count} 件 ・ {bundleTitle(item.reason)}
											{range && <span className="font-normal text-[var(--text-muted)]"> {range}</span>}
										</p>
										<p className="mt-0.5 text-xs text-[var(--text-muted)]">
											{formatDate(item.createdAt)} ・ {decisionLabel[item.decision]}
										</p>
									</div>
									<span className="shrink-0 px-2 text-sm text-[var(--text-muted)]">
										{open ? "閉じる" : hasMore ? `ほか ${item.count - item.items.length} 件を表示` : "表示"}
									</span>
								</button>
								{(open || item.count <= item.items.length) && (
									<div className="flex flex-col">
										{shown.map((e) => (
											<div key={e.id} className="border-t border-[var(--line-soft)]">
												<EntryRow entry={e} rules={rules} onOpen={openThread} />
											</div>
										))}
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
