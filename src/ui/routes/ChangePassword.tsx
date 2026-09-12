import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { MeApi } from "@/ui/lib/api";

export function ChangePassword() {
	const navigate = useNavigate();
	const [current, setCurrent] = useState("");
	const [next, setNext] = useState("");
	const [confirm, setConfirm] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		if (next !== confirm) {
			setError("新しいパスワードが一致しません");
			return;
		}
		setBusy(true);
		setError("");
		try {
			const res = await MeApi.update({ currentPassword: current, newPassword: next });
			// パスワード変更でサーバ側の全セッションと API キーが失効する（#99）。失効本数を伝える。
			const revoked =
				res.revokedApiKeys > 0 ? `発行済みの API キーは失効しました（${res.revokedApiKeys} 本）。` : "";
			setNotice(
				`パスワードを変更しました。${revoked}全セッションが切れたので、ログインし直してください。`,
			);
		} catch (err) {
			setError(err instanceof Error ? err.message : "変更できませんでした");
		} finally {
			setBusy(false);
		}
	};

	const field =
		"mb-3 w-full min-h-11 rounded border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)] sm:min-h-0";

	return (
		<div className="safe-bottom flex min-h-screen items-center justify-center bg-[var(--surface-sunken)] p-4">
			<form
				onSubmit={submit}
				className="w-full max-w-sm rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-6"
			>
				{notice ? (
					<>
						<h1 className="mb-2 text-xl font-bold text-[var(--text)]">パスワードを変更しました</h1>
						<p className="mb-4 text-sm text-[var(--text-muted)]">{notice}</p>
						<button
							type="button"
							onClick={() => navigate("/login?changed=1", { replace: true })}
							className="w-full min-h-11 rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white sm:min-h-0"
						>
							ログインページへ
						</button>
					</>
				) : (
					<>
						<h1 className="mb-1 text-xl font-bold text-[var(--text)]">パスワードを変更してください</h1>
						<p className="mb-4 text-sm text-[var(--text-muted)]">
							仮パスワードでログインしています。自分のパスワードに変えるまで先に進めません。
						</p>

						<label className="mb-1 block text-sm text-[var(--text)]">いまのパスワード（仮）</label>
						<input
							type="password"
							required
							autoComplete="current-password"
							value={current}
							onChange={(e) => setCurrent(e.target.value)}
							className={field}
						/>

						<label className="mb-1 block text-sm text-[var(--text)]">新しいパスワード（12 文字以上）</label>
						<input
							type="password"
							required
							minLength={12}
							autoComplete="new-password"
							value={next}
							onChange={(e) => setNext(e.target.value)}
							className={field}
						/>

						<label className="mb-1 block text-sm text-[var(--text)]">もう一度</label>
						<input
							type="password"
							required
							minLength={12}
							autoComplete="new-password"
							value={confirm}
							onChange={(e) => setConfirm(e.target.value)}
							className={field}
						/>

						{error && <p className="mb-3 text-sm text-[var(--danger)]">{error}</p>}

						<div className="mb-4 rounded-md border border-[var(--line)] bg-[var(--surface-sunken)] px-3 py-2 text-xs text-[var(--text-muted)]">
							パスワードを変えると、あなたの API キーはすべて失効します。
						</div>

						<button
							type="submit"
							disabled={busy}
							className="w-full min-h-11 rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50 sm:min-h-0"
						>
							{busy ? "変更中…" : "変更する"}
						</button>
					</>
				)}
			</form>
		</div>
	);
}
