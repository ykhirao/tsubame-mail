import { useEffect, type ReactNode } from "react";
import { Link, useLocation } from "react-router";

// ここに出ていない管理画面は誰にも辿り着けない（API キーの画面がそうなっていた）。
const ADMIN_TABS = [
	{ to: "/admin/domains", label: "ドメイン" },
	{ to: "/admin/addresses", label: "メールボックス" },
	{ to: "/admin/users", label: "ユーザー" },
	{ to: "/admin/api-keys", label: "API キー" },
	{ to: "/admin/webhooks", label: "Webhook" },
	{ to: "/admin/rules", label: "ルール" },
] as const;

export function AdminTabs() {
	const { pathname } = useLocation();
	return (
		<nav className="mb-6 flex flex-wrap gap-1 border-b border-[var(--line-soft)] pb-2">
			{ADMIN_TABS.map((t) => {
				const active = pathname === t.to;
				return (
					<Link
						key={t.to}
						to={t.to}
						className={`flex h-11 items-center rounded-full px-3 py-1.5 text-sm transition-colors md:h-auto ${
							active
								? "bg-[var(--surface-selected)] font-medium text-[var(--text-on-selected)]"
								: "text-[var(--text-muted)] hover:bg-[var(--surface-hover)]"
						}`}
					>
						{t.label}
					</Link>
				);
			})}
		</nav>
	);
}

export function Page({ title, children }: { title: string; children: ReactNode }) {
	// 中央寄せにすると、ページごとの中身の幅でタブと見出しの位置が動く。
	return (
		<div className="w-full max-w-6xl px-4 py-6 md:px-6">
			<AdminTabs />
			<h1 className="mb-6 text-xl font-bold text-[var(--text)]">{title}</h1>
			{children}
		</div>
	);
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
	return <div className={`card ${className}`}>{children}</div>;
}

export function CardHeader({
	title,
	description,
	action,
}: {
	title: string;
	description?: string;
	action?: ReactNode;
}) {
	return (
		<div className="flex items-start justify-between gap-4 border-b border-[var(--line)] px-5 py-4">
			<div>
				<h2 className="text-base font-semibold text-[var(--text)]">{title}</h2>
				{description && <p className="mt-1 text-sm text-[var(--text-muted)]">{description}</p>}
			</div>
			{action}
		</div>
	);
}

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

const buttonStyles: Record<ButtonVariant, string> = {
	primary: "bg-[var(--accent)] text-white hover:opacity-90",
	secondary:
		"bg-[var(--surface)] text-[var(--text)] border border-[var(--line)] hover:bg-[var(--surface-hover)]",
	danger: "bg-transparent text-[var(--danger)] hover:bg-[var(--surface-hover)]",
	ghost: "bg-transparent text-[var(--text-muted)] hover:bg-[var(--surface-hover)]",
};

export function Button({
	variant = "primary",
	className = "",
	type = "button",
	...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
	return (
		<button
			type={type}
			className={`pill inline-flex max-md:min-h-11 items-center justify-center px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${buttonStyles[variant]} ${className}`}
			{...rest}
		/>
	);
}

export function Label({ children }: { children: ReactNode }) {
	return <label className="mb-1 block text-sm font-medium text-[var(--text)]">{children}</label>;
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
	return (
		<input
			{...props}
			className={`w-full rounded-md border border-[var(--line)] bg-[var(--surface)] px-3 py-1.5 text-sm max-md:text-base max-md:py-2 text-[var(--text)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)] ${props.className ?? ""}`}
		/>
	);
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
	return (
		<select
			{...props}
			className={`w-full rounded-md border border-[var(--line)] bg-[var(--surface)] px-3 py-1.5 text-sm max-md:text-base max-md:py-2 text-[var(--text)] focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)] ${props.className ?? ""}`}
		/>
	);
}

export function Checkbox(props: React.InputHTMLAttributes<HTMLInputElement>) {
	return (
		<input
			type="checkbox"
			{...props}
			className={`size-4 rounded border-[var(--line)] text-[var(--accent)] focus:ring-[var(--accent)] ${props.className ?? ""}`}
		/>
	);
}

export type BadgeColor = "green" | "red" | "yellow" | "gray" | "blue" | "purple";

const badgeStyles: Record<BadgeColor, string> = {
	green: "bg-[var(--surface-hover)] text-[var(--success)]",
	red: "bg-[var(--surface-hover)] text-[var(--danger)]",
	yellow: "bg-[var(--surface-hover)] text-[var(--warning)]",
	gray: "bg-[var(--surface-hover)] text-[var(--text-muted)]",
	blue: "bg-[var(--surface-hover)] text-[var(--accent)]",
	purple: "bg-[var(--surface-hover)] text-[var(--accent)]",
};

export function Badge({ color, children }: { color: BadgeColor; children: ReactNode }) {
	return (
		<span
			className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${badgeStyles[color]}`}
		>
			{children}
		</span>
	);
}

export function ErrorBanner({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
	if (!message) return null;
	return (
		<div
			role="alert"
			className="mb-4 flex items-start justify-between gap-4 rounded-md border border-[var(--danger)] bg-[var(--surface-hover)] px-4 py-3 text-sm text-[var(--danger)]"
		>
			<p className="whitespace-pre-wrap">{message}</p>
			{onDismiss && (
				<button
					onClick={onDismiss}
					aria-label="閉じる"
					className="text-[var(--danger)] hover:opacity-70"
				>
					×
				</button>
			)}
		</div>
	);
}

export function Notice({
	children,
	tone = "info",
}: {
	children: ReactNode;
	tone?: "info" | "warn" | "danger";
}) {
	const styles = {
		info: "border border-[var(--line)] bg-[var(--surface-hover)] text-[var(--text)]",
		warn: "border-l-4 border-[var(--warning)] bg-[var(--surface-hover)] text-[var(--text)]",
		danger: "border-l-4 border-[var(--danger)] bg-[var(--surface-hover)] text-[var(--text)]",
	}[tone] satisfies string;
	return <div className={`rounded-md px-4 py-3 text-sm ${styles}`}>{children}</div>;
}

export function WarningBlock({ children }: { children: ReactNode }) {
	return (
		<div className="rounded-r-md border-l-4 border-[var(--warning)] bg-[var(--surface-hover)] px-4 py-3 text-sm text-[var(--text)]">
			{children}
		</div>
	);
}

export function EmptyState({ message }: { message: string }) {
	return <div className="px-5 py-10 text-center text-sm text-[var(--text-muted)]">{message}</div>;
}

export const thCls =
	"px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]";
export const tdCls = "px-4 py-2 text-sm text-[var(--text)]";

export function TableRow({ children }: { children: ReactNode }) {
	return (
		<tr className="border-b border-[var(--line-soft)] last:border-0 hover:bg-[var(--surface-hover)]">
			{children}
		</tr>
	);
}

export function Modal({
	title,
	onClose,
	children,
}: {
	title: string;
	onClose: () => void;
	children: ReactNode;
}) {
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	return (
		<div
			className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-start md:overflow-y-auto md:p-4 md:pt-16"
			onClick={onClose}
		>
			<div
				className="flex max-h-[92dvh] w-full max-w-2xl flex-col overflow-y-auto rounded-t-2xl bg-[var(--surface)] pb-[env(safe-area-inset-bottom)] shadow-xl md:max-h-none md:rounded-2xl md:pb-0"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-[var(--line)] bg-[var(--surface)] px-5 py-3">
					<h3 className="min-w-0 text-base font-semibold text-[var(--text)]">{title}</h3>
					<button
						onClick={onClose}
						aria-label="閉じる"
						className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-xl text-[var(--text-muted)] hover:text-[var(--text)] md:h-auto md:w-auto"
					>
						×
					</button>
				</div>
				<div className="px-5 py-4">{children}</div>
			</div>
		</div>
	);
}

export function MobileField({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex items-start justify-between gap-3 py-1 text-sm">
			<span className="shrink-0 text-[var(--text-muted)]">{label}</span>
			<span className="min-w-0 flex-1 break-words text-right text-[var(--text)]">{children}</span>
		</div>
	);
}

export function MobileActions({ children }: { children: ReactNode }) {
	return <div className="flex flex-wrap justify-end gap-2 pt-2">{children}</div>;
}

export function formatDateTime(sec: number | null | undefined): string {
	if (!sec) return "—";
	const d = new Date(sec * 1000);
	if (Number.isNaN(d.getTime())) return "—";
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
		d.getMinutes(),
	)}`;
}
