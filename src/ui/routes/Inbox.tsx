import { useEffect, useState, useCallback } from "react";
import { Link, useSearchParams } from "react-router";
import type { ThreadListItem } from "@/shared/contracts/messages";
import { MessagesApi, ThreadsApi } from "@/ui/lib/api";
import { EmptyState } from "@/ui/components/EmptyState";
import { Spinner } from "@/ui/components/Spinner";

const PAGE = 25;

function formatListDate(unixSec: number): string {
	const d = new Date(unixSec * 1000);
	const now = new Date();
	if (d.toDateString() === now.toDateString()) {
		return new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit" }).format(d);
	}
	if (d.getFullYear() === now.getFullYear()) {
		return new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric" }).format(d);
	}
	return new Intl.DateTimeFormat("ja-JP", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(d);
}

export function Inbox() {
	const [searchParams] = useSearchParams();
	const selected = searchParams.get("address") ?? "";

	const [threads, setThreads] = useState<ThreadListItem[]>([]);
	const [nextCursor, setNextCursor] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [loadingMore, setLoadingMore] = useState(false);

	// 未選択のときは絞らず、触れる全メールボックスを出す。切り替えは上部バーが持つ。

	const fetchThreads = useCallback(async (cursor?: string) => {
		if (!cursor) {
			setLoading(true);
			setThreads([]);
			setNextCursor(null);
		} else {
			setLoadingMore(true);
		}
		try {
			const res = await ThreadsApi.list({
				...(selected ? { address: selected } : {}),
				limit: PAGE,
				cursor,
			});
			if (!cursor) {
				setThreads(res.data);
				setNextCursor(res.next_cursor);
			} else {
				setThreads((prev) => [...prev, ...res.data]);
				setNextCursor(res.next_cursor);
			}
		} finally {
			setLoading(false);
			setLoadingMore(false);
		}
	}, [selected]);

	/**
	 * スターはメッセージ側に付くので、スレッドの最新 1 件を代表として更新する。
	 * 画面は待たずに先に反転させ、失敗したら戻す。一覧の操作が重く感じないようにするため。
	 */
	const toggleStar = async (t: ThreadListItem) => {
		const next = !t.isStarred;
		setThreads((prev) => prev.map((x) => (x.id === t.id ? { ...x, isStarred: next } : x)));
		try {
			const detail = await ThreadsApi.get(t.id);
			const last = detail.messages.at(-1);
			if (last) await MessagesApi.patch(last.id, { isStarred: next });
		} catch {
			setThreads((prev) => prev.map((x) => (x.id === t.id ? { ...x, isStarred: !next } : x)));
		}
	};

	useEffect(() => {
		void fetchThreads();
	}, [fetchThreads]);

	return (
		<div className="flex flex-1 flex-col">
			<section className="card overflow-hidden">
				{loading ? (
					<Spinner />
				) : threads.length === 0 ? (
					<EmptyState title="メールがありません">
						{selected
							? "このメールボックスにはまだ届いていません"
							: "すべてのメールボックスを見ています"}
					</EmptyState>
				) : (
					<>
						<ul className="divide-y divide-[var(--line-soft)]">
							{threads.map((t) => {
								const unread = t.unreadCount > 0;
								return (
									<li key={t.id}>
										<Link
											to={`/threads/${t.id}`}
											className={`flex min-h-11 items-center gap-3 px-4 py-1.5 transition-colors hover:bg-[var(--surface-hover)] hover:shadow-sm ${
												unread
													? "bg-[var(--surface)] font-semibold text-[var(--text)]"
													: "bg-[var(--surface-read)] text-[var(--text-muted)]"
											}`}
										>
											<input
												type="checkbox"
												aria-label="選択"
												className="h-4 w-4 shrink-0 accent-[var(--accent)]"
												onClick={(e) => {
													e.preventDefault();
													e.stopPropagation();
												}}
											/>
											<button
												type="button"
												aria-label={t.isStarred ? "スターを外す" : "スターを付ける"}
												title={t.isStarred ? "スターを外す" : "スターを付ける"}
												onClick={(e) => {
													e.preventDefault();
													e.stopPropagation();
													void toggleStar(t);
												}}
												className="shrink-0 text-[var(--text-muted)] hover:text-[var(--warning)]"
											>
												<svg
													className="h-4 w-4"
													viewBox="0 0 24 24"
													fill={t.isStarred ? "var(--warning)" : "none"}
													stroke={t.isStarred ? "var(--warning)" : "currentColor"}
													strokeWidth="1.8"
													strokeLinejoin="round"
												>
													<path d="m12 4 2.4 5 5.6.8-4 3.9.9 5.5-4.9-2.6-4.9 2.6.9-5.5-4-3.9 5.6-.8z" />
												</svg>
											</button>
											<span className="w-44 shrink-0 leading-tight">
												<span className="block truncate text-sm" title={t.lastFromAddr ?? undefined}>
													{t.lastFromName?.trim() || t.lastFromAddr || "（差出人不明）"}
												</span>
												{!selected && t.address && (
													<span
														className="flex items-center gap-1 truncate text-[10px] font-normal text-[var(--text-muted)]"
														title={t.address}
													>
														<span
															className="inline-block h-1.5 w-[9px] shrink-0 rounded-full"
															style={{ background: t.addressColor ?? "var(--text-muted)" }}
														/>
														<span className="truncate opacity-80">{t.address}</span>
													</span>
												)}
											</span>
											<span className="min-w-0 flex-1 truncate text-sm">
												{t.messageCount > 1 && (
													<span className="mr-1.5 text-xs text-[var(--text-muted)]">
														{t.messageCount}
													</span>
												)}
												{t.subject?.trim() || "（件名なし）"}
												{t.snippet?.trim() ? (
													<span className="ml-2 font-normal text-[var(--text-muted)]">
														— {t.snippet}
													</span>
												) : null}
											</span>
											{t.hasAttachments && (
												<svg
													className="h-4 w-4 shrink-0 text-[var(--text-muted)]"
													viewBox="0 0 24 24"
													fill="none"
													stroke="currentColor"
													strokeWidth="2"
													aria-label="添付あり"
												>
													<path d="M21.4 11.05 12.25 20.2a6 6 0 0 1-8.49-8.49l9.2-9.19a4 4 0 0 1 5.65 5.66l-9.2 9.19a2 2 0 0 1-2.82-2.83l8.49-8.48" />
												</svg>
											)}
											<span className="shrink-0 text-xs text-[var(--text-muted)]">
												{formatListDate(t.lastMessageAt)}
											</span>
										</Link>
									</li>
								);
							})}
						</ul>
						{nextCursor && (
							<div className="border-t border-[var(--line-soft)] p-3 text-center">
								<button
									onClick={() => void fetchThreads(nextCursor)}
									disabled={loadingMore}
									className="pill border border-[var(--line)] px-4 py-1.5 text-sm text-[var(--accent)] transition-colors hover:bg-[var(--surface-hover)] disabled:opacity-50"
								>
									{loadingMore ? "読み込み中…" : "もっと読む"}
								</button>
							</div>
						)}
					</>
				)}
			</section>
		</div>
	);
}
