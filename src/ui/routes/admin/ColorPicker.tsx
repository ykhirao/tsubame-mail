import { useState } from "react";
import { MAILBOX_COLORS, isHexColor } from "@/shared/colors";

// 一覧で見分けるためだけの値なので、彩度や明度の検証まではしない。
export function ColorPicker({
	value,
	onChange,
}: {
	value: string | null;
	onChange: (hex: string) => void;
}) {
	const [custom, setCustom] = useState(value && !isPreset(value) ? value : "");

	return (
		<div className="space-y-3">
			<div className="flex flex-wrap gap-1.5">
				{MAILBOX_COLORS.map((c) => {
					const active = value?.toLowerCase() === c.hex;
					return (
						<button
							key={c.id}
							type="button"
							title={c.name}
							aria-label={c.name}
							onClick={() => onChange(c.hex)}
							className={`h-7 w-7 rounded-full transition-transform hover:scale-110 ${
								active ? "ring-2 ring-[var(--text)] ring-offset-2 ring-offset-[var(--surface)]" : ""
							}`}
							style={{ background: c.hex }}
						/>
					);
				})}
			</div>

			<div className="flex items-center gap-2">
				<span className="text-xs text-[var(--text-muted)]">それ以外の色</span>
				<input
					type="color"
					value={isHexColor(value ?? "") ? value! : "#1a73e8"}
					onChange={(e) => {
						setCustom(e.target.value);
						onChange(e.target.value);
					}}
					className="h-8 w-10 cursor-pointer rounded border border-[var(--line)] bg-transparent p-0.5"
					aria-label="色を選ぶ"
				/>
				<input
					type="text"
					value={custom}
					placeholder="#1a73e8"
					onChange={(e) => {
						const v = e.target.value.trim();
						setCustom(v);
						if (isHexColor(v)) onChange(v.toLowerCase());
					}}
					className="h-8 w-28 rounded border border-[var(--line)] bg-[var(--surface)] px-2 font-mono text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
				/>
				{custom && !isHexColor(custom) && (
					<span className="text-xs text-[var(--danger)]">#rrggbb の形で入力してください</span>
				)}
			</div>
		</div>
	);
}

function isPreset(hex: string): boolean {
	return MAILBOX_COLORS.some((c) => c.hex === hex.toLowerCase());
}
