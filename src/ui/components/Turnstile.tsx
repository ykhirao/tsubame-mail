import { useEffect, useRef } from "react";

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

type TurnstileApi = {
	render: (el: HTMLElement, opts: Record<string, unknown>) => string;
	reset: (id: string) => void;
	remove: (id: string) => void;
};

declare global {
	interface Window {
		turnstile?: TurnstileApi;
	}
}

let scriptPromise: Promise<void> | null = null;

function loadScript(): Promise<void> {
	if (window.turnstile) return Promise.resolve();
	scriptPromise ??= new Promise<void>((resolve, reject) => {
		const el = document.createElement("script");
		el.src = SCRIPT_SRC;
		el.async = true;
		el.defer = true;
		el.onload = () => resolve();
		el.onerror = () => {
			// 次のマウントで読み直せるよう、失敗したら覚えたものを捨てる。
			scriptPromise = null;
			reject(new Error("Turnstile の読み込みに失敗しました"));
		};
		document.head.appendChild(el);
	});
	return scriptPromise;
}

/**
 * Turnstile のウィジェット。`sitekey` が null のときは何も描かない
 * （設定していない環境ではサーバも検査しないので、画面にも出さない）。
 *
 * トークンは**1 回しか使えない**。この画面は送信に失敗しても残るので、
 * 親が `resetKey` を変えると取り直す。変えないと 2 回目のログインが必ず落ちる。
 */
export function Turnstile({
	sitekey,
	action,
	onToken,
	resetKey,
}: {
	sitekey: string | null;
	action: string;
	onToken: (token: string | null) => void;
	resetKey: number;
}) {
	const boxRef = useRef<HTMLDivElement>(null);
	const widgetIdRef = useRef<string | null>(null);
	// 描画のたびに作り直すと id が変わるので、最新の受け手を ref 越しに呼ぶ。
	const onTokenRef = useRef(onToken);
	onTokenRef.current = onToken;

	useEffect(() => {
		if (!sitekey) return;
		let alive = true;
		void loadScript()
			.then(() => {
				if (!alive || !boxRef.current || !window.turnstile) return;
				widgetIdRef.current = window.turnstile.render(boxRef.current, {
					sitekey,
					action,
					callback: (token: string) => onTokenRef.current(token),
					"expired-callback": () => onTokenRef.current(null),
					"error-callback": () => onTokenRef.current(null),
				});
			})
			.catch(() => onTokenRef.current(null));
		return () => {
			alive = false;
			const id = widgetIdRef.current;
			if (id && window.turnstile) window.turnstile.remove(id);
			widgetIdRef.current = null;
		};
	}, [sitekey, action]);

	useEffect(() => {
		if (resetKey === 0) return;
		const id = widgetIdRef.current;
		if (id && window.turnstile) {
			window.turnstile.reset(id);
			onTokenRef.current(null);
		}
	}, [resetKey]);

	if (!sitekey) return null;
	return <div ref={boxRef} className="mb-4" />;
}
