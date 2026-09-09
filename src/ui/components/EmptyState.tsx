import type { ReactNode } from"react";

export function EmptyState({
	icon ="📭",
	title,
	children,
}: {
	icon?: string;
	title: string;
	children?: ReactNode;
}) {
	return (
		<div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
			<div className="text-3xl" aria-hidden>
				{icon}
			</div>
			<p className="text-sm font-medium text-[var(--text-muted)]">{title}</p>
			{children && <div className="text-sm text-[var(--text-muted)]">{children}</div>}
		</div>
	);
}
