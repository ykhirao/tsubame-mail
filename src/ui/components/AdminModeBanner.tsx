import { useEffect, useState } from "react";
import { useAuth } from "@/ui/lib/auth";

/** 管理者モード中だけ画面上部に出す常設の帯。1 時間で切れ、期限超過は me を読み直して消す。FR-19。 */
export function AdminModeBanner() {
	const { me, setAdminMode, refresh } = useAuth();
	const inMode = me?.adminMode === true;
	const until = me?.adminModeUntil ?? null;
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		if (!inMode || until == null) return;
		setNow(Date.now());
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, [inMode, until]);

	useEffect(() => {
		if (!inMode || until == null) return;
		if (until * 1000 <= Date.now()) void refresh();
	}, [inMode, until, now, refresh]);

	if (!inMode || until == null) return null;
	const remainMs = Math.max(0, until * 1000 - now);
	const mm = String(Math.floor(remainMs / 60000)).padStart(2, "0");
	const ss = String(Math.floor((remainMs % 60000) / 1000)).padStart(2, "0");

	const end = async () => {
		try {
			await setAdminMode(false);
		} catch {
			return;
		}
		window.location.reload();
	};

	return (
		<div className="flex items-center justify-center gap-3 bg-[var(--danger)] px-4 py-1.5 text-xs text-white">
			<span className="font-medium">管理者モード中 — 全員のメールを読めます（あと {mm}:{ss}）</span>
			<button
				type="button"
				onClick={() => void end()}
				className="rounded border border-white/40 px-2 py-0.5 transition-colors hover:bg-white/15"
			>
				終える
			</button>
		</div>
	);
}
