import { DevicesApi } from "@/ui/lib/api";

type BadgeNavigator = Navigator & {
	setAppBadge?: (count?: number) => Promise<void>;
	clearAppBadge?: () => Promise<void>;
};

type ThreadNotification = Notification & { data?: { threadId?: string } };

async function shownNotifications(): Promise<ThreadNotification[]> {
	if (!("serviceWorker" in navigator)) return [];
	const reg = await navigator.serviceWorker.getRegistration();
	if (!reg) return [];
	return (await reg.getNotifications()) as ThreadNotification[];
}

// 読んだ会話の通知が通知欄に残ると、Android はアイコンの点を消さない。
export async function closeThreadNotifications(threadId: string): Promise<void> {
	try {
		for (const n of await shownNotifications()) {
			if (n.data?.threadId === threadId) n.close();
		}
	} catch {
		// 通知の API が無い環境では何もしない。
	}
}

// push は他の端末で読んだ分を知らせてこないので、画面を開くたびにサーバの未読数で付け直す。
export async function syncAppBadge(): Promise<void> {
	const nav = navigator as BadgeNavigator;
	let count: number;
	try {
		count = (await DevicesApi.badge()).count;
	} catch {
		return;
	}
	try {
		if (count > 0) await nav.setAppBadge?.(count);
		else await nav.clearAppBadge?.();
	} catch {
		// バッジ非対応の端末では何もしない。
	}
	if (count === 0) {
		try {
			for (const n of await shownNotifications()) n.close();
		} catch {
			// 同上。
		}
	}
}
