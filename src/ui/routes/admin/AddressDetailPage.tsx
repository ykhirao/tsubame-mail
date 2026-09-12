import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { AdminAddress, AddressViewer, Rule } from "./api";
import { api, ApiClientError, getAllPages } from "./api";
import { AdminGate } from "./gate";
import { AuditLogCard, DetailItem, DetailList } from "./detail";
import { DeleteAddressModal, EditAddressModal } from "./AddressesPage";
import { actionColor, MatcherText } from "./RulesPage";
import {
	Badge,
	Button,
	Card,
	CardHeader,
	EmptyState,
	ErrorBanner,
	formatDateTime,
	Page,
	TableRow,
	tdCls,
	thCls,
} from "./components";

export function AddressDetailPage() {
	const { id } = useParams();
	const navigate = useNavigate();
	const [address, setAddress] = useState<AdminAddress | null>(null);
	const [viewers, setViewers] = useState<AddressViewer[]>([]);
	const [allAddresses, setAllAddresses] = useState<AdminAddress[]>([]);
	const [rules, setRules] = useState<Rule[]>([]);
	const [error, setError] = useState("");
	const [editTarget, setEditTarget] = useState<AdminAddress | null>(null);
	const [deleteTarget, setDeleteTarget] = useState<AdminAddress | null>(null);

	const load = useCallback(async () => {
		if (!id) return;
		setError("");
		try {
			const [addrRes, viewersRes, addressList, ruleList] = await Promise.all([
				api.get<{ data: AdminAddress }>(`/api/v1/admin/addresses/${id}`),
				api.get<{ data: AddressViewer[] }>(`/api/v1/admin/addresses/${id}/viewers`),
				getAllPages<AdminAddress>("/api/v1/admin/addresses"),
				getAllPages<Rule>("/api/v1/admin/rules"),
			]);
			setAddress(addrRes.data);
			setViewers(viewersRes.data);
			setAllAddresses(addressList);
			setRules(ruleList.filter((r) => r.addressId === id));
		} catch (e) {
			setError(e instanceof ApiClientError ? e.message : "アドレスの詳細を読めませんでした");
		}
	}, [id]);

	useEffect(() => {
		load();
	}, [load]);

	return (
		<AdminGate>
			<Page title="アドレスの詳細">
				<ErrorBanner message={error} onDismiss={() => setError("")} />
				{address && (
					<>
						<div className="mb-4 flex flex-wrap gap-2">
							<Button onClick={() => setEditTarget(address)}>編集</Button>
							<Button variant="danger" onClick={() => setDeleteTarget(address)}>
								削除
							</Button>
						</div>
						<Card>
							<CardHeader title="基本情報" />
							<DetailList>
								<DetailItem label="アドレス">{address.address}</DetailItem>
								<DetailItem label="表示名">{address.displayName}</DetailItem>
								<DetailItem label="種別">
									<Badge color={address.kind === "alias" ? "purple" : "green"}>
										{address.kind === "alias" ? "エイリアス" : "メールボックス"}
									</Badge>
								</DetailItem>
								<DetailItem label="エイリアス先">
									{address.aliasTargetId ? (
										<Link
											to={`/admin/addresses/${address.aliasTargetId}`}
											className="text-[var(--accent)] hover:underline"
										>
											{address.aliasTargetAddress ?? address.aliasTargetId}
										</Link>
									) : (
										"—"
									)}
								</DetailItem>
								<DetailItem label="キャッチオール">
									{address.isCatchAll ? <Badge color="yellow">キャッチオール</Badge> : "—"}
								</DetailItem>
								<DetailItem label="色">
									<span className="inline-flex items-center gap-2">
										<span
											className="h-5 w-5 rounded-full border border-[var(--line)]"
											style={{ background: address.color ?? "#cccccc" }}
										/>
										<span className="font-mono text-xs">{address.color ?? "—"}</span>
									</span>
								</DetailItem>
								<DetailItem label="署名">
									{address.signature ? (
										<pre className="whitespace-pre-wrap rounded-md bg-[var(--surface-sunken)] px-3 py-2 font-mono text-xs">
											{address.signature}
										</pre>
									) : (
										"—"
									)}
								</DetailItem>
								<DetailItem label="アーカイブ日時">{formatDateTime(address.archivedAt)}</DetailItem>
								<DetailItem label="作成日時">{formatDateTime(address.createdAt)}</DetailItem>
							</DetailList>
						</Card>
						<Card className="mt-4">
							<CardHeader
								title="見られる人"
								description="所有者は全アドレスを、それ以外は割り当て（read / write）に従います"
							/>
							{viewers.length === 0 ? (
								<EmptyState message="割り当てられた利用者はいません。誰の受信箱にも出ません（管理者モードでだけ読めます）。" />
							) : (
								<div className="overflow-x-auto">
									<table className="w-full min-w-[420px]">
										<thead>
											<tr className="border-b border-[var(--line)] bg-[var(--surface-sunken)]">
												<th className={thCls}>名前</th>
												<th className={thCls}>メール</th>
												<th className={thCls}>権限</th>
											</tr>
										</thead>
										<tbody>
											{viewers.map((v) => (
												<TableRow key={v.userId}>
													<td className={tdCls}>
														<Link
															to={`/admin/users/${v.userId}`}
															className="font-medium text-[var(--accent)] hover:underline"
														>
															{v.name}
														</Link>
													</td>
													<td className={tdCls}>{v.email}</td>
													<td className={tdCls}>
														{v.isPrimary && (
															<span className="mr-1"><Badge color="purple">プライマリ</Badge></span>
														)}
														<Badge color={v.level === "write" ? "green" : "gray"}>
															{v.level === "write" ? "書き込み可" : "読み取り可"}
														</Badge>
													</td>
												</TableRow>
											))}
										</tbody>
									</table>
								</div>
							)}
						</Card>
						<Card className="mt-4">
							<CardHeader
								title="効くルーティングルール"
								description="このアドレスを対象にしたルール（アドレススコープ）"
							/>
							{rules.length === 0 ? (
								<EmptyState message="このアドレスに効くルールはありません。" />
							) : (
								<div className="overflow-x-auto">
									<table className="w-full min-w-[560px]">
										<thead>
											<tr className="border-b border-[var(--line)] bg-[var(--surface-sunken)]">
												<th className={thCls}>名前</th>
												<th className={thCls}>アクション</th>
												<th className={thCls}>条件</th>
												<th className={thCls}>優先度</th>
												<th className={thCls}>状態</th>
											</tr>
										</thead>
										<tbody>
											{rules.map((r) => (
												<TableRow key={r.id}>
													<td className={tdCls}>
														<Link
															to={`/admin/rules/${r.id}`}
															className="font-medium text-[var(--accent)] hover:underline"
														>
															{r.name}
														</Link>
													</td>
													<td className={tdCls}>
														<Badge color={actionColor(r.action)}>{r.action}</Badge>
													</td>
													<td className={`${tdCls} break-all`}>
														<MatcherText matcher={r.matcher} />
													</td>
													<td className={tdCls}>{r.priority}</td>
													<td className={tdCls}>
														<Badge color={r.enabled ? "green" : "gray"}>
															{r.enabled ? "有効" : "無効"}
														</Badge>
													</td>
												</TableRow>
											))}
										</tbody>
									</table>
								</div>
							)}
						</Card>
						<AuditLogCard filter={{ targetType: "address", targetId: id }} />
					</>
				)}
				{address && editTarget && (
					<EditAddressModal
						address={editTarget}
						existing={allAddresses}
						onClose={() => setEditTarget(null)}
						onSaved={() => {
							setEditTarget(null);
							load();
						}}
					/>
				)}
				{deleteTarget && (
					<DeleteAddressModal
						address={deleteTarget}
						onClose={() => setDeleteTarget(null)}
						onDeleted={(note) => navigate("/admin/addresses", { state: { note } })}
					/>
				)}
			</Page>
		</AdminGate>
	);
}
