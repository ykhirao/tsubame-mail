import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import type { AdminAddress, AdminUser, AdminUserDetail, ApiKeySummary, Scope } from "./api";
import { api, ApiClientError, getAllPages } from "./api";
import { AdminGate } from "./gate";
import { DetailItem, DetailList, AuditLogCard } from "./detail";
import { GrantsModal } from "./UsersPage";
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
	type BadgeColor,
} from "./components";

const roleLabels: Record<AdminUser["role"], string> = {
	owner: "オーナー",
	member: "メンバー",
	agent: "AI エージェント",
};

function roleBadge(role: AdminUser["role"]): BadgeColor {
	switch (role) {
		case "owner":
			return "purple";
		case "member":
			return "blue";
		case "agent":
			return "yellow";
	}
}

function keyStatus(k: ApiKeySummary): { label: string; color: BadgeColor } {
	if (k.revokedAt != null) return { label: "失効", color: "red" };
	if (k.expiresAt != null && k.expiresAt * 1000 < Date.now()) return { label: "期限切れ", color: "yellow" };
	return { label: "有効", color: "green" };
}

export function UserDetailPage() {
	const { id } = useParams();
	const [user, setUser] = useState<AdminUserDetail | null>(null);
	const [addresses, setAddresses] = useState<AdminAddress[]>([]);
	const [keys, setKeys] = useState<ApiKeySummary[]>([]);
	const [error, setError] = useState("");
	const [grantOpen, setGrantOpen] = useState(false);
	const [loaded, setLoaded] = useState(false);

	useEffect(() => {
		let alive = true;
		if (!id) return;
		setLoaded(false);
		(async () => {
			try {
				const [detail, addrList, keyList] = await Promise.all([
					api.get<AdminUserDetail>(`/api/v1/admin/users/${id}`),
					getAllPages<AdminAddress>("/api/v1/admin/addresses"),
					getAllPages<ApiKeySummary>(`/api/v1/admin/api-keys?userId=${id}`),
				]);
				if (!alive) return;
				setUser(detail);
				setAddresses(addrList);
				setKeys(keyList);
			} catch (e) {
				if (alive) setError(e instanceof ApiClientError ? e.message : "ユーザー情報を読めませんでした");
			} finally {
				if (alive) setLoaded(true);
			}
		})();
		return () => {
			alive = false;
		};
	}, [id]);

	return (
		<AdminGate>
			<Page title="ユーザーの詳細">
				<ErrorBanner message={error} onDismiss={() => setError("")} />
				{loaded && !user && !error && <EmptyState message="読み込み中…" />}
				{loaded && user && (
					<>
						<div className="mb-4 flex flex-wrap items-start justify-between gap-3">
							<Link
								to="/admin/users"
								className="text-sm text-[var(--text-muted)] hover:text-[var(--text)] no-underline"
							>
								← ユーザー一覧に戻る
							</Link>
						</div>
						<Card>
							<CardHeader
								title={user.name}
								description={user.email}
								action={<Button variant="secondary" onClick={() => setGrantOpen(true)}>権限を編集</Button>}
							/>
							<DetailList>
								<DetailItem label="名前">{user.name}</DetailItem>
								<DetailItem label="メールアドレス">{user.email}</DetailItem>
								<DetailItem label="ロール"><Badge color={roleBadge(user.role)}>{roleLabels[user.role]}</Badge></DetailItem>
								<DetailItem label="状態">
									<Badge color={user.status === "active" ? "green" : "red"}>
										{user.status === "active" ? "有効" : "無効"}
									</Badge>
								</DetailItem>
								<DetailItem label="パスワード">{user.hasPassword ? "設定済み" : "未設定"}</DetailItem>
								<DetailItem label="最終ログイン">{formatDateTime(user.lastLoginAt)}</DetailItem>
								<DetailItem label="作成日時">{formatDateTime(user.createdAt)}</DetailItem>
							</DetailList>
						</Card>

						<Card className="mt-4">
							<CardHeader title="権限" description="このユーザーに割り当てた全アドレスと権限レベル" />
							<div className="overflow-x-auto">
								<table className="w-full min-w-[480px]">
									<thead>
										<tr className="border-b border-[var(--line)] bg-[var(--surface-sunken)]">
											<th className={thCls}>アドレス</th>
											<th className={thCls}>レベル</th>
										</tr>
									</thead>
									<tbody>
										{user.grants.length === 0 ? (
											<TableRow><td colSpan={2} className={`${tdCls} text-[var(--text-muted)]`}>割り当てられたアドレスはありません。</td></TableRow>
										) : user.grants.map((g) => (
											<TableRow key={g.addressId}>
												<td className={`${tdCls} font-medium text-[var(--text)]`}>{g.address ?? "—"}</td>
												<td className={tdCls}><Badge color={g.level === "write" ? "green" : "blue"}>{g.level}</Badge></td>
											</TableRow>
										))}
									</tbody>
								</table>
							</div>
						</Card>

						<Card className="mt-4">
							<CardHeader title="API キー" description="このユーザーが持つ API キー一覧" />
							{keys.length === 0 ? (
								<EmptyState message="このユーザーの API キーはありません。" />
							) : (
								<div className="overflow-x-auto">
									<table className="w-full min-w-[520px]">
										<thead>
											<tr className="border-b border-[var(--line)] bg-[var(--surface-sunken)]">
												<th className={thCls}>名前</th>
												<th className={thCls}>prefix</th>
												<th className={thCls}>スコープ</th>
												<th className={thCls}>状態</th>
											</tr>
										</thead>
										<tbody>
											{keys.map((k) => {
												const st = keyStatus(k);
												return (
													<TableRow key={k.id}>
														<td className={tdCls}>
															<Link
																to={`/admin/api-keys/${k.id}`}
																className="font-medium text-[var(--text)] hover:text-[var(--accent)] underline decoration-[var(--line)] underline-offset-2 hover:decoration-[var(--accent)]"
															>
																{k.name}
															</Link>
														</td>
														<td className={`${tdCls} font-mono text-xs text-[var(--text-muted)]`}>{k.prefix}…</td>
														<td className={tdCls}>
															<div className="flex flex-wrap gap-1">
																{k.scopes.map((s: Scope) => <Badge key={s} color="blue">{s}</Badge>)}
															</div>
														</td>
														<td className={tdCls}><Badge color={st.color}>{st.label}</Badge></td>
													</TableRow>
												);
											})}
										</tbody>
									</table>
								</div>
							)}
						</Card>

						<AuditLogCard title="このユーザーへの操作" filter={{ targetType: "user", targetId: id }} />
						<AuditLogCard title="このユーザーが行った操作" filter={{ actorId: id }} />
					</>
				)}

				{loaded && user && grantOpen && (
					<GrantsModal
						user={user}
						addresses={addresses}
						onClose={() => setGrantOpen(false)}
						onSaved={() => setGrantOpen(false)}
					/>
				)}
			</Page>
		</AdminGate>
	);
}
