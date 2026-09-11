type BeforeInstallPromptEvent = Event & {
	prompt(): Promise<void>;
	userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const VISITS_KEY = "tsubame-install-visits";
const DISMISS_KEY = "tsubame-install-dismissed-at";
const DONT_SHOW_DAYS = 30;

let deferredInstallPrompt: BeforeInstallPromptEvent | null = null;

export function isStandalone(): boolean {
	return (
		window.matchMedia("(display-mode: standalone)").matches ||
		// iOS の Home Screen 起動は display-mode を効かせないことがある。
		Boolean((navigator as Navigator & { standalone?: boolean }).standalone)
	);
}

export function isIos(): boolean {
	return /iPad|iPhone|iPod/.test(navigator.userAgent);
}

export function isMobileWidth(): boolean {
	return window.innerWidth < 768;
}

// FR-15: 案内は「追加していない・スマホで開いている・3 回目以降・閉じて 30 日以内でない」。
export function shouldShowInstallBanner(): boolean {
	if (isStandalone()) return false;
	if (!isMobileWidth()) return false;
	if (Number(localStorage.getItem(VISITS_KEY) ?? "0") < 3) return false;
	const dismissedAt = Number(localStorage.getItem(DISMISS_KEY) ?? "0");
	if (dismissedAt && Date.now() - dismissedAt < DONT_SHOW_DAYS * 86_400_000) return false;
	return true;
}

export function trackInstallVisit(): void {
	const n = Number(localStorage.getItem(VISITS_KEY) ?? "0");
	localStorage.setItem(VISITS_KEY, String(n + 1));
}

export function dismissInstallBanner(): void {
	localStorage.setItem(DISMISS_KEY, String(Date.now()));
}

export function hasInstallPrompt(): boolean {
	return deferredInstallPrompt != null;
}

export function captureInstallPrompt(): void {
	window.addEventListener("beforeinstallprompt", (e) => {
		e.preventDefault();
		deferredInstallPrompt = e as BeforeInstallPromptEvent;
	});
}

export function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
	const promptEvent = deferredInstallPrompt;
	if (!promptEvent) return Promise.resolve("unavailable");
	deferredInstallPrompt = null;
	return promptEvent.prompt().then(async () => (await promptEvent.userChoice).outcome);
}

// 開発モードで登録すると Vite の HMR と衝突するため、本番ビルドだけ。
export function registerServiceWorker(): void {
	if (!import.meta.env.PROD) return;
	if (!("serviceWorker" in navigator)) return;
	void navigator.serviceWorker.register("/sw.js").catch(() => {});
}
