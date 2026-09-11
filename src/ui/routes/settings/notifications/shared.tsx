import type { ReactNode } from "react";
import { Link } from "react-router";

export function Scaffold({
	title,
	summary,
	children,
}: {
	title: string;
	summary?: string;
	children: ReactNode;
}) {
	return (
		<div className="mx-auto flex w-full max-w-xl flex-col gap-3 px-3 py-4 sm:px-0">
			<h1 className="text-lg font-bold text-[var(--text)]">{title}</h1>
			{summary && <p className="text-sm text-[var(--text-muted)]">{summary}</p>}
			{children}
		</div>
	);
}

export function BackLink({ to, label }: { to: string; label: string }) {
	return (
		<Link
			to={to}
			className="inline-flex h-11 items-center gap-1 rounded-full pr-4 text-sm text-[var(--text)] transition-colors hover:bg-[var(--surface-hover)]"
		>
			<span className="text-xl leading-none">‹</span>
			{label}
		</Link>
	);
}

export function Card({ children }: { children: ReactNode }) {
	return <div className="card divide-y divide-[var(--line-soft)] overflow-hidden">{children}</div>;
}

export function SettingRow({
	title,
	subtitle,
	trailing,
	onClick,
	disabled,
}: {
	title: ReactNode;
	subtitle?: ReactNode;
	trailing?: ReactNode;
	onClick?: () => void;
	disabled?: boolean;
}) {
	const interactive = onClick !== undefined;
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled || !interactive}
			className={`flex min-h-[52px] w-full items-center gap-3 px-4 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
				interactive ? "hover:bg-[var(--surface-hover)]" : ""
			}`}
		>
			<span className="min-w-0 flex-1">
				<span className="block text-sm text-[var(--text)]">{title}</span>
				{subtitle && <span className="mt-0.5 block text-xs text-[var(--text-muted)]">{subtitle}</span>}
			</span>
			{trailing}
		</button>
	);
}

export function Toggle({
	checked,
	onChange,
	disabled,
}: {
	checked: boolean;
	onChange: (v: boolean) => void;
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			disabled={disabled}
			onClick={() => onChange(!checked)}
			className="-m-2 grid h-11 w-11 shrink-0 place-items-center rounded-full disabled:opacity-40"
		>
			<span
				className={`relative h-6 w-10 rounded-full transition-colors ${
					checked ? "bg-[var(--accent)]" : "bg-[var(--line)]"
				}`}
			>
				<span
					className={`absolute top-0.5 block h-5 w-5 rounded-full bg-white shadow transition-transform ${
						checked ? "translate-x-[18px]" : "translate-x-0.5"
					}`}
				/>
			</span>
		</button>
	);
}

export function Chevron() {
	return (
		<span className="shrink-0 text-[var(--text-muted)]" aria-hidden>
			›
		</span>
	);
}

export function MailboxDot({ color }: { color: string }) {
	return (
		<span
			className="inline-block h-2.5 w-[15px] shrink-0 rounded-full"
			style={{ background: color }}
		/>
	);
}

export function LevelChip({ level }: { level: string }) {
	const label =
		level === "all"
			? "すべての新着"
			: level === "new_thread"
				? "新しい会話だけ"
				: level === "direct"
					? "To に入っているときだけ"
					: level === "off"
						? "通知しない"
						: level;
	return (
		<span className="shrink-0 rounded-full bg-[var(--surface-hover)] px-2 py-0.5 text-xs text-[var(--text-muted)]">
			{label}
		</span>
	);
}
