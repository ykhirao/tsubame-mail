import { useEffect, useState } from "react";
import { AuthApi } from "@/ui/lib/api";

export type SetupState = "loading" | "needs-setup" | "ready";

export function useSetupState(): SetupState {
	const [state, setState] = useState<SetupState>("loading");

	useEffect(() => {
		let alive = true;
		AuthApi.setupState()
			.then((r) => alive && setState(r.needsSetup ? "needs-setup" : "ready"))
			// 判定できないときは ready に倒す。オーナー作成画面を晒すより、
			// ログイン画面を出して失敗させる方が安全側。
			.catch(() => alive && setState("ready"));
		return () => {
			alive = false;
		};
	}, []);

	return state;
}
