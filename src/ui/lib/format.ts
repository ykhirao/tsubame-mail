const timeFmt = new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit" });
const shortDateFmt = new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric" });
const fullDateFmt = new Intl.DateTimeFormat("ja-JP", {
	year: "numeric",
	month: "long",
	day: "numeric",
});
const dateTimeFmt = new Intl.DateTimeFormat("ja-JP", {
	year: "numeric",
	month: "numeric",
	day: "numeric",
	hour: "2-digit",
	minute: "2-digit",
});

export function formatDate(unixSec: number): string {
	const d = new Date(unixSec * 1000);
	const now = new Date();
	if (d.toDateString() === now.toDateString()) return timeFmt.format(d);
	return shortDateFmt.format(d);
}

export function formatFullDate(unixSec: number): string {
	return fullDateFmt.format(new Date(unixSec * 1000));
}

export function formatDateTime(unixSec: number): string {
	return dateTimeFmt.format(new Date(unixSec * 1000));
}

export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
