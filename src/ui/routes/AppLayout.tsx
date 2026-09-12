import { Link, Outlet, useNavigate, useParams, useSearchParams } from "react-router";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useAuth } from "@/ui/lib/auth";
import { AddressesApi, NotificationsApi } from "@/ui/lib/api";
import type { MyAddress } from "@/shared/contracts/addresses";
import { getTheme, setTheme, type Theme } from "@/ui/lib/theme";
import { AddMemberDialog } from "@/ui/components/AddMemberDialog";
import { CatchAllBadge } from "@/ui/components/mobile/CatchAllBadge";
import { useIsMobile } from "@/ui/lib/useIsMobile";
import { EmptyState } from "@/ui/components/EmptyState";
import { useLayoutPref } from "@/ui/lib/viewPrefs";
import { Inbox } from "@/ui/routes/Inbox";
import { ThreadDetail } from "@/ui/routes/ThreadDetail";

const icon = "h-5 w-5";
const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" } as const;

const InboxIcon = () => (
	<svg className={icon} viewBox="0 0 24 24" {...stroke}>
		<path d="M4 13h4l2 3h4l2-3h4" />
		<path d="M4 13 6 5h12l2 8v6H4z" />
	</svg>
);
const BellIcon = () => (
	<svg className={icon} viewBox="0 0 24 24" {...stroke}>
		<path d="M6 9a6 6 0 0 1 12 0c0 5 2.5 5.5 2.5 5.5H3.5S6 14 6 9z" />
		<path d="M10 19a2 2 0 0 0 4 0" />
	</svg>
);
const StarIcon = () => (
	<svg className={icon} viewBox="0 0 24 24" {...stroke}>
		<path d="m12 4 2.4 5 5.6.8-4 3.9.9 5.5-4.9-2.6-4.9 2.6.9-5.5-4-3.9 5.6-.8z" />
	</svg>
);
const SentIcon = () => (
	<svg className={icon} viewBox="0 0 24 24" {...stroke}>
		<path d="M21 3 3 10l7 3 3 7z" />
	</svg>
);
const TrashIcon = () => (
	<svg className={icon} viewBox="0 0 24 24" {...stroke}>
		<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
	</svg>
);
const PencilIcon = () => (
	<svg className={icon} viewBox="0 0 24 24" {...stroke}>
		<path d="M4 20h4L20 8l-4-4L4 16z" />
	</svg>
);
const SearchIcon = () => (
	<svg className={icon} viewBox="0 0 24 24" {...stroke}>
		<circle cx="11" cy="11" r="7" />
		<path d="m20 20-3.5-3.5" />
	</svg>
);
const MenuIcon = () => (
	<svg className={icon} viewBox="0 0 24 24" {...stroke}>
		<path d="M4 7h16M4 12h16M4 17h16" />
	</svg>
);
const ChevronIcon = () => (
	<svg className="h-4 w-4" viewBox="0 0 24 24" {...stroke}>
		<path d="m6 9 6 6 6-6" />
	</svg>
);
const ShieldIcon = () => (
	<svg className={icon} viewBox="0 0 24 24" {...stroke}>
		<path d="M12 3 5 6v5c0 4.2 2.9 8 7 10 4.1-2 7-5.8 7-10V6z" />
	</svg>
);
const GearIcon = () => (
	<svg className={icon} viewBox="0 0 24 24" {...stroke}>
		<circle cx="12" cy="12" r="3" />
		<path d="M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6l1.4 1.4m10 10 1.4 1.4m0-12.8-1.4 1.4m-10 10-1.4 1.4" />
	</svg>
);
const SunIcon = () => (
	<svg className={icon} viewBox="0 0 24 24" {...stroke}>
		<circle cx="12" cy="12" r="4" />
		<path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4m0-14.2-1.4 1.4M6.3 17.7l-1.4 1.4" />
	</svg>
);
const MoonIcon = () => (
	<svg className={icon} viewBox="0 0 24 24" {...stroke}>
		<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
	</svg>
);

function MailboxSwitcher({
	addresses,
	selected,
	onSelect,
	flexible = false,
}: {
	addresses: MyAddress[];
	selected: string;
	onSelect: (id: string) => void;
	flexible?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const onDown = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, [open]);

	const current = addresses.find((a) => a.id === selected);
	const totalUnread = addresses.reduce((n, a) => n + a.unreadCount, 0);

	return (
		<div className={`relative ${flexible ? "min-w-0" : "shrink-0"}`} ref={ref}>
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className="flex h-9 max-w-[260px] items-center gap-1.5 rounded-full border border-[var(--line)] px-3 text-sm text-[var(--text)] transition-colors hover:bg-[var(--surface-hover)]"
				title="メールボックスを切り替える"
			>
				{current && (
					<span
						className="inline-block h-2.5 w-[15px] shrink-0 rounded-full"
						style={{ background: current.color }}
					/>
				)}
				<span className="truncate">{current ? current.address : "すべてのメールボックス"}</span>
				{current?.isCatchAll && <CatchAllBadge />}
				{(current ? current.unreadCount : totalUnread) > 0 && (
					<span className="rounded-full bg-[var(--accent)] px-1.5 text-xs text-white">
						{current ? current.unreadCount : totalUnread}
					</span>
				)}
				<ChevronIcon />
			</button>

			{open && (
				<div className="absolute left-0 z-20 mt-1 w-80 overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--surface)] py-1 shadow-lg">
					<button
						type="button"
						onClick={() => {
							onSelect("");
							setOpen(false);
						}}
						className={`flex w-full items-center justify-between px-4 py-2 text-left text-sm hover:bg-[var(--surface-hover)] ${
							selected === "" ? "bg-[var(--surface-selected)] text-[var(--text-on-selected)]" : ""
						}`}
					>
						<span>すべてのメールボックス</span>
						{totalUnread > 0 && <span className="text-xs text-[var(--text-muted)]">{totalUnread}</span>}
					</button>
					<div className="my-1 border-t border-[var(--line-soft)]" />
					{addresses.map((a) => (
						<button
							key={a.id}
							type="button"
							onClick={() => {
								onSelect(a.id);
								setOpen(false);
							}}
							className={`flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-sm hover:bg-[var(--surface-hover)] ${
								a.id === selected ? "bg-[var(--surface-selected)] text-[var(--text-on-selected)]" : ""
							}`}
						>
							<span className="flex min-w-0 items-center gap-2">
								<span
									className="inline-block h-2.5 w-[15px] shrink-0 rounded-full"
									style={{ background: a.color }}
								/>
								<span className="min-w-0">
								<span className="inline-flex items-center gap-1.5">
									<span className="block truncate">{a.address}</span>
									{a.isCatchAll && <CatchAllBadge />}
								</span>
								{a.displayName && (
									<span className="block truncate text-xs text-[var(--text-muted)]">
										{a.displayName}
									</span>
								)}
								</span>
							</span>
							{a.unreadCount > 0 && (
								<span className="shrink-0 text-xs text-[var(--text-muted)]">{a.unreadCount}</span>
							)}
						</button>
					))}
					{addresses.length === 0 && (
						<p className="px-4 py-2 text-sm text-[var(--text-muted)]">
							使えるメールボックスがありません
						</p>
					)}
				</div>
			)}
		</div>
	);
}

const VIEWS = [
	{ key: "inbox", label: "受信箱", icon: <InboxIcon /> },
	{ key: "starred", label: "スター付き", icon: <StarIcon /> },
	{ key: "sent", label: "送信済み", icon: <SentIcon /> },
	{ key: "trash", label: "ゴミ箱", icon: <TrashIcon /> },
] as const;

const SIDEBAR_KEY = "tsubame-sidebar";

function initialOf(value: string): string {
	const first = value.trim().charAt(0);
	return first ? first.toUpperCase() : "?";
}

function ChooseConversation() {
	return (
		<EmptyState icon="💬" title="会話を選んでください">
			左の一覧から会話を選ぶと、ここに本文が表示されます
		</EmptyState>
	);
}

// "/" と "/threads/:id" を PC では分割、スマホでは今までの単独画面にする入り口。
// 全画面モード（端末の表示設定）は分割を畳んで本文だけにする。
export function MailShell() {
	const { id } = useParams();
	const isMobile = useIsMobile();
	const [pref] = useLayoutPref();

	if (isMobile || pref === "fullscreen") {
		return id ? <ThreadDetail key={id} /> : <Inbox />;
	}
	return (
		<div className="flex min-h-0 min-w-0 flex-1">
			<div className="w-[380px] shrink-0 overflow-y-auto border-r border-[var(--line-soft)] pr-2">
				<Inbox split />
			</div>
			<div className="min-w-0 flex-1 overflow-y-auto pl-4">
				{id ? <ThreadDetail key={id} /> : <ChooseConversation />}
			</div>
		</div>
	);
}

export function AppLayout() {
	const { me, logout } = useAuth();
	const navigate = useNavigate();
	const [params, setParams] = useSearchParams();
	const [loggingOut, setLoggingOut] = useState(false);
	const [q, setQ] = useState("");
	const [theme, setThemeState] = useState<Theme>(getTheme());
	const [addresses, setAddresses] = useState<MyAddress[]>([]);
	const [open, setOpen] = useState(() => {
		try {
			return localStorage.getItem(SIDEBAR_KEY) !== "closed";
		} catch {
			return true;
		}
	});

	const [accountOpen, setAccountOpen] = useState(false);
	const [showAddMember, setShowAddMember] = useState(false);
	const [drawerOpen, setDrawerOpen] = useState(false);
	const [unseenCount, setUnseenCount] = useState(0);
	const accountRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		let alive = true;
		NotificationsApi.get()
			.then((s) => alive && setUnseenCount(s.unseen_count))
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, []);

	// 仮パスワードのままなら、他の画面を見せずに変更へ寄せる。
	useEffect(() => {
		if (me?.mustChangePassword) navigate("/change-password", { replace: true });
	}, [me?.mustChangePassword, navigate]);

	useEffect(() => {
		if (!accountOpen) return;
		const onDown = (e: MouseEvent) => {
			if (accountRef.current && !accountRef.current.contains(e.target as Node)) {
				setAccountOpen(false);
			}
		};
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, [accountOpen]);

	const isMobile = useIsMobile();

	const view = params.get("view") ?? "inbox";
	const address = params.get("address") ?? "";

	useEffect(() => {
		let alive = true;
		AddressesApi.list()
			.then((res) => alive && setAddresses(res.data))
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, []);

	const toggleSidebar = () => {
		setOpen((v) => {
			const next = !v;
			try {
				localStorage.setItem(SIDEBAR_KEY, next ? "open" : "closed");
			} catch {
				/* 保存できなくても動作に影響はない */
			}
			return next;
		});
	};

	const selectAddress = (id: string) => {
		const next = new URLSearchParams(params);
		if (id) next.set("address", id);
		else next.delete("address");
		setParams(next);
		if (window.location.pathname !== "/") navigate({ pathname: "/", search: next.toString() });
	};

	const handleLogout = async () => {
		setLoggingOut(true);
		await logout();
		navigate("/login", { replace: true });
	};

	const toggleTheme = () => {
		const next: Theme = theme === "light" ? "dark" : "light";
		setTheme(next);
		setThemeState(next);
	};

	const onSearch = (e: FormEvent) => {
		e.preventDefault();
		const query = q.trim();
		navigate(query ? `/search?q=${encodeURIComponent(query)}` : "/search");
	};

	const viewHref = (key: string) => {
		const next = new URLSearchParams();
		if (address) next.set("address", address);
		if (key !== "inbox") next.set("view", key);
		const s = next.toString();
		return s ? `/?${s}` : "/";
	};

	const composeTo = address ? `/compose?from=${encodeURIComponent(address)}` : "/compose";

	useEffect(() => {
		setDrawerOpen(false);
	}, [params]);

	const accountControl = (big: boolean) => (
		<div className="relative shrink-0" ref={accountRef}>
			<button
				type="button"
				onClick={() => setAccountOpen((v) => !v)}
				title={me?.email}
				aria-label="アカウント"
				className={`grid ${big ? "h-11 w-11" : "h-9 w-9"} place-items-center rounded-full bg-[var(--accent)] text-sm font-medium text-white transition-opacity hover:opacity-90`}
			>
				{initialOf(me?.name ?? me?.email ?? "")}
			</button>

			{accountOpen && (
				<div className="absolute right-0 z-20 mt-1 w-64 overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--surface)] py-1 shadow-lg">
					<div className="flex items-center gap-3 px-4 py-3">
							<span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[var(--accent)] text-sm font-medium text-white">
									{initialOf(me?.name ?? me?.email ?? "")}
								</span>
								<span className="min-w-0">
									<span className="flex items-center gap-1.5">
										<span className="truncate text-sm text-[var(--text)]">{me?.name}</span>
										{me?.role === "owner" && (
											<span className="shrink-0 rounded-full bg-[var(--surface-selected)] px-1.5 py-0.5 text-[10px] text-[var(--text-on-selected)]">
												オーナー
											</span>
										)}
									</span>
									<span className="block truncate text-xs text-[var(--text-muted)]">{me?.email}</span>
								</span>
							</div>
					<div className="my-1 border-t border-[var(--line-soft)]" />
					{me?.role === "owner" && (
						<button
							type="button"
							onClick={() => {
								setAccountOpen(false);
								setShowAddMember(true);
							}}
							className="w-full px-4 py-2 text-left text-sm text-[var(--text)] hover:bg-[var(--surface-hover)]"
						>
							メンバーを追加
						</button>
					)}
					<Link
						to="/settings"
						onClick={() => setAccountOpen(false)}
						className="block px-4 py-2 text-sm text-[var(--text)] hover:bg-[var(--surface-hover)]"
					>
						設定
					</Link>
					{me?.role === "owner" && (
						<Link
							to="/admin/users"
							onClick={() => setAccountOpen(false)}
							className="block px-4 py-2 text-sm text-[var(--text)] hover:bg-[var(--surface-hover)]"
						>
							ユーザーの管理
						</Link>
					)}
					<div className="my-1 border-t border-[var(--line-soft)]" />
					<button
						type="button"
						onClick={handleLogout}
						disabled={loggingOut}
						className="w-full px-4 py-2 text-left text-sm text-[var(--text)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
					>
						ログアウト
					</button>
				</div>
			)}
		</div>
	);

	return (
		<div className="flex h-screen flex-col bg-[var(--surface-sunken)]">
			{isMobile ? (
				<header className="flex h-16 shrink-0 items-center gap-1.5 px-3">
					<button
						type="button"
						onClick={() => setDrawerOpen(true)}
						className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)]"
						aria-label="メニュー"
					>
						<MenuIcon />
					</button>
					<div className="min-w-0 flex-1 self-center">
						<MailboxSwitcher addresses={addresses} selected={address} onSelect={selectAddress} flexible />
					</div>
					<Link
						to="/notifications"
						aria-label="通知"
						className="relative grid h-11 w-11 shrink-0 place-items-center rounded-full text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)]"
					>
						<BellIcon />
						{unseenCount > 0 && (
							<span
								className="pointer-events-none absolute right-1.5 top-1.5 size-2.5 rounded-full bg-[var(--danger)]"
								aria-hidden
							/>
						)}
					</Link>
					{accountControl(true)}
				</header>
			) : (
				<header className="flex h-16 shrink-0 items-center gap-3 px-4">
				<button
					type="button"
					onClick={toggleSidebar}
					className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)]"
					title={open ? "メニューを畳む" : "メニューを開く"}
					aria-label="メニューの開閉"
				>
					<MenuIcon />
				</button>

				<Link to="/" className="shrink-0 text-lg font-bold tracking-tight text-[var(--text)]">
					Tsubame
				</Link>

				<MailboxSwitcher addresses={addresses} selected={address} onSelect={selectAddress} />

				<form
					onSubmit={onSearch}
					className="flex h-10 max-w-[720px] flex-1 items-center gap-2 rounded-full bg-[var(--surface-hover)] px-4"
				>
					<span className="shrink-0 text-[var(--text-muted)]">
						<SearchIcon />
					</span>
					<input
						value={q}
						onChange={(e) => setQ(e.target.value)}
						placeholder="メールを検索"
						className="min-w-0 flex-1 bg-transparent text-sm text-[var(--text)] outline-none placeholder:text-[var(--text-muted)]"
					/>
				</form>

				<div className="flex shrink-0 items-center gap-1">
					<div className="relative" ref={accountRef}>
						<button
							type="button"
							onClick={() => setAccountOpen((v) => !v)}
							title={me?.email}
							aria-label="アカウント"
							className="grid h-9 w-9 place-items-center rounded-full bg-[var(--accent)] text-sm font-medium text-white transition-opacity hover:opacity-90"
						>
							{initialOf(me?.name ?? me?.email ?? "")}
						</button>

						{accountOpen && (
							<div className="absolute right-0 z-20 mt-1 w-64 overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--surface)] py-1 shadow-lg">
								<div className="flex items-center gap-3 px-4 py-3">
									<span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[var(--accent)] text-sm font-medium text-white">
										{initialOf(me?.name ?? me?.email ?? "")}
									</span>
									<span className="min-w-0">
										<span className="flex items-center gap-1.5">
											<span className="truncate text-sm text-[var(--text)]">{me?.name}</span>
											{me?.role === "owner" && (
												<span className="shrink-0 rounded-full bg-[var(--surface-selected)] px-1.5 py-0.5 text-[10px] text-[var(--text-on-selected)]">
													オーナー
												</span>
											)}
										</span>
										<span className="block truncate text-xs text-[var(--text-muted)]">{me?.email}</span>
									</span>
								</div>
								<div className="my-1 border-t border-[var(--line-soft)]" />
								{me?.role === "owner" && (
									<button
										type="button"
										onClick={() => {
											setAccountOpen(false);
											setShowAddMember(true);
										}}
										className="w-full px-4 py-2 text-left text-sm text-[var(--text)] hover:bg-[var(--surface-hover)]"
									>
										メンバーを追加
									</button>
								)}
								<Link
									to="/settings"
									onClick={() => setAccountOpen(false)}
									className="block px-4 py-2 text-sm text-[var(--text)] hover:bg-[var(--surface-hover)]"
								>
									設定
								</Link>
								{me?.role === "owner" && (
									<Link
										to="/admin/users"
										onClick={() => setAccountOpen(false)}
										className="block px-4 py-2 text-sm text-[var(--text)] hover:bg-[var(--surface-hover)]"
									>
										ユーザーの管理
									</Link>
								)}
								<div className="my-1 border-t border-[var(--line-soft)]" />
								<button
									type="button"
									onClick={handleLogout}
									disabled={loggingOut}
									className="w-full px-4 py-2 text-left text-sm text-[var(--text)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
								>
									ログアウト
								</button>
							</div>
						)}
					</div>
					<button
						type="button"
						onClick={toggleTheme}
						className="grid h-10 w-10 place-items-center rounded-full text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)]"
						title={theme === "light" ? "暗くする" : "明るくする"}
					>
						{theme === "light" ? <MoonIcon /> : <SunIcon />}
					</button>
				</div>
			</header>
			)}

			<div className="flex min-h-0 flex-1">
				{!isMobile && (
					<aside
					className={`shrink-0 overflow-y-auto px-2 pb-4 transition-[width] ${
						open ? "w-56" : "w-[72px]"
					}`}
				>
					<Link
						to={composeTo}
						className={`mb-3 flex h-12 items-center gap-3 rounded-full bg-[var(--accent-weak)] text-[var(--accent-text)] shadow-sm transition-shadow hover:shadow ${
							open ? "px-5" : "w-14 justify-center px-0"
						}`}
					>
						<PencilIcon />
						{open && <span className="text-sm font-medium">作成</span>}
					</Link>

					<nav className="flex flex-col gap-0.5">
						{VIEWS.map((v) => {
							const active = view === v.key;
							return (
								<Link
									key={v.key}
									to={viewHref(v.key)}
									title={v.label}
									className={`flex h-9 items-center gap-3 rounded-r-full px-4 text-sm transition-colors ${
										active
											? "bg-[var(--surface-selected)] font-medium text-[var(--text-on-selected)]"
											: "text-[var(--text)] hover:bg-[var(--surface-hover)]"
									} ${open ? "" : "justify-center px-0"}`}
								>
									<span className="shrink-0">{v.icon}</span>
									{open && <span className="min-w-0 flex-1 truncate">{v.label}</span>}
								</Link>
							);
						})}
					</nav>

					<div className="my-3 border-t border-[var(--line-soft)]" />

					<nav className="flex flex-col gap-0.5">
						<Link
							to="/settings"
							title="設定"
							className={`flex h-9 items-center gap-3 rounded-r-full px-4 text-sm text-[var(--text)] transition-colors hover:bg-[var(--surface-hover)] ${
								open ? "" : "justify-center px-0"
							}`}
						>
							<span className="shrink-0">
								<GearIcon />
							</span>
							{open && <span className="min-w-0 flex-1 truncate">設定</span>}
						</Link>
						{me?.role === "owner" && (
							<Link
								to="/admin/domains"
								title="管理"
								className={`flex h-9 items-center gap-3 rounded-r-full px-4 text-sm text-[var(--text)] transition-colors hover:bg-[var(--surface-hover)] ${
									open ? "" : "justify-center px-0"
								}`}
							>
								<span className="shrink-0">
									<ShieldIcon />
								</span>
								{open && <span className="min-w-0 flex-1 truncate">管理</span>}
							</Link>
						)}
					</nav>
				</aside>
				)}

				{/* scrollbar-gutter: stable がないと、内容の長さでページごとに 15px ほど横ずれする。 */}
				<main
					className={`flex min-w-0 flex-1 flex-col overflow-y-auto ${isMobile ? "" : "pb-4 pr-4"}`}
					style={isMobile ? undefined : { scrollbarGutter: "stable" }}
				>
					<Outlet />
				</main>
			</div>

			{isMobile && drawerOpen && (
				<div className="fixed inset-0 z-40">
					<div
						className="absolute inset-0 bg-black/40"
						onClick={() => setDrawerOpen(false)}
						aria-hidden
					/>
					<nav className="absolute left-0 top-0 flex h-full w-72 flex-col overflow-y-auto bg-[var(--surface)] px-2 py-4 shadow-2xl">
						<Link
							to={composeTo}
							onClick={() => setDrawerOpen(false)}
							className="mb-3 flex h-12 shrink-0 items-center justify-center gap-2 rounded-full bg-[var(--accent-weak)] text-[var(--accent-text)] shadow-sm transition-shadow hover:shadow"
						>
							<PencilIcon />
							<span className="text-sm font-medium">作成</span>
						</Link>
						<nav className="flex flex-col gap-0.5">
							{VIEWS.map((v) => {
								const active = view === v.key;
								return (
									<Link
										key={v.key}
										to={viewHref(v.key)}
										onClick={() => setDrawerOpen(false)}
										className={`flex h-11 items-center gap-3 rounded-r-full px-4 text-sm transition-colors ${
											active
												? "bg-[var(--surface-selected)] font-medium text-[var(--text-on-selected)]"
												: "text-[var(--text)] hover:bg-[var(--surface-hover)]"
										}`}
									>
										<span className="shrink-0">{v.icon}</span>
										<span className="min-w-0 flex-1 truncate">{v.label}</span>
									</Link>
								);
							})}
							<div className="my-2 border-t border-[var(--line-soft)]" />
							<Link
								to="/settings"
								onClick={() => setDrawerOpen(false)}
								className="flex h-11 items-center gap-3 rounded-r-full px-4 text-sm text-[var(--text)] transition-colors hover:bg-[var(--surface-hover)]"
							>
								<span className="shrink-0">
									<GearIcon />
								</span>
								<span className="min-w-0 flex-1 truncate">設定</span>
							</Link>
							{me?.role === "owner" && (
								<Link
									to="/admin/domains"
									onClick={() => setDrawerOpen(false)}
									className="flex h-11 items-center gap-3 rounded-r-full px-4 text-sm text-[var(--text)] transition-colors hover:bg-[var(--surface-hover)]"
								>
									<span className="shrink-0">
										<ShieldIcon />
									</span>
									<span className="min-w-0 flex-1 truncate">管理</span>
								</Link>
							)}
						</nav>
					</nav>
				</div>
			)}

			{showAddMember && <AddMemberDialog onClose={() => setShowAddMember(false)} />}
		</div>
	);
}
