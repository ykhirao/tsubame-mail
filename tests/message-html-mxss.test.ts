import { describe, expect, it } from "vitest";
import { buildSrcDoc } from "@/ui/components/MessageHtml";

// #17 再検査失敗（第 2 回）の再現。この実行環境（@cloudflare/vitest-pool-workers、workerd）には
// DOMParser が無いので、ここで通っているのは常に正規表現の代用経路（MessageHtml.tsx の
// stripDangerousOnceRegex）。ブラウザの DOMParser 経路（stripDangerousOnceDom）は Chrome headless で
// 別途確認した（報告に記載。攻撃者ホスト役の TCP リスナへの接続が 3 攻撃とも 0 だった）。
describe("MessageHtml buildSrcDoc — #17 mXSS の再検査失敗を再現するテスト", () => {
	it("1) 名前空間混乱: math/mglyph/style に隠れた <link> ごと除去する", () => {
		const payload =
			"<form><math><mtext></form><form><mglyph><style></math>" +
			"<link rel=preconnect href=http://attacker.example/>";
		const doc = buildSrcDoc(payload, false);
		expect(doc).not.toContain("<link");
		expect(doc).not.toContain("attacker.example");
		// math/svg は名前空間混乱の温床なので丸ごと落ちる（style 自体は無害なので残ってよい）。
		expect(doc).not.toMatch(/<math\b/i);
	});

	it("2) 属性値に隠れた <link>: iframe の srcdoc 属性ごと除去する", () => {
		const payload = '<iframe srcdoc="&lt;link rel=preconnect href=http://attacker.example/&gt;"></iframe>';
		const doc = buildSrcDoc(payload, false);
		expect(doc).not.toContain("<iframe");
		expect(doc).not.toContain("attacker.example");
	});

	it("3) iframe src への投機接続: iframe 要素ごと除去する（sandbox・CSP では止まらない）", () => {
		const payload = '<iframe src="http://attacker.example/"></iframe>';
		const doc = buildSrcDoc(payload, false);
		expect(doc).not.toContain("<iframe");
		expect(doc).not.toContain("attacker.example");
	});

	it("frame/object/embed も要素ごと落とす", () => {
		const doc = buildSrcDoc(
			'<frame src="http://attacker.example/a">' +
				'<object data="http://attacker.example/b"></object>' +
				'<embed src="http://attacker.example/c">' +
				"<p>本文</p>",
			false,
		);
		expect(doc).not.toMatch(/<(frame|object|embed)\b/i);
		expect(doc).not.toContain("attacker.example");
		expect(doc).toContain("<p>本文</p>");
	});

	it("除去後に断片が再結合して蘇る細工も、収束するまで繰り返して落とす", () => {
		// 1 回の置換だけだと "<i" + "<iframe>" + "frame>" の中間だけが消えて
		// "<i" + "frame>" = "<iframe>" が復活する（単純な単発正規表現サニタイザの典型的な穴）。
		const doc = buildSrcDoc("<i<iframe src=http://attacker.example/>frame><p>本文</p>", false);
		expect(doc).not.toContain("<iframe");
		expect(doc).not.toContain("attacker.example");
		expect(doc).toContain("<p>本文</p>");
	});

	it("収束の上限を超えるほど深く入れ子にした細工は、安全側に倒して本文を空にする", () => {
		let nested = "iframe";
		for (let i = 0; i < 8; i++) nested = `i<${nested}>frame`;
		const payload = `<${nested} src=http://attacker.example/>`;
		const doc = buildSrcDoc(payload, false);
		expect(doc).not.toContain("<iframe");
		expect(doc).not.toContain("attacker.example");
	});

	// 差し戻し 1: <template shadowrootmode> の宣言的 Shadow DOM。DOMParser.parseFromString は
	// shadow root を作らないので中身が querySelectorAll に掛からず outerHTML に生き残るが、
	// srcdoc 側のナビゲーションパーサは shadow root を作って中身を live にする（Chrome 152 実測）。
	it("4) 宣言的 Shadow DOM (open) に隠れた iframe ごと template を落とす", () => {
		const payload = '<div><template shadowrootmode="open"><iframe src="http://attacker.example/"></template></div>';
		const doc = buildSrcDoc(payload, false);
		expect(doc).not.toMatch(/<template\b/i);
		expect(doc).not.toContain("<iframe");
		expect(doc).not.toContain("attacker.example");
	});

	it("宣言的 Shadow DOM (closed) でも同様に落とす", () => {
		const payload = '<div><template shadowrootmode="closed"><iframe src="http://attacker.example/"></template></div>';
		const doc = buildSrcDoc(payload, false);
		expect(doc).not.toMatch(/<template\b/i);
		expect(doc).not.toContain("<iframe");
		expect(doc).not.toContain("attacker.example");
	});

	it("宣言的 Shadow DOM に隠れた <link rel=preconnect> も落とす", () => {
		const payload =
			'<div><template shadowrootmode="open">' +
			'<link rel="preconnect" href="http://attacker.example/">' +
			"</template></div>";
		const doc = buildSrcDoc(payload, false);
		expect(doc).not.toMatch(/<template\b/i);
		expect(doc).not.toContain("<link");
		expect(doc).not.toContain("attacker.example");
	});

	it("Shadow DOM と名前空間混乱を組み合わせた細工も落とす", () => {
		const payload =
			'<template shadowrootmode="open">' +
			"<form><math><mtext></form><form><mglyph><style></math>" +
			"<link rel=preconnect href=http://attacker.example/>" +
			"</template>";
		const doc = buildSrcDoc(payload, false);
		expect(doc).not.toMatch(/<template\b/i);
		expect(doc).not.toMatch(/<math\b/i);
		expect(doc).not.toContain("<link");
		expect(doc).not.toContain("attacker.example");
	});
});

// 差し戻し 2: pre/textarea/listing 直後の先頭 LF が収束ループの周回ごとに 1 つずつ消え、
// 5 つ以上あると上限に達して本文が丸ごと空になる誤検知（Chrome 実測）。この経路
// （stripDangerousOnceDom）は DOMParser が要るが、workerd（この実行環境）には無いので
// vitest では再現できない。ここでは正規表現の代用経路が本文をそのまま通すことだけ確かめる。
describe("MessageHtml buildSrcDoc — pre の先頭 LF を壊さない（正規表現経路）", () => {
	it("<pre> の先頭改行を複数含む本文でも空にしない", () => {
		const doc = buildSrcDoc("<pre>\n\n\n\n\nfoo</pre><p>keep</p>", false);
		expect(doc).toContain("foo");
		expect(doc).toContain("<p>keep</p>");
	});
});
