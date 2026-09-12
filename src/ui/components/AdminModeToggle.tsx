import { useAuth } from "@/ui/lib/auth";

/** owner だけに出す管理者モードの切り替えボタン。FR-19。 */
export function AdminModeToggle() {
	const { me, setAdminMode } = useAuth();
	if (!me || me.role !== "owner") return null;
	const inMode = me.adminMode === true;

	const toggle = async () => {
		const ok = window.confirm(
			inMode
				? "管理者モードを終えますか？"
				: "管理者モードでは全員のメールを読めます。1 時間で自動で切れ、入ったことは記録されます。",
		);
		if (!ok) return;
		try {
			await setAdminMode(!inMode);
		} catch {
			return;
		}
		// 読める範囲が変わるので表示を最初から読み直す。
		window.location.reload();
	};

	return (
		<button
			type="button"
			onClick={() => void toggle()}
			aria-pressed={inMode}
			className={`pill border px-3 py-1 text-sm transition-colors hover:bg-[var(--surface-hover)] ${
				inMode
					? "border-[var(--danger)]/40 bg-[var(--danger)]/10 text-[var(--danger)]"
					: "border-[var(--line)] text-[var(--text-muted)]"
			}`}
		>
			{inMode ? "管理者モードを終える" : "管理者モード"}
		</button>
	);
}
