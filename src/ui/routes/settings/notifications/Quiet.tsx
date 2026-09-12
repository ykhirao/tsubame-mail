import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { QuietHours } from "@/shared/contracts/notifications";
import { NotificationsApi } from "@/ui/lib/api";
import { SettingsPage, SwitchRow, daysLabel } from "./ruleShared";

const DAYS = [0, 1, 2, 3, 4, 5, 6];
const DAY_NAMES = ["日", "月", "火", "水", "木", "金", "土"];
const WEEKDAYS = [1, 2, 3, 4, 5];

const TZ_OPTIONS = [
	"Asia/Tokyo",
	"Asia/Seoul",
	"Asia/Shanghai",
	"Asia/Taipei",
	"Asia/Hong_Kong",
	"Asia/Singapore",
	"Europe/London",
	"Europe/Paris",
	"Europe/Berlin",
	"America/New_York",
	"America/Los_Angeles",
	"UTC",
];

function defaultTimezone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone;
	} catch {
		return "UTC";
	}
}

export function NotificationsQuiet() {
	const [loaded, setLoaded] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);

	const [on, setOn] = useState(false);
	const [ranges, setRanges] = useState<{ days: number[]; start: string; end: string }[]>([]);
	const [mode, setMode] = useState<"drop" | "digest">("digest");
	const [tz, setTz] = useState(defaultTimezone());

	useEffect(() => {
		void (async () => {
			try {
				const s = await NotificationsApi.get();
				const q = s.quiet;
				setOn(q !== null);
				setMode(q?.mode ?? "digest");
				setTz(q?.tz ?? defaultTimezone());
				setRanges(
					q?.ranges.length
						? q.ranges.map((r) => ({ days: r.days, start: r.start, end: r.end }))
						: [{ days: WEEKDAYS, start: "22:00", end: "07:00" }],
				);
			} catch (e) {
				setError(e instanceof Error ? e.message : "設定の取得に失敗しました");
			} finally {
				setLoaded(true);
			}
		})();
	}, []);

	const toggleDay = (rangeIndex: number, day: number) => {
		setRanges((prev) =>
			prev.map((r, i) => {
				if (i !== rangeIndex) return r;
				const days = r.days.includes(day)
					? r.days.filter((d) => d !== day)
					: [...r.days, day].sort((a, b) => a - b);
				return { ...r, days };
			}),
		);
	};

	const updateRange = (rangeIndex: number, patch: Partial<{ start: string; end: string }>) => {
		setRanges((prev) => prev.map((r, i) => (i === rangeIndex ? { ...r, ...patch } : r)));
	};

	const addRange = () =>
		setRanges((prev) => [...prev, { days: WEEKDAYS, start: "22:00", end: "07:00" }]);

	const removeRange = (rangeIndex: number) =>
		setRanges((prev) => prev.filter((_, i) => i !== rangeIndex));

	const save = async () => {
		setError(null);
		setSaved(false);
		try {
			if (on) {
				const quiet: QuietHours = {
					tz,
					ranges: ranges.map((r) => ({ days: [...r.days].sort((a, b) => a - b), start: r.start, end: r.end })),
					mode,
				};
				await NotificationsApi.patch({ quiet });
			} else {
				await NotificationsApi.patch({ quiet: null });
			}
			setSaved(true);
		} catch (e) {
			setError(e instanceof Error ? e.message : "保存に失敗しました");
		}
	};

	const summary = !loaded
		? "読み込み中…"
		: !on
			? "おやすみ時間は設定されていません"
			: `${ranges.map((r) => `${daysLabel(r.days)} ${r.start}〜${r.end}`).join("、")}${
					mode === "digest"
						? " は終わったときにまとめて通知"
						: " は通知しない"
				}`;

	const valid = on && ranges.length > 0;

	return (
		<SettingsPage title="おやすみ時間" summary={summary}>
			{!loaded ? (
				<div className="text-sm text-[var(--text-muted)]">読み込み中…</div>
			) : (
				<div className="flex flex-col gap-4">
					{error && (
						<div className="rounded-md border border-[var(--danger)] bg-[var(--surface-hover)] px-4 py-3 text-sm text-[var(--danger)]">
							{error}
						</div>
					)}
					{saved && (
						<div className="rounded-md border border-[var(--success)] bg-[var(--surface-hover)] px-4 py-3 text-sm text-[var(--success)]">
							保存しました
						</div>
					)}

					<SwitchRow checked={on} onChange={setOn} label="おやすみ時間">
						<span className="block text-xs text-[var(--text-muted)]">
							この時間帯に届いたメールは
							{mode === "digest" ? "終わったときにまとめて通知します" : "通知しません"}
						</span>
					</SwitchRow>

					<div className={`card flex flex-col gap-4 p-4 ${on ? "" : "pointer-events-none opacity-50"}`}>
						<p className="text-sm font-medium text-[var(--text)]">時間帯</p>
						<div className="flex flex-col gap-4">
							{ranges.map((r, i) => (
								<div key={i} className="flex flex-col gap-2">
									<div className="flex items-center justify-between">
										<span className="text-sm text-[var(--text)]">
											時間帯 {i + 1}
										</span>
										{ranges.length > 1 && (
											<button
												type="button"
												onClick={() => removeRange(i)}
												className="min-h-11 px-2 text-sm text-[var(--danger)] hover:opacity-70"
											>
												削除
											</button>
										)}
									</div>
									<div className="flex gap-2">
										<label className="flex-1">
											<span className="mb-1 block text-xs text-[var(--text-muted)]">開始</span>
											<input
												type="time"
												value={r.start}
												onChange={(e) => updateRange(i, { start: e.target.value })}
												className="w-full rounded-md border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] focus:border-[var(--accent)] focus:outline-none"
											/>
										</label>
										<label className="flex-1">
											<span className="mb-1 block text-xs text-[var(--text-muted)]">終了</span>
											<input
												type="time"
												value={r.end}
												onChange={(e) => updateRange(i, { end: e.target.value })}
												className="w-full rounded-md border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] focus:border-[var(--accent)] focus:outline-none"
											/>
										</label>
									</div>
									<div className="flex gap-1">
										{DAYS.map((d) => (
											<button
												key={d}
												type="button"
												onClick={() => toggleDay(i, d)}
												aria-pressed={r.days.includes(d)}
												className={`h-11 w-11 rounded-full text-sm transition-colors ${
													r.days.includes(d)
														? "bg-[var(--accent)] text-white"
														: "border border-[var(--line)] text-[var(--text-muted)] hover:bg-[var(--surface-hover)]"
												}`}
											>
												{DAY_NAMES[d]}
											</button>
										))}
									</div>
									<p className="text-xs text-[var(--text-muted)]">
										終了が開始より前なら日をまたぎます。空欄の曜日は対象外。
									</p>
								</div>
							))}
						</div>
						<button
							type="button"
							onClick={addRange}
							className="mt-1 h-11 rounded-full border border-[var(--line)] text-sm text-[var(--accent)] hover:bg-[var(--surface-hover)]"
						>
							＋ 時間帯を追加
						</button>
					</div>

					<div className={`card flex flex-col gap-3 p-4 ${on ? "" : "pointer-events-none opacity-50"}`}>
						<p className="text-sm font-medium text-[var(--text)]">おやすみ中の新着</p>
						<label className="flex min-h-11 items-center gap-2 px-1">
							<input
								type="radio"
								name="quiet-mode"
								checked={mode === "drop"}
								onChange={() => setMode("drop")}
								className="size-4 text-[var(--accent)] focus:ring-[var(--accent)]"
							/>
							<span className="text-sm text-[var(--text)]">通知しない</span>
						</label>
						<label className="flex min-h-11 items-center gap-2 px-1">
							<input
								type="radio"
								name="quiet-mode"
								checked={mode === "digest"}
								onChange={() => setMode("digest")}
								className="size-4 text-[var(--accent)] focus:ring-[var(--accent)]"
							/>
							<span className="text-sm text-[var(--text)]">
								終わったときにまとめて 1 通（「おやすみ中に 12 件の新着」）
							</span>
						</label>
					</div>

					<div className={`card flex flex-col gap-2 p-4 ${on ? "" : "pointer-events-none opacity-50"}`}>
						<label className="text-sm font-medium text-[var(--text)]">タイムゾーン</label>
						<select
							value={tz}
							onChange={(e) => setTz(e.target.value)}
							className="w-full rounded-md border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] focus:border-[var(--accent)] focus:outline-none"
						>
							{TZ_OPTIONS.includes(tz) ? null : <option value={tz}>{tz}</option>}
							{TZ_OPTIONS.map((t) => (
								<option key={t} value={t}>
									{t}
								</option>
							))}
						</select>
						<p className="text-xs text-[var(--text-muted)]">既定は端末の設定です。</p>
					</div>

					<div className="card p-4 text-xs leading-relaxed text-[var(--text-muted)]">
						動作が「必ず通知」のルールはおやすみ時間でも通ります。
						<Link
							to="/settings/notifications/rules"
							className="mx-1 text-[var(--accent)] hover:underline"
						>
							通知ルール
						</Link>
						で設定できます。
					</div>

					<button
						type="button"
						disabled={!valid}
						onClick={() => void save()}
						className="h-11 rounded-full bg-[var(--accent)] text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
					>
						保存
					</button>
				</div>
			)}
		</SettingsPage>
	);
}