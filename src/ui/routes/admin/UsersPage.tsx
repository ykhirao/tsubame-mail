import { useCallback, useEffect, useState } from "react";
import type { AdminAddress, AdminUser, AdminUserDetail, GrantInput } from "./api";
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
	Label,
	Modal,
	Notice,
	Page,
	Select,
	TableRow,
	tdCls,
	TextInput,
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

function CreateUserModal({
	onClose,
	onCreated,
}: {
	onClose: () => void;
	onCreated: () => void;
}) {
	const [name, setName] = useState("");
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<AdminUser["role"]>("member");
	const [password, setPassword] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	const create = async () => {
		setError("");
		setBusy(true);
		try {
			await api.post("/api/v1/admin/users", {
				name,
				email,
				role,
				password: role === "agent" ? undefined : password,
			});
			onCreated();
		} catch (e) {
			setError(e instanceof ApiClientError ? e.message : "ユーザーの作成に失敗しました");
		} finally {
			setBusy(false);
		}
	};

	const valid = name && email && (role === "agent" || password.length >= 12);

	return (
		<Modal title="ユーザーを作成" onClose={onClose}>
			<ErrorBanner message={error} onDismiss={() => setError("")} />
			<div className="space-y-4">
				<div>
					<Label>名前</Label>
					<TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="山田 太郎" />
				</div>
				<div>
					<Label>メールアドレス（ログイン ID）</Label>
					<TextInput value={email} onChange={(e) => setEmail(e.target.value)} placeholder="taro@example.com" />
				</div>
				<div>
					<Label>ロール</Label>
					<Select value={role} onChange={(e) => setRole(e.target.value as AdminUser["role"])}>
						<option value="member">メンバー（UI からログイン）</option>
						<option value="owner">オーナー（全権限）</option>
						<option value="agent">AI エージェント（API キー専用）</option>
					</Select>
					{role === "agent" && (
						<p className="mt-1 text-xs text-[var(--text-muted)]">
							agent はパスワードを持ちません。UI にはログインせず、専用の API キーで動きます。
						</p>
					)}
				</div>
				{role !== "agent" && (
					<div>
						<Label>パスワード（12 文字以上）</Label>
						<TextInput
							type="password"
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							placeholder="••••••••••••"
						/>
					</div>
				)}
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

function GrantsModal({
	user,
	addresses,
	onClose,
	onSaved,
}: {
	user: AdminUser;
	addresses: AdminAddress[];
	onClose: () => void;
	onSaved: () => void;
}) {
	// キーが無い = 権限なし。loadUser が終わるまでは空で、loaded で描き分ける。
	const [levels, setLevels] = useState<Record<string, "read" | "write">>({});
	const [loaded, setLoaded] = useState(false);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const detail = await api.get<AdminUserDetail>(`/api/v1/admin/users/${user.id}`);
				if (cancelled) return;
				const m: Record<string, "read" | "write"> = {};
				for (const g of detail.grants) m[g.addressId] = g.level as "read" | "write";
				setLevels(m);
			} catch (e) {
				if (!cancelled)
					setError(e instanceof ApiClientError ? e.message : "権限情報の取得に失敗しました");
			} finally {
				if (!cancelled) setLoaded(true);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [user.id]);

	const save = async () => {
		setError("");
		setBusy(true);
		try {
			const grants: GrantInput[] = Object.entries(levels)
				.filter(([, l]) => l)
				.map(([addressId, level]) => ({ addressId, level }));
			await api.put(`/api/v1/admin/users/${user.id}/grants`, { grants });
			onSaved();
		} catch (e) {
			setError(e instanceof ApiClientError ? e.message : "権限の保存に失敗しました");
		} finally {
			setBusy(false);
		}
	};

	return (
		<Modal title={`権限の割り当て — ${user.name}`} onClose={onClose}>
			<ErrorBanner message={error} onDismiss={() => setError("")} />
			{!loaded ? (
				<div className="py-6 text-center text-sm text-[var(--text-muted)]">読み込み中…</div>
			) : (
				<div className="space-y-4">
					<p className="text-sm text-[var(--text-muted)]">
						read = 読むだけ / write = 読み書き（そのアドレスで送信も可能）。エイリアスには write を付けないでください。
					</p>
					<div className="max-h-96 overflow-y-auto rounded-md border border-[var(--line)]">
						<div className="overflow-x-auto">
						<table className="w-full min-w-[720px]">
							<thead className="sticky top-0 bg-[var(--surface-sunken)]">
								<tr className="border-b border-[var(--line)]">
									<th className={thCls}>アドレス</th>
									<th className={thCls}>権限</th>
								</tr>
							</thead>
							<tbody>
								{addresses.map((a) => (
									<TableRow key={a.id}>
										<td className={tdCls}>
											<div className="font-medium text-[var(--text)]">{a.address}</div>
											<div className="text-xs text-[var(--text-muted)]">
												{a.kind === "alias" ? "エイリアス" : "メールボックス"}
											</div>
										</td>
										<td className={tdCls}>
											<Select
												value={levels[a.id] ?? ""}
												onChange={(e) => {
													const v = e.target.value as "" | "read" | "write";
													setLevels((prev) => {
														const next = { ...prev };
														if (v === "") delete next[a.id];
														else next[a.id] = v;
														return next;
													});
												}}
											>
												<option value="">なし</option>
												<option value="read">read</option>
												<option value="write">write</option>
											</Select>
										</td>
									</TableRow>
								))}
							</tbody>
						</table>
						</div>
					</div>
					<div className="flex justify-end gap-2">
						<Button variant="secondary" onClick={onClose}>
							キャンセル
						</Button>
						<Button onClick={save} disabled={busy}>
							保存する
						</Button>
					</div>
				</div>
			)}
		</Modal>
	);
}

function EditUserModal({
	user,
	onClose,
	onSaved,
}: {
	user: AdminUser;
	onClose: () => void;
	onSaved: () => void;
}) {
	const [name, setName] = useState(user.name);
	const [role, setRole] = useState<AdminUser["role"]>(user.role);
	const [status, setStatus] = useState<AdminUser["status"]>(user.status);
	const [password, setPassword] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	// agent はパスワードを持たない。ロールを agent にすると既存のハッシュも消える。
	const passwordAllowed = role !== "agent";

	const save = async () => {
		setError("");
		setBusy(true);
		try {
			await api.patch(`/api/v1/admin/users/${user.id}`, {
				name: name.trim(),
				role,
				status,
				password: passwordAllowed && password ? password : undefined,
			});
			onSaved();
		} catch (e) {
			setError(e instanceof ApiClientError ? e.message : "ユーザーの更新に失敗しました");
		} finally {
			setBusy(false);
		}
	};

	const valid = name.trim().length > 0 && (!password || password.length >= 12);

	return (
		<Modal title="ユーザーを編集" onClose={onClose}>
			<ErrorBanner message={error} onDismiss={() => setError("")} />
			<div className="space-y-4">
				<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md bg-[var(--surface-sunken)] px-4 py-3 text-sm">
					<dt className="text-[var(--text-muted)]">メールアドレス</dt>
					<dd className="font-medium text-[var(--text)]">{user.email}</dd>
					<dt className="text-[var(--text-muted)]">作成日</dt>
					<dd className="text-[var(--text)]">{formatDateTime(user.createdAt)}</dd>
				</dl>

				<div>
					<Label>名前</Label>
					<TextInput value={name} onChange={(e) => setName(e.target.value)} />
				</div>

				<div>
					<Label>ロール</Label>
					<Select
						value={role}
						onChange={(e) => setRole(e.target.value as AdminUser["role"])}
					>
						<option value="owner">オーナー</option>
						<option value="member">メンバー</option>
						<option value="agent">AI エージェント</option>
					</Select>
					{role === "agent" && user.role !== "agent" && (
						<p className="mt-1 text-xs text-[var(--danger)]">
							AI エージェントにするとパスワードが消え、ログインできなくなります。API キーだけで動きます。
						</p>
					)}
				</div>

				<div>
					<Label>状態</Label>
					<Select
						value={status}
						onChange={(e) => setStatus(e.target.value as AdminUser["status"])}
					>
						<option value="active">有効</option>
						<option value="disabled">無効</option>
					</Select>
				</div>

				{passwordAllowed && (
					<div>
						<Label>パスワードを変更（12 文字以上・空なら変更しない）</Label>
						<TextInput
							type="password"
							autoComplete="new-password"
							value={password}
							onChange={(e) => setPassword(e.target.value)}
						/>
					</div>
				)}

				<Notice tone="warn">
					ロール・状態・パスワードのいずれかを変えると、この利用者の既存セッションは全部切れます。
				</Notice>

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

export function UsersPage() {
	const [users, setUsers] = useState<AdminUser[]>([]);
	const [addresses, setAddresses] = useState<AdminAddress[]>([]);
	const [error, setError] = useState("");
	const [showCreate, setShowCreate] = useState(false);
	const [editTarget, setEditTarget] = useState<AdminUser | null>(null);
	const [grantsTarget, setGrantsTarget] = useState<AdminUser | null>(null);
	const [disableTarget, setDisableTarget] = useState<AdminUser | null>(null);

	const load = useCallback(async () => {
		try {
			const [userList, addressList] = await Promise.all([
				getAllPages<AdminUser>("/api/v1/admin/users"),
				getAllPages<AdminAddress>("/api/v1/admin/addresses"),
			]);
			setUsers(userList);
			setAddresses(addressList);
		} catch (e) {
			setError(e instanceof ApiClientError ? e.message : "一覧の取得に失敗しました");
		}
	}, []);

	useEffect(() => {
		load();
	}, [load]);

	const toggleDisable = async (u: AdminUser) => {
		setError("");
		try {
			await api.patch(`/api/v1/admin/users/${u.id}`, {
				status: u.status === "disabled" ? "active" : "disabled",
			});
			setDisableTarget(null);
			await load();
		} catch (e) {
			setError(e instanceof ApiClientError ? e.message : "状態の更新に失敗しました");
		}
	};

	return (
		<AdminGate>
			<Page title="ユーザー管理">
				<div className="mb-4">
					<div className="rounded-md border border-[var(--line)] bg-[var(--surface)] px-4 py-3 text-sm text-[var(--text-muted)]">
						オーナーが社内メンバーと AI エージェントを作成します。自己登録はありません。各ユーザーに
						アドレスごとの権限（read / write）を割り当てられます。AI エージェントは
						AI エージェント（agent）ロールで作ります。
					</div>
				</div>
				<ErrorBanner message={error} onDismiss={() => setError("")} />
				<Card>
					<CardHeader
						title="ユーザー"
						description="人と AI のアカウント一覧"
						action={<Button onClick={() => setShowCreate(true)}>ユーザーを作成</Button>}
					/>
					{users.length === 0 ? (
						<EmptyState message="ユーザーがまだありません。" />
					) : (
						<div className="overflow-x-auto">
						<table className="w-full min-w-[720px]">
							<thead>
								<tr className="border-b border-[var(--line)] bg-[var(--surface-sunken)]">
									<th className={thCls}>名前</th>
									<th className={thCls}>メール</th>
									<th className={thCls}>ロール</th>
									<th className={thCls}>状態</th>
									<th className={thCls}>作成日</th>
									<th className={thCls}>操作</th>
								</tr>
							</thead>
							<tbody>
								{users.map((u) => (
									<TableRow key={u.id}>
										<td className={tdCls}>
											<span className="font-medium text-[var(--text)]">{u.name}</span>
										</td>
										<td className={tdCls}>{u.email}</td>
										<td className={tdCls}>
											<Badge color={roleBadge(u.role)}>{roleLabels[u.role]}</Badge>
										</td>
										<td className={tdCls}>
											<Badge color={u.status === "active" ? "green" : "red"}>
												{u.status === "active" ? "有効" : "無効"}
											</Badge>
										</td>
										<td className={tdCls}>{formatDateTime(u.createdAt)}</td>
										<td className={tdCls}>
											<div className="flex gap-2">
												<Button variant="secondary" onClick={() => setEditTarget(u)}>
													編集
												</Button>
												<Button variant="secondary" onClick={() => setGrantsTarget(u)}>
													権限
												</Button>
												<Button variant="secondary" onClick={() => setDisableTarget(u)}>
													{u.status === "active" ? "無効化" : "再有効化"}
												</Button>
											</div>
										</td>
									</TableRow>
								))}
							</tbody>
						</table>
						</div>
					)}
				</Card>

				{showCreate && (
					<CreateUserModal
						onClose={() => setShowCreate(false)}
						onCreated={() => {
							setShowCreate(false);
							load();
						}}
					/>
				)}

				{editTarget && (
					<EditUserModal
						user={editTarget}
						onClose={() => setEditTarget(null)}
						onSaved={() => {
							setEditTarget(null);
							load();
						}}
					/>
				)}

				{grantsTarget && (
					<GrantsModal
						user={grantsTarget}
						addresses={addresses}
						onClose={() => setGrantsTarget(null)}
						onSaved={() => {
							setGrantsTarget(null);
						}}
					/>
				)}

				{disableTarget && (
					<Modal title="ユーザーの状態" onClose={() => setDisableTarget(null)}>
						<div className="space-y-4">
							<div className="text-sm text-[var(--text)]">
								<strong>{disableTarget.name}</strong>（{disableTarget.email}）を
								{disableTarget.status === "active" ? "無効化" : "再有効化"}
								します。無効化すると既存のセッションと API キーが無効になります。
							</div>
							<div className="flex justify-end gap-2">
								<Button variant="secondary" onClick={() => setDisableTarget(null)}>
									キャンセル
								</Button>
								<Button variant="danger" onClick={() => toggleDisable(disableTarget)}>
									{disableTarget.status === "active" ? "無効化する" : "再有効化する"}
								</Button>
							</div>
						</div>
					</Modal>
				)}
			</Page>
		</AdminGate>
	);
}
