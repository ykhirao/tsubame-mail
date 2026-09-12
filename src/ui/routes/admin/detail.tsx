import { useEffect, useState, type ReactNode } from "react";
import type { AuditLogEntry } from "@/shared/contracts/audit-logs";
import { api, ApiClientError, type Page } from "./api";
import { Card, CardHeader, EmptyState, ErrorBanner, formatDateTime, TableRow, tdCls, thCls } from "./components";

export function DetailList({ children }: { children: ReactNode }) {
	return <dl className="grid grid-cols-1 gap-x-6 gap-y-3 px-4 py-4 md:grid-cols-[10rem_1fr] md:px-6">{children}</dl>;
}

export function DetailItem({ label, children }: { label: string; children: ReactNode }) {
	return (
		<>
			<dt className="text-sm text-[var(--text-muted)]">{label}</dt>
			<dd className="min-w-0 break-words text-sm text-[var(--text)]">{children ?? "—"}</dd>
		</>
	);
}

type AuditFilter = { targetType?: string; targetId?: string; actorId?: string };

const AUDIT_PAGE = 50;

export function AuditLogCard({ title = "操作の記録", filter }: { title?: string; filter: AuditFilter }) {
	const [entries, setEntries] = useState<AuditLogEntry[] | null>(null);
	const [nextCursor, setNextCursor] = useState<string | null>(null);
	const [loadingMore, setLoadingMore] = useState(false);
	const [error, setError] = useState("");
	const query = new URLSearchParams(
		Object.entries(filter).filter((e): e is [string, string] => typeof e[1] === "string"),
	).toString();

	// 監査ログは 400 日残り、間引きも無い。活発な owner や自動化のエージェントでは
	// 万の単位になるので、全件を辿らず 1 ページずつ出す。
	const load = (cursor?: string) => {
		const url = `/api/v1/admin/audit-logs?${query}&limit=${AUDIT_PAGE}${
			cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
		}`;
		return api.get<Page<AuditLogEntry>>(url);
	};

	useEffect(() => {
		let alive = true;
		setEntries(null);
		setNextCursor(null);
		load()
			.then((page) => {
				if (!alive) return;
				setEntries(page.data);
				setNextCursor(page.next_cursor);
			})
			.catch((e) => alive && setError(e instanceof ApiClientError ? e.message : "操作の記録を読めませんでした"));
		return () => {
			alive = false;
		};
	}, [query]);

	const loadMore = async () => {
		if (!nextCursor) return;
		setLoadingMore(true);
		try {
			const page = await load(nextCursor);
			setEntries((prev) => [...(prev ?? []), ...page.data]);
			setNextCursor(page.next_cursor);
		} catch (e) {
			setError(e instanceof ApiClientError ? e.message : "操作の記録を読めませんでした");
		} finally {
			setLoadingMore(false);
		}
	};

	return (
		<Card className="mt-4">
			<CardHeader title={title} description="監査ログから、この対象に関わる操作を新しい順に出します" />
			<ErrorBanner message={error} />
			{entries === null ? (
				!error && <EmptyState message="読み込み中…" />
			) : entries.length === 0 ? (
				<EmptyState message="記録はありません。" />
			) : (
				<div className="overflow-x-auto">
					<table className="w-full min-w-[640px]">
						<thead>
							<tr className="border-b border-[var(--line)] bg-[var(--surface-sunken)]">
								<th className={thCls}>日時</th>
								<th className={thCls}>操作</th>
								<th className={thCls}>実行者</th>
								<th className={thCls}>内容</th>
							</tr>
						</thead>
						<tbody>
							{entries.map((e) => (
								<TableRow key={e.id}>
									<td className={`${tdCls} whitespace-nowrap`}>{formatDateTime(e.createdAt)}</td>
									<td className={`${tdCls} font-mono text-xs`}>{e.action}</td>
									<td className={`${tdCls} font-mono text-xs`}>{e.actorId ?? "—"}</td>
									<td className={`${tdCls} font-mono text-xs break-all`}>
										{e.meta == null ? "—" : JSON.stringify(e.meta)}
									</td>
								</TableRow>
							))}
						</tbody>
					</table>
					{nextCursor && (
						<div className="mt-3 text-center">
							<button
								type="button"
								onClick={() => void loadMore()}
								disabled={loadingMore}
								className="rounded-full px-4 py-1.5 text-sm text-[var(--accent)] hover:bg-[var(--surface-hover)] disabled:text-[var(--text-muted)]"
							>
								{loadingMore ? "読み込み中…" : "もっと読む"}
							</button>
						</div>
					)}
				</div>
			)}
		</Card>
	);
}
