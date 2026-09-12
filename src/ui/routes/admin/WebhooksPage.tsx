import { useCallback, useEffect, useState } from "react";
import type { Webhook, WebhookCreate, WebhookDelivery, WebhookEvent } from "./api";
import { api, ApiClientError, getAllPages } from "./api";
import { AdminGate } from "./gate";
import {
	Badge,
	Button,
	Card,
	CardHeader,
	Checkbox,
	EmptyState,
	ErrorBanner,
	formatDateTime,
	Label,
	MobileActions,
	MobileField,
	Modal,
	Notice,
	Page,
	Select,
	TableRow,
	tdCls,
	TextInput,
	thCls,
	WarningBlock,
} from "./components";

const eventLabels: Record<WebhookEvent, string> = {
	"message.received": "新着受信",
	"message.sent": "送信完了",
	"message.failed": "送信失敗",
};

// 作成と編集で入力項目が同じなので 1 つにしてある。secret は作成時しか返らない。
function WebhookModal({
	addresses,
	webhook,
	onClose,
	onCreated,
	onUpdated,
}: {
	addresses: { id: string; address: string }[];
	webhook?: Webhook;
	onClose: () => void;
	onCreated?: (w: WebhookCreate) => void;
	onUpdated?: () => void;
}) {
	const [name, setName] = useState(webhook?.name ?? "");
	const [url, setUrl] = useState(webhook?.url ?? "");
	const [events, setEvents] = useState<WebhookEvent[]>(webhook?.events ?? []);
	const [addressMode, setAddressMode] = useState<"all" | "specific">(
		webhook?.addressIds ? "specific" : "all",
	);
	const [selected, setSelected] = useState<string[]>(webhook?.addressIds ?? []);
	const [enabled, setEnabled] = useState(webhook?.enabled ?? true);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	const toggleEvent = (e: WebhookEvent) => {
		setEvents((prev) => (prev.includes(e) ? prev.filter((x) => x !== e) : [...prev, e]));
	};

	const toggleAddr = (id: string) => {
		setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
	};

	const save = async () => {
		setError("");
		setBusy(true);
		try {
			const body = {
				name,
				url,
				events,
				addressIds: addressMode === "specific" ? selected : null,
				enabled,
			};
			if (webhook) {
				await api.patch(`/api/v1/webhooks/${webhook.id}`, body);
				onUpdated?.();
			} else {
				onCreated?.(await api.post<WebhookCreate>("/api/v1/webhooks", body));
			}
		} catch (e) {
			setError(
				e instanceof ApiClientError
					? e.message
					: webhook
						? "Webhook の更新に失敗しました"
						: "Webhook の作成に失敗しました",
			);
		} finally {
			setBusy(false);
		}
	};

	const valid = name && url && events.length > 0;

	return (
		<Modal title={webhook ? "Webhook を編集" : "Webhook を作成"} onClose={onClose}>
			<ErrorBanner message={error} onDismiss={() => setError("")} />
			<div className="space-y-4">
				<div>
					<Label>名前</Label>
					<TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="新着通知" />
				</div>
				<div>
					<Label>配送先 URL</Label>
					<TextInput value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/hook" />
				</div>
				<div>
					<Label>イベント</Label>
					<div className="flex flex-wrap gap-4">
						{(Object.keys(eventLabels) as WebhookEvent[]).map((e) => (
							<label key={e} className="flex items-center gap-2 text-sm text-[var(--text)]">
								<Checkbox checked={events.includes(e)} onChange={() => toggleEvent(e)} />
								{eventLabels[e]}
							</label>
						))}
					</div>
				</div>
				<div>
					<Label>対象アドレス</Label>
					<div className="space-y-2">
						<label className="flex items-center gap-2 text-sm text-[var(--text)]">
							<input
								type="radio"
								name="addrMode"
								checked={addressMode === "all"}
								onChange={() => setAddressMode("all")}
								className="size-4 text-[var(--accent)]"
							/>
							全アドレス
						</label>
						<label className="flex items-center gap-2 text-sm text-[var(--text)]">
							<input
								type="radio"
								name="addrMode"
								checked={addressMode === "specific"}
								onChange={() => setAddressMode("specific")}
								className="size-4 text-[var(--accent)]"
							/>
							特定のアドレスだけ
						</label>
						{addressMode === "specific" && (
							<div className="max-h-40 overflow-y-auto rounded-md border border-[var(--line)] p-2">
								{addresses.map((a) => (
									<label key={a.id} className="flex items-center gap-2 py-1 text-sm text-[var(--text)]">
										<Checkbox checked={selected.includes(a.id)} onChange={() => toggleAddr(a.id)} />
										{a.address}
									</label>
								))}
							</div>
						)}
					</div>
				</div>
				<label className="flex items-center gap-2 text-sm text-[var(--text)]">
					<Checkbox checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
					有効
				</label>

				<div className="flex justify-end gap-2 pt-2">
					<Button variant="secondary" onClick={onClose}>
						キャンセル
					</Button>
					<Button onClick={save} disabled={busy || !valid}>
						{webhook ? "保存する" : "作成する"}
					</Button>
				</div>
			</div>
		</Modal>
	);
}

function SecretDialog({ created, onClose }: { created: WebhookCreate; onClose: () => void }) {
	const [copied, setCopied] = useState(false);
	return (
		<Modal title="Webhook を作成しました" onClose={onClose}>
			<div className="space-y-4">
				<WarningBlock>
					<strong>secret は作成直後のこの 1 回だけ表示されます。</strong>
					<p className="mt-1">署名検証に使うため控えてください。以後は再表示できません。</p>
				</WarningBlock>
				<div className="flex items-center gap-2">
					<code className="flex-1 break-all rounded-md bg-[var(--surface-hover)] px-3 py-2 text-sm text-[var(--text)]">
						{created.secret}
					</code>
					<Button
						variant="secondary"
						onClick={() => {
							void navigator.clipboard?.writeText(created.secret);
							setCopied(true);
						}}
					>
						{copied ? "コピー済み" : "コピー"}
					</Button>
				</div>
			</div>
		</Modal>
	);
}

function NoticeDanger({ children }: { children: React.ReactNode }) {
	return (
		<div className="rounded-md border border-[var(--warning)] bg-[var(--surface-hover)] px-4 py-3 text-sm text-[var(--warning)]">
			{children}
		</div>
	);
}

function DeliveriesModal({ webhook, onClose }: { webhook: Webhook; onClose: () => void }) {
	const [items, setItems] = useState<WebhookDelivery[]>([]);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [retrying, setRetrying] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const res = await api.get<{ data: WebhookDelivery[] }>(
				`/api/v1/webhooks/${webhook.id}/deliveries?limit=100`,
			);
			setItems(res.data);
		} catch (e) {
			setError(e instanceof ApiClientError ? e.message : "配信履歴の取得に失敗しました");
		}
	}, [webhook.id]);

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

	return (
		<Modal title={`配信履歴 — ${webhook.name}`} onClose={onClose}>
			<ErrorBanner message={error} onDismiss={() => setError("")} />
			<div className="mb-2 text-sm text-[var(--text-muted)]">イベント: {webhook.events.map((e) => eventLabels[e]).join(" / ")}</div>
			{items.length === 0 ? (
				<EmptyState message="配信履歴はまだありません。" />
			) : (
				<div className="max-h-96 overflow-y-auto rounded-md border border-[var(--line)]">
					<div className="hidden overflow-x-auto md:block">
					<table className="w-full min-w-[720px]">
						<thead className="sticky top-0 bg-[var(--surface-sunken)]">
							<tr className="border-b border-[var(--line)]">
								<th className={thCls}>日時</th>
								<th className={thCls}>イベント</th>
								<th className={thCls}>状態</th>
								<th className={thCls}>HTTP</th>
								<th className={thCls}>試行</th>
								<th className={thCls}></th>
							</tr>
						</thead>
						<tbody>
							{items.map((d) => (
								<TableRow key={d.id}>
									<td className={tdCls}>{formatDateTime(d.createdAt)}</td>
									<td className={tdCls}>{eventLabels[d.event]}</td>
									<td className={tdCls}>
										<Badge color={d.status === "success" ? "green" : d.status === "failed" ? "red" : "yellow"}>
											{d.status}
										</Badge>
										{d.error && <div className="text-xs text-[var(--danger)]">{d.error}</div>}
									</td>
									<td className={tdCls}>{d.httpStatus ?? "—"}</td>
									<td className={tdCls}>{d.attempt}</td>
									<td className={tdCls}>
										{d.status === "failed" && (
											<Button variant="secondary" disabled={retrying === d.id} onClick={() => retry(d)}>
												{retrying === d.id ? "再送中…" : "再送"}
											</Button>
										)}
									</td>
								</TableRow>
							))}
						</tbody>
					</table>
					</div>
					<ul className="md:hidden">
						{items.map((d) => (
							<li key={d.id} className="border-b border-[var(--line-soft)] px-3 py-2">
								<div className="flex items-center justify-between gap-2">
									<span className="text-sm font-medium text-[var(--text)]">{eventLabels[d.event]}</span>
									<Badge color={d.status === "success" ? "green" : d.status === "failed" ? "red" : "yellow"}>
										{d.status}
									</Badge>
								</div>
								{d.error && <div className="mt-1 text-xs text-[var(--danger)]">{d.error}</div>}
								<div className="mt-1 space-y-0.5 text-sm">
									<div className="text-[var(--text-muted)]">{formatDateTime(d.createdAt)}</div>
									<div className="text-[var(--text)]">HTTP: {d.httpStatus ?? "—"} / 試行: {d.attempt}</div>
								</div>
								{d.status === "failed" && (
									<div className="mt-1">
										<Button variant="secondary" disabled={retrying === d.id} onClick={() => retry(d)}>
											{retrying === d.id ? "再送中…" : "再送"}
										</Button>
									</div>
								)}
							</li>
						))}
					</ul>
				</div>
			)}
		</Modal>
	);
}

export function WebhooksPage() {
	const [webhooks, setWebhooks] = useState<Webhook[]>([]);
	const [addresses, setAddresses] = useState<{ id: string; address: string }[]>([]);
	const [error, setError] = useState("");
	const [showCreate, setShowCreate] = useState(false);
	const [created, setCreated] = useState<WebhookCreate | null>(null);
	const [editTarget, setEditTarget] = useState<Webhook | null>(null);
	const [deliveriesTarget, setDeliveriesTarget] = useState<Webhook | null>(null);
	const [deleteTarget, setDeleteTarget] = useState<Webhook | null>(null);

	const load = useCallback(async () => {
		try {
			const [list, addressList] = await Promise.all([
				getAllPages<Webhook>("/api/v1/webhooks"),
				getAllPages<{ id: string; address: string }>("/api/v1/admin/addresses"),
			]);
			setWebhooks(list);
			setAddresses(addressList);
		} catch (e) {
			setError(e instanceof ApiClientError ? e.message : "一覧の取得に失敗しました");
		}
	}, []);

	useEffect(() => {
		load();
	}, [load]);

	const confirmDelete = async () => {
		if (!deleteTarget) return;
		setError("");
		try {
			await api.del(`/api/v1/webhooks/${deleteTarget.id}`);
			setDeleteTarget(null);
			await load();
		} catch (e) {
			setError(e instanceof ApiClientError ? e.message : "削除に失敗しました");
		}
	};

	const addressLabel = (ids: string[] | null): string => {
		if (!ids) return "全アドレス";
		const names = ids.map((id) => addresses.find((a) => a.id === id)?.address ?? id);
		return names.length <= 2 ? names.join(", ") : `${names[0]} 他 ${names.length - 1} 件`;
	};

	return (
		<AdminGate>
			<Page title="Webhook 管理">
				<ErrorBanner message={error} onDismiss={() => setError("")} />
				<Card>
					<CardHeader
						title="Webhook"
						description="新着受信・送信完了・送信失敗を外部に POST する"
						action={<Button onClick={() => setShowCreate(true)}>Webhook を作成</Button>}
					/>
					{webhooks.length === 0 ? (
						<EmptyState message="Webhook はまだありません。「Webhook を作成」から追加してください。" />
					) : (
						<>
						<div className="hidden overflow-x-auto md:block">
						<table className="w-full min-w-[720px]">
							<thead>
								<tr className="border-b border-[var(--line)] bg-[var(--surface-sunken)]">
									<th className={thCls}>名前</th>
									<th className={thCls}>URL</th>
									<th className={thCls}>イベント</th>
									<th className={thCls}>対象</th>
									<th className={thCls}>状態</th>
									<th className={thCls}>操作</th>
								</tr>
							</thead>
							<tbody>
								{webhooks.map((w) => (
									<TableRow key={w.id}>
										<td className={tdCls}>
											<span className="font-medium text-[var(--text)]">{w.name}</span>
										</td>
										<td className={tdCls}>
											<span className="break-all font-mono text-xs">{w.url}</span>
										</td>
										<td className={tdCls}>
											<div className="flex flex-wrap gap-1">
												{w.events.map((e) => (
													<Badge key={e} color="blue">
														{eventLabels[e]}
													</Badge>
												))}
											</div>
										</td>
										<td className={tdCls}>{addressLabel(w.addressIds)}</td>
										<td className={tdCls}>
											<Badge color={w.enabled ? "green" : "gray"}>{w.enabled ? "有効" : "無効"}</Badge>
										</td>
										<td className={tdCls}>
											<div className="flex gap-2">
												<Button variant="secondary" onClick={() => setEditTarget(w)}>
													編集
												</Button>
												<Button variant="secondary" onClick={() => setDeliveriesTarget(w)}>
													配信履歴
												</Button>
												<Button variant="danger" onClick={() => setDeleteTarget(w)}>
													削除
												</Button>
											</div>
										</td>
									</TableRow>
								))}
							</tbody>
						</table>
						</div>
						<ul className="md:hidden">
							{webhooks.map((w) => (
								<li key={w.id} className="border-b border-[var(--line-soft)] px-4 py-3">
									<div className="flex items-center justify-between gap-2">
										<span className="min-w-0 flex-1 font-medium text-[var(--text)]">{w.name}</span>
										<Badge color={w.enabled ? "green" : "gray"}>{w.enabled ? "有効" : "無効"}</Badge>
									</div>
									<div className="mt-1 break-all font-mono text-xs text-[var(--text-muted)]">{w.url}</div>
									<div className="mt-2 space-y-1">
										<MobileField label="イベント">
											<div className="flex flex-wrap justify-end gap-1">
												{w.events.map((e) => (
													<Badge key={e} color="blue">
														{eventLabels[e]}
													</Badge>
												))}
											</div>
										</MobileField>
										<MobileField label="対象">{addressLabel(w.addressIds)}</MobileField>
									</div>
									<MobileActions>
										<Button variant="secondary" onClick={() => setEditTarget(w)}>
											編集
										</Button>
										<Button variant="secondary" onClick={() => setDeliveriesTarget(w)}>
											配信履歴
										</Button>
										<Button variant="danger" onClick={() => setDeleteTarget(w)}>
											削除
										</Button>
									</MobileActions>
								</li>
							))}
						</ul>
						</>
					)}
				</Card>

				{showCreate && (
					<WebhookModal
						addresses={addresses}
						onClose={() => setShowCreate(false)}
						onCreated={(w) => {
							setShowCreate(false);
							setCreated(w);
							load();
						}}
					/>
				)}

				{editTarget && (
					<WebhookModal
						addresses={addresses}
						webhook={editTarget}
						onClose={() => setEditTarget(null)}
						onUpdated={() => {
							setEditTarget(null);
							load();
						}}
					/>
				)}

				{created && <SecretDialog created={created} onClose={() => setCreated(null)} />}

				{deliveriesTarget && (
					<DeliveriesModal webhook={deliveriesTarget} onClose={() => setDeliveriesTarget(null)} />
				)}

				{deleteTarget && (
					<Modal title="Webhook を削除" onClose={() => setDeleteTarget(null)}>
						<div className="space-y-4">
							<Notice tone="info">
								<strong>{deleteTarget.name}</strong> を削除します。
							</Notice>
							<div className="flex justify-end gap-2">
								<Button variant="secondary" onClick={() => setDeleteTarget(null)}>
									キャンセル
								</Button>
								<Button variant="danger" onClick={confirmDelete}>
									削除する
								</Button>
							</div>
						</div>
					</Modal>
				)}
			</Page>
		</AdminGate>
	);
}
