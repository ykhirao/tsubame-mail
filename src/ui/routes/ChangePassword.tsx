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

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		if (next !== confirm) {
			setError("新しいパスワードが一致しません");
			return;
		}
		setBusy(true);
		setError("");
		try {
			await MeApi.update({ currentPassword: current, newPassword: next });
			// パスワード変更でサーバ側の全セッションが落ちる（自分の分も含む）ので、
			// そのまま留まると次の操作が 401 になる。
			navigate("/login?changed=1", { replace: true });
		} catch (err) {
			setError(err instanceof Error ? err.message : "変更できませんでした");
		} finally {
			setBusy(false);
		}
	};

	const field =
		"mb-3 w-full rounded border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]";

	return (
		<div className="flex min-h-screen items-center justify-center bg-[var(--surface-sunken)] p-4">
			<form
				onSubmit={submit}
				className="w-full max-w-sm rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-6"
			>
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

				<button
					type="submit"
					disabled={busy}
					className="w-full rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
				>
					{busy ? "変更中…" : "変更する"}
				</button>
			</form>
		</div>
	);
}
