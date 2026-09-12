export type QuietRange = {
	/** 0=日曜 … 6=土曜。空なら全日。 */
	days: number[];
	/** 分（0–1439）。 */
	start: number;
	end: number;
};

export type QuietSchedule = {
	tz: string;
	mode: "drop" | "digest";
	ranges: QuietRange[];
};

type WallDate = { y: number; mo: number; d: number };

function offsetMinutes(tz: string, ms: number): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: tz,
		timeZoneName: "longOffset",
	}).formatToParts(ms);
	const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
	const m = name.match(/GMT([+-])(\d{2}):?(\d{2})/);
	if (!m) return 0;
	return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

function wall(tz: string, ms: number): { wd: WallDate; dow: number; minuteOfDay: number } {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: tz,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).formatToParts(ms);
	const g: Record<string, string> = {};
	for (const p of parts) g[p.type] = p.value;
	const y = Number(g.year);
	const mo = Number(g.month);
	const d = Number(g.day);
	const wd = { y, mo, d };
	return { wd, dow: new Date(Date.UTC(y, mo - 1, d)).getUTCDay(), minuteOfDay: Number(g.hour) * 60 + Number(g.minute) };
}

// ローカル時＝UTC＋オフセット。target をローカル時として解釈した instant は target−offset。
// DST でオフセットが変わるので、target の周辺で数回反復して収束させる。
function zonedMs(tz: string, y: number, mo: number, d: number, h: number, mi: number): number {
	const target = Date.UTC(y, mo - 1, d, h, mi);
	let ms = target;
	for (let i = 0; i < 3; i++) ms = target - offsetMinutes(tz, ms) * 60000;
	return ms;
}

function startOfDayMs(tz: string, wd: WallDate): number {
	return zonedMs(tz, wd.y, wd.mo, wd.d, 0, 0);
}

function shiftDay(wd: WallDate, delta: number): WallDate {
	const dt = new Date(Date.UTC(wd.y, wd.mo - 1, wd.d) + delta * 86400000);
	return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/** ある日曜（曜日）に開始する 1 回分の静音区間 [startMs, endMs)。日をまたぐのは end < start で表す。 */
function occurrence(tz: string, root: WallDate, range: QuietRange): [number, number] {
	const startMs = startOfDayMs(tz, root) + range.start * 60000;
	const endMs =
		range.end <= range.start
			? startOfDayMs(tz, shiftDay(root, 1)) + range.end * 60000
			: startOfDayMs(tz, root) + range.end * 60000;
	return [startMs, endMs];
}

export function isQuiet(schedule: QuietSchedule, nowMs: number): boolean {
	try {
		const { wd } = wall(schedule.tz, nowMs);
		// 区間は最大 2 日をまたぐので、昨日・今日に開始する分だけ見ればよい。
		const roots = [shiftDay(wd, -1), wd];
		for (const range of schedule.ranges) {
			for (const root of roots) {
				if (range.days.length > 0 && !range.days.includes(new Date(Date.UTC(root.y, root.mo - 1, root.d)).getUTCDay())) {
					continue;
				}
				const [startMs, endMs] = occurrence(schedule.tz, root, range);
				if (nowMs >= startMs && nowMs < endMs) return true;
			}
		}
		return false;
	} catch {
		// 壊れた tz は「静音でない」とみなし、通知を止めない。
		return false;
	}
}

/** 今より後で最初に静音が終わる時刻（epoch ms）。 */
export function nextQuietEnd(schedule: QuietSchedule, nowMs: number): number {
	try {
		const { wd } = wall(schedule.tz, nowMs);
		let best = Infinity;
		// 曜日の並びは週で繰り返すので、昨日＋8 日先まで調べればどの区間の終わりにも届く。
		for (const range of schedule.ranges) {
			for (let k = -1; k < 8; k++) {
				const root = shiftDay(wd, k);
				if (range.days.length > 0 && !range.days.includes(new Date(Date.UTC(root.y, root.mo - 1, root.d)).getUTCDay())) {
					continue;
				}
				const [, endMs] = occurrence(schedule.tz, root, range);
				if (endMs > nowMs && endMs < best) best = endMs;
			}
		}
		return best;
	} catch {
		// 壊れた tz は静音でないので、今すぐ配信できるよう nowMs を返す。
		return nowMs;
	}
}
