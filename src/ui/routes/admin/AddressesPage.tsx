import { useCallback, useEffect, useState } from "react";
import type { AdminAddress, DomainSummary } from "./api";
import { api, ApiClientError, getAllPages } from "./api";
import { AdminGate } from "./gate";
import { ColorPicker } from "./ColorPicker";
import { defaultColorFor } from "@/shared/colors";
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
} from "./components";

function AddressTable({
	addresses,
	onCreate,
	onEdit,
	onDelete,
	onColorChange,
}: {
	addresses: AdminAddress[];
	onCreate: () => void;
	onEdit: (a: AdminAddress) => void;
	onDelete: (a: AdminAddress) => void;
	onColorChange: (a: AdminAddress, hex: string) => void;
}) {
	const [colorTarget, setColorTarget] = useState<string | null>(null);

	return (
		<Card>
			<CardHeader
				title="メールアドレス"
				description="受信アドレス（メールボックス / エイリアス）の管理"
				action={<Button onClick={onCreate}>アドレスを作成</Button>}
			/>
			{addresses.length === 0 ? (
				<EmptyState message="メールアドレスはまだありません。「アドレスを作成」から追加してください。" />
			) : (
				<div className="overflow-x-auto">
				<table className="w-full min-w-[720px]">
					<thead>
						<tr className="border-b border-[var(--line)] bg-[var(--surface-sunken)]">
							<th className={thCls}>色</th>
							<th className={thCls}>アドレス</th>
							<th className={thCls}>種類</th>
							<th className={thCls}>表示名</th>
							<th className={thCls}>エイリアス先</th>
							<th className={thCls}>作成日</th>
							<th className={thCls}>操作</th>
						</tr>
					</thead>
					<tbody>
						{addresses.map((a, i) => (
							<TableRow key={a.id}>
								<td className={tdCls}>
									<button
										type="button"
										onClick={() => setColorTarget(colorTarget === a.id ? null : a.id)}
										title="色を変える"
										aria-label="色を変える"
										className="h-5 w-[30px] rounded-full border border-[var(--line)] transition-transform hover:scale-110"
										style={{ background: a.color ?? defaultColorFor(i) }}
									/>
								</td>
								<td className={tdCls}>
									<span className="font-medium text-[var(--text)]">{a.address}</span>
									{a.isCatchAll && (
										<span className="ml-2">
											<Badge color="yellow">catch-all</Badge>
										</span>
									)}
									{a.archivedAt && (
										<span className="ml-2">
											<Badge color="gray">アーカイブ済み</Badge>
										</span>
									)}
								</td>
								<td className={tdCls}>
									<Badge color={a.kind === "alias" ? "purple" : "green"}>
										{a.kind === "alias" ? "エイリアス" : "メールボックス"}
									</Badge>
								</td>
								<td className={tdCls}>{a.displayName || "—"}</td>
								<td className={tdCls}>{a.aliasTargetAddress || "—"}</td>
								<td className={tdCls}>{formatDateTime(a.createdAt)}</td>
								<td className={tdCls}>
									<div className="flex items-center gap-1">
										<Button variant="secondary" onClick={() => onEdit(a)}>
											編集
										</Button>
										<Button variant="danger" onClick={() => onDelete(a)}>
											削除
										</Button>
									</div>
								</td>
								{colorTarget === a.id && (
									<td colSpan={7} className="bg-[var(--surface-sunken)] px-4 py-3">
										<ColorPicker
											value={a.color}
											onChange={(hex: string) => {
												onColorChange(a, hex);
												setColorTarget(null);
											}}
										/>
									</td>
								)}
							</TableRow>
						))}
					</tbody>
				</table>
				</div>
			)}
		</Card>
	);
}

function CreateAddressModal({
	domains,
	existing,
	onClose,
	onCreated,
}: {
	domains: DomainSummary[];
	existing: AdminAddress[];
	onClose: () => void;
	onCreated: () => void;
}) {
	const [domainId, setDomainId] = useState(domains[0]?.id ?? "");
	const [localPart, setLocalPart] = useState("");
	const [displayName, setDisplayName] = useState("");
	const [kind, setKind] = useState<"mailbox" | "alias">("mailbox");
	const [aliasTargetId, setAliasTargetId] = useState("");
	const [isCatchAll, setIsCatchAll] = useState(false);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	// エイリアス先はメールボックスだけ（エイリアスのエイリアスは不可）。
	const mailboxTargets = existing.filter((a) => a.kind === "mailbox" && !a.archivedAt);
	const selectedDomain = domains.find((d) => d.id === domainId);

	const create = async () => {
		setError("");
		setBusy(true);
		try {
			await api.post("/api/v1/admin/addresses", {
				domainId,
				localPart,
				displayName: displayName.trim() || undefined,
				kind,
				aliasTargetId: kind === "alias" ? aliasTargetId : undefined,
				isCatchAll,
			});
			onCreated();
		} catch (e) {
			setError(e instanceof ApiClientError ? e.message : "アドレスの作成に失敗しました");
		} finally {
			setBusy(false);
		}
	};

	const valid = domainId && /^[a-z0-9._+-]+$/.test(localPart) && (kind === "mailbox" || aliasTargetId);

	return (
		<Modal title="アドレスを作成" onClose={onClose}>
			<ErrorBanner message={error} onDismiss={() => setError("")} />
			<div className="space-y-4">
				<div>
					<Label>ドメイン</Label>
					<Select value={domainId} onChange={(e) => setDomainId(e.target.value)}>
						{domains.map((d) => (
							<option key={d.id} value={d.id}>
								{d.name}
							</option>
						))}
					</Select>
				</div>

				<div>
					<Label>ローカル部（@ の前）</Label>
					<div className="flex items-center gap-2">
						<TextInput
							value={localPart}
							onChange={(e) => setLocalPart(e.target.value.toLowerCase())}
							placeholder="info"
							className="flex-1"
						/>
						<span className="text-sm text-[var(--text-muted)]">@{selectedDomain?.name ?? ""}</span>
					</div>
				</div>

				<div>
					<Label>表示名（任意）</Label>
					<TextInput
						value={displayName}
						onChange={(e) => setDisplayName(e.target.value)}
						placeholder="お問い合わせ窓口"
					/>
				</div>

				<div>
					<Label>種類</Label>
					<Select value={kind} onChange={(e) => setKind(e.target.value as "mailbox" | "alias")}>
						<option value="mailbox">メールボックス（受信して保管）</option>
						<option value="alias">エイリアス（転送）</option>
					</Select>
				</div>

				{kind === "alias" && (
					<div>
						<Label>転送先（メールボックス）</Label>
						<Select value={aliasTargetId} onChange={(e) => setAliasTargetId(e.target.value)}>
							<option value="">選択してください</option>
							{mailboxTargets.map((m) => (
								<option key={m.id} value={m.id}>
									{m.address}
								</option>
							))}
						</Select>
					</div>
				)}

				<label className="flex items-start gap-2 text-sm text-[var(--text)]">
					<Checkbox
						checked={isCatchAll}
						onChange={(e) => setIsCatchAll(e.target.checked)}
						className="mt-0.5"
					/>
					<span>
						このアドレスを catch-all の受け皿にする
						{isCatchAll && (
							<span className="mt-1 block text-xs text-[var(--danger)]">
								ドメインあたり 1 件まで。このドメイン宛で、どのアドレスにも一致しないメールがここに届きます。
							</span>
						)}
					</span>
				</label>

				<div className="flex justify-end gap-2 pt-2">
					<Button variant="secondary" onClick={onClose}>
						キャンセル
					</Button>
					<Button onClick={create} disabled={busy || !valid}>
						作成する
					</Button>
				</div>
			</div>
		</Modal>
	);
}

function EditAddressModal({
	address,
	existing,
	onClose,
	onSaved,
}: {
	address: AdminAddress;
	existing: AdminAddress[];
	onClose: () => void;
	onSaved: () => void;
}) {
	const [displayName, setDisplayName] = useState(address.displayName ?? "");
	const [signature, setSignature] = useState(address.signature ?? "");
	const [kind, setKind] = useState<"mailbox" | "alias">(address.kind);
	const [aliasTargetId, setAliasTargetId] = useState(address.aliasTargetId ?? "");
	const [isCatchAll, setIsCatchAll] = useState(address.isCatchAll);
	const [archived, setArchived] = useState(Boolean(address.archivedAt));
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	// 自分自身とエイリアスは転送先にできない。
	const mailboxTargets = existing.filter(
		(a) => a.kind === "mailbox" && !a.archivedAt && a.id !== address.id,
	);

	const save = async () => {
		setError("");
		setBusy(true);
		try {
			await api.patch(`/api/v1/admin/addresses/${address.id}`, {
				displayName: displayName.trim() || null,
				signature: signature.trim() || null,
				kind,
				aliasTargetId: kind === "alias" ? aliasTargetId : null,
				isCatchAll,
				archived,
			});
			onSaved();
		} catch (e) {
			setError(e instanceof ApiClientError ? e.message : "アドレスの更新に失敗しました");
		} finally {
			setBusy(false);
		}
	};

	const valid = kind === "mailbox" || Boolean(aliasTargetId);

	return (
		<Modal title="アドレスを編集" onClose={onClose}>
			<ErrorBanner message={error} onDismiss={() => setError("")} />
			<div className="space-y-4">
				<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md bg-[var(--surface-sunken)] px-4 py-3 text-sm">
					<dt className="text-[var(--text-muted)]">アドレス</dt>
					<dd className="font-medium text-[var(--text)]">{address.address}</dd>
					<dt className="text-[var(--text-muted)]">ドメイン</dt>
					<dd className="text-[var(--text)]">{address.domainName}</dd>
					<dt className="text-[var(--text-muted)]">作成日</dt>
					<dd className="text-[var(--text)]">{formatDateTime(address.createdAt)}</dd>
				</dl>

				<div>
					<Label>表示名</Label>
					<TextInput
						value={displayName}
						onChange={(e) => setDisplayName(e.target.value)}
						placeholder="お問い合わせ窓口"
					/>
				</div>

				<div>
					<Label>署名</Label>
					<textarea
						value={signature}
						onChange={(e) => setSignature(e.target.value)}
						rows={4}
						placeholder="送信するメールの末尾に付く文面"
						className="w-full rounded-md border border-[var(--line)] bg-[var(--surface)] px-3 py-1.5 text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
					/>
				</div>

				<div>
					<Label>種類</Label>
					<Select value={kind} onChange={(e) => setKind(e.target.value as "mailbox" | "alias")}>
						<option value="mailbox">メールボックス（受信して保管）</option>
						<option value="alias">エイリアス（転送）</option>
					</Select>
				</div>

				{kind === "alias" && (
					<div>
						<Label>転送先（メールボックス）</Label>
						<Select value={aliasTargetId} onChange={(e) => setAliasTargetId(e.target.value)}>
							<option value="">選択してください</option>
							{mailboxTargets.map((m) => (
								<option key={m.id} value={m.id}>
									{m.address}
								</option>
							))}
						</Select>
					</div>
				)}

				<label className="flex items-start gap-2 text-sm text-[var(--text)]">
					<Checkbox
						checked={isCatchAll}
						onChange={(e) => setIsCatchAll(e.target.checked)}
						className="mt-0.5"
					/>
					<span>
						このアドレスを catch-all の受け皿にする
						{isCatchAll && !address.isCatchAll && (
							<span className="mt-1 block text-xs text-[var(--danger)]">
								ドメインあたり 1 件まで。このドメイン宛で、どのアドレスにも一致しないメールがここに届きます。
							</span>
						)}
					</span>
				</label>

				<label className="flex items-start gap-2 text-sm text-[var(--text)]">
					<Checkbox
						checked={archived}
						onChange={(e) => setArchived(e.target.checked)}
						className="mt-0.5"
					/>
					<span>
						アーカイブする
						<span className="mt-1 block text-xs text-[var(--text-muted)]">
							新しい割り当てや送信の選択肢から外れます。過去のメールは残ります。
						</span>
					</span>
				</label>

				<div className="flex justify-end gap-2 pt-2">
					<Button variant="secondary" onClick={onClose}>
						キャンセル
					</Button>
					<Button onClick={save} disabled={busy || !valid}>
						保存する
					</Button>
				</div>
			</div>
		</Modal>
	);
}

export function AddressesPage() {
	const [addresses, setAddresses] = useState<AdminAddress[]>([]);
	const [domains, setDomains] = useState<DomainSummary[]>([]);
	const [error, setError] = useState("");
	const [showCreate, setShowCreate] = useState(false);
	const [editTarget, setEditTarget] = useState<AdminAddress | null>(null);
	const [deleteTarget, setDeleteTarget] = useState<AdminAddress | null>(null);

	const changeColor = useCallback(
		async (a: AdminAddress, hex: string) => {
			try {
				await api.patch(`/api/v1/admin/addresses/${a.id}`, { color: hex });
				setAddresses((prev) => prev.map((x) => (x.id === a.id ? { ...x, color: hex } : x)));
			} catch (e) {
				setError(e instanceof ApiClientError ? e.message : "色を変更できませんでした");
			}
		},
		[],
	);

	const load = useCallback(async () => {
		try {
			const [addressList, domainList] = await Promise.all([
				getAllPages<AdminAddress>("/api/v1/admin/addresses"),
				getAllPages<DomainSummary>("/api/v1/admin/domains"),
			]);
			setAddresses(addressList);
			setDomains(domainList);
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
			const res = await api.del<{ note: string | null }>(
				`/api/v1/admin/addresses/${deleteTarget.id}`,
			);
			if (res.note) setError(res.note);
			setDeleteTarget(null);
			await load();
		} catch (e) {
			setError(e instanceof ApiClientError ? e.message : "アドレスの削除に失敗しました");
		}
	};

	return (
		<AdminGate>
			<Page title="アドレス管理">
				<div className="mb-4">
					<Notice tone="info">
						メールボックスは受信して保管します。エイリアスは転送先のメールボックスを選べます。
						catch-all は、このドメイン宛でどのアドレスにも一致しないメールを受け取る受け皿です（ドメインあたり 1 件）。
					</Notice>
				</div>
				<ErrorBanner message={error} onDismiss={() => setError("")} />
				{domains.length === 0 ? (
					<EmptyState message="先に「ドメイン管理」からドメインを接続してください。" />
				) : (
					<AddressTable
						addresses={addresses}
						onCreate={() => setShowCreate(true)}
						onEdit={setEditTarget}
						onDelete={setDeleteTarget}
						onColorChange={changeColor}
					/>
				)}

				{showCreate && (
					<CreateAddressModal
						domains={domains}
						existing={addresses}
						onClose={() => setShowCreate(false)}
						onCreated={() => {
							setShowCreate(false);
							load();
						}}
					/>
				)}

				{editTarget && (
					<EditAddressModal
						address={editTarget}
						existing={addresses}
						onClose={() => setEditTarget(null)}
						onSaved={() => {
							setEditTarget(null);
							load();
						}}
					/>
				)}

				{deleteTarget && (
					<Modal title="アドレスを削除" onClose={() => setDeleteTarget(null)}>
						<div className="space-y-4">
							<Notice tone="info">
								<strong>{deleteTarget.address}</strong> を削除します。Cloudflare 側のルーティングルールも削除されます。
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
