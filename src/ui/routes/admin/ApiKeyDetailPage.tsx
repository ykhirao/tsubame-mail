import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import type { AdminAddress, AdminUser, ApiKeySummary } from "./api";
import { api, ApiClientError, getAllPages } from "./api";
import { useKeyActions } from "./ApiKeysPage";
import { AdminGate } from "./gate";
import { Badge, Button, Card, CardHeader, ErrorBanner, formatDateTime, Page } from "./components";
import { AuditLogCard, DetailItem, DetailList } from "./detail";

export function ApiKeyDetailPage() {
	const { id } = useParams();
	const [key, setKey] = useState<ApiKeySummary | null>(null);
	const [users, setUsers] = useState<AdminUser[]>([]);
	const [addresses, setAddresses] = useState<AdminAddress[]>([]);
	const [error, setError] = useState("");

	const load = useCallback(async () => {
		if (!id) return;
		setError("");
		try {
			const [k, userList, addressList] = await Promise.all([
				api.get<ApiKeySummary>(`/api/v1/admin/api-keys/${id}`),
				getAllPages<AdminUser>("/api/v1/admin/users"),
				getAllPages<AdminAddress>("/api/v1/admin/addresses"),
			]);
			setKey(k);
			setUsers(userList);
			setAddresses(addressList);
		} catch (e) {
			setKey(null);
			setError(e instanceof ApiClientError ? e.message : "キーの取得に失敗しました");
		}
	}, [id]);

	useEffect(() => {
		load();
	}, [load]);

	const actions = useKeyActions(load);

	if (!id) return null;

	const owner = users.find((u) => u.id === key?.userId);
	const addressNames =
		key?.addressIds === null
			? null
			: (key?.addressIds ?? []).map((aid) => addresses.find((a) => a.id === aid)?.address ?? aid);
	const revoked = key != null && key.revokedAt != null;
	const expired =
		key != null && !revoked && key.expiresAt != null && key.expiresAt * 1000 < Date.now();

	return (
		<AdminGate>
			<Page title={key ? key.name : "API キーの詳細"}>
				<ErrorBanner message={error || actions.error} onDismiss={() => { setError(""); actions.setError(""); }} />

				{key && (
					<Card>
						<CardHeader
							title={key.name}
							description={`${key.prefix}…`}
							action={
								<div className="flex flex-wrap gap-2">
									<Button onClick={() => actions.setRotateTarget(key)}>
										{revoked ? "再発行" : "差し替え"}
									</Button>
									{!revoked && (
										<Button variant="danger" onClick={() => actions.setRevokeTarget(key)}>
											失効
										</Button>
									)}
								</div>
							}
						/>
						<DetailList>
							<DetailItem label="所有ユーザー">
								{owner ? (
									<Link to={`/admin/users/${owner.id}`} className="text-[var(--accent-text)] hover:underline">
										{owner.name}（{owner.email}）
									</Link>
								) : (
									key.userId
								)}
							</DetailItem>
							<DetailItem label="スコープ">
								<div className="flex flex-wrap gap-1">
									{key.scopes.map((s) => (
										<Badge key={s} color="blue">
											{s}
										</Badge>
									))}
								</div>
							</DetailItem>
							<DetailItem label="対象メールボックス">
								{addressNames === null ? (
									"制限なし（ユーザーの権限に従う）"
								) : addressNames.length > 0 ? (
									<ul className="space-y-0.5">
										{addressNames.map((name) => (
											<li key={name}>{name}</li>
										))}
									</ul>
								) : (
									"なし（どのメールボックスにも届かない）"
								)}
							</DetailItem>
							<DetailItem label="有効期限">{key.expiresAt ? formatDateTime(key.expiresAt) : "無期限"}</DetailItem>
							<DetailItem label="最終使用">{formatDateTime(key.lastUsedAt)}</DetailItem>
							<DetailItem label="作成">{formatDateTime(key.createdAt)}</DetailItem>
							<DetailItem label="失効日時">{formatDateTime(key.revokedAt)}</DetailItem>
							<DetailItem label="状態">
								{revoked ? (
									<Badge color="red">失効</Badge>
								) : expired ? (
									<Badge color="yellow">期限切れ</Badge>
								) : (
									<Badge color="green">有効</Badge>
								)}
							</DetailItem>
						</DetailList>
					</Card>
				)}

				{key && <AuditLogCard filter={{ targetType: "api_key", targetId: key.id }} />}
				{actions.dialogs}
			</Page>
		</AdminGate>
	);
}
