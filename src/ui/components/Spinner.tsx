export function Spinner({ label ="読み込み中…" }: { label?: string }) {
	return (
		<div className="flex items-center justify-center gap-2 py-10 text-sm text-[var(--text-muted)]">
			<span
				className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--text-muted)] border-t-transparent"
				aria-hidden
			/>
			{label}
		</div>
	);
}

export function FullScreenSpinner() {
	return (
		<div className="flex min-h-screen items-center justify-center bg-[var(--surface-sunken)]">
			<Spinner />
		</div>
	);
}
