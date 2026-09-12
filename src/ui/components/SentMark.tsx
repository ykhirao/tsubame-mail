// 一覧では受信も送信控えも「差出人・件名・時刻」が同じ形で並ぶ。自分宛に送ると
// 同じ件名の行が 2 本並んで見分けられないので、送信控えの側にだけ印を付ける（B-34）。
export function SentMark() {
	return (
		<span className="shrink-0 text-xs opacity-70" title="自分が送ったメール">
			送信
		</span>
	);
}
