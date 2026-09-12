import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import type { Webhook, WebhookDelivery } from "./api";
import { api, ApiClientError, getAllPages } from "./api";
import { AdminGate } from "./gate";
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
import { AuditLogCard, DetailItem, DetailList } from "./detail";
import { DeleteWebhookDialog, eventLabels, WebhookModal } from "./WebhooksPage";

function canRetry(d: WebhookDelivery): boolean {
	if (d.status === "failed") return true;
	if (d.status !== "pending") return false;
	const stuckBefore = Date.now() / 1000 - 1800;
	return (d.nextRetryAt ?? d.createdAt ?? Infinity) < stuckBefore;
}

export function WebhookDetailPage() {
	const { id } = useParams();
	const navigate = useNavigate();
	const [webhook, setWebhook] = useState<Webhook | null>(null);
	const [addresses, setAddresses] = useState<{ id: string; address: string }[]>([]);
	const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
	const [error, setError] = useState("");
	const [edit, setEdit] = useState(false);
	const [del, setDel] = useState(false);
	const [retrying, setRetrying] = useState<string | null>(null);

	const load = useCallback(async () => {
		if (!id) return;
		try {
			const [hook, addressList, dlvs] = await Promise.all([
				api.get<Webhook>(`/api/v1/webhooks/${id}`),
				getAllPages<{ id: string; address: string }>("/api/v1/admin/addresses"),
				getAllPages<WebhookDelivery>(`/api/v1/webhooks/${id}/deliveries`),
			]);
			setWebhook(hook);
			setAddresses(addressList);
			setDeliveries(dlvs);
		} catch (e) {
			setError(e instanceof ApiClientError ? e.message : "Webhook の読み込みに失敗しました");
		}
	}, [id]);

	useEffect(() => {
		load();
	}, [load]);

	const retry = async (d: WebhookDelivery) => {
		setRetrying(d.id);
		setError("");
		try {
			await api.post(`/api/v1/webhooks/deliveries/${d.id}/retry`);
			await load();
		} catch (e) {
			setError(e instanceof ApiClientError ? e.message : "再送に失敗しました");
		} finally {
			setRetrying(null);
		}
	};

	const addressNames = (addressIds: string[] | null): string => {
		if (!addressIds) return "全アドレス";
		return addressIds
			.map((aId) => addresses.find((a) => a.id === aId)?.address ?? aId)
			.join(", ");
	};

	return (
		<AdminGate>
			<Page title="Webhook の詳細">
				<ErrorBanner message={error} onDismiss={() => setError("")} />
				{!webhook ? (
					!error && <EmptyState message="読み込み中…" />
				) : (
					<>
						<Card>
							<CardHeader
								title={webhook.name}
								description="この Webhook の基本設定"
								action={
									<div className="flex gap-2">
										<Button variant="secondary" onClick={() => setEdit(true)}>
											編集
										</Button>
										<Button variant="danger" onClick={() => setDel(true)}>
											削除
										</Button>
									</div>
								}
							/>
							<DetailList>
								<DetailItem label="名前">{webhook.name}</DetailItem>
								<DetailItem label="URL">
									<span className="break-all font-mono text-xs">{webhook.url}</span>
								</DetailItem>
								<DetailItem label="イベント">
									<div className="flex flex-wrap gap-1">
										{webhook.events.map((e) => (
											<Badge key={e} color="blue">
												{eventLabels[e]}
											</Badge>
										))}
									</div>
								</DetailItem>
								<DetailItem label="対象アドレス">{addressNames(webhook.addressIds)}</DetailItem>
								<DetailItem label="有効">{webhook.enabled ? "有効" : "無効"}</DetailItem>
								<DetailItem label="作成日時">{formatDateTime(webhook.createdAt)}</DetailItem>
							</DetailList>
						</Card>

						<Card className="mt-4">
							<CardHeader title="配信履歴" description="この Webhook が送った / 送ろうとした POST の記録（全件）" />
							{deliveries.length === 0 ? (
								<EmptyState message="配信履歴はまだありません。" />
							) : (
								<div className="overflow-x-auto">
									<table className="w-full min-w-[720px]">
										<thead>
											<tr className="border-b border-[var(--line)] bg-[var(--surface-sunken)]">
												<th className={thCls}>日時</th>
												<th className={thCls}>イベント</th>
												<th className={thCls}>状態</th>
												<th className={thCls}>HTTP</th>
												<th className={thCls}>試行</th>
												<th className={thCls}></th>
											</tr>
										</thead>
										<tbody>
											{deliveries.map((d) => (
												<TableRow key={d.id}>
													<td className={tdCls}>{formatDateTime(d.createdAt)}</td>
													<td className={tdCls}>{eventLabels[d.event]}</td>
													<td className={tdCls}>
														<Badge
															color={
																d.status === "success"
																	? "green"
																	: d.status === "failed"
																		? "red"
																		: "yellow"
															}
														>
															{d.status}
														</Badge>
														{d.error && <div className="text-xs text-[var(--danger)]">{d.error}</div>}
													</td>
													<td className={tdCls}>{d.httpStatus ?? "—"}</td>
													<td className={tdCls}>{d.attempt}</td>
													<td className={tdCls}>
														{canRetry(d) && (
															<Button
																variant="secondary"
																disabled={retrying === d.id}
																onClick={() => retry(d)}
															>
																{retrying === d.id ? "再送中…" : "再送"}
															</Button>
														)}
													</td>
												</TableRow>
											))}
										</tbody>
									</table>
								</div>
							)}
						</Card>

						<AuditLogCard filter={{ targetType: "webhook", targetId: id }} />

						{edit && (
							<WebhookModal
								addresses={addresses}
								webhook={webhook}
								onClose={() => setEdit(false)}
								onUpdated={() => {
									setEdit(false);
									load();
								}}
							/>
						)}

						{del && (
							<DeleteWebhookDialog
								webhook={webhook}
								onClose={() => setDel(false)}
								onDeleted={() => navigate("/admin/webhooks")}
							/>
						)}
					</>
				)}
			</Page>
		</AdminGate>
	);
}
