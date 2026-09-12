import { useEffect, useRef, useState, useCallback } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import type { ThreadListItem } from "@/shared/contracts/messages";
import { MessagesApi, ThreadsApi, AddressesApi, useIncludeHidden } from "@/ui/lib/api";
import { EmptyState } from "@/ui/components/EmptyState";
import { Spinner } from "@/ui/components/Spinner";
import { CatchAllBadge } from "@/ui/components/mobile/CatchAllBadge";
import { SentMark } from "@/ui/components/SentMark";
import { useIsMobile } from "@/ui/lib/useIsMobile";
import { InstallBanner } from "@/ui/components/InstallBanner";
import {
	commitScrollTop,
	listKey,
	resetList,
	setList,
	useListState,
} from "@/ui/lib/listState";

const PAGE = 25;
const PULL_THRESHOLD = 60;

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

const SearchIcon = () => (
	<svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
		<circle cx="11" cy="11" r="7" />
		<path d="m20 20-3.5-3.5" />
	</svg>
);
const PencilIcon = () => (
	<svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
		<path d="M4 20h4L20 8l-4-4L4 16z" />
	</svg>
);

export function Inbox({ split = false }: { split?: boolean } = {}) {
	const navigate = useNavigate();
	const [searchParams] = useSearchParams();
	const selected = searchParams.get("address") ?? "";
	const view = searchParams.get("view") ?? "inbox";
	const isMobile = useIsMobile();
	const includeHidden = useIncludeHidden();
	const store = useListState();

	const query = { address: selected, view } as const;
	const queryKey = listKey(query);

	const [threads, setThreads] = useState<ThreadListItem[]>([]);
	const [nextCursor, setNextCursor] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [loadingMore, setLoadingMore] = useState(false);
	const [catchAllIds, setCatchAllIds] = useState<Set<string>>(new Set());
	const [pullDist, setPullDist] = useState(0);
	const [scrolled, setScrolled] = useState(false);
	const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
	const [bulkBusy, setBulkBusy] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const pullRef = useRef(0);
	const restoreRef = useRef(false);
	const restoreTargetRef = useRef(0);
	const idsRef = useRef<string[]>([]);
	const scrollerRef = useRef<HTMLElement | null>(null);

	// 未選択のときは絞らず、触れる全メールボックスを出す。切り替えは上部バーが持つ。

	const fetchThreads = useCallback(async (cursor?: string) => {
		const queryParams = {
			...(selected ? { address: selected } : {}),
			...(view !== "inbox" ? { view: view as "starred" | "sent" | "trash" } : {}),
			...(includeHidden && !selected ? { includeHidden: "true" as const } : {}),
		};
		if (cursor) {
			setLoadingMore(true);
			try {
				const res = await ThreadsApi.list({ ...queryParams, limit: PAGE, cursor });
				const ids = [...idsRef.current, ...res.data.map((t) => t.id)];
				setThreads((prev) => [...prev, ...res.data]);
				setNextCursor(res.next_cursor);
				setList(query, ids);
			} finally {
				setLoadingMore(false);
			}
			return;
		}

		if (!restoreRef.current) resetList(query);
		setLoading(true);
		setThreads([]);
		setNextCursor(null);
		try {
			// 復元時は保存した件数まで読み返す。1 ページ目だけ取って ids を
			// 上書きすると「もっと読む」で進んだ位置に戻れない。
			const all: ThreadListItem[] = [];
			let c: string | undefined;
			const target = restoreTargetRef.current;
			for (;;) {
				const res = await ThreadsApi.list({ ...queryParams, limit: PAGE, cursor: c });
				all.push(...res.data);
				setThreads([...all]);
				setNextCursor(res.next_cursor);
				if (!res.next_cursor || all.length >= target) break;
				c = res.next_cursor;
			}
			setList(query, all.map((t) => t.id));
		} finally {
			setLoading(false);
		}
	}, [selected, view, includeHidden]);

	useEffect(() => {
		idsRef.current = threads.map((t) => t.id);
	}, [threads]);

	useEffect(() => {
		const main = rootRef.current?.closest(".overflow-y-auto");
		scrollerRef.current = (main as HTMLElement | null) ?? null;
	}, []);

	// 一覧を開いたとき、同じ絞り込みの状態が残っていれば、会話から戻った扱いで
	// 位置を復元する。絞り込みが違えば白紙から取り直す。
	useEffect(() => {
		const restoring = store.loaded && listKey(store.query) === queryKey;
		restoreRef.current = restoring;
		restoreTargetRef.current = restoring ? store.ids.length : 0;
		void fetchThreads();
	}, [fetchThreads]);

	useEffect(() => {
		if (!restoreRef.current) return;
		if (!loading && threads.length > 0) {
			const s = scrollerRef.current;
			if (s && store.scrollTop > 0) s.scrollTop = store.scrollTop;
			restoreRef.current = false;
		}
	}, [loading, threads, store.scrollTop]);

	useEffect(() => {
		return () => {
			const s = scrollerRef.current;
			if (s) commitScrollTop(s.scrollTop);
		};
	}, []);

	/**
	 * スターはメッセージ側に付くので、スレッドの最新 1 件を代表として更新する。
	 * 画面は待たずに先に反転させ、失敗したら戻す。一覧の操作が重く感じないようにするため。
	 * 対象の id は一覧が持っている（会話の全文を取ると本文 200 件分が乗ってくる）。
	 */
	const toggleStar = async (t: ThreadListItem) => {
		if (!t.lastMessageId) return;
		const next = !t.isStarred;
		setThreads((prev) => prev.map((x) => (x.id === t.id ? { ...x, isStarred: next } : x)));
		try {
			await MessagesApi.patch(t.lastMessageId, { isStarred: next });
		} catch {
			setThreads((prev) => prev.map((x) => (x.id === t.id ? { ...x, isStarred: !next } : x)));
		}
	};

	const toggleSelect = (id: string) =>
		setSelectedIds((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	const selectBox = (t: ThreadListItem) => (
		<input
			type="checkbox"
			aria-label="選択"
			checked={selectedIds.has(t.id)}
			readOnly
			className="h-4 w-4 shrink-0 accent-[var(--accent)]"
			onClick={(e) => {
				e.preventDefault();
				e.stopPropagation();
				toggleSelect(t.id);
			}}
		/>
	);

	// 「既読にする」だけは会話の全メッセージを見る必要がある（未読の 1 通ずつに付ける）。
	// 残る 2 つは最新の 1 件を代表にするので、一覧が持つ id で足りる。
	const markAllRead = async (t: ThreadListItem) => {
		const detail = await ThreadsApi.get(t.id);
		for (const m of detail.messages) if (!m.isRead) await MessagesApi.patch(m.id, { isRead: true });
	};
	const markAllUnread = async (t: ThreadListItem) => {
		if (t.lastMessageId) await MessagesApi.patch(t.lastMessageId, { isRead: false });
	};
	const moveToTrash = async (t: ThreadListItem) => {
		if (t.lastMessageId) await MessagesApi.patch(t.lastMessageId, { status: "trash" });
	};

	const bulkApply = async (op: (t: ThreadListItem) => Promise<void>) => {
		setBulkBusy(true);
		try {
			const byId = new Map(threads.map((t) => [t.id, t]));
			for (const tid of selectedIds) {
				const t = byId.get(tid);
				if (!t) continue;
				try {
					await op(t);
				} catch {
					// 既にゴミ箱に移った等で消えたスレッドは飛ばす。
				}
			}
			await fetchThreads();
			setSelectedIds(new Set());
		} finally {
			setBulkBusy(false);
		}
	};

	useEffect(() => {
		let alive = true;
		AddressesApi.list()
			.then((res) =>
				alive && setCatchAllIds(new Set(res.data.filter((a) => a.isCatchAll).map((a) => a.id))),
			)
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, []);

	// 引っ張って再読み込みと、作成ボタンの畳み判定。スクロールコンテナは AppLayout の main。
	useEffect(() => {
		if (!isMobile) return;
		const el = rootRef.current;
		if (!el) return;
		const scroller = el.closest(".overflow-y-auto");
		if (!scroller) return;
		let startY = 0;
		let tracking = false;
		const onScroll = () => setScrolled(scroller.scrollTop > 24);
		const onStart = (e: TouchEvent) => {
			startY = e.touches[0]!.clientY;
			tracking = scroller.scrollTop <= 0 && !pullRef.current;
		};
		const onMove = (e: TouchEvent) => {
			if (!tracking) return;
			const dy = e.touches[0]!.clientY - startY;
			if (dy <= 0) {
				pullRef.current = 0;
				setPullDist(0);
				return;
			}
			pullRef.current = Math.min(dy * 0.5, 80);
			setPullDist(pullRef.current);
		};
		const onEnd = () => {
			if (pullRef.current >= PULL_THRESHOLD) void fetchThreads();
			pullRef.current = 0;
			setPullDist(0);
		};
		onScroll();
		scroller.addEventListener("scroll", onScroll, { passive: true });
		el.addEventListener("touchstart", onStart, { passive: true });
		el.addEventListener("touchmove", onMove, { passive: true });
		el.addEventListener("touchend", onEnd);
		el.addEventListener("touchcancel", onEnd);
		return () => {
			scroller.removeEventListener("scroll", onScroll);
			el.removeEventListener("touchstart", onStart);
			el.removeEventListener("touchmove", onMove);
			el.removeEventListener("touchend", onEnd);
			el.removeEventListener("touchcancel", onEnd);
		};
	}, [isMobile, fetchThreads]);

	const VIEW_TITLES: Record<string, string> = {
		inbox: "受信箱",
		starred: "スター付き",
		sent: "送信済み",
		trash: "ゴミ箱",
	};

	return (
		<div ref={rootRef} className="flex flex-1 flex-col">
			{isMobile && (
				<>
					<Link
						to="/search"
						className="mb-2 flex h-11 items-center gap-2 rounded-full bg-[var(--surface-hover)] px-4 text-sm text-[var(--text-muted)]"
					>
						<SearchIcon />
						メールを検索
					</Link>
					<div className="mb-2 empty:hidden">
						<InstallBanner />
					</div>
					{pullDist > 0 && (
						<p className="flex justify-center pb-1 text-xs text-[var(--text-muted)]">
							{pullDist >= PULL_THRESHOLD ? "手を離して更新" : "引っ張って更新"}
						</p>
					)}
				</>
			)}
			{!isMobile && selectedIds.size > 0 && (
				<div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2">
					<span className="text-sm text-[var(--text-muted)]">{selectedIds.size} 件を選択中</span>
					<button
						onClick={() => void bulkApply(markAllRead)}
						disabled={bulkBusy}
						className="pill border border-[var(--line)] px-3 py-1 text-sm text-[var(--accent)] transition-colors hover:bg-[var(--surface-hover)] disabled:opacity-50"
					>
						既読にする
					</button>
					<button
						onClick={() => void bulkApply(markAllUnread)}
						disabled={bulkBusy}
						className="pill border border-[var(--line)] px-3 py-1 text-sm text-[var(--accent)] transition-colors hover:bg-[var(--surface-hover)] disabled:opacity-50"
					>
						未読にする
					</button>
					<button
						onClick={() => void bulkApply(moveToTrash)}
						disabled={bulkBusy}
						className="pill border border-[var(--danger)]/40 px-3 py-1 text-sm text-[var(--danger)] transition-colors hover:bg-[var(--surface-hover)] disabled:opacity-50"
					>
						ゴミ箱へ
					</button>
					<button
						onClick={() => setSelectedIds(new Set())}
						disabled={bulkBusy}
						className="ml-auto text-sm text-[var(--text-muted)] transition-colors hover:text-[var(--text)] disabled:opacity-50"
					>
						選択を解除
					</button>
				</div>
			)}
			<section className="card overflow-hidden">
				{loading ? (
					<Spinner />
				) : threads.length === 0 ? (
					<EmptyState
						title={
							view === "inbox"
								? "メールがありません"
								: `${VIEW_TITLES[view] ?? "この一覧"}のメールがありません`
						}
					>
						{selected
							? "このメールボックスにはまだ届いていません"
							: "すべてのメールボックスを見ています"}
					</EmptyState>
				) : (
					<>
						<ul className="divide-y divide-[var(--line-soft)]">
							{threads.map((t) => {
								const unread = t.unreadCount > 0;
								const rowParams = new URLSearchParams();
								if (selected) rowParams.set("address", selected);
								if (view !== "inbox") rowParams.set("view", view);
								const rowUrl = `/threads/${t.id}${rowParams.toString() ? `?${rowParams}` : ""}`;
								if (isMobile) {
									return (
										<li key={t.id}>
											<Link
												to={rowUrl}
												className={`flex min-h-[72px] items-center gap-1 px-2 py-2 transition-colors hover:bg-[var(--surface-hover)] ${
													unread ? "bg-[var(--surface)] text-[var(--text)]" : "bg-[var(--surface-read)] text-[var(--text-muted)]"
												}`}
											>
												<button
													type="button"
													aria-label={t.isStarred ? "スターを外す" : "スターを付ける"}
													onClick={(e) => {
														e.preventDefault();
														e.stopPropagation();
														void toggleStar(t);
													}}
													className="-m-2 grid h-11 w-11 shrink-0 place-items-center"
												>
													<svg
														className="h-5 w-5"
														viewBox="0 0 24 24"
														fill={t.isStarred ? "var(--warning)" : "none"}
														stroke={t.isStarred ? "var(--warning)" : "currentColor"}
														strokeWidth="1.8"
														strokeLinejoin="round"
													>
														<path d="m12 4 2.4 5 5.6.8-4 3.9.9 5.5-4.9-2.6-4.9 2.6.9-5.5-4-3.9 5.6-.8z" />
													</svg>
												</button>
												<div className="min-w-0 flex-1">
													<div className="flex items-baseline justify-between gap-3">
														<span className="flex min-w-0 items-baseline gap-1.5">
															{t.lastDirection === "outbound" && <SentMark />}
															<span className={`min-w-0 truncate text-sm ${unread ? "font-bold" : ""}`}>
																{t.lastFromName?.trim() || t.lastFromAddr || "（差出人不明）"}
															</span>
														</span>
														<span className="shrink-0 text-xs opacity-70">
															{formatListDate(t.lastMessageAt)}
														</span>
													</div>
													{!selected && t.address && (
														<span className="mt-0.5 flex items-center gap-1 text-xs opacity-80">
															<span
																className="inline-block h-1.5 w-[9px] shrink-0 rounded-full"
																style={{ background: t.addressColor ?? "currentColor" }}
															/>
															<span className="truncate">{t.address}</span>
															{catchAllIds.has(t.addressId) && <CatchAllBadge />}
															{catchAllIds.has(t.addressId) && t.envelopeTo && (
																<span className="truncate">宛先 {t.envelopeTo}</span>
															)}
														</span>
													)}
													<div className="mt-0.5 truncate text-sm">
														{t.messageCount > 1 && (
															<span className="mr-1.5 text-xs opacity-70">{t.messageCount}</span>
														)}
														{t.subject?.trim() || "（件名なし）"}
														{t.snippet?.trim() ? (
															<span className="ml-2 opacity-70">— {t.snippet}</span>
														) : null}
													</div>
												</div>
											</Link>
										</li>
									);
								}
								if (split) {
									return (
										<li key={t.id}>
											<Link
												to={rowUrl}
												className={`flex min-h-11 items-center gap-2 px-3 py-1.5 transition-colors hover:bg-[var(--surface-hover)] ${
													unread
														? "bg-[var(--surface)] font-medium text-[var(--text)]"
														: "bg-[var(--surface-read)] text-[var(--text-muted)]"
												}`}
											>
												{selectBox(t)}
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
												<div className="min-w-0 flex-1">
													<div className="flex items-baseline justify-between gap-2">
														<span className="flex min-w-0 items-baseline gap-1.5">
															{t.lastDirection === "outbound" && <SentMark />}
															<span className={`min-w-0 truncate text-sm ${unread ? "font-medium" : ""}`}>
																{t.lastFromName?.trim() || t.lastFromAddr || "（差出人不明）"}
															</span>
														</span>
														<span className="shrink-0 text-xs opacity-70">
															{formatListDate(t.lastMessageAt)}
														</span>
													</div>
													<div className="truncate text-sm">
														{t.messageCount > 1 && (
															<span className="mr-1.5 text-xs opacity-70">{t.messageCount}</span>
														)}
														{t.subject?.trim() || "（件名なし）"}
														{t.snippet?.trim() ? (
															<span className="ml-2 opacity-70">— {t.snippet}</span>
														) : null}
													</div>
													{!selected && t.address && (
														<span
															className="flex items-center gap-1 truncate text-[10px] text-[var(--text-muted)]"
															title={t.address}
														>
															<span
																className="inline-block h-1.5 w-[9px] shrink-0 rounded-full"
																style={{ background: t.addressColor ?? "var(--text-muted)" }}
															/>
															<span className="truncate opacity-80">{t.address}</span>
															{catchAllIds.has(t.addressId) && <CatchAllBadge />}
														</span>
													)}
												</div>
											</Link>
										</li>
									);
								}
								return (
									<li key={t.id}>
										<Link
											to={rowUrl}
											className={`flex min-h-11 items-center gap-3 px-4 py-1.5 transition-colors hover:bg-[var(--surface-hover)] hover:shadow-sm ${
												unread
													? "bg-[var(--surface)] font-semibold text-[var(--text)]"
													: "bg-[var(--surface-read)] text-[var(--text-muted)]"
											}`}
										>
											{selectBox(t)}
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
												<span className="flex items-baseline gap-1.5">
													{t.lastDirection === "outbound" && <SentMark />}
													<span className="truncate text-sm" title={t.lastFromAddr ?? undefined}>
														{t.lastFromName?.trim() || t.lastFromAddr || "（差出人不明）"}
													</span>
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
														{catchAllIds.has(t.addressId) && <CatchAllBadge />}
														{catchAllIds.has(t.addressId) && t.envelopeTo && (
															<span className="truncate">宛先 {t.envelopeTo}</span>
														)}
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
			{isMobile && (
				<button
					type="button"
					onClick={() => navigate("/compose")}
					aria-label="作成"
					style={{ bottom: "calc(1.25rem + env(safe-area-inset-bottom))" }}
					className={`fixed right-4 z-30 flex h-14 items-center justify-center gap-2 rounded-full bg-[var(--accent)] text-sm font-medium text-white shadow-lg transition-all hover:opacity-90 ${
						scrolled ? "w-14" : "px-5"
					}`}
				>
					<PencilIcon />
					{!scrolled && <span>作成</span>}
				</button>
			)}
		</div>
	);
}
