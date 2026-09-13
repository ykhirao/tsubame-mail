import { Navigate, useNavigate, useSearchParams } from "react-router";
import { useState, type FormEvent } from "react";
import { useAuth } from "@/ui/lib/auth";
import { FullScreenSpinner } from "@/ui/components/Spinner";
import { useSetupState } from "@/ui/lib/setup";

export function Login() {
	const setup = useSetupState();
	const { login } = useAuth();
	const navigate = useNavigate();
	const [params] = useSearchParams();
	const passwordChanged = params.get("changed") === "1";
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const onSubmit = async (e: FormEvent) => {
		e.preventDefault();
		setError(null);
		setBusy(true);
		try {
			await login(email.trim().toLowerCase(), password);
			const next = params.get("next");
			navigate(next ?? "/", { replace: true });
		} catch (err) {
			setError(err instanceof Error ? err.message : "ログインに失敗しました");
		} finally {
			setBusy(false);
		}
	};

	// オーナーが 1 人も居ない間はログインできる相手が存在しない。作成画面だけを出す。
	if (setup === "loading") return <FullScreenSpinner />;
	if (setup === "needs-setup") return <Navigate to="/bootstrap" replace />;

	const inputCls =
		"mb-4 w-full rounded border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] outline-none transition-colors focus:border-[var(--accent)]";

	return (
		<div className="flex min-h-screen items-center justify-center bg-[var(--surface-sunken)] px-4">
			<form onSubmit={onSubmit} className="card w-full max-w-[400px] p-8">
				<h1 className="mb-1 text-2xl font-bold text-[var(--text)]">Tsubamail</h1>
				{passwordChanged && (
					<p className="mb-3 rounded bg-[var(--surface-sunken)] px-3 py-2 text-sm text-[var(--text)]">
						パスワードを変更しました。新しいパスワードでログインしてください。
					</p>
				)}
				<p className="mb-6 text-sm text-[var(--text-muted)]">メールアドレスとパスワードでログイン</p>

				{error && (
					<div className="mb-4 rounded border border-[var(--danger)] bg-[var(--surface-hover)] px-3 py-2 text-sm text-[var(--danger)]">
						{error}
					</div>
				)}

				<label className="mb-1 block text-sm font-medium text-[var(--text)]">
					メールアドレス
				</label>
				<input
					type="email"
					required
					autoComplete="email"
					value={email}
					onChange={(e) => setEmail(e.target.value)}
					className={inputCls}
				/>

				<label className="mb-1 block text-sm font-medium text-[var(--text)]">
					パスワード
				</label>
				<input
					type="password"
					required
					autoComplete="current-password"
					value={password}
					onChange={(e) => setPassword(e.target.value)}
					className={inputCls}
				/>

				<button
					type="submit"
					disabled={busy}
					className="w-full min-h-11 rounded-full bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50 sm:min-h-0"
				>
					{busy ? "ログイン中…" : "ログイン"}
				</button>
			</form>
		</div>
	);
}
