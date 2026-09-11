const SHELL_CACHE = "tsubame-shell-v1";
// start_url は /?source=pwa なので、オフラインの戻り先として /index.html を使う。
const SHELL_ROOTS = ["/", "/index.html", "/manifest.webmanifest"];

type PushNotificationData = {
	threadId?: string;
	messageId?: string;
	url?: string;
};

type SwNotification = {
	close(): void;
	data?: PushNotificationData;
};

type SwExtendableEvent = {
	waitUntil(promise: Promise<unknown>): void;
};

type SwFetchEvent = {
	request: Request;
	respondWith(response: Response | Promise<Response>): void;
};

type SwPushEvent = {
	data: { text(): string | undefined } | null;
} & SwExtendableEvent;

type SwClickEvent = {
	notification: SwNotification;
	action: string;
} & SwExtendableEvent;

type SwOptions = {
	body?: string;
	tag?: string;
	icon?: string;
	badge?: string;
	dir?: "auto" | "ltr" | "rtl";
	lang?: string;
	renotify?: boolean;
	requireInteraction?: boolean;
	vibrate?: number[];
	image?: string;
	silent?: boolean;
	actions?: { action: string; title: string }[];
	data?: PushNotificationData;
};

type SwScope = {
	addEventListener(type: "install" | "activate", cb: (e: SwExtendableEvent) => void): void;
	addEventListener(type: "fetch", cb: (e: SwFetchEvent) => void): void;
	addEventListener(type: "push", cb: (e: SwPushEvent) => void): void;
	addEventListener(type: "notificationclick", cb: (e: SwClickEvent) => void): void;
	skipWaiting(): void;
	clients: {
		claim(): Promise<unknown>;
		matchAll(opts: {
			type: string;
			includeUncontrolled: boolean;
		}): Promise<Array<{ focus(): Promise<unknown>; navigate(url: string): Promise<unknown> }>>;
		openWindow(url: string): Promise<unknown>;
	};
	registration: {
		getNotifications(): Promise<SwNotification[]>;
		showNotification(title: string, options?: SwOptions): Promise<void>;
	};
	navigator: {
		setAppBadge(count?: number): Promise<void>;
		clearAppBadge(): Promise<void>;
	};
	location: Location;
};

// DOM lib の self(Window) が webworker の self を上書きするため、必要分だけ型を手で張る。
const sw = globalThis as unknown as SwScope;

type PushPayload = {
	web_push: number;
	notification: {
		title: string;
		body?: string;
		navigate?: string;
		tag?: string;
		app_badge?: number;
		silent?: boolean;
		icon?: string;
		badge?: string;
		data?: PushNotificationData;
		actions?: { action: string; title: string }[];
		dir?: SwOptions["dir"];
		lang?: string;
		renotify?: boolean;
		requireInteraction?: boolean;
		vibrate?: number[];
		image?: string;
	};
};

function parsePush(text: string | undefined): PushPayload | null {
	if (!text) return null;
	try {
		const data = JSON.parse(text) as PushPayload;
		// Declarative Web Push（RFC 8030 準拠の web_push マーカー）だけを受け取る。
		return data.web_push === 8030 ? data : null;
	} catch {
		return null;
	}
}

sw.addEventListener("install", (event) => {
	event.waitUntil(
		caches
			.open(SHELL_CACHE)
			.then((cache) => cache.addAll(SHELL_ROOTS))
			.then(() => sw.skipWaiting()),
	);
});

sw.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))))
			.then(() => sw.clients.claim()),
	);
});

function sameOrigin(url: URL): boolean {
	return url.origin === sw.location.origin;
}

async function cacheFirst(request: Request): Promise<Response> {
	const cached = await caches.match(request);
	if (cached) return cached;
	const res = await fetch(request);
	if (res.ok) {
		const clone = res.clone();
		void caches.open(SHELL_CACHE).then((cache) => cache.put(request, clone));
	}
	return res;
}

async function networkFirst(request: Request): Promise<Response> {
	try {
		const res = await fetch(request);
		if (res.ok) return res;
		return await shellHtml();
	} catch {
		return await shellHtml();
	}
}

async function shellHtml(): Promise<Response> {
	const cached = (await caches.match("/index.html")) ?? (await caches.match("/"));
	if (cached) return cached;
	return fetch("/index.html");
}

sw.addEventListener("fetch", (event) => {
	if (event.request.method !== "GET") return;

	const url = new URL(event.request.url);
	if (!sameOrigin(url)) return;

	// API は常にネットワーク。オフラインでは普通に失敗する。
	if (url.pathname.startsWith("/api/")) return;

	if (event.request.mode === "navigate") {
		event.respondWith(networkFirst(event.request));
	} else if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icons/")) {
		// assets はファイル名にハッシュが入るので、一度取れば中身は変わらない。
		event.respondWith(cacheFirst(event.request));
	}
});

async function applyBadge(count: number): Promise<void> {
	try {
		if (count > 0) await sw.navigator.setAppBadge(count);
		else await sw.navigator.clearAppBadge();
	} catch {
		// 非対応の端末では無視してよい。
	}
}

sw.addEventListener("push", (event) => {
	event.waitUntil(handlePush(event));
});

async function handlePush(event: SwPushEvent): Promise<void> {
	const payload = parsePush(event.data?.text());
	// 通知を出さないプッシュを続けると iOS は許可を取り消す。読めなくても必ず 1 件出す。
	if (!payload?.notification) {
		await sw.registration.showNotification("Tsubame", { body: "新着メール", data: { url: "/" } });
		return;
	}

	const n = payload.notification;
	const url = n.navigate ?? n.data?.url ?? "/";
	const options: SwOptions = {
		body: n.body,
		tag: n.tag,
		icon: n.icon,
		badge: n.badge,
		dir: n.dir,
		lang: n.lang,
		renotify: n.renotify,
		requireInteraction: n.requireInteraction,
		vibrate: n.vibrate,
		image: n.image,
		silent: n.silent,
		actions: n.actions,
		data: { ...n.data, url },
	};

	if (typeof n.app_badge === "number") await applyBadge(n.app_badge);

	// iOS は tag を無視する（WebKit bug 258922）。会話が 1 件にまとまるよう、
	// data.threadId が同じ既存通知を閉じてから出す。
	if (n.data?.threadId) {
		const existing = await sw.registration.getNotifications();
		for (const note of existing) {
			if (note.data?.threadId === n.data.threadId) note.close();
		}
	}

	await sw.registration.showNotification(n.title, options);
}

sw.addEventListener("notificationclick", (event) => {
	event.notification.close();
	event.waitUntil(handleClick(event));
});

async function patchMessage(messageId: string, action: "read" | "trash"): Promise<void> {
	// 通知ボタン。セッション Cookie で認可される（/api/v1/messages の契約に合わせる）。
	const body = JSON.stringify(action === "read" ? { isRead: true } : { status: "trash" });
	await fetch(`/api/v1/messages/${messageId}`, {
		method: "PATCH",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body,
	}).catch(() => {});
}

async function handleClick(event: SwClickEvent): Promise<void> {
	const messageId = event.notification.data?.messageId;

	if (event.action === "read" || event.action === "trash") {
		if (messageId) await patchMessage(messageId, event.action);
		return;
	}

	const target = event.notification.data?.url ?? "/";
	const clients = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
	const open = clients[0];
	if (open) {
		await open.focus();
		await open.navigate(target).catch(() => {});
	} else {
		await sw.clients.openWindow(target);
	}
}
