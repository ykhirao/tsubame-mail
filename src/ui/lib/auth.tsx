import { forgetRegisteredDevice } from "@/ui/lib/push";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useState,
	type ReactNode,
} from "react";
import { ApiError, AuthApi, MeApi, type Me } from "@/ui/lib/api";

export type AuthStatus = "loading" | "guest" | "authenticated";

type AuthContextValue = {
	status: AuthStatus;
	me: Me | null;
	/** ログイン・bootstrap の成功後に呼ぶこと。呼ばないと me が古いままになる。 */
	refresh: () => Promise<void>;
	login: (email: string, password: string) => Promise<void>;
	logout: () => Promise<void>;
};

const Ctx = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
	const [status, setStatus] = useState<AuthStatus>("loading");
	const [me, setMe] = useState<Me | null>(null);

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
		async (email: string, password: string) => {
			await AuthApi.login(email, password);
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

	return (
		<Ctx.Provider value={{ status, me, refresh, login, logout }}>{children}</Ctx.Provider>
	);
}

export function useAuth(): AuthContextValue {
	const ctx = useContext(Ctx);
	if (!ctx) throw new Error("useAuth は AuthProvider の中で使ってください");
	return ctx;
}
