import { useCallback, useEffect, useState } from "react";
import type { AvailableZone, DnsCheckResult, DomainSummary } from "./api";
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
	Modal,
	Notice,
	Page,
	Select,
	TableRow,
	tdCls,
	TextInput,
	thCls,
	WarningBlock,
	type BadgeColor,
} from "./components";

const CATCH_ALL_WARNING =
	"catch-all はゾーン全体のメールをこのアプリに流し込みます。実在アドレス宛のメールも受け皿に届くため、有効化するとゾーン内の全メールがここに吸い込まれます。";

function modeBadge(mode: DomainSummary["mode"]): BadgeColor {
	return mode === "apex" ? "purple" : "blue";
}

function statusBadge(status: string): BadgeColor {
	switch (status) {
		case "active":
			return "green";
		case "error":
			return "red";
		default:
			return "yellow";
	}
}

function DomainList({
	domains,
	onConnect,
	onDelete,
	onToggleCatchAll,
	onVerify,
}: {
	domains: DomainSummary[];
	onConnect: () => void;
	onDelete: (d: DomainSummary) => void;
	onToggleCatchAll: (d: DomainSummary) => void;
	onVerify: (d: DomainSummary) => void;
}) {
	return (
		<Card>
			<CardHeader
				title="接続済みドメイン"
				description="Email Routing / Email Sending を接続したドメインの一覧"
				action={
					<Button onClick={onConnect}>ドメインを接続</Button>
				}
			/>
			{domains.length === 0 ? (
				<EmptyState message="接続済みのドメインはありません。「ドメインを接続」から追加してください。" />
			) : (
				<div className="overflow-x-auto">
				<table className="w-full min-w-[720px]">
					<thead>
						<tr className="border-b border-[var(--line)] bg-[var(--surface-sunken)]">
							<th className={thCls}>ドメイン</th>
							<th className={thCls}>モード</th>
							<th className={thCls}>受信</th>
							<th className={thCls}>送信</th>
							<th className={thCls}>catch-all</th>
							<th className={thCls}>接続日</th>
							<th className={thCls}>操作</th>
						</tr>
					</thead>
					<tbody>
						{domains.map((d) => (
							<TableRow key={d.id}>
								<td className={tdCls}>
									<div className="font-medium text-[var(--text)]">{d.name}</div>
									<div className="text-xs text-[var(--text-muted)]">{d.zoneName}</div>
								</td>
								<td className={tdCls}>
									<Badge color={modeBadge(d.mode)}>
										{d.mode === "apex" ? "apex" : "サブドメイン"}
									</Badge>
								</td>
								<td className={tdCls}>
									<Badge color={statusBadge(d.routingStatus)}>{d.routingStatus}</Badge>
								</td>
								<td className={tdCls}>
									<Badge color={statusBadge(d.sendingStatus)}>{d.sendingStatus}</Badge>
								</td>
								<td className={tdCls}>
									<Button
										variant="ghost"
										onClick={() => onToggleCatchAll(d)}
										title={d.catchAllEnabled ? "無効化する" : "有効化する"}
									>
										{d.catchAllEnabled ? "有効" : "無効"}
									</Button>
								</td>
								<td className={tdCls}>{formatDateTime(d.createdAt)}</td>
								<td className={tdCls}>
									<div className="flex gap-2">
										<Button variant="secondary" onClick={() => onVerify(d)}>
											再検査
										</Button>
										<Button
											variant="danger"
											onClick={() => onDelete(d)}
										>
											削除
										</Button>
									</div>
								</td>
							</TableRow>
						))}
					</tbody>
				</table>
				</div>
			)}
			{domains.some((d) => d.catchAllEnabled) && (
				<div className="border-t border-[var(--line)] px-5 py-3">
					<Notice tone="warn">
						catch-all はゾーン全体のメールをこのアプリに流し込みます。有効なドメインに注意してください。
					</Notice>
				</div>
			)}
		</Card>
	);
}

function ConnectDomainModal({
	onClose,
	onCreated,
}: {
	onClose: () => void;
	onCreated: () => void;
}) {
	const [zones, setZones] = useState<AvailableZone[]>([]);
	const [zonesNote, setZonesNote] = useState("");
	const [zoneId, setZoneId] = useState("");
	const [name, setName] = useState("");
	const [enableSending, setEnableSending] = useState(true);
	const [preview, setPreview] = useState<DnsCheckResult | null>(null);
	const [confirmApex, setConfirmApex] = useState(false);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [created, setCreated] = useState(false);

	useEffect(() => {
		(async () => {
			try {
				const res = await api.get<{ data: AvailableZone[]; note: string }>(
					"/api/v1/admin/domains/available",
				);
				setZones(res.data);
				setZonesNote(res.note ?? "");
			} catch (e) {
				setError(e instanceof ApiClientError ? e.message : "接続可能なゾーンの取得に失敗しました");
			}
		})();
	}, []);

	const selectZone = (id: string) => {
		setZoneId(id);
		const z = zones.find((x) => x.zoneId === id);
		if (z) {
			setName(z.suggestedName);
			setPreview(null);
			setConfirmApex(false);
		}
	};

	const runPreview = async () => {
		setError("");
		setPreview(null);
		setBusy(true);
		try {
			const res = await api.post<{ data: DnsCheckResult; requiresApexConfirmation: boolean }>(
				"/api/v1/admin/domains/preview",
				{ name, zoneId: zoneId || undefined },
			);
			setPreview(res.data);
		} catch (e) {
			setError(e instanceof ApiClientError ? e.message : "プレビューの取得に失敗しました");
		} finally {
			setBusy(false);
		}
	};

	const create = async () => {
		setError("");
		setBusy(true);
		try {
			await api.post("/api/v1/admin/domains", {
				name,
				zoneId: zoneId || undefined,
				confirmApex: preview?.requiresApexConfirmation === true ? confirmApex : false,
				enableSending,
				localParts: [],
			});
			setCreated(true);
			onCreated();
		} catch (e) {
			setError(e instanceof ApiClientError ? e.message : "ドメインの接続に失敗しました");
		} finally {
			setBusy(false);
		}
	};

	const needsApex = preview?.requiresApexConfirmation === true;

	return (
		<Modal title="ドメインを接続" onClose={onClose}>
			{created ? (
				<Notice tone="info">接続が完了しました。</Notice>
			) : (
				<div className="space-y-4">
					<ErrorBanner message={error} onDismiss={() => setError("")} />
					{zonesNote && <Notice>{zonesNote}</Notice>}

					<div>
						<Label>Cloudflare のゾーン</Label>
						<Select value={zoneId} onChange={(e) => selectZone(e.target.value)}>
							<option value="">選択してください</option>
							{zones.map((z) => (
								<option key={z.zoneId} value={z.zoneId}>
									{z.zoneName}
									{z.connectedNames.length > 0 ? `（接続済み: ${z.connectedNames.join(", ")}）` : ""}
								</option>
							))}
						</Select>
					</div>

					<div>
						<Label>接続するホスト名</Label>
						<TextInput
							value={name}
							onChange={(e) => {
								setName(e.target.value);
								setPreview(null);
							}}
							placeholder="mail.example.com"
						/>
						<p className="mt-1 text-xs text-[var(--text-muted)]">
							既定はサブドメイン運用。apex（そのドメインそのもの）を使うと、そのドメイン宛の全メールがこのアプリに流れ込みます。
						</p>
					</div>

					<div className="flex items-center gap-2">
						<Checkbox
							id="enableSending"
							checked={enableSending}
							onChange={(e) => setEnableSending(e.target.checked)}
						/>
						<Label>
							<label htmlFor="enableSending" className="mb-0 text-sm">
								送信（Email Sending）も設定する
							</label>
						</Label>
					</div>

					<Button variant="secondary" onClick={runPreview} disabled={busy || !name}>
						{busy ? "確認中…" : "DNS を確認する"}
					</Button>

					{preview && (
						<div className="space-y-3 rounded-md border border-[var(--line)] bg-[var(--surface-sunken)] p-4">
							<h3 className="text-sm font-semibold text-[var(--text)]">確認結果</h3>

							{preview.warnings.length > 0 && (
								<div className="space-y-2">
									{preview.warnings.map((w, i) => (
										<Notice key={i} tone={w.level === "danger" ? "danger" : w.level === "warn" ? "warn" : "info"}>
											[{w.code}] {w.message}
										</Notice>
									))}
								</div>
							)}

							{preview.isApex && preview.apexMx.length > 0 && (
								<WarningBlock>
									<strong>この apex には既に下の MX レコードがあります。</strong>
									<p className="mt-1">
										apex をこのアプリ向けにすると、現在のメール提供（例: Google Workspace）が止まり、
										このドメイン宛の全メールがここに流れ込みます。
									</p>
									<ul className="mt-2 space-y-1">
										{preview.apexMx.map((m, i) => (
											<li key={i}>
												<span className="font-mono text-xs">
													{m.name} → {m.content}
												</span>
											</li>
										))}
									</ul>
								</WarningBlock>
							)}

							<MxTable mx={preview.mx} />

							<div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
								<span>推奨モード:</span>
								<Badge color={preview.recommendedMode === "subdomain" ? "blue" : "purple"}>
									{preview.recommendedMode === "subdomain" ? "サブドメイン" : "apex"}
								</Badge>
								<span>（{preview.name}）</span>
							</div>
						</div>
					)}

					{needsApex && (
						<WarningBlock>
							<label className="flex items-start gap-2 text-sm">
								<Checkbox
									checked={confirmApex}
									onChange={(e) => setConfirmApex(e.target.checked)}
									className="mt-0.5"
								/>
								<span>
									apex をこのアプリに接続することに同意します。既にあるメールが止まる可能性と、
									ドメイン宛の全メールがここに流れ込むことを理解しました。
								</span>
							</label>
						</WarningBlock>
					)}

					<div className="flex justify-end gap-2 pt-2">
						<Button variant="secondary" onClick={onClose}>
							キャンセル
						</Button>
						<Button onClick={create} disabled={busy || !name || (needsApex && !confirmApex)}>
							接続する
						</Button>
					</div>
				</div>
			)}
		</Modal>
	);
}

function MxTable({ mx }: { mx: { name: string; content: string; priority?: number; provider: string }[] }) {
	if (mx.length === 0) return null;
	return (
		<div>
			<h4 className="text-xs font-semibold text-[var(--text-muted)]">既存の MX レコード</h4>
			<table className="mt-1 w-full text-xs">
				<tbody>
					{mx.map((m, i) => (
						<tr key={i} className="border-b border-[var(--line-soft)] last:border-0">
							<td className="px-2 py-1 font-mono">{m.name}</td>
							<td className="px-2 py-1 font-mono">{m.content}</td>
							<td className="px-2 py-1 text-[var(--text-muted)]">{m.priority}</td>
							<td className="px-2 py-1 text-[var(--text-muted)]">{m.provider}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function CatchAllModal({
	domain,
	onClose,
	onDone,
}: {
	domain: DomainSummary;
	onClose: () => void;
	onDone: () => void;
}) {
	const [confirm, setConfirm] = useState(false);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	const toggle = async () => {
		setError("");
		setBusy(true);
		try {
			await api.post(`/api/v1/admin/domains/${domain.id}/catch-all`, {
				enabled: !domain.catchAllEnabled,
				confirm: !domain.catchAllEnabled ? confirm : true,
			});
			onDone();
		} catch (e) {
			setError(e instanceof ApiClientError ? e.message : "catch-all の変更に失敗しました");
		} finally {
			setBusy(false);
		}
	};

	return (
		<Modal title={domain.catchAllEnabled ? "catch-all を無効化" : "catch-all を有効化"} onClose={onClose}>
			<ErrorBanner message={error} onDismiss={() => setError("")} />
			<div className="space-y-4">
				{domain.catchAllEnabled ? (
					<Notice tone="warn">
						catch-all（{domain.name}）を無効にします。以後、宛先が見つからないメールは拒否されます。
					</Notice>
				) : (
					<>
						<WarningBlock>
							<p className="font-medium">{CATCH_ALL_WARNING}</p>
							<label className="mt-2 flex items-start gap-2 text-sm">
								<Checkbox checked={confirm} onChange={(e) => setConfirm(e.target.checked)} className="mt-0.5" />
								<span>
									ゾーン全体のメールがこのアプリに流れ込むことを理解しました。確認して有効化します。
								</span>
							</label>
						</WarningBlock>
					</>
				)}
				<div className="flex justify-end gap-2">
					<Button variant="secondary" onClick={onClose}>
						キャンセル
					</Button>
					<Button variant="danger" onClick={toggle} disabled={busy || (!domain.catchAllEnabled && !confirm)}>
						実行する
					</Button>
				</div>
			</div>
		</Modal>
	);
}

export function DomainsPage() {
	const [domains, setDomains] = useState<DomainSummary[]>([]);
	const [error, setError] = useState("");
	const [showConnect, setShowConnect] = useState(false);
	const [catchAllTarget, setCatchAllTarget] = useState<DomainSummary | null>(null);
	const [deleteTarget, setDeleteTarget] = useState<DomainSummary | null>(null);

	const load = useCallback(async () => {
		try {
			const list = await getAllPages<DomainSummary>("/api/v1/admin/domains");
			setDomains(list);
		} catch (e) {
			setError(e instanceof ApiClientError ? e.message : "ドメイン一覧の取得に失敗しました");
		}
	}, []);

	useEffect(() => {
		load();
	}, [load]);

	const confirmDelete = async () => {
		if (!deleteTarget) return;
		setError("");
		try {
			const res = await api.del<{ note: string | null; data: { id: string; deleted: boolean } }>(
				`/api/v1/admin/domains/${deleteTarget.id}`,
			);
			if (res.note) setError(res.note);
			setDeleteTarget(null);
			await load();
		} catch (e) {
			setError(e instanceof ApiClientError ? e.message : "ドメインの削除に失敗しました");
		}
	};

	const verify = async (d: DomainSummary) => {
		setError("");
		try {
			await api.post(`/api/v1/admin/domains/${d.id}/verify`);
			await load();
		} catch (e) {
			setError(e instanceof ApiClientError ? e.message : "再検査に失敗しました");
		}
	};

	return (
		<AdminGate>
			<Page title="ドメイン管理">
				<ErrorBanner message={error} onDismiss={() => setError("")} />
				<DomainList
					domains={domains}
					onConnect={() => setShowConnect(true)}
					onDelete={setDeleteTarget}
					onToggleCatchAll={setCatchAllTarget}
					onVerify={verify}
				/>

				{showConnect && (
					<ConnectDomainModal
						onClose={() => setShowConnect(false)}
						onCreated={() => {
							load();
						}}
					/>
				)}

				{catchAllTarget && (
					<CatchAllModal
						domain={catchAllTarget}
						onClose={() => setCatchAllTarget(null)}
						onDone={() => {
							setCatchAllTarget(null);
							load();
						}}
					/>
				)}

				{deleteTarget && (
					<Modal title="ドメインを削除" onClose={() => setDeleteTarget(null)}>
						<div className="space-y-4">
							<Notice tone="warn">
								<strong>{deleteTarget.name}</strong>（{deleteTarget.zoneName}）を削除します。
								Cloudflare 側の後始末（DNS・ルーティングルール）も実行されます。この操作は取り消せません。
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
