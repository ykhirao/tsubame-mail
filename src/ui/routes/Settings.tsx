import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { useAuth } from "@/ui/lib/auth";
import { MyApiKeys } from "@/ui/components/MyApiKeys";
import { MeApi } from "@/ui/lib/api";

const inputCls =
	"w-full min-h-11 rounded border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none sm:min-h-0";

const saveBtnCls =
	"rounded-full bg-[var(--accent)] px-5 py-2 text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 min-h-11 sm:min-h-0";

export function Settings() {
	const { me, refresh } = useAuth();
	const [name, setName] = useState(me?.name ?? "");
	const [savingName, setSavingName] = useState(false);
	const [nameMsg, setNameMsg] = useState<string | null>(null);

	const [currentPassword, setCurrentPassword] = useState("");
	const [newPassword, setNewPassword] = useState("");
	const [savingPw, setSavingPw] = useState(false);
	const [pwMsg, setPwMsg] = useState<string | null>(null);
	const [pwError, setPwError] = useState<string | null>(null);

	const saveName = async (e: FormEvent) => {
		e.preventDefault();
		setSavingName(true);
		setNameMsg(null);
		try {
			await MeApi.update({ name: name.trim() });
			await refresh();
			setNameMsg("表示名を更新しました");
		} catch (err) {
			setNameMsg(err instanceof Error ? err.message : "更新に失敗しました");
		} finally {
			setSavingName(false);
		}
	};

	const savePassword = async (e: FormEvent) => {
		e.preventDefault();
		if (newPassword.length < 12) {
			setPwError("新しいパスワードは 12 文字以上にしてください");
			return;
		}
		setSavingPw(true);
		setPwMsg(null);
		setPwError(null);
		try {
			await MeApi.update({
				currentPassword,
				newPassword,
			});
			setPwMsg("パスワードを変更しました。再度ログインしてください");
			setCurrentPassword("");
			setNewPassword("");
		} catch (err) {
			setPwError(err instanceof Error ? err.message : "変更に失敗しました");
		} finally {
			setSavingPw(false);
		}
	};

	return (
		<div className="mx-auto flex w-full max-w-xl flex-col gap-6 safe-bottom">
			<div>
				<h1 className="mb-1 text-lg font-bold text-[var(--text)]">設定</h1>
				<p className="mb-4 text-sm text-[var(--text-muted)]">
					{me?.name}（{me?.email}）のアカウント設定
				</p>
			</div>

			<form
				onSubmit={saveName}
				className="card flex flex-col gap-3 p-5"
			>
				<h2 className="text-sm font-semibold text-[var(--text)]">表示名</h2>
				<div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
					<label className="w-24 shrink-0 text-sm text-[var(--text-muted)]">表示名</label>
					<input
						value={name}
						onChange={(e) => setName(e.target.value)}
						maxLength={100}
						className={inputCls}
					/>
				</div>
				{nameMsg && <div className="text-sm text-[var(--text-muted)]">{nameMsg}</div>}
				<div className="flex justify-end">
					<button type="submit" disabled={savingName} className={saveBtnCls}>
						{savingName ? "保存中…" : "保存"}
					</button>
				</div>
			</form>

			<form onSubmit={savePassword} className="card flex flex-col gap-3 p-5">
				<h2 className="text-sm font-semibold text-[var(--text)]">パスワード変更</h2>
				<div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
					<label className="w-24 shrink-0 text-sm text-[var(--text-muted)]">現在のパスワード</label>
					<input
						type="password"
						autoComplete="current-password"
						value={currentPassword}
						onChange={(e) => setCurrentPassword(e.target.value)}
						className={inputCls}
					/>
				</div>
				<div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
					<label className="w-24 shrink-0 text-sm text-[var(--text-muted)]">新しいパスワード</label>
					<input
						type="password"
						autoComplete="new-password"
						minLength={12}
						value={newPassword}
						onChange={(e) => setNewPassword(e.target.value)}
						className={inputCls}
					/>
				</div>
				<p className="text-xs text-[var(--text-muted)]">12 文字以上</p>
				{pwMsg && (
					<div className="rounded border border-[var(--success)] bg-[var(--surface-hover)] px-3 py-2 text-sm text-[var(--success)]">
						{pwMsg}
					</div>
				)}
				{pwError && (
					<div className="rounded border border-[var(--danger)] bg-[var(--surface-hover)] px-3 py-2 text-sm text-[var(--danger)]">
						{pwError}
					</div>
				)}
				<div className="flex justify-end">
					<button type="submit" disabled={savingPw} className={saveBtnCls}>
						{savingPw ? "変更中…" : "パスワードを変更"}
					</button>
				</div>
			</form>

			<Link
				to="/settings/notifications"
				className="card flex min-h-12 items-center justify-between px-5 py-4 text-sm font-medium text-[var(--text)] transition-colors hover:bg-[var(--surface-hover)]"
			>
				<span>通知設定</span>
				<span className="text-[var(--text-muted)]">›</span>
			</Link>
			<MyApiKeys addresses={me?.addresses ?? []} />
		</div>
	);
}
