import { useEffect, useState, type ReactNode } from "react";
import type { AuditLogEntry } from "@/shared/contracts/audit-logs";
import { ApiClientError, getAllPages } from "./api";
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

export function AuditLogCard({ title = "操作の記録", filter }: { title?: string; filter: AuditFilter }) {
	const [entries, setEntries] = useState<AuditLogEntry[] | null>(null);
	const [error, setError] = useState("");
	const query = new URLSearchParams(
		Object.entries(filter).filter((e): e is [string, string] => typeof e[1] === "string"),
	).toString();

	useEffect(() => {
		let alive = true;
		getAllPages<AuditLogEntry>(`/api/v1/admin/audit-logs?${query}`)
			.then((rows) => alive && setEntries(rows))
			.catch((e) => alive && setError(e instanceof ApiClientError ? e.message : "操作の記録を読めませんでした"));
		return () => {
			alive = false;
		};
	}, [query]);

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
				</div>
			)}
		</Card>
	);
}
