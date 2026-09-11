import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import {
	AddressesPage,
	ApiKeysPage,
	DomainsPage,
	RulesPage,
	UsersPage,
	WebhooksPage,
} from "@/ui/routes/admin";
import "./styles.css";
import { AuthProvider } from "@/ui/lib/auth";
import { RequireAuth } from "@/ui/components/RequireAuth";
import { AppLayout } from "@/ui/routes/AppLayout";
import { Login } from "@/ui/routes/Login";
import { Bootstrap } from "@/ui/routes/Bootstrap";
import { Inbox } from "@/ui/routes/Inbox";
import { ThreadDetail } from "@/ui/routes/ThreadDetail";
import { Compose } from "@/ui/routes/Compose";
import { Search } from "@/ui/routes/Search";
import { Settings } from "@/ui/routes/Settings";
import { ChangePassword } from "@/ui/routes/ChangePassword";
import { getTheme, setTheme } from "@/ui/lib/theme";
import { PushLifecycle } from "@/ui/components/PushLifecycle";
import { NotificationWelcome } from "@/ui/routes/welcome/notifications";
import { NotificationSettingsTop } from "@/ui/routes/settings/notifications/Top";
import { NotificationMailboxes } from "@/ui/routes/settings/notifications/Mailboxes";
import { NotificationMailboxDetail } from "@/ui/routes/settings/notifications/MailboxDetail";
import { NotificationDisplaySettings } from "@/ui/routes/settings/notifications/Display";
import { NotificationDevices } from "@/ui/routes/settings/notifications/Devices";
import { NotificationsRules } from "@/ui/routes/settings/notifications/Rules";
import { NotificationRuleEdit } from "@/ui/routes/settings/notifications/RuleEdit";
import { NotificationsQuiet } from "@/ui/routes/settings/notifications/Quiet";
import { NotificationsFeed } from "@/ui/routes/NotificationsFeed";
import { OfflineNotice } from "@/ui/components/OfflineNotice";
import {
	captureInstallPrompt,
	registerServiceWorker,
	trackInstallVisit,
} from "@/ui/lib/pwa";

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
					<Route path="/welcome/notifications" element={<NotificationWelcome />} />
					<Route element={<AppLayout />}>
						<Route path="/" element={<Inbox />} />
						<Route path="/threads/:id" element={<ThreadDetail />} />
						<Route path="/compose" element={<Compose />} />
						<Route path="/search" element={<Search />} />
						<Route path="/settings" element={<Settings />} />
						<Route path="/settings/notifications" element={<NotificationSettingsTop />} />
						<Route path="/settings/notifications/mailboxes" element={<NotificationMailboxes />} />
						<Route path="/settings/notifications/mailboxes/:id" element={<NotificationMailboxDetail />} />
						<Route path="/settings/notifications/display" element={<NotificationDisplaySettings />} />
						<Route path="/settings/notifications/devices" element={<NotificationDevices />} />
						<Route path="/settings/notifications/rules" element={<NotificationsRules />} />
						<Route path="/settings/notifications/rules/:id" element={<NotificationRuleEdit />} />
						<Route path="/settings/notifications/quiet" element={<NotificationsQuiet />} />
						<Route path="/notifications" element={<NotificationsFeed />} />
						<Route path="/admin/domains" element={<DomainsPage />} />
						<Route path="/admin/addresses" element={<AddressesPage />} />
						<Route path="/admin/users" element={<UsersPage />} />
						<Route path="/admin/api-keys" element={<ApiKeysPage />} />
						<Route path="/admin/webhooks" element={<WebhooksPage />} />
						<Route path="/admin/rules" element={<RulesPage />} />
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
