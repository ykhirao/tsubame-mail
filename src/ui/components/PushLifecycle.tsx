import { useEffect } from "react";
import { Navigate, Outlet, useLocation } from "react-router";
import { ensureSubscriptionFresh, shouldShowNotificationWelcome, useDeviceHeartbeat } from "@/ui/lib/push";
import { useAuth } from "@/ui/lib/auth";
import { closeThreadNotifications, syncAppBadge } from "@/ui/lib/badge";

export function PushLifecycle() {
	const location = useLocation();
	const { me } = useAuth();
	useDeviceHeartbeat();

	// 会話を開くと既読の PATCH が少し遅れて走るので、落ち着いてからバッジを数え直す。
	useEffect(() => {
		const threadId = /^\/threads\/([^/]+)/.exec(location.pathname)?.[1];
		if (threadId) void closeThreadNotifications(threadId);
		const timer = setTimeout(() => void syncAppBadge(), 1500);
		return () => clearTimeout(timer);
	}, [location.pathname, location.search]);

	useEffect(() => {
		const onVisible = () => {
			if (document.visibilityState === "visible") void syncAppBadge();
		};
		document.addEventListener("visibilitychange", onVisible);
		const timer = setInterval(() => void syncAppBadge(), 60_000);
		return () => {
			document.removeEventListener("visibilitychange", onVisible);
			clearInterval(timer);
		};
	}, []);

	useEffect(() => {
		void ensureSubscriptionFresh();
	}, []);

	// 仮パスワードのままなら、通知の案内も通さず変更へ寄せる（FR-13-a）。
	if (me?.mustChangePassword && location.pathname === "/welcome/notifications") {
		return <Navigate to="/change-password" replace />;
	}
	// ホーム画面のアプリで初めて開いたときだけ。通知から開いた会話には割り込まない。
	if (me?.mustChangePassword && location.pathname === "/") return <Outlet />;
	if (location.pathname === "/" && shouldShowNotificationWelcome()) {
		return <Navigate to="/welcome/notifications" replace />;
	}
	return <Outlet />;
}
