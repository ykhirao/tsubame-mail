import { useEffect, useState } from "react";
import { AuthApi } from "@/ui/lib/api";

export type SetupState = "loading" | "needs-setup" | "ready";

/** Turnstile の sitekey は同じ口から来る。未設定の環境では null。 */
export function useSetupState(): { state: SetupState; turnstileSitekey: string | null } {
	const [state, setState] = useState<SetupState>("loading");
	const [turnstileSitekey, setTurnstileSitekey] = useState<string | null>(null);

	useEffect(() => {
		let alive = true;
		AuthApi.setupState()
			.then((r) => {
				if (!alive) return;
				setState(r.needsSetup ? "needs-setup" : "ready");
				setTurnstileSitekey(r.turnstileSitekey ?? null);
			})
			// 判定できないときは ready に倒す。オーナー作成画面を晒すより、
			// ログイン画面を出して失敗させる方が安全側。
			.catch(() => alive && setState("ready"));
		return () => {
			alive = false;
		};
	}, []);

	return { state, turnstileSitekey };
}
