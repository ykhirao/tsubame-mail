import type { ReactNode, ButtonHTMLAttributes } from"react";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
	variant?:"primary" |"ghost" |"danger";
	children: ReactNode;
};

export function Button({ variant ="primary", className ="", children, ...rest }: Props) {
	const styles =
		variant ==="primary"
			?"bg-[var(--accent)] text-white hover:opacity-90 disabled:bg-blue-300"
			: variant ==="danger"
				?"bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300"
				:"bg-transparent text-[var(--text)] hover:bg-[var(--surface-hover)] disabled:text-[var(--text-muted)]";
	return (
		<button
			className={`inline-flex items-center gap-1 rounded px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed ${styles} ${className}`}
			{...rest}
		>
			{children}
		</button>
	);
}
