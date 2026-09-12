import { useRef } from "react";

const BLOCK_REMOTE_CSP =
	"default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'";
const ALLOW_REMOTE_IMAGES_CSP =
	"default-src 'none'; img-src data: https:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'";

const REMOTE_REF = /(?:\b(?:src|srcset|background|poster)\s*=\s*["']?|url\(\s*["']?)\s*(?:https?:)?\/\//i;

/** 「画像を表示」を出すかの目安にだけ使う。読み込みを止めているのは CSP の方。 */
export function hasRemoteImages(html: string): boolean {
	return REMOTE_REF.test(html);
}

// iframe/frame/object/embed は要素自体が接続を起こす。math/svg は mglyph/foreignObject 経由の
// 名前空間混乱（下記）の温床なので、表示に要らないこの2つも合わせて落とす。template は
// DOMParser.parseFromString が shadowrootmode 付きでも shadow root を作らず、中身が
// querySelectorAll に掛からないまま outerHTML に残る（宣言的 Shadow DOM の抜け道。
// srcdoc 側のナビゲーションパーサは shadow root を作るので中身が live になる）ので落とす。
const DANGEROUS_TAGS = ["iframe", "frame", "object", "embed", "math", "svg", "template"] as const;

// parse → 除去 → serialize を1回やっただけでは足りない（#17 再検査失敗）。
// 例: <form><math><mtext></form><form><mglyph><style></math><link rel=preconnect href=…>
// は、1 回目の parse では <style> が HTML 要素になり <link …> はその中の生テキストなので
// querySelectorAll("link") に掛からずそのまま outerHTML に残る。iframe 側の再パースで
// <style> が MathML の内側と解釈され直し、<link> が実要素として復活する
// （parse → serialize → reparse が冪等でない = mXSS）。そこで除去後の出力を自分でも
// 再パースし、これ以上変わらなくなるまで繰り返す。上限を超えたら安全側に倒して本文を空にする。
const MAX_STRIP_ROUNDS = 5;

// pre/textarea/listing の直後の先頭 LF は、parse のたびに1つ消費される（HTML5 の仕様どおりの
// 挙動）のに、Chrome の直列化はそれを書き戻さない。素直に毎回 parse → serialize すると、
// 収束ループの周回ごとに正当な本文の先頭 LF が 1 つずつ消え、上限に達すると本文ごと空にする
// フォールバックで消える（誤検知）。次の周回で consumed 分をちょうど打ち消せるよう、
// このラウンドで消費された LF を 1 つ前置してから直列化する。
function restoreConsumedLeadingNewlines(doc: Document): void {
	for (const tag of ["pre", "textarea", "listing"]) {
		for (const el of doc.querySelectorAll(tag)) {
			const first = el.firstChild;
			if (first?.nodeType === Node.TEXT_NODE && (first as Text).data.startsWith("\n")) {
				(first as Text).data = "\n" + (first as Text).data;
			}
		}
	}
}

function stripDangerousOnceDom(html: string): string {
	const doc = new DOMParser().parseFromString(html, "text/html");
	for (const tag of DANGEROUS_TAGS) {
		for (const el of [...doc.querySelectorAll(tag)]) el.remove();
	}
	for (const link of [...doc.querySelectorAll("link")]) link.remove();
	for (const meta of [...doc.querySelectorAll('meta[http-equiv="refresh" i]')]) meta.remove();
	restoreConsumedLeadingNewlines(doc);
	// outerHTML は doctype を含まない。落とすと srcdoc が互換モードになる。
	return "<!DOCTYPE html>" + doc.documentElement.outerHTML;
}

// DOMParser の無い環境（workerd のテストなど）向け。DOM を組み立てず生テキストを
// 直接パターン削除するので、`<style>` の中に文字列として埋まっていても関係なく消える
// （名前空間混乱は DOM の構築結果に依存する現象なので、そもそも起こらない）。
const DANGEROUS_TAG_RE = new RegExp(`<\\/?(?:${DANGEROUS_TAGS.join("|")})\\b[^>]*>`, "gi");

function stripDangerousOnceRegex(html: string): string {
	return html
		.replace(DANGEROUS_TAG_RE, "")
		.replace(/<link\b[^>]*>/gi, "")
		.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, "");
}

function stripUntilStable(html: string, stripOnce: (html: string) => string): string {
	let current = html;
	for (let round = 0; round < MAX_STRIP_ROUNDS; round++) {
		const next = stripOnce(current);
		if (next === current) return next;
		current = next;
	}
	return "";
}

/**
 * CSP は fetch を伴う読み込みしか止めない。`<link rel=preconnect|dns-prefetch|prefetch>` と
 * `<meta http-equiv=refresh>` は接続やナビゲーションを CSP の外で起こし、`iframe`/`frame`/
 * `object`/`embed` は sandbox や CSP があっても要素自体が接続を起こしうるので、
 * srcdoc に入れる前にどちらも取り除く（#17）。
 */
function stripTrackingTags(html: string): string {
	if (typeof DOMParser !== "undefined") return stripUntilStable(html, stripDangerousOnceDom);
	return stripUntilStable(html, stripDangerousOnceRegex);
}

/**
 * CSP の meta は head の中にないと無視される。先頭に置けばパーサが暗黙の head に入れる。
 * doctype より前に置くと互換モードに落ちるので、doctype があればその後ろに差し込む。
 * メール側が別の CSP を書いても、複数の CSP は積集合で効くので緩められない。
 */
export function buildSrcDoc(rawHtml: string, allowRemoteImages: boolean): string {
	const html = stripTrackingTags(rawHtml);
	const csp = allowRemoteImages ? ALLOW_REMOTE_IMAGES_CSP : BLOCK_REMOTE_CSP;
	const head =
		`<meta http-equiv="Content-Security-Policy" content="${csp}">` +
		`<meta http-equiv="x-dns-prefetch-control" content="off">`;
	const doctype = html.match(/^\s*<!doctype[^>]*>/i);
	if (!doctype) return head + html;
	return doctype[0] + head + html.slice(doctype[0].length);
}

/**
 * sandbox に allow-scripts を足してはいけない。スクリプトを実行させないことが
 * サニタイズの代わりになっている。allow-same-origin だけは、onLoad で内容の高さを
 * 読んで iframe を伸ばすために要る。
 */
export function MessageHtml({
	html,
	allowRemoteImages = false,
}: {
	html: string;
	allowRemoteImages?: boolean;
}) {
	const ref = useRef<HTMLIFrameElement>(null);

	return (
		// 広い table などで本文が画面幅を超えても、外のレイアウトを押し広げないように
		// 本文の箱の中で横スクロールさせ、iframe 本体は block にして行内の隙間を消す。
		<div className="w-full overflow-x-auto">
			<iframe
				ref={ref}
				title="メール本文"
				sandbox="allow-same-origin"
				referrerPolicy="no-referrer"
				className="block w-full border-0"
				style={{ minHeight: 120 }}
				srcDoc={buildSrcDoc(html, allowRemoteImages)}
				onLoad={() => {
					const f = ref.current;
					if (!f) return;
					try {
						const doc = f.contentDocument;
						if (!doc?.body) return;
						f.style.height = `${Math.max(doc.body.scrollHeight + 24, 120)}px`;
					} catch {
						/* 高さが読めなくても本文の表示は続ける。 */
					}
				}}
			/>
		</div>
	);
}
