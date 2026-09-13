import { forgetRegisteredDevice } from "@/ui/lib/push";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useState,
	type ReactNode,
} from "react";
import { ApiError, AuthApi, BASE_URL, MeApi, type Me } from "@/ui/lib/api";

export type AuthStatus = "loading" | "guest" | "authenticated";

export type MeWithAdminMode = Me & {
	adminMode?: boolean;
	adminModeUntil?: number | null;
	ownAddressIds?: string[] | "all";
};

type AuthContextValue = {
	status: AuthStatus;
	me: MeWithAdminMode | null;
	/** ログイン・bootstrap の成功後に呼ぶこと。呼ばないと me が古いままになる。 */
	refresh: () => Promise<void>;
	login: (email: string, password: string, turnstileToken?: string | null) => Promise<void>;
	logout: () => Promise<void>;
	/** 管理者モードのオン・オフ。切り替え後は me を読み直す。 */
	setAdminMode: (enabled: boolean) => Promise<void>;
};

const Ctx = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
	const [status, setStatus] = useState<AuthStatus>("loading");
	const [me, setMe] = useState<MeWithAdminMode | null>(null);

	const refresh = useCallback(async () => {
		try {
			const m = await MeApi.get();
			setMe(m);
			setStatus("authenticated");
		} catch (e) {
			// ネットワーク障害も 401 と同じく guest に倒す。ログイン画面なら復帰できる。
			setMe(null);
			setStatus(e instanceof ApiError && e.status !== 401 ? "guest" : "guest");
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const login = useCallback(
		async (email: string, password: string, turnstileToken?: string | null) => {
			await AuthApi.login(email, password, turnstileToken);
			await refresh();
		},
		[refresh],
	);

	const logout = useCallback(async () => {
		try {
			await AuthApi.logout();
		} catch {
			/* サーバ側が失敗してもクライアントは guest に落とす。 */
		}
		forgetRegisteredDevice();
		setMe(null);
		setStatus("guest");
	}, []);

	const setAdminMode = useCallback(
		async (enabled: boolean) => {
			const res = await fetch(`${BASE_URL}/me/admin-mode`, {
				method: "POST",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ enabled }),
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
				throw new ApiError("admin_mode_failed", body?.error?.message ?? "管理者モードを切り替えられませんでした", res.status);
			}
			await refresh();
		},
		[refresh],
	);

	return (
		<Ctx.Provider value={{ status, me, refresh, login, logout, setAdminMode }}>
			{children}
		</Ctx.Provider>
	);
}

export function useAuth(): AuthContextValue {
	const ctx = useContext(Ctx);
	if (!ctx) throw new Error("useAuth は AuthProvider の中で使ってください");
	return ctx;
}
