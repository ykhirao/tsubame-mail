import { useEffect, useState } from "react";
import type { Me } from "./api";
import { api, ApiClientError } from "./api";

export type GateState =
	| { status: "loading" }
	| { status: "ready"; me: Me }
	| { status: "denied"; message: string };

/** ナビに出さないだけでは足りないので、直接 URL を開いた場合もここで弾く。 */
export function useOwnerGate(): GateState {
	const [state, setState] = useState<GateState>({ status: "loading" });

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const me = await api.get<Me>("/api/v1/me");
				if (cancelled) return;
				if (me.role !== "owner") {
					setState({
						status: "denied",
						message: "この管理画面はオーナー専用です。この操作にはオーナー権限が必要です。",
					});
					return;
				}
				setState({ status: "ready", me });
			} catch (e) {
				if (cancelled) return;
				const message =
					e instanceof ApiClientError
						? e.message
						: "権限の確認に失敗しました。もう一度お試しください。";
				setState({ status: "denied", message });
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	return state;
}

export function AdminGate({ children }: { children: React.ReactNode }) {
	const state = useOwnerGate();
	if (state.status === "loading") {
		return <div className="px-6 py-12 text-sm text-[var(--text-muted)]">読み込み中…</div>;
	}
	if (state.status === "denied") {
		return (
			<div className="mx-auto max-w-6xl px-6 py-12">
				<h1 className="mb-4 text-2xl font-bold text-[var(--text)]">アクセスできません</h1>
				<div
					role="alert"
					className="rounded-md border border-[var(--danger)] bg-[var(--surface-hover)] px-4 py-3 text-sm text-[var(--danger)]"
				>
					{state.message}
				</div>
			</div>
		);
	}
	return <>{children}</>;
}
