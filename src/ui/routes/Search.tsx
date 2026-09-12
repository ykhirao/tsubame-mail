import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import type { MessageListItem } from "@/shared/contracts/messages";
import { MessagesApi } from "@/ui/lib/api";
import { EmptyState } from "@/ui/components/EmptyState";
import { Spinner } from "@/ui/components/Spinner";
import { formatDate } from "@/ui/lib/format";
import { useIsMobile } from "@/ui/lib/useIsMobile";

const PAGE = 25;

const OPERATORS = ["from:", "subject:", "since:2026-01-01", "is:unread", "has:attachment"];

export function Search() {
	const isMobile = useIsMobile();
	const [params, setParams] = useSearchParams();
	const q = params.get("q") ?? "";
	const hasQuery = params.get("q") != null;

	const [draft, setDraft] = useState(q);
	const [results, setResults] = useState<MessageListItem[]>([]);
	const [nextCursor, setNextCursor] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [loadingMore, setLoadingMore] = useState(false);

	const run = useCallback(
		async (cursor?: string) => {
			const term = params.get("q") ?? "";
			if (cursor) {
				setLoadingMore(true);
			} else {
				setLoading(true);
				setError(null);
				setResults([]);
				setNextCursor(null);
			}
			try {
				const res = await MessagesApi.list({ q: term || undefined, limit: PAGE, cursor });
				if (cursor) {
					setResults((prev) => [...prev, ...res.data]);
					setNextCursor(res.next_cursor);
				} else {
					setResults(res.data);
					setNextCursor(res.next_cursor);
				}
			} catch (err) {
				setError(err instanceof Error ? err.message : "検索に失敗しました");
			} finally {
				setLoading(false);
				setLoadingMore(false);
			}
		},
		[params],
	);

	useEffect(() => {
		if (!hasQuery) return;
		void run();
	}, [run, hasQuery]);

	const submit = (e: FormEvent) => {
		e.preventDefault();
		setDraft(draft.trim());
		setParams({ q: draft.trim() });
	};

	const insertOperator = (op: string) => {
		setDraft((prev) => (prev ? `${prev} ${op}` : op));
	};

	return (
		<div className="flex flex-col gap-4 safe-bottom">
			<form
				onSubmit={submit}
				className="sticky top-0 z-10 -mx-2 flex gap-2 bg-[var(--surface-sunken)] p-2"
			>
				<input
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					placeholder="検索キーワードを入力（例: from:foo@example.com subject:「見積」）"
					className="w-full rounded-full border border-[var(--line)] bg-[var(--surface)] px-4 py-2 text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
				/>
				<button
					type="submit"
					className="shrink-0 rounded-full bg-[var(--accent)] px-5 py-2 text-sm font-medium text-white hover:opacity-90"
				>
					検索
				</button>
			</form>

			<div className="flex flex-wrap items-center gap-1.5">
				{OPERATORS.map((op) => (
					<button
						key={op}
						type="button"
						onClick={() => insertOperator(op)}
						className="rounded-full border border-[var(--line)] bg-[var(--surface)] px-2.5 py-1 text-xs text-[var(--accent)] hover:bg-[var(--surface-hover)]"
					>
						{op}
					</button>
				))}
			</div>

			<p className="text-xs text-[var(--text-muted)]">
				3 文字以上は全文検索、1〜2 文字は部分一致で動きます。
			</p>

			{error && (
				<div className="rounded border border-[var(--danger)] bg-[var(--surface-hover)] px-3 py-2 text-sm text-[var(--danger)]">
					{error}
				</div>
			)}

			{loading ? (
				<Spinner />
			) : !hasQuery ? (
				<EmptyState icon="🔎" title="検索キーワードを入力してください">
					件名・本文・送信者・宛先を日本語部分一致で検索できます。
				</EmptyState>
			) : results.length === 0 ? (
				<EmptyState title="該当するメールがありません">条件を変えて再検索してください。</EmptyState>
			) : (
				<>
					<ul className="card divide-y divide-[var(--line-soft)] overflow-hidden">
						{results.map((m) =>
							isMobile ? (
								<li key={m.id}>
									<Link
										to={m.threadId ? `/threads/${m.threadId}` : "#"}
										onClick={(e) => {
											if (!m.threadId) e.preventDefault();
										}}
										className={`flex min-h-[72px] items-center gap-1 px-2 py-2 ${
											m.isRead ? "row-read" : "row-unread"
										}`}
									>
										<span className="min-w-0 flex-1">
											<div className="flex items-baseline justify-between gap-3">
												<span className={`min-w-0 truncate text-sm ${m.isRead ? "" : "font-bold"}`}>
													{m.fromName?.trim() || m.fromAddr || "（差出人不明）"}
												</span>
												<span className="shrink-0 text-xs opacity-70">
													{formatDate(m.receivedAt)}
												</span>
											</div>
											<div className="mt-0.5 truncate text-sm">
												{m.subject?.trim() || "（件名なし）"}
												{m.snippet?.trim() ? <span className="ml-2 opacity-70">— {m.snippet}</span> : null}
											</div>
											{m.hasAttachments && (
												<span className="mt-0.5 block truncate text-xs opacity-70">📎 添付あり</span>
											)}
										</span>
									</Link>
								</li>
							) : (
								<li key={m.id}>
									<Link
										to={m.threadId ? `/threads/${m.threadId}` : "#"}
										onClick={(e) => {
											if (!m.threadId) e.preventDefault();
										}}
										className={`flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--surface-hover)] ${
											m.isRead ? "row-read" : "row-unread"
										}`}
									>
										<span className="min-w-0 flex-1">
											<span className="block truncate text-sm">
												{m.subject?.trim() || "（件名なし）"}
											</span>
											<span className="mt-0.5 block truncate text-xs text-[var(--text-muted)]">
												{m.fromName || m.fromAddr}
												{m.hasAttachments ? "  📎" : ""}
											</span>
										</span>
										<span className="shrink-0 text-right text-xs text-[var(--text-muted)]">
											{formatDate(m.receivedAt)}
										</span>
									</Link>
								</li>
							),
						)}
					</ul>
					{nextCursor && (
						<div className="text-center">
							<button
								onClick={() => void run(nextCursor)}
								disabled={loadingMore}
								className="rounded-full px-4 py-1.5 text-sm text-[var(--accent)] hover:bg-[var(--surface-hover)] disabled:text-[var(--text-muted)]"
							>
								{loadingMore ? "読み込み中…" : "もっと読む"}
							</button>
						</div>
					)}
				</>
			)}
		</div>
	);
}
