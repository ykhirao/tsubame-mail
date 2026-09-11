import { useCallback, useEffect, useState } from "react";
import type { AdminAddress, AdminUser, ApiKeySummary, CreatedApiKey, Scope } from "./api";
import { api, ApiClientError, getAllPages } from "./api";
import { AdminGate } from "./gate";
import { rotatedExpiry } from "@/ui/lib/rotateExpiry";
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
} from "./components";

const scopeLabels: Record<Scope, string> = {
	read: "read（読む）",
	send: "send（送る）",
	admin: "admin（管理）",
};

function CreateKeyModal({
	users,
	addresses,
	onClose,
	onCreated,
}: {
	users: AdminUser[];
	addresses: AdminAddress[];
	onClose: () => void;
	onCreated: (created: CreatedApiKey) => void;
}) {
	const [userId, setUserId] = useState(users[0]?.id ?? "");
	const [name, setName] = useState("");
	const [scopes, setScopes] = useState<Scope[]>(["read"]);
	const [addressMode, setAddressMode] = useState<"all" | "specific" | "single">("single");
	const [singleAddressId, setSingleAddressId] = useState("");
	const [selectedAddresses, setSelectedAddresses] = useState<string[]>([]);
	const [expiryEnabled, setExpiryEnabled] = useState(false);
	const [expiryDays, setExpiryDays] = useState(30);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	const toggleScope = (s: Scope) => {
		setScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
	};

	const toggleAddress = (id: string) => {
		setSelectedAddresses((prev) =>
			prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
		);
	};

	const create = async () => {
		setError("");
		setBusy(true);
		try {
			let addressIds: string[] | null = null;
			if (addressMode === "specific") addressIds = selectedAddresses;
			else if (addressMode === "single") addressIds = singleAddressId ? [singleAddressId] : null;

			const expiresAt = expiryEnabled ? Math.floor(Date.now() / 1000) + expiryDays * 86400 : undefined;

			const res = await api.post<CreatedApiKey>("/api/v1/admin/api-keys", {
				userId,
				name,
				scopes,
				addressIds,
				expiresAt,
			});
			onCreated(res);
		} catch (e) {
			setError(e instanceof ApiClientError ? e.message : "キーの発行に失敗しました");
		} finally {
			setBusy(false);
		}
	};

	const addressOptions = (a: AdminAddress) => (
		<option key={a.id} value={a.id}>
			{a.address}
		</option>
	);

	const valid = userId && name && scopes.length > 0;

	return (
		<Modal title="API キーを発行" onClose={onClose}>
			<ErrorBanner message={error} onDismiss={() => setError("")} />
			<div className="space-y-4">
				<div className="rounded-md border border-[var(--accent)] bg-[var(--surface-hover)] px-4 py-3 text-sm text-[var(--accent-text)]">
					<strong>AI エージェント向けの作り方（推奨）</strong>
					<ol className="mt-1 list-decimal pl-4 space-y-0.5">
						<li>ユーザー管理で role を「AI エージェント」にして作る。</li>
						<li>権限でアドレスを 1 つだけ割り当てる。</li>
						<li>ここで「1 アドレスに限定」を選び、同じ 1 つを対象にする。</li>
					</ol>
					<p className="mt-1 text-xs">
						キーの対象はユーザーの権限との積集合で効くため、キーがユーザーの権限を超えることはありません。
					</p>
				</div>

				<div>
					<Label>対象ユーザー</Label>
					<Select value={userId} onChange={(e) => setUserId(e.target.value)}>
						{users.map((u) => (
							<option key={u.id} value={u.id}>
								{u.name}（{u.email} / {u.role}）
							</option>
						))}
					</Select>
				</div>

				<div>
					<Label>名前</Label>
					<TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="AI ボット用" />
				</div>

				<div>
					<Label>スコープ（複数選択可）</Label>
					<div className="flex flex-wrap gap-4">
						{(Object.keys(scopeLabels) as Scope[]).map((s) => (
							<label key={s} className="flex items-center gap-2 text-sm text-[var(--text)]">
								<Checkbox checked={scopes.includes(s)} onChange={() => toggleScope(s)} />
								{scopeLabels[s]}
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
								checked={addressMode === "single"}
								onChange={() => setAddressMode("single")}
								className="size-4 text-[var(--accent)]"
							/>
							1 アドレスに限定（AI 用）
						</label>
						{addressMode === "single" && (
							<Select value={singleAddressId} onChange={(e) => setSingleAddressId(e.target.value)}>
								<option value="">選択してください</option>
								{addresses.map(addressOptions)}
							</Select>
						)}

						<label className="flex items-center gap-2 text-sm text-[var(--text)]">
							<input
								type="radio"
								name="addrMode"
								checked={addressMode === "specific"}
								onChange={() => setAddressMode("specific")}
								className="size-4 text-[var(--accent)]"
							/>
							複数アドレスを選ぶ
						</label>
						{addressMode === "specific" && (
							<div className="max-h-40 overflow-y-auto rounded-md border border-[var(--line)] p-2">
								{addresses.length === 0 ? (
									<p className="text-xs text-[var(--text-muted)]">割り当てられるアドレスがありません。</p>
								) : (
									addresses.map((a) => (
										<label
											key={a.id}
											className="flex items-center gap-2 py-1 text-sm text-[var(--text)]"
										>
											<Checkbox
												checked={selectedAddresses.includes(a.id)}
												onChange={() => toggleAddress(a.id)}
											/>
											{a.address}
										</label>
									))
								)}
							</div>
						)}

						<label className="flex items-center gap-2 text-sm text-[var(--text)]">
							<input
								type="radio"
								name="addrMode"
								checked={addressMode === "all"}
								onChange={() => setAddressMode("all")}
								className="size-4 text-[var(--accent)]"
							/>
							制限しない（ユーザーの権限に従う）
						</label>
					</div>
				</div>

				<label className="flex items-center gap-2 text-sm text-[var(--text)]">
					<Checkbox checked={expiryEnabled} onChange={(e) => setExpiryEnabled(e.target.checked)} />
					有効期限を設定する
				</label>
				{expiryEnabled && (
					<div className="flex items-center gap-2">
						<TextInput
							type="number"
							min={1}
							value={expiryDays}
							onChange={(e) => setExpiryDays(Number(e.target.value))}
							className="w-28"
						/>
						<span className="text-sm text-[var(--text-muted)]">日後</span>
					</div>
				)}

				<div className="flex justify-end gap-2 pt-2">
					<Button variant="secondary" onClick={onClose}>
						キャンセル
					</Button>
					<Button onClick={create} disabled={busy || !valid}>
						発行する
					</Button>
				</div>
			</div>
		</Modal>
	);
}

function TokenDialog({ created, onClose }: { created: CreatedApiKey; onClose: () => void }) {
	const [copied, setCopied] = useState(false);
	return (
		<Modal title="API キーを発行しました" onClose={onClose}>
			<div className="space-y-4">
				<WarningBlock>
					<strong>この平文トークンは今だけ表示されます。</strong>
					<p className="mt-1">保存はハッシュのみで、以後は再表示できません。必ず控えてください。</p>
				</WarningBlock>
				<div className="flex items-center gap-2">
					<code className="flex-1 break-all rounded-md bg-[var(--surface-hover)] px-3 py-2 text-sm text-[var(--text)]">
						{created.token}
					</code>
					<Button
						variant="secondary"
						onClick={() => {
							void navigator.clipboard?.writeText(created.token);
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

export function ApiKeysPage() {
	const [keys, setKeys] = useState<ApiKeySummary[]>([]);
	const [users, setUsers] = useState<AdminUser[]>([]);
	const [addresses, setAddresses] = useState<AdminAddress[]>([]);
	const [error, setError] = useState("");
	const [showCreate, setShowCreate] = useState(false);
	const [created, setCreated] = useState<CreatedApiKey | null>(null);
	const [usersByName, setUsersByName] = useState<Record<string, AdminUser>>({});
	const [revokeTarget, setRevokeTarget] = useState<ApiKeySummary | null>(null);
	const [rotateTarget, setRotateTarget] = useState<ApiKeySummary | null>(null);
	const [rotating, setRotating] = useState(false);

	const load = useCallback(async () => {
		try {
			const [keyList, userList, addressList] = await Promise.all([
				getAllPages<ApiKeySummary>("/api/v1/admin/api-keys"),
				getAllPages<AdminUser>("/api/v1/admin/users"),
				getAllPages<AdminAddress>("/api/v1/admin/addresses"),
			]);
			setKeys(keyList);
			setUsers(userList);
			setAddresses(addressList);
			setUsersByName(Object.fromEntries(userList.map((u) => [u.id, u])));
		} catch (e) {
			setError(e instanceof ApiClientError ? e.message : "一覧の取得に失敗しました");
		}
	}, []);

	useEffect(() => {
		load();
	}, [load]);

	// 平文は保存していないので同じトークンは復活できない。同じ設定で作り直す。
	// 発行してから失効させる順序にして、失敗したときに鍵が 1 本も無い時間を作らない。
	const confirmRotate = async () => {
		if (!rotateTarget) return;
		setError("");
		setRotating(true);
		try {
			const res = await api.post<CreatedApiKey>("/api/v1/admin/api-keys", {
				userId: rotateTarget.userId,
				name: rotateTarget.name,
				scopes: rotateTarget.scopes,
				addressIds: rotateTarget.addressIds,
				...(rotateTarget.expiresAt ? { expiresAt: rotatedExpiry(rotateTarget) } : {}),
			});
			if (!rotateTarget.revokedAt) {
				await api.del(`/api/v1/admin/api-keys/${rotateTarget.id}`);
			}
			setRotateTarget(null);
			setCreated(res);
			await load();
		} catch (e) {
			setError(e instanceof ApiClientError ? e.message : "再発行に失敗しました");
		} finally {
			setRotating(false);
		}
	};

	const confirmRevoke = async () => {
		if (!revokeTarget) return;
		setError("");
		try {
			await api.del(`/api/v1/admin/api-keys/${revokeTarget.id}`);
			setRevokeTarget(null);
			await load();
		} catch (e) {
			setError(e instanceof ApiClientError ? e.message : "失効に失敗しました");
		}
	};

	const addressOf = (ids: string[] | null): string => {
		if (!ids) return "制限なし";
		if (ids.length === 0) return "制限なし";
		const names = ids.map((id) => addresses.find((a) => a.id === id)?.address ?? id);
		return names.length <= 2 ? names.join(", ") : `${names[0]} 他 ${names.length - 1} 件`;
	};

	return (
		<AdminGate>
			<Page title="API キー管理">
				<div className="mb-4">
					<div className="rounded-md border border-[var(--line)] bg-[var(--surface)] px-4 py-3 text-sm text-[var(--text-muted)]">
						キーは<strong>ユーザー単位ではなくキー単位</strong>でスコープと対象アドレスを絞れます。
						AI エージェントには agent ロールのユーザーを作り、アドレスを 1 つだけ割り当てて、
						キーの対象もそのアドレスに限定してください。
					</div>
				</div>
				<ErrorBanner message={error} onDismiss={() => setError("")} />
				<Card>
					<CardHeader
						title="発行済みキー"
						description="失効済みのキーも履歴として残ります"
						action={<Button onClick={() => setShowCreate(true)}>キーを発行</Button>}
					/>
					{keys.length === 0 ? (
						<EmptyState message="発行済みのキーはありません。" />
					) : (
						<div className="overflow-x-auto">
						<table className="w-full min-w-[720px]">
							<thead>
								<tr className="border-b border-[var(--line)] bg-[var(--surface-sunken)]">
									<th className={thCls}>名前</th>
									<th className={thCls}>ユーザー</th>
									<th className={thCls}>スコープ</th>
									<th className={thCls}>対象アドレス</th>
									<th className={thCls}>期限</th>
									<th className={thCls}>状態</th>
									<th className={thCls}>操作</th>
								</tr>
							</thead>
							<tbody>
								{keys.map((k) => {
									const revoked = k.revokedAt != null;
									const expired = !revoked && k.expiresAt != null && k.expiresAt * 1000 < Date.now();
									return (
										<TableRow key={k.id}>
											<td className={tdCls}>
												<div className="font-medium text-[var(--text)]">{k.name}</div>
												<div className="font-mono text-xs text-[var(--text-muted)]">{k.prefix}…</div>
											</td>
											<td className={tdCls}>{usersByName[k.userId]?.name ?? k.userId}</td>
											<td className={tdCls}>
												<div className="flex flex-wrap gap-1">
													{k.scopes.map((s) => (
														<Badge key={s} color="blue">
															{s}
														</Badge>
													))}
												</div>
											</td>
											<td className={tdCls}>{addressOf(k.addressIds)}</td>
											<td className={tdCls}>{k.expiresAt ? formatDateTime(k.expiresAt) : "無期限"}</td>
											<td className={tdCls}>
												{revoked ? (
													<Badge color="red">失効</Badge>
												) : expired ? (
													<Badge color="yellow">期限切れ</Badge>
												) : (
													<Badge color="green">有効</Badge>
												)}
											</td>
											<td className={tdCls}>
												<div className="flex gap-2">
													<Button variant="secondary" onClick={() => setRotateTarget(k)}>
														{revoked ? "再発行" : "差し替え"}
													</Button>
													{!revoked && (
														<Button variant="danger" onClick={() => setRevokeTarget(k)}>
															失効
														</Button>
													)}
												</div>
											</td>
										</TableRow>
									);
								})}
							</tbody>
						</table>
						</div>
					)}
				</Card>

				{showCreate && (
					<CreateKeyModal
						users={users}
						addresses={addresses}
						onClose={() => setShowCreate(false)}
						onCreated={(c) => {
							setShowCreate(false);
							setCreated(c);
							load();
						}}
					/>
				)}

				{created && <TokenDialog created={created} onClose={() => setCreated(null)} />}

				{rotateTarget && (
					<Modal
						title={rotateTarget.revokedAt ? "API キーを再発行" : "API キーを差し替え"}
						onClose={() => setRotateTarget(null)}
					>
						<div className="space-y-4">
							<Notice tone={rotateTarget.revokedAt ? "info" : "danger"}>
								<strong>{rotateTarget.name}</strong> と同じ設定
								（スコープ・対象アドレス・有効期間）で新しいキーを発行します。
								{rotateTarget.revokedAt ? (
									<>元のキーは失効済みのままです。</>
								) : (
									<>
										{" "}
										発行できたら<strong>元のキーは失効します</strong>。
										古いキーを使っている連携は、新しいキーに入れ替えるまで動かなくなります。
									</>
								)}
							</Notice>
							<div className="flex justify-end gap-2">
								<Button variant="secondary" onClick={() => setRotateTarget(null)}>
									キャンセル
								</Button>
								<Button onClick={confirmRotate} disabled={rotating}>
									{rotating ? "発行中…" : rotateTarget.revokedAt ? "再発行する" : "差し替える"}
								</Button>
							</div>
						</div>
					</Modal>
				)}

				{revokeTarget && (
					<Modal title="API キーを失効" onClose={() => setRevokeTarget(null)}>
						<div className="space-y-4">
							<Notice tone="danger">
								<strong>{revokeTarget.name}</strong>（{revokeTarget.prefix}…）を失効します。
								このキーを使っている連携はすぐに動かなくなります。
								<strong>失効は取り消せません。</strong>使い続けるなら新しいキーを発行してください。
							</Notice>
							<div className="flex justify-end gap-2">
								<Button variant="secondary" onClick={() => setRevokeTarget(null)}>
									キャンセル
								</Button>
								<Button variant="danger" onClick={confirmRevoke}>
									失効する
								</Button>
							</div>
						</div>
					</Modal>
				)}
			</Page>
		</AdminGate>
	);
}
