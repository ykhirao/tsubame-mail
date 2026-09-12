import { useEffect, useState } from "react";
import { UsersApi } from "@/ui/lib/api";
import { getAllPages } from "@/ui/routes/admin/api";

type DomainOption = { id: string; name: string };
type AddressOption = { id: string; address: string; kind: string; archivedAt: number | null };

// 仮パスワードはこの画面でしか表示されない。閉じたらもう誰も平文を読めない。
export function AddMemberDialog({ onClose }: { onClose: () => void }) {
	const [email, setEmail] = useState("");
	const [name, setName] = useState("");
	const [role, setRole] = useState<"member" | "agent">("member");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [issued, setIssued] = useState<{ email: string; password: string | null } | null>(null);
	const [copied, setCopied] = useState(false);
	const [primaryMode, setPrimaryMode] = useState<"new" | "existing">("new");
	const [domains, setDomains] = useState<DomainOption[]>([]);
	const [mailboxes, setMailboxes] = useState<AddressOption[]>([]);
	const [domainId, setDomainId] = useState("");
	const [localPart, setLocalPart] = useState("");
	const [addressId, setAddressId] = useState("");

	useEffect(() => {
		let alive = true;
		void Promise.all([
			getAllPages<DomainOption>("/api/v1/admin/domains"),
			getAllPages<AddressOption>("/api/v1/admin/addresses"),
		])
			.then(([ds, as]) => {
				if (!alive) return;
				setDomains(ds);
				setDomainId((cur) => cur || ds[0]?.id || "");
				setMailboxes(as.filter((a) => a.kind === "mailbox" && a.archivedAt === null));
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, []);

	const primaryDomain = domains.find((d) => d.id === domainId)?.name ?? "";

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		setBusy(true);
		setError("");
		try {
			const external = email.trim().toLowerCase();
			const created = await UsersApi.create({
				...(external ? { email: external } : {}),
				name: name.trim(),
				role,
				primaryAddress:
					primaryMode === "new" ? { domainId, localPart: localPart.trim().toLowerCase() } : { addressId },
			});
			const login =
				primaryMode === "new"
					? `${localPart.trim().toLowerCase()}@${primaryDomain}`
					: (mailboxes.find((m) => m.id === addressId)?.address ?? created.email);
			setIssued({ email: login, password: created.temporaryPassword });
		} catch (err) {
			setError(err instanceof Error ? err.message : "追加できませんでした");
		} finally {
			setBusy(false);
		}
	};

	const field =
		"w-full rounded border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-base md:text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]";

	return (
		<div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 md:items-center md:p-4">
			<div className="flex max-h-[92dvh] w-full max-w-md flex-col overflow-y-auto rounded-t-2xl border border-[var(--line)] bg-[var(--surface)] p-6 pb-[env(safe-area-inset-bottom)] shadow-lg md:rounded-2xl md:pb-6">
				{issued ? (
					<>
						<h2 className="mb-1 text-lg font-bold text-[var(--text)]">メンバーを追加しました</h2>
						<p className="mb-4 text-sm text-[var(--text-muted)]">ログイン: {issued.email}</p>

						{issued.password ? (
							<>
								<div className="mb-3 border-l-4 border-[var(--warning)] bg-[var(--surface-sunken)] p-3 text-sm text-[var(--text)]">
									この仮パスワードは<strong>この画面を閉じると二度と表示できません</strong>。
									本人に渡してください。初回ログイン後に変更を求められます。
								</div>
								<div className="mb-4 flex items-center gap-2">
									<code className="flex-1 truncate rounded bg-[var(--surface-sunken)] px-3 py-2 font-mono text-sm text-[var(--text)]">
										{issued.password}
									</code>
									<button
										type="button"
										onClick={() => {
											void navigator.clipboard?.writeText(issued.password ?? "");
											setCopied(true);
										}}
										className="shrink-0 rounded-full border border-[var(--line)] px-3 py-2 text-sm max-md:min-h-11 text-[var(--text)] hover:bg-[var(--surface-hover)]"
									>
										{copied ? "コピーしました" : "コピー"}
									</button>
								</div>
							</>
						) : (
							<p className="mb-4 text-sm text-[var(--text-muted)]">
								AI 用のアカウントなのでパスワードはありません。管理画面から API キーを発行してください。
							</p>
						)}

						<button
							type="button"
							onClick={onClose}
							className="w-full rounded-full bg-[var(--accent)] px-4 py-2 text-sm max-md:min-h-11 font-medium text-white"
						>
							閉じる
						</button>
					</>
				) : (
					<form onSubmit={submit}>
						<h2 className="mb-4 text-lg font-bold text-[var(--text)]">メンバーを追加</h2>

						<label className="mb-1 block text-sm text-[var(--text)]">名前</label>
						<input
							required
							value={name}
							onChange={(e) => setName(e.target.value)}
							className={`${field} mb-3`}
						/>

						<label className="mb-1 block text-sm text-[var(--text)]">プライマリアドレス</label>
						<p className="mb-1 text-xs text-[var(--text-muted)]">
							この人のメールボックス。ログインにも使える。本人に割り当てられ、他の人からは見えない。
						</p>
						<div className="mb-2 flex gap-4 text-sm text-[var(--text)]">
							<label className="flex items-center gap-1.5">
								<input type="radio" checked={primaryMode === "new"} onChange={() => setPrimaryMode("new")} />
								新しく作る
							</label>
							<label className="flex items-center gap-1.5">
								<input
									type="radio"
									checked={primaryMode === "existing"}
									onChange={() => setPrimaryMode("existing")}
								/>
								既存から選ぶ
							</label>
						</div>
						{primaryMode === "new" ? (
							<div className="mb-3 flex items-center gap-1">
								<input
									required
									value={localPart}
									onChange={(e) => setLocalPart(e.target.value)}
									placeholder="tanaka"
									className={`${field} min-w-0 flex-1`}
								/>
								<span className="shrink-0 text-sm text-[var(--text-muted)]">@</span>
								<select value={domainId} onChange={(e) => setDomainId(e.target.value)} className={`${field} min-w-0 flex-1`}>
									{domains.map((d) => (
										<option key={d.id} value={d.id}>
											{d.name}
										</option>
									))}
								</select>
							</div>
						) : (
							<select
								required
								value={addressId}
								onChange={(e) => setAddressId(e.target.value)}
								className={`${field} mb-3`}
							>
								<option value="">選んでください</option>
								{mailboxes.map((m) => (
									<option key={m.id} value={m.id}>
										{m.address}
									</option>
								))}
							</select>
						)}

						<label className="mb-1 block text-sm text-[var(--text)]">外部アドレス（任意）</label>
						<p className="mb-1 text-xs text-[var(--text-muted)]">
							Gmail など。本人が後から登録・確認してもよい。確認するまではログインに使えない。
						</p>
						<input
							type="email"
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							className={`${field} mb-3`}
						/>

						<label className="mb-1 block text-sm text-[var(--text)]">種類</label>
						<select
							value={role}
							onChange={(e) => setRole(e.target.value as "member" | "agent")}
							className={`${field} mb-1`}
						>
							<option value="member">メンバー（人が使う）</option>
							<option value="agent">エージェント（AI が API キーで使う）</option>
						</select>
						<p className="mb-4 text-xs text-[var(--text-muted)]">
							プライマリ以外に触れるメールボックスは、管理画面で割り当てる。
						</p>

						{error && <p className="mb-3 text-sm text-[var(--danger)]">{error}</p>}

						<div className="flex gap-2">
							<button
								type="submit"
								disabled={busy}
								className="flex-1 rounded-full bg-[var(--accent)] px-4 py-2 text-sm max-md:min-h-11 font-medium text-white disabled:opacity-50"
							>
								{busy ? "追加中…" : "追加する"}
							</button>
							<button
								type="button"
								onClick={onClose}
								className="rounded-full border border-[var(--line)] px-4 py-2 text-sm max-md:min-h-11 text-[var(--text)]"
							>
								やめる
							</button>
						</div>
					</form>
				)}
			</div>
		</div>
	);
}
