#!/usr/bin/env node
/**
 * コメントが「why」かどうかを検査する。
 *
 * コメントは実行されないので誰も嘘に気づかない。AI に書かせると、次の行を日本語にしただけの
 * 行が無限に増える。機械で止めないと必ずたまる。
 *
 *   node scripts/check-comments.mjs [--staged | <比較元>] [--llm]
 *   node scripts/check-comments.mjs --all [--llm]   # 差分ではなく全ファイル。密度も出す
 *
 * 既定は規則だけで判定する。`--llm` は灰色のものを安いモデルに渡すが、遅く課金されるので
 * フックと CI では付けない。
 */
import { execSync, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const useLlm = args.includes("--llm");
const staged = args.includes("--staged");
const all = args.includes("--all");
const base = args.find((a) => !a.startsWith("--"));

/** 全ファイル検査で許すコメント密度（コメント行 / 空行を除く行）。 */
const MAX_DENSITY = 0.2;

// core.quotepath=false でないと、日本語のファイル名が 8 進エスケープで返ってきて開けない。
const sh = (cmd) =>
	execSync(`git -c core.quotepath=false ${cmd}`, {
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});

const SOURCES = "'src/**/*.ts' 'src/**/*.tsx' 'e2e/**/*.ts' 'tests/**/*.ts' 'scripts/*.mjs'";

function diff() {
	if (staged) return sh(`diff --cached --unified=0 -- ${SOURCES}`);
	if (base) return sh(`diff --unified=0 ${base}...HEAD -- ${SOURCES}`);
	return sh(`diff --unified=0 HEAD~1...HEAD -- ${SOURCES}`);
}

function sourceFiles() {
	return sh(`ls-files -z -- ${SOURCES}`).split("\0").filter(Boolean);
}

const stripMarkers = (s) =>
	s
		.replace(/^\/\/+/, "")
		.replace(/^\/\*+/, "")
		.replace(/^\*+/, "")
		.replace(/\*\/$/, "")
		.trim();

const isCommentLine = (t) => t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");

/** 記号だけのかたまり（JSDoc の閉じ）は判定しても意味がない。 */
const isJudgeable = (content) => /[\p{L}\p{N}]{2,}/u.test(content);

/**
 * 連続するコメント行を**かたまりで**拾う。1 行ずつ見ると、理由を数行に分けて書いた
 * JSDoc の 2 行目以降が単独では what に見えてしまう。
 * `raw` は先頭行だけを持つ（区切り線の判定に使う）。
 */
function group(lines, file) {
	const out = [];
	let current = null;
	const flush = () => {
		if (current && isJudgeable(current.content)) out.push(current);
		current = null;
	};
	for (const { text, line, next } of lines) {
		if (text === null) {
			flush();
			continue;
		}
		if (!isCommentLine(text)) {
			flush();
			continue;
		}
		const content = stripMarkers(text);
		if (current) {
			current.content += " " + content;
			current.next = next;
		} else if (content) {
			current = { file, line, raw: text, content, next };
		}
	}
	flush();
	return out;
}

function addedComments(text) {
	const out = [];
	let file = "";
	let buf = [];
	const flush = () => {
		if (buf.length) out.push(...group(buf, file));
		buf = [];
	};
	for (const line of text.split("\n")) {
		if (line.startsWith("+++ b/")) {
			flush();
			file = line.slice(6);
			continue;
		}
		if (!line.startsWith("+") || line.startsWith("+++")) {
			buf.push({ text: null });
			continue;
		}
		buf.push({ text: line.slice(1).trim(), line: null, next: "" });
	}
	flush();
	return out;
}

/** 次の非コメント行を添えて拾う。識別子の言い換えかどうかは、その行と比べないと分からない。 */
function allComments(files) {
	const out = [];
	for (const file of files) {
		const lines = readFileSync(file, "utf8").split("\n");
		const seq = lines.map((raw, i) => {
			const t = raw.trim();
			if (!isCommentLine(t)) return { text: t || null };
			let next = "";
			for (let k = i + 1; k < lines.length; k++) {
				const n = lines[k].trim();
				if (!n || isCommentLine(n)) continue;
				next = n;
				break;
			}
			return { text: t, line: i + 1, next };
		});
		out.push(...group(seq, file));
	}
	return out;
}

/**
 * why を示す言葉。
 * 「から」は素通しにできない。「落ちるから」は理由だが「R2 から読み出す」は起点の助詞で、
 * 後者まで why と見なすと、複数行に散らした what がすべてすり抜ける。
 */
const WHY = [
	/[るいたないだれ]から|ので|ため/,
	/理由|避け|防ぐ|壊れ|落ちる|注意|危険|そのまま|代わりに|優先|都合|仕様|制約|前提/,
	/しない|できない/,
	// 「〜されうる」「〜しかねない」— 起きてほしくない結果を述べるのも理由の形。
	/され(うる|得る)|しかねない|てしまう|恐れ|漏れ/,
	/why|because|avoid|prevent|otherwise|note that/i,
];

const statesWhy = (t) => WHY.some((re) => re.test(t));

/** what に寄りがちな言い回し。 */
const WHAT = [
	/^[^。]{0,24}(を)?(取得|設定|作成|削除|更新|返す|返却|処理|実行|呼ぶ|表示|保存|追加)(する|。)?$/,
	/^(returns?|sets?|gets?|creates?|deletes?|updates?|loops?|iterates?)\b/i,
	/^(ここ|以下|上記)(から|より)?(が|は)?[^。]{0,12}(処理|部分|一覧|設定)$/,
];

/** 区切り線・章立て。章立てが要るほど長いなら、コメントではなくファイル分割で直す。 */
const isDivider = (raw) => /^\/\*[-=*\s]{4,}/.test(raw) || /^\/\/\s*[-=]{3,}/.test(raw);

/**
 * 型では表せない情報。これがあれば、名前と語が重なっていても言い換えではない。
 * 異常時の振る舞い・null や特別な値の意味・単位・他フィールドとの関係は、
 * シグネチャを読んでも分からない。
 */
const CONTRACT = [
	/null|undefined|throw|json|utc|"all"/i,
	/空|不正|壊れ|失敗|エラー|例外/,
	/省略|既定|のみ|だけ|いずれ|含む|区切り/,
	/部分集合|積集合|優先|以上|以下|単位|秒|ミリ|バイト/,
	/「/,
	// 「A か B」— 受け付ける形が複数あることは署名から読めない。
	// 「から」を巻き込まないよう、か の後に区切りを要求する。
	/\S+か\s+\S+。?$/,
];

const statesContract = (t) => CONTRACT.some((re) => re.test(t));

/**
 * 次の行の識別子を言い換えただけの JSDoc を捕まえる。
 * 日本語コメントなので語そのものは比べられない。「短くて、理由も型に無い情報も述べず、
 * 名前に現れる語をなぞっているだけ」を近似で見る。
 */
function restatesName(c) {
	if (!c.next) return false;
	if (!/^(export\s+)?(const|function|class|let|type|interface|async)\b|^\w+[?]?:/.test(c.next))
		return false;
	if (c.content.length > 28) return false;
	if (statesWhy(c.content)) return false;
	const name = /([A-Za-z_$][\w$]{2,})/.exec(c.next)?.[1] ?? "";
	if (!name) return false;
	const words = name
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[\s_]+/)
		.filter((w) => w.length > 2);
	return words.some((w) => c.content.toLowerCase().includes(w));
}

/**
 * 複数行のコメントは 1 文目が要約になりがちで、そこだけが what ということが多い。
 * かたまり全体で見ると 2 文目以降の語に隠れて見逃すので、1 文目も単独で当てる。
 */
const firstSentence = (t) => t.split(/[。．]/)[0].trim();

function classify(c) {
	const t = c.content;
	if (/^why:/i.test(t)) return "ok";
	if (isDivider(c.raw)) return "bad";
	// 異常時の振る舞いや特別な値の意味は、「〜を返す」の形でも型からは読めない。
	if (statesContract(t)) return "ok";
	if (restatesName(c)) return "bad";
	if (WHAT.some((re) => re.test(t))) return "bad";
	// 1 文目が what でも、後の文が理由を述べているなら残す。理由の判定を先に通す。
	if (statesWhy(t)) return "ok";
	if (WHAT.some((re) => re.test(firstSentence(t)))) return "bad";
	return "suspect";
}

/** 空行を除いた行数に対するコメント行の割合。 */
function density(file) {
	let comment = 0, effective = 0, inBlock = false;
	for (const line of readFileSync(file, "utf8").split("\n")) {
		const t = line.trim();
		if (!t) continue;
		effective++;
		if (inBlock) {
			comment++;
			if (t.includes("*/")) inBlock = false;
			continue;
		}
		if (t.startsWith("//")) comment++;
		else if (t.startsWith("/*")) {
			comment++;
			if (!t.includes("*/")) inBlock = true;
		}
	}
	return { comment, effective, ratio: effective ? comment / effective : 0 };
}

const files = all ? sourceFiles() : [];
const comments = all ? allComments(files) : addedComments(diff());
const where = (c) => (c.line ? `${c.file}:${c.line}` : c.file);
const head = (s) => (s.length > 90 ? s.slice(0, 88) + "…" : s);

if (all) {
	let comment = 0, effective = 0;
	for (const f of files) {
		const d = density(f);
		comment += d.comment;
		effective += d.effective;
	}
	console.log(
		`コメント ${comment} 行 / 実効 ${effective} 行 = ${((comment / effective) * 100).toFixed(1)}%（${files.length} ファイル）\n`,
	);
}

if (comments.length === 0) {
	console.log(all ? "コメントはありません。" : "追加されたコメントはありません。");
	process.exit(0);
}

const bad = [];
const suspect = [];
for (const c of comments) {
	const verdict = classify(c);
	if (verdict === "bad") bad.push(c);
	else if (verdict === "suspect") suspect.push(c);
}

if (useLlm && suspect.length > 0) {
	const list = suspect.map((c, i) => `${i + 1}. ${c.content}`).join("\n");
	const prompt = `次のコード内コメントを 1 件ずつ判定してください。
コードを読めば分かること（何をしているか、識別子の言い換え）を述べているだけなら WHAT、
なぜそうしたのか・何を避けるためか・外から呼ぶ側が知らないと間違える契約を述べていれば WHY です。
章立ての見出しや区切り線は WHAT にしてください。
出力は「番号:WHAT」か「番号:WHY」だけを 1 行ずつ。説明は書かないでください。

${list}`;
	try {
		const out = execFileSync(
			"pi",
			["--provider", "ollama-cloud", "--model", "deepseek-v4-flash:cloud", "-p", "--no-session", prompt],
			{ encoding: "utf8", timeout: 120000 },
		);
		for (const line of out.split("\n")) {
			const m = /^\s*(\d+)\s*[:：]\s*WHAT/i.exec(line);
			if (m) {
				const c = suspect[Number(m[1]) - 1];
				if (c) bad.push(c);
			}
		}
	} catch {
		console.log("（モデルに判定させられなかったので、規則の判定だけを使います）");
	}
}

const dense = all
	? files
			.map((f) => ({ file: f, ...density(f) }))
			// 短いファイルは、契約の JSDoc が数行あるだけで比率が跳ねる。母数で足切りする。
			.filter((d) => d.ratio > MAX_DENSITY && d.effective >= 40)
			.sort((a, b) => b.ratio - a.ratio)
	: [];

// 規則で白黒つかなかったもの。黙って通すと、複数行に散らした what が見えないまま残る。
if (!useLlm && suspect.length > 0) {
	console.log(
		`規則では判定できなかったコメントが ${suspect.length} 件あります` +
			`（--llm で判定できます）。これは止めません。\n`,
	);
}

if (bad.length === 0 && dense.length === 0) {
	console.log(`コメント ${comments.length} 件。what と判定されたものはありません。`);
	process.exit(0);
}

if (bad.length > 0) {
	console.log(`コードを読めば分かることを書いているコメントが ${bad.length} 件あります:\n`);
	for (const c of bad) console.log(`  ${where(c)}\n    ${head(c.content)}\n`);
	console.log(`なぜそうしたのかを書くか、消してください（.agents/skills/comments/SKILL.md）。
どうしても必要なら行頭に "why:" を付けて理由を書いてください。\n`);
}

if (dense.length > 0) {
	console.log(`コメントが多すぎるファイルが ${dense.length} 件あります（上限 ${MAX_DENSITY * 100}%）:\n`);
	for (const d of dense)
		console.log(`  ${d.file}  ${(d.ratio * 100).toFixed(0)}%（${d.comment} / ${d.effective}）`);
	console.log("");
}

process.exit(1);
