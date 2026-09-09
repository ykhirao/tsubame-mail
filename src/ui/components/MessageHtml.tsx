import { useRef } from "react";

/**
 * sandbox に allow-scripts を足してはいけない。スクリプトを実行させないことが
 * サニタイズの代わりになっている。allow-same-origin だけは、onLoad で内容の高さを
 * 読んで iframe を伸ばすために要る。
 */
export function MessageHtml({ html }: { html: string }) {
	const ref = useRef<HTMLIFrameElement>(null);

	return (
		<iframe
			ref={ref}
			title="メール本文"
			sandbox="allow-same-origin"
			referrerPolicy="no-referrer"
			className="w-full border-0"
			style={{ minHeight: 120 }}
			srcDoc={html}
			onLoad={() => {
				const f = ref.current;
				if (!f) return;
				try {
					const doc = f.contentDocument;
					if (!doc?.body) return;
					f.style.height = `${Math.max(doc.body.scrollHeight + 24, 120)}px`;
				} catch {
					/* 高さが読めなくても本文の表示は続ける。 */
				}
			}}
		/>
	);
}
