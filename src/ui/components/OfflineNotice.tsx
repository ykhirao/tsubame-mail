import { useEffect, useState } from "react";

export function OfflineNotice() {
	const [online, setOnline] = useState(() => navigator.onLine);

	useEffect(() => {
		const up = () => setOnline(true);
		const down = () => setOnline(false);
		window.addEventListener("online", up);
		window.addEventListener("offline", down);
		return () => {
			window.removeEventListener("online", up);
			window.removeEventListener("offline", down);
		};
	}, []);

	if (online) return null;
	return (
		<div className="sticky top-0 z-40 bg-[var(--warning)] px-3 py-1.5 text-center text-sm font-medium text-white">
			オフラインです
		</div>
	);
}
