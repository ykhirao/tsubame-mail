import { useEffect, useState } from "react";
import { Link } from "react-router";
import {
	subscribeDevice,
	markNotificationWelcomeSeen,
	getDeviceStatus,
	loadPushKey,
	guessDeviceName,
	type DeviceStatus,
} from "@/ui/lib/push";
import { NotificationsApi } from "@/ui/lib/api";

type Preset = "all" | "important" | "later";

const PRESETS: { value: Preset; label: string; desc: string }[] = [
	{ value: "all", label: "すべて", desc: "割り当てられたメールボックスの新着をすべて" },
	{ value: "important", label: "重要なものだけ", desc: "To に自分のメールボックスが入っているものと、自分たちが送った会話への返信だけ" },
	{ value: "later", label: "あとで決める", desc: "まずは登録だけして、設定はあとで" },
];

export function NotificationWelcome() {
	const [preset, setPreset] = useState<Preset>("all");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [done, setDone] = useState(false);
	const [subscribed, setSubscribed] = useState(false);
	const [status, setStatus] = useState<DeviceStatus>(getDeviceStatus());

	// iOS は購読をジェスチャ直後に呼ぶ必要があるため、鍵は画面を開いた時点で先に取っておく。
	useEffect(() => {
		loadPushKey().catch(() => {});
	}, []);

	if (status === "ios_not_standalone") {
		return <StandaloneRequired />;
	}

	if (status === "unsupported") {
		return <Unsupported />;
	}

	if (subscribed) {
		return (
			<Center>
				<h1 className="text-lg font-bold text-[var(--text)]">通知を許可しました</h1>
				<p className="mt-2 text-sm text-[var(--text-muted)]">
					{guessDeviceName()} に新着メールの通知を届けます。細かい設定はあとで変えられます。
				</p>
				<button
					type="button"
					onClick={() => {
						markNotificationWelcomeSeen();
						setDone(true);
					}}
					className="mt-6 inline-flex h-12 min-w-44 items-center justify-center rounded-full bg-[var(--accent)] px-6 text-sm font-medium text-white hover:opacity-90"
				>
					これで終わり
				</button>
			</Center>
		);
	}

	if (done) {
		return (
			<Center>
				<h1 className="text-lg font-bold text-[var(--text)]">通知の設定が完了しました</h1>
				<p className="mt-2 text-sm text-[var(--text-muted)]">
					{guessDeviceName()} に新着メールの通知を届けます。細かい設定はいつでも変えられます。
				</p>
				<Link
					to="/settings/notifications"
					className="mt-6 inline-flex h-12 items-center justify-center rounded-full bg-[var(--accent)] px-6 text-sm font-medium text-white hover:opacity-90"
				>
					通知設定を開く
				</Link>
			</Center>
		);
	}

	if (status === "blocked") {
		return (
			<Blocked
				onRecheck={async () => {
					// OS で許可し直したかを見て、許されていればこの画面で購読まで進める。
					if (Notification.permission !== "granted") {
						setStatus(getDeviceStatus());
						return;
					}
					setBusy(true);
					const st = await subscribeDevice();
					setStatus(st);
					if (st === "notifying") {
						setSubscribed(true);
					}
					setBusy(false);
				}}
			/>
		);
	}

	return (
		<Center>
			<h1 className="text-lg font-bold text-[var(--text)]">
				新着メールをこの端末に通知しますか
			</h1>
			<p className="mt-2 text-sm text-[var(--text-muted)]">
				端末名は {guessDeviceName()} で登録します。後から変えられます。
			</p>

			<div className="mt-5 flex flex-col gap-2">
				{PRESETS.map((p) => (
					<button
						key={p.value}
						type="button"
						onClick={() => setPreset(p.value)}
						className={`flex min-h-12 flex-col rounded-xl border px-4 py-3 text-left transition-colors ${
							preset === p.value
								? "border-[var(--accent)] bg-[var(--accent-weak)]"
								: "border-[var(--line)] bg-[var(--surface)] hover:bg-[var(--surface-hover)]"
						}`}
					>
						<span className="text-sm font-medium text-[var(--text)]">{p.label}</span>
						<span className="text-xs text-[var(--text-muted)]">{p.desc}</span>
					</button>
				))}
			</div>

			<button
				type="button"
				disabled={busy}
				onClick={async () => {
					setBusy(true);
					setError(null);
					try {
						const st = await subscribeDevice();
						setStatus(st);
						if (st === "notifying") {
							await NotificationsApi.patch({ preset }).catch(() => {});
							setSubscribed(true);
						}
					} catch (e) {
						setError(e instanceof Error ? e.message : "登録に失敗しました");
					} finally {
						setBusy(false);
					}
				}}
				className="mt-6 inline-flex h-12 min-w-44 items-center justify-center gap-2 rounded-full bg-[var(--accent)] px-6 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
			>
				{busy ? "通信中…" : "通知を許可する"}
			</button>
			<p className="mt-3 text-xs text-[var(--text-muted)]">ボタンを押すと OS の許可ダイアログが出ます。</p>
			{error && <p className="mt-3 text-sm text-[var(--danger)]">{error}</p>}
			<Link
				to="/"
				onClick={() => markNotificationWelcomeSeen()}
				className="mt-6 inline-flex h-11 items-center text-sm text-[var(--text-muted)] hover:underline"
			>
				今はしない（設定からいつでも始められます）
			</Link>
		</Center>
	);
}

function Center({ children }: { children: React.ReactNode }) {
	return (
		<div className="mx-auto flex w-full max-w-md flex-col px-4 py-10">
			{children}
		</div>
	);
}

function Unsupported() {
	return (
		<Center>
			<h1 className="text-lg font-bold text-[var(--text)]">このブラウザでは通知に対応していません</h1>
			<p className="mt-2 text-sm text-[var(--text-muted)]">
				お使いの環境ではプッシュ通知を利用できないため、この端末には新着をお知らせできません。最新のブラウザから開いてください。
			</p>
			<Link
				to="/"
				className="mt-6 inline-flex h-12 items-center justify-center rounded-full px-6 text-sm text-[var(--accent)] hover:bg-[var(--surface-hover)]"
			>
				受信箱へ戻る
			</Link>
		</Center>
	);
}

function StandaloneRequired() {
	return (
		<Center>
			<h1 className="text-lg font-bold text-[var(--text)]">ホーム画面から開いてください</h1>
			<p className="mt-2 text-sm text-[var(--text-muted)]">
				通知を受け取るには、このアプリをホーム画面に追加し、追加したアイコンから開いてこの画面を表示してください。
			</p>
			<Link
				to="/settings"
				className="mt-6 inline-flex h-12 items-center justify-center rounded-full px-6 text-sm text-[var(--accent)] hover:bg-[var(--surface-hover)]"
			>
				設定へ戻る
			</Link>
		</Center>
	);
}

function Blocked({ onRecheck }: { onRecheck: () => Promise<void> }) {
	const [checking, setChecking] = useState(false);
	return (
		<Center>
			<h1 className="text-lg font-bold text-[var(--text)]">通知がブロックされています</h1>
			<p className="mt-2 text-sm text-[var(--text-muted)]">
				アプリからは許可し直せません。OS の設定で通知を許可してください。
			</p>
			<div className="mt-4 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4 text-sm text-[var(--text)]">
				<ul className="list-inside list-disc space-y-1 text-xs text-[var(--text-muted)]">
					<li>
						<strong className="text-[var(--text)]">iOS:</strong> 設定 → 通知 → Tsubame
					</li>
					<li>
						<strong className="text-[var(--text)]">Android:</strong> アイコンを長押し → アプリ情報 → 通知
					</li>
				</ul>
			</div>
			<button
				type="button"
				disabled={checking}
				onClick={async () => {
					setChecking(true);
					await onRecheck();
					setChecking(false);
				}}
				className="mt-6 inline-flex h-12 items-center justify-center rounded-full bg-[var(--accent)] px-6 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
			>
				{checking ? "確認中…" : "許可したら、ここに戻って確かめる"}
			</button>
		</Center>
	);
}
