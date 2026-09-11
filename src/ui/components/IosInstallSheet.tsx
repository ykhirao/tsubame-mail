import type { ReactNode } from "react";
import { Button } from "@/ui/components/Button";

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
	return (
		<li className="flex gap-3">
			<span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-sm font-bold text-white">
				{n}
			</span>
			<p className="text-sm text-[var(--text)]">
				<strong className="mr-1">{title}</strong>
				{children}
			</p>
		</li>
	);
}

export function IosInstallSheet({
	open,
	onClose,
}: {
	open: boolean;
	onClose: () => void;
}) {
	if (!open) return null;
	return (
		<div
			className="fixed inset-0 z-50 flex items-end justify-center bg-black/30"
			onClick={onClose}
		>
			<div
				className="w-full max-w-md rounded-t-2xl border border-b-0 border-[var(--line)] bg-[var(--surface)] p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] shadow-lg"
				onClick={(e) => e.stopPropagation()}
			>
				<h2 className="mb-4 text-lg font-bold text-[var(--text)]">
					ホーム画面に追加して新着を受け取る
				</h2>
				<ol className="mb-4 space-y-4">
					<Step n={1} title="「…」を押して「共有」を選ぶ">
						共有ボタンがツールバーに見えていれば、それを押してもよい。
					</Step>
					<Step n={2} title="「ホーム画面に追加」を選ぶ">
						見当たらなければ、共有メニューを下へスクロールする。
					</Step>
					<Step n={3} title="「Web アプリとして開く」がオンのまま「追加」">
						追加を押せばホーム画面にアイコンが並ぶ。
					</Step>
				</ol>
				<p className="mb-1 text-sm text-[var(--text)]">
					次回からはホーム画面のアイコンから開いてください。
				</p>
				<p className="mb-5 text-sm text-[var(--text)]">
					開き直した後にもう一度ログインが要る場合があります。
				</p>
				<div className="flex gap-2">
					<Button onClick={onClose} className="flex-1">
						閉じる
					</Button>
				</div>
			</div>
		</div>
	);
}
