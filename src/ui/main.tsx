import {
	lazy,
	StrictMode,
	Suspense,
	type ComponentType,
	type LazyExoticComponent,
	type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import "./styles.css";
import { AuthProvider } from "@/ui/lib/auth";
import { RequireAuth } from "@/ui/components/RequireAuth";
import { AppLayout, MailShell } from "@/ui/routes/AppLayout";
import { Login } from "@/ui/routes/Login";
import { Bootstrap } from "@/ui/routes/Bootstrap";
import { ChangePassword } from "@/ui/routes/ChangePassword";
import { getTheme, setTheme } from "@/ui/lib/theme";
import { PushLifecycle } from "@/ui/components/PushLifecycle";
import { OfflineNotice } from "@/ui/components/OfflineNotice";
import { Spinner } from "@/ui/components/Spinner";
import {
	captureInstallPrompt,
	registerServiceWorker,
	trackInstallVisit,
} from "@/ui/lib/pwa";

function lazyWithRetry<T extends ComponentType>(
	load: () => Promise<{ default: T }>,
): LazyExoticComponent<T> {
	const key = "tsubame:lazy-retry";
	return lazy(async () => {
		try {
			const mod = await load();
			sessionStorage.removeItem(key);
			return mod;
		} catch {
			// デプロイ後は index.html が新しいハッシュを指すため、古いタブで開いた
			// 遅延チャンクの URL が 404 になり得る。sessionStorage を見て一度だけ再読込する。
			if (!sessionStorage.getItem(key)) {
				sessionStorage.setItem(key, "1");
				window.location.reload();
			}
			throw new Error("遅延チャンクの読み込みに失敗しました");
		}
	});
}

const DomainsPage = lazyWithRetry(() =>
	import("@/ui/routes/admin").then((m) => ({ default: m.DomainsPage })),
);
const AddressesPage = lazyWithRetry(() =>
	import("@/ui/routes/admin").then((m) => ({ default: m.AddressesPage })),
);
const UsersPage = lazyWithRetry(() =>
	import("@/ui/routes/admin").then((m) => ({ default: m.UsersPage })),
);
const ApiKeysPage = lazyWithRetry(() =>
	import("@/ui/routes/admin").then((m) => ({ default: m.ApiKeysPage })),
);
const WebhooksPage = lazyWithRetry(() =>
	import("@/ui/routes/admin").then((m) => ({ default: m.WebhooksPage })),
);
const RulesPage = lazyWithRetry(() =>
	import("@/ui/routes/admin").then((m) => ({ default: m.RulesPage })),
);
const ApiKeyDetailPage = lazyWithRetry(() =>
	import("@/ui/routes/admin").then((m) => ({ default: m.ApiKeyDetailPage })),
);
const UserDetailPage = lazyWithRetry(() =>
	import("@/ui/routes/admin").then((m) => ({ default: m.UserDetailPage })),
);
const DomainDetailPage = lazyWithRetry(() =>
	import("@/ui/routes/admin").then((m) => ({ default: m.DomainDetailPage })),
);
const AddressDetailPage = lazyWithRetry(() =>
	import("@/ui/routes/admin").then((m) => ({ default: m.AddressDetailPage })),
);
const RuleDetailPage = lazyWithRetry(() =>
	import("@/ui/routes/admin").then((m) => ({ default: m.RuleDetailPage })),
);
const WebhookDetailPage = lazyWithRetry(() =>
	import("@/ui/routes/admin").then((m) => ({ default: m.WebhookDetailPage })),
);
const NotificationWelcome = lazyWithRetry(() =>
	import("@/ui/routes/welcome/notifications").then((m) => ({ default: m.NotificationWelcome })),
);
const NotificationSettingsTop = lazyWithRetry(() =>
	import("@/ui/routes/settings/notifications/Top").then((m) => ({
		default: m.NotificationSettingsTop,
	})),
);
const NotificationMailboxes = lazyWithRetry(() =>
	import("@/ui/routes/settings/notifications/Mailboxes").then((m) => ({
		default: m.NotificationMailboxes,
	})),
);
const NotificationMailboxDetail = lazyWithRetry(() =>
	import("@/ui/routes/settings/notifications/MailboxDetail").then((m) => ({
		default: m.NotificationMailboxDetail,
	})),
);
const NotificationDisplaySettings = lazyWithRetry(() =>
	import("@/ui/routes/settings/notifications/Display").then((m) => ({
		default: m.NotificationDisplaySettings,
	})),
);
const NotificationDevices = lazyWithRetry(() =>
	import("@/ui/routes/settings/notifications/Devices").then((m) => ({
		default: m.NotificationDevices,
	})),
);
const NotificationsRules = lazyWithRetry(() =>
	import("@/ui/routes/settings/notifications/Rules").then((m) => ({
		default: m.NotificationsRules,
	})),
);
const NotificationRuleEdit = lazyWithRetry(() =>
	import("@/ui/routes/settings/notifications/RuleEdit").then((m) => ({
		default: m.NotificationRuleEdit,
	})),
);
const NotificationsQuiet = lazyWithRetry(() =>
	import("@/ui/routes/settings/notifications/Quiet").then((m) => ({
		default: m.NotificationsQuiet,
	})),
);
const Compose = lazyWithRetry(() =>
	import("@/ui/routes/Compose").then((m) => ({ default: m.Compose })),
);
const Search = lazyWithRetry(() => import("@/ui/routes/Search").then((m) => ({ default: m.Search })));
const Settings = lazyWithRetry(() =>
	import("@/ui/routes/Settings").then((m) => ({ default: m.Settings })),
);
const NotificationsFeed = lazyWithRetry(() =>
	import("@/ui/routes/NotificationsFeed").then((m) => ({ default: m.NotificationsFeed })),
);

function Page({ children }: { children: ReactNode }) {
	return <Suspense fallback={<Spinner />}>{children}</Suspense>;
}

// React のマウント前に当てないと、初回描画が既定配色で一瞬ちらつく。
setTheme(getTheme());
// SW は本番ビルドのときだけ登録する（dev では HMR と衝突する）。
registerServiceWorker();
captureInstallPrompt();
trackInstallVisit();

function RoutesRoot() {
	return (
		<Routes>
			<Route path="/login" element={<Login />} />
			<Route path="/bootstrap" element={<Bootstrap />} />
			<Route path="/change-password" element={<ChangePassword />} />
			<Route element={<RequireAuth />}>
				<Route element={<PushLifecycle />}>
					<Route path="/welcome/notifications" element={<Page><NotificationWelcome /></Page>} />
					<Route element={<AppLayout />}>
						<Route path="/" element={<MailShell />} />
						<Route path="/threads/:id" element={<MailShell />} />
						<Route path="/compose" element={<Page><Compose /></Page>} />
						<Route path="/search" element={<Page><Search /></Page>} />
						<Route path="/settings" element={<Page><Settings /></Page>} />
						<Route path="/settings/notifications" element={<Page><NotificationSettingsTop /></Page>} />
						<Route path="/settings/notifications/mailboxes" element={<Page><NotificationMailboxes /></Page>} />
						<Route path="/settings/notifications/mailboxes/:id" element={<Page><NotificationMailboxDetail /></Page>} />
						<Route path="/settings/notifications/display" element={<Page><NotificationDisplaySettings /></Page>} />
						<Route path="/settings/notifications/devices" element={<Page><NotificationDevices /></Page>} />
						<Route path="/settings/notifications/rules" element={<Page><NotificationsRules /></Page>} />
						<Route path="/settings/notifications/rules/:id" element={<Page><NotificationRuleEdit /></Page>} />
						<Route path="/settings/notifications/quiet" element={<Page><NotificationsQuiet /></Page>} />
						<Route path="/notifications" element={<Page><NotificationsFeed /></Page>} />
						<Route path="/admin/domains" element={<Page><DomainsPage /></Page>} />
						<Route path="/admin/addresses" element={<Page><AddressesPage /></Page>} />
						<Route path="/admin/users" element={<Page><UsersPage /></Page>} />
						<Route path="/admin/api-keys" element={<Page><ApiKeysPage /></Page>} />
						<Route path="/admin/webhooks" element={<Page><WebhooksPage /></Page>} />
						<Route path="/admin/rules" element={<Page><RulesPage /></Page>} />
						<Route path="/admin/api-keys/:id" element={<Page><ApiKeyDetailPage /></Page>} />
						<Route path="/admin/users/:id" element={<Page><UserDetailPage /></Page>} />
						<Route path="/admin/domains/:id" element={<Page><DomainDetailPage /></Page>} />
						<Route path="/admin/addresses/:id" element={<Page><AddressDetailPage /></Page>} />
						<Route path="/admin/rules/:id" element={<Page><RuleDetailPage /></Page>} />
						<Route path="/admin/webhooks/:id" element={<Page><WebhookDetailPage /></Page>} />
					</Route>
				</Route>
			</Route>
		</Routes>
	);
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root が見つかりません");

createRoot(rootEl).render(
	<StrictMode>
		<BrowserRouter>
			<OfflineNotice />
			<AuthProvider>
				<RoutesRoot />
			</AuthProvider>
		</BrowserRouter>
	</StrictMode>,
);
