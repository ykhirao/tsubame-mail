import { Navigate, Outlet } from "react-router";
import { useAuth } from "@/ui/lib/auth";
import { FullScreenSpinner } from "@/ui/components/Spinner";

export function RequireAuth() {
	const { status } = useAuth();
	if (status === "loading") return <FullScreenSpinner />;
	if (status === "guest") return <Navigate to="/login" replace />;
	return <Outlet />;
}
