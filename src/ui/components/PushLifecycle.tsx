import { useEffect } from "react";
import { Navigate, Outlet, useLocation } from "react-router";
import { ensureSubscriptionFresh, shouldShowNotificationWelcome, useDeviceHeartbeat } from "@/ui/lib/push";

export function PushLifecycle() {
	const location = useLocation();
	useDeviceHeartbeat();

	useEffect(() => {
		void ensureSubscriptionFresh();
	}, []);

	// ホーム画面のアプリで初めて開いたときだけ。通知から開いた会話には割り込まない。
	if (location.pathname === "/" && shouldShowNotificationWelcome()) {
		return <Navigate to="/welcome/notifications" replace />;
	}
	return <Outlet />;
}
