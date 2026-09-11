import { useEffect, useState } from "react";

export function useIsMobile(): boolean {
	const [isMobile, setIsMobile] = useState(() =>
		window.matchMedia("(max-width: 767px)").matches,
	);
	useEffect(() => {
		const mq = window.matchMedia("(max-width: 767px)");
		setIsMobile(mq.matches);
		const onChange = () => setIsMobile(mq.matches);
		mq.addEventListener("change", onChange);
		return () => mq.removeEventListener("change", onChange);
	}, []);
	return isMobile;
}
