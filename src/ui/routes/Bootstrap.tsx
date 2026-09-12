import { Navigate, useNavigate } from "react-router";
import { useState, type FormEvent } from "react";
import { useAuth } from "@/ui/lib/auth";
import { AuthApi } from "@/ui/lib/api";
import { FullScreenSpinner } from "@/ui/components/Spinner";
import { useSetupState } from "@/ui/lib/setup";

// これが唯一の自己登録経路。オーナーが既に居ればサーバが 409 を返す。
export function Bootstrap() {
	const setup = useSetupState();
	const { refresh } = useAuth();
	const navigate = useNavigate();
	const [email, setEmail] = useState("");
	const [name, setName] = useState("");
	const [password, setPassword] = useState("");
	const [secret, setSecret] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const onSubmit = async (e: FormEvent) => {
		e.preventDefault();
		setError(null);
		setBusy(true);
		try {
			await AuthApi.bootstrap(email.trim().toLowerCase(), name.trim(), password, secret.trim());
			await refresh();
			navigate("/", { replace: true });
		} catch (err) {
			if (err instanceof Error && err.message.includes("オーナー")) {
				setError("すでにオーナーが存在します。ログインしてください");
			} else {
				setError(err instanceof Error ? err.message :"初期設定に失敗しました");
			}
		} finally {
			setBusy(false);
		}
	};

	if (setup === "loading") return <FullScreenSpinner />;
	if (setup === "ready") return <Navigate to="/login" replace />;

	return (
		<div className="flex min-h-screen items-center justify-center bg-[var(--surface-sunken)] px-4">
			<form
				onSubmit={onSubmit}
				className="w-full max-w-sm rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-6"
			>
				<h1 className="mb-1 text-2xl font-bold text-[var(--text)]">Tsubame</h1>
				<p className="mb-5 text-sm text-[var(--text-muted)]">
					最初のオーナーアカウントを作成します。管理者はここで 1 人だけ作れます。
				</p>

				{error && (
					<div className="mb-4 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
						{error}
					</div>
				)}

				<label className="mb-1 block text-sm font-medium text-[var(--text)]">
					名前
				</label>
				<input
					type="text"
					required
					maxLength={100}
					value={name}
					onChange={(e) => setName(e.target.value)}
					className="mb-4 w-full rounded border border-[var(--line)] px-3 py-2 text-sm dark:border-[var(--line)]"
				/>

				<label className="mb-1 block text-sm font-medium text-[var(--text)]">
					メールアドレス
				</label>
				<input
					type="email"
					required
					value={email}
					onChange={(e) => setEmail(e.target.value)}
					className="mb-4 w-full rounded border border-[var(--line)] px-3 py-2 text-sm dark:border-[var(--line)]"
				/>

				<label className="mb-1 block text-sm font-medium text-[var(--text)]">
					パスワード（12 文字以上）
				</label>
				<input
					type="password"
					required
					minLength={12}
					autoComplete="new-password"
					value={password}
					onChange={(e) => setPassword(e.target.value)}
					className="mb-5 w-full rounded border border-[var(--line)] px-3 py-2 text-sm dark:border-[var(--line)]"
				/>

				<label className="mb-1 block text-sm font-medium text-[var(--text)]">
					セットアップの合言葉
				</label>
				<p className="mb-1 text-xs text-[var(--text-muted)]">
					デプロイ時に Worker のシークレット <code>INTERNAL_SECRET</code> に入れた値。
					オーナーはドメインの DNS まで触れるため、これを知っている人しか作成できない。
				</p>
				<input
					type="password"
					required
					autoComplete="off"
					value={secret}
					onChange={(e) => setSecret(e.target.value)}
					className="mb-5 w-full rounded border border-[var(--line)] bg-[var(--surface)] px-3 py-2 font-mono text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
				/>

				<button
					type="submit"
					disabled={busy}
					className="w-full min-h-11 rounded bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50 sm:min-h-0"
				>
					{busy ?"作成中…" :"オーナーを作成"}
				</button>
			</form>
		</div>
	);
}
