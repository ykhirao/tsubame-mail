import { useState } from "react";
import { UsersApi } from "@/ui/lib/api";

// 仮パスワードはこの画面でしか表示されない。閉じたらもう誰も平文を読めない。
export function AddMemberDialog({ onClose }: { onClose: () => void }) {
	const [email, setEmail] = useState("");
	const [name, setName] = useState("");
	const [role, setRole] = useState<"member" | "agent">("member");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [issued, setIssued] = useState<{ email: string; password: string | null } | null>(null);
	const [copied, setCopied] = useState(false);

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		setBusy(true);
		setError("");
		try {
			const created = await UsersApi.create({
				email: email.trim().toLowerCase(),
				name: name.trim(),
				role,
			});
			setIssued({ email: created.email, password: created.temporaryPassword });
		} catch (err) {
			setError(err instanceof Error ? err.message : "追加できませんでした");
		} finally {
			setBusy(false);
		}
	};

	const field =
		"w-full rounded border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]";

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
			<div className="w-full max-w-md rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-6 shadow-lg">
				{issued ? (
					<>
						<h2 className="mb-1 text-lg font-bold text-[var(--text)]">メンバーを追加しました</h2>
						<p className="mb-4 text-sm text-[var(--text-muted)]">{issued.email}</p>

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
										className="shrink-0 rounded-full border border-[var(--line)] px-3 py-2 text-sm text-[var(--text)] hover:bg-[var(--surface-hover)]"
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
							className="w-full rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white"
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

						<label className="mb-1 block text-sm text-[var(--text)]">メールアドレス</label>
						<p className="mb-1 text-xs text-[var(--text-muted)]">
							ログインに使うだけなので、このアプリで受信するアドレスでなくてよい。
						</p>
						<input
							type="email"
							required
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
							どちらも、触れるメールボックスは管理画面で割り当てる。
						</p>

						{error && <p className="mb-3 text-sm text-[var(--danger)]">{error}</p>}

						<div className="flex gap-2">
							<button
								type="submit"
								disabled={busy}
								className="flex-1 rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
							>
								{busy ? "追加中…" : "追加する"}
							</button>
							<button
								type="button"
								onClick={onClose}
								className="rounded-full border border-[var(--line)] px-4 py-2 text-sm text-[var(--text)]"
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
