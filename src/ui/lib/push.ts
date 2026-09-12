import { useEffect } from "react";
import { DevicesApi } from "@/ui/lib/api";
import { isIos, isStandalone } from "@/ui/lib/pwa";

const DEVICE_ID_KEY = "tsubame-push-device-id";
const PUSH_KEY_KEY = "tsubame-push-key";
const WELCOME_SEEN_KEY = "tsubame-notification-welcome-seen";
const HEARTBEAT_MS = 60_000;

export type DeviceStatus =
	| "unsupported"
	| "ios_not_standalone"
	| "blocked"
	| "notifying"
	| "unregistered";

export function getRegisteredDeviceId(): string | null {
	return localStorage.getItem(DEVICE_ID_KEY);
}

function pushSupported(): boolean {
	return (
		typeof window !== "undefined" &&
		"serviceWorker" in navigator &&
		"PushManager" in window &&
		"Notification" in window
	);
}

export function getDeviceStatus(): DeviceStatus {
	if (!pushSupported()) return "unsupported";
	if (isIos() && !isStandalone()) return "ios_not_standalone";
	if (Notification.permission === "denied") return "blocked";
	if (!getRegisteredDeviceId()) return "unregistered";
	return "notifying";
}

export function guessDeviceName(): string {
	const ua = navigator.userAgent;
	const platform = (navigator.platform ?? "").toLowerCase();
	if (/iPhone/i.test(ua)) return "iPhone";
	if (/iPad/i.test(ua) || (/Mac/i.test(ua) && /Mobile|Touch/i.test(ua))) return "iPad";
	if (/Android/i.test(ua)) return "Android";
	const os =
		platform.includes("mac") || /Macintosh/i.test(ua)
			? "Mac"
			: platform.includes("win") || /Windows/i.test(ua)
				? "Windows"
				: "Linux";
	let browser = "Chrome";
	if (/Edg\//i.test(ua)) browser = "Edge";
	else if (/Firefox/i.test(ua) || /FxiOS/i.test(ua)) browser = "Firefox";
	else if (/OPR\//i.test(ua)) browser = "Opera";
	else if (/Safari/i.test(ua) && !/Chrome/i.test(ua)) browser = "Safari";
	return `${os} の ${browser}`;
}

export function guessDevicePlatform(): "ios" | "android" | "desktop" {
	if (isIos()) return "ios";
	if (/Android/i.test(navigator.userAgent)) return "android";
	return "desktop";
}

function urlB64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
	const padding = "=".repeat((4 - (base64.length % 4)) % 4);
	const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
	const raw = atob(b64);
	const out = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
	return out;
}

function arrayBufferToUrlB64(buf: ArrayBuffer | null): string {
	if (!buf) throw new Error("鍵が取得できません");
	const bytes = new Uint8Array(buf);
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let cachedPushKey: string | null | undefined;

// VAPID 公開鍵。画面を開いた時点で先に取っておき、購読のタップでは HTTP を挟まない
//（iOS は購読をジェスチャ直後に呼ぶ必要があるため）。
export async function loadPushKey(): Promise<string | null> {
	if (cachedPushKey !== undefined) return cachedPushKey;
	const res = await DevicesApi.pushKey();
	cachedPushKey = res.key;
	return res.key;
}

export function forgetRegisteredDevice(): void {
	localStorage.removeItem(DEVICE_ID_KEY);
	localStorage.removeItem(PUSH_KEY_KEY);
}

// SW が入らないと ready は永遠に解決しない。待ち続けず、登録し直してから期限つきで待つ。
async function readyRegistration(): Promise<ServiceWorkerRegistration> {
	if (!(await navigator.serviceWorker.getRegistration())) {
		await navigator.serviceWorker.register("/sw.js");
	}
	return await new Promise<ServiceWorkerRegistration>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error("Service Worker の準備ができませんでした。アプリを開き直してください。")),
			10_000,
		);
		void navigator.serviceWorker.ready.then((r) => {
			clearTimeout(timer);
			resolve(r);
		});
	});
}

export async function subscribeDevice(opts: { replaceExisting?: boolean } = {}): Promise<DeviceStatus> {
	if (!pushSupported()) return "unsupported";
	if (isIos() && !isStandalone()) return "ios_not_standalone";
	const permission = await Notification.requestPermission();
	if (permission !== "granted") return "blocked";
	const key = await loadPushKey();
	if (!key) return "unsupported";
	const registration = await readyRegistration();
	if (opts.replaceExisting) {
		// 別の鍵で作った購読が残っていると subscribe は InvalidStateError で失敗する。
		const old = await registration.pushManager.getSubscription();
		await old?.unsubscribe();
	}
	const subscription = await registration.pushManager.subscribe({
		userVisibleOnly: true,
		applicationServerKey: urlB64ToUint8Array(key),
	});
	const device = await DevicesApi.register({
		endpoint: subscription.endpoint,
		keys: {
			p256dh: arrayBufferToUrlB64(subscription.getKey("p256dh")),
			auth: arrayBufferToUrlB64(subscription.getKey("auth")),
		},
		name: guessDeviceName(),
		platform: guessDevicePlatform(),
	});
	localStorage.setItem(DEVICE_ID_KEY, device.id);
	localStorage.setItem(PUSH_KEY_KEY, key);
	return "notifying";
}

// サーバの VAPID 鍵が変わると既存の購読は無効になる。保存した鍵と違えば購読し直す。
export async function ensureSubscriptionFresh(): Promise<void> {
	if (!pushSupported()) return;
	if (isIos() && !isStandalone()) return;
	if (!getRegisteredDeviceId()) return;
	cachedPushKey = undefined;
	let key: string | null;
	try {
		key = await loadPushKey();
	} catch {
		return;
	}
	if (!key) return;
	if (localStorage.getItem(PUSH_KEY_KEY) !== key) {
		await subscribeDevice({ replaceExisting: true }).catch(() => {});
	}
}

export function useDeviceHeartbeat(): void {
	const deviceId = getRegisteredDeviceId();
	useEffect(() => {
		if (!deviceId) return;
		const ping = () => {
			// 「使用中なら鳴らさない」の合図なので、裏に回ったタブからは送らない。
			if (document.visibilityState !== "visible") return;
			DevicesApi.seen(deviceId).catch(() => {});
		};
		ping();
		const timer = setInterval(ping, HEARTBEAT_MS);
		return () => clearInterval(timer);
	}, [deviceId]);
}

export function shouldShowNotificationWelcome(): boolean {
	if (!isStandalone()) return false;
	return localStorage.getItem(WELCOME_SEEN_KEY) !== "1";
}

export function markNotificationWelcomeSeen(): void {
	localStorage.setItem(WELCOME_SEEN_KEY, "1");
}
