import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { DnsCheckResult, DomainDetail, DomainSummary } from "./api";
import { api, ApiClientError } from "./api";
import { AdminGate } from "./gate";
import { DetailItem, DetailList, AuditLogCard } from "./detail";
import { CatchAllModal, DeleteDomainModal } from "./DomainsPage";
import {
	Badge,
	Button,
	Card,
	CardHeader,
	EmptyState,
	ErrorBanner,
	formatDateTime,
	Notice,
	Page,
	TableRow,
	tdCls,
	thCls,
	type BadgeColor,
} from "./components";

function statusBadge(status: string): BadgeColor {
	switch (status) {
		case "active":
			return "green";
		case "error":
			return "red";
		case "disabled":
			return "gray";
		default:
			return "yellow";
	}
}

type MxRow = { name: string; content: string; priority?: number; provider: string };

function DnsCheckTable({ result }: { result: DnsCheckResult }) {
	return (
		<Card className="mt-4">
			<CardHeader title="再検査の結果" description="DNS の警告と MX / SPF / DMARC の確認結果" />
			<div className="space-y-4 px-5 py-4">
				{result.warnings.length === 0 ? (
					<p className="text-sm text-[var(--text-muted)]">警告はありません。</p>
				) : (
					<div className="space-y-2">
						{result.warnings.map((w, i) => (
							<Notice key={i} tone={w.level === "danger" ? "danger" : w.level === "warn" ? "warn" : "info"}>
								[{w.code}] {w.message}
							</Notice>
						))}
					</div>
				)}

				<div>
					<h4 className="mb-1 text-xs font-semibold text-[var(--text-muted)]">MX</h4>
					{result.mx.length === 0 ? (
						<p className="text-sm text-[var(--text-muted)]">MX レコードはありません。</p>
					) : (
						<table className="w-full text-sm">
							<tbody>
								{(result.mx as MxRow[]).map((m, i) => (
									<tr key={i} className="border-b border-[var(--line-soft)] last:border-0">
										<td className={`${tdCls} font-mono`}>{m.name}</td>
										<td className={`${tdCls} font-mono`}>{m.content}</td>
										<td className={`${tdCls} text-[var(--text-muted)]`}>{m.priority ?? ""}</td>
										<td className={`${tdCls} text-[var(--text-muted)]`}>{m.provider}</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
				</div>

				<div>
					<h4 className="mb-1 text-xs font-semibold text-[var(--text-muted)]">SPF</h4>
					<p className="text-sm">{result.spf ? <code className="break-all text-[var(--text)]">{result.spf.name} → {result.spf.content}</code> : <span className="text-[var(--text-muted)]">未設定</span>}</p>
				</div>

				<div>
					<h4 className="mb-1 text-xs font-semibold text-[var(--text-muted)]">DMARC</h4>
					<p className="text-sm">{result.dmarc ? <code className="break-all text-[var(--text)]">{result.dmarc.name} → {result.dmarc.content}</code> : <span className="text-[var(--text-muted)]">未設定</span>}</p>
				</div>
			</div>
		</Card>
	);
}

export function DomainDetailPage() {
	const { id } = useParams();
	const navigate = useNavigate();
	const [domain, setDomain] = useState<DomainDetail | null>(null);
	const [verify, setVerify] = useState<DnsCheckResult | null>(null);
	const [error, setError] = useState("");
	const [loaded, setLoaded] = useState(false);
	const [verifyBusy, setVerifyBusy] = useState(false);
	const [sendingBusy, setSendingBusy] = useState(false);
	const [catchAllOpen, setCatchAllOpen] = useState(false);
	const [deleteOpen, setDeleteOpen] = useState(false);

	const load = useCallback(async () => {
		if (!id) return;
		try {
			const res = await api.get<{ data: DomainDetail }>(`/api/v1/admin/domains/${id}`);
			setDomain(res.data);
		} catch (e) {
			setError(e instanceof ApiClientError ? e.message : "ドメイン情報を読めませんでした");
		} finally {
			setLoaded(true);
		}
	}, [id]);

	useEffect(() => {
		if (!id) return;
		setLoaded(false);
		load();
	}, [id, load]);

	const runVerify = async () => {
		if (!domain) return;
		setError("");
		setVerifyBusy(true);
		setVerify(null);
		try {
			const res = await api.post<{ data: { dnsCheck: DnsCheckResult } }>(`/api/v1/admin/domains/${domain.id}/verify`);
			setVerify(res.data.dnsCheck);
			await load();
		} catch (e) {
			setError(e instanceof ApiClientError ? e.message : "再検査に失敗しました");
		} finally {
			setVerifyBusy(false);
		}
	};

	const toggleSending = async () => {
		if (!domain) return;
		setError("");
		setSendingBusy(true);
		try {
			await api.post(`/api/v1/admin/domains/${domain.id}/sending`, {
				enabled: domain.sendingStatus === "disabled",
			});
			await load();
		} catch (e) {
			setError(e instanceof ApiClientError ? e.message : "Email Sending の切り替えに失敗しました");
		} finally {
			setSendingBusy(false);
		}
	};

	return (
		<AdminGate>
			<Page title="ドメインの詳細">
				<ErrorBanner message={error} onDismiss={() => setError("")} />
				{loaded && !domain && !error && <EmptyState message="読み込み中…" />}
				{loaded && domain && (
					<>
						<div className="mb-4">
							<Link to="/admin/domains" className="text-sm text-[var(--text-muted)] hover:text-[var(--text)] no-underline">
								← ドメイン一覧に戻る
							</Link>
						</div>
						<Card>
							<CardHeader
								title={domain.name}
								description={domain.zoneName}
								action={
									<div className="flex flex-wrap gap-2">
										<Button variant="secondary" onClick={runVerify} disabled={verifyBusy}>
											{verifyBusy ? "検査中…" : "再検査"}
										</Button>
										<Button variant="secondary" onClick={() => setCatchAllOpen(true)}>
											{domain.catchAllEnabled ? "catch-all を無効化" : "catch-all を有効化"}
										</Button>
										<Button variant="danger" onClick={() => setDeleteOpen(true)}>
											切断
										</Button>
									</div>
								}
							/>
							<DetailList>
								<DetailItem label="ドメイン">{domain.name}</DetailItem>
								<DetailItem label="ゾーン名">{domain.zoneName}</DetailItem>
								<DetailItem label="ゾーン ID"><code className="break-all">{domain.zoneId}</code></DetailItem>
								<DetailItem label="モード">
									<Badge color={domain.mode === "apex" ? "purple" : "blue"}>
										{domain.mode === "apex" ? "apex" : "サブドメイン"}
									</Badge>
								</DetailItem>
								<DetailItem label="受信（Email Routing）">
									<Badge color={statusBadge(domain.routingStatus)}>{domain.routingStatus}</Badge>
								</DetailItem>
								<DetailItem label="送信（Email Sending）">
									<div className="flex items-center gap-2">
										<Badge color={statusBadge(domain.sendingStatus)}>{domain.sendingStatus}</Badge>
										<Button variant="ghost" onClick={toggleSending} disabled={sendingBusy}>
											{domain.sendingStatus === "disabled" ? "有効にする" : "無効にする"}
										</Button>
									</div>
								</DetailItem>
								<DetailItem label="catch-all">
									{domain.catchAllEnabled ? <Badge color="green">有効</Badge> : <Badge color="gray">無効</Badge>}
								</DetailItem>
								<DetailItem label="lastError">{domain.lastError}</DetailItem>
								<DetailItem label="接続日時">{formatDateTime(domain.createdAt)}</DetailItem>
							</DetailList>
						</Card>

						{verify && <DnsCheckTable result={verify} />}

						<Card className="mt-4">
							<CardHeader title="配下のアドレス" description="このドメインのメールボックスとエイリアス" />
							{domain.addresses.length === 0 ? (
								<EmptyState message="このドメインにはアドレスがありません。" />
							) : (
								<div className="overflow-x-auto">
									<table className="w-full min-w-[480px]">
										<thead>
											<tr className="border-b border-[var(--line)] bg-[var(--surface-sunken)]">
												<th className={thCls}>アドレス</th>
												<th className={thCls}>種別</th>
												<th className={thCls}>catch-all</th>
											</tr>
										</thead>
										<tbody>
											{domain.addresses.map((a) => (
												<TableRow key={a.id}>
													<td className={tdCls}>
														<Link
															to={`/admin/addresses/${a.id}`}
															className="font-medium text-[var(--text)] hover:text-[var(--accent)] underline decoration-[var(--line)] underline-offset-2 hover:decoration-[var(--accent)]"
														>
															{a.address}
														</Link>
													</td>
													<td className={tdCls}>{a.kind === "alias" ? "エイリアス" : "メールボックス"}</td>
													<td className={tdCls}>{a.isCatchAll ? <Badge color="green">有効</Badge> : "—"}</td>
												</TableRow>
											))}
										</tbody>
									</table>
								</div>
							)}
						</Card>

						<AuditLogCard title="操作の記録" filter={{ targetType: "domain", targetId: id }} />
					</>
				)}

				{loaded && domain && catchAllOpen && (
					<CatchAllModal
						domain={domain as DomainSummary}
						onClose={() => setCatchAllOpen(false)}
						onDone={() => {
							setCatchAllOpen(false);
							load();
						}}
					/>
				)}

				{loaded && domain && deleteOpen && (
					<DeleteDomainModal
						domain={domain as DomainSummary}
						onClose={() => setDeleteOpen(false)}
						onDone={() => navigate("/admin/domains")}
					/>
				)}
			</Page>
		</AdminGate>
	);
}
