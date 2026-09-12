import { useEffect } from "react";
import { useNavigate } from "react-router";

// URL の安全性（isSafePath）は sw.ts が送る前に済ませている。ここでは受け取った
// 壊れた値で navigate が例外を投げないことだけを確かめる。
export function useServiceWorkerNavigate(): void {
	const navigate = useNavigate();
	useEffect(() => {
		const sw = navigator.serviceWorker;
		if (!sw) return;
		const onMessage = (event: Event) => {
			const message = event as MessageEvent;
			const data = message.data as { type?: string; url?: unknown } | null;
			if (data?.type !== "navigate") return;
			if (typeof data.url !== "string" || !/^\/(?![/\\])/.test(data.url)) return;
			message.ports[0]?.postMessage("ok");
			navigate(data.url);
		};
		sw.addEventListener("message", onMessage);
		sw.startMessages();
		return () => sw.removeEventListener("message", onMessage);
	}, [navigate]);
}
