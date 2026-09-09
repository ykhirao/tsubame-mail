#!/usr/bin/env node
/**
 * docs/ の Markdown を、そのまま配れる静的サイトに変換する。
 *
 * 仕様書は外に出す前提なので、リポジトリを開かなくても読める形にしておく。
 * 各要件には**それを検証している e2e の一覧**を自動で差し込む。
 * 「書いてあるが確かめていない仕様」を、読む側からも見えるようにするため。
 *
 *   node scripts/build-docs.mjs           docs/build/ に出力
 *   node scripts/build-docs.mjs --serve   出力してから 4173 番で配る
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync } from "node:fs";
import { join, dirname, relative, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { execSync } from "node:child_process";
import { marked } from "marked";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(root, "docs");
const OUT = join(root, "docs/build");
const serve = process.argv.includes("--serve");

function walk(dir) {
	const out = [];
	for (const entry of readdirSync(dir)) {
		if (entry === "build") continue;
		const p = join(dir, entry);
		if (statSync(p).isDirectory()) out.push(...walk(p));
		else if (p.endsWith(".md")) out.push(p);
	}
	return out;
}

/** 要件 ID ごとに、それを検証している e2e シナリオ名を集める。 */
function coverage() {
	try {
		const raw = execSync("node scripts/spec-coverage.mjs --json", {
			cwd: root,
			encoding: "utf8",
		});
		const parsed = JSON.parse(raw);
		return new Map(parsed.requirements.map((r) => [r.id, r.scenarios]));
	} catch (err) {
		// 未カバーがあると exit 1 になるが、出力自体は使える。
		const text = String(err.stdout ?? "");
		try {
			const parsed = JSON.parse(text);
			return new Map(parsed.requirements.map((r) => [r.id, r.scenarios]));
		} catch {
			return new Map();
		}
	}
}

const covered = coverage();

/** 要件の見出しの直後に、検証している e2e を差し込む。 */
function injectCoverage(markdown) {
	return markdown.replace(/^###\s+(FR-\d+)\s+(.+)$/gm, (line, id) => {
		const scenarios = covered.get(id);
		if (!scenarios) return line;
		if (scenarios.length === 0) {
			return `${line}\n\n> **検証:** まだ e2e がありません。\n`;
		}
		const items = scenarios.map((s) => `> - ${s}`).join("\n");
		return `${line}\n\n> **検証済み（e2e ${scenarios.length} 件）**\n>\n${items}\n`;
	});
}

const PAGES = walk(SRC).sort();

function hrefFor(file) {
	return relative(SRC, file).replace(/\.md$/, ".html");
}

function navHtml(current) {
	const groups = new Map();
	for (const f of PAGES) {
		const rel = relative(SRC, f);
		const dir = rel.includes("/") ? rel.split("/")[0] : ".";
		if (!groups.has(dir)) groups.set(dir, []);
		groups.get(dir).push(f);
	}
	const label = { spec: "仕様", ops: "運用", ".": "その他" };
	// 仕様を先に、運用を後に出す。読む順序がそうなっているため。
	const order = ["spec", "ops", "."];
	const sorted = [...groups.entries()].sort(
		(a, b) => order.indexOf(a[0]) - order.indexOf(b[0]),
	);
	let html = "";
	for (const [dir, files] of sorted) {
		html += `<p class="nav-group">${label[dir] ?? dir}</p><ul>`;
		for (const f of files) {
			const href = hrefFor(f);
			const title = firstHeading(f) ?? basename(f, ".md");
			const active = f === current ? ' class="active"' : "";
			html += `<li><a href="/${href}"${active}>${title}</a></li>`;
		}
		html += "</ul>";
	}
	return html;
}

function firstHeading(file) {
	const m = /^#\s+(.+)$/m.exec(readFileSync(file, "utf8"));
	return m ? m[1].trim() : null;
}

const CSS = `
:root{--bg:#fff;--sunken:#f6f8fc;--text:#1f1f1f;--muted:#5f6368;--line:#e3e3e3;--accent:#0b57d0}
@media(prefers-color-scheme:dark){:root{--bg:#1e1f20;--sunken:#131314;--text:#e3e3e3;--muted:#9aa0a6;--line:#3c4043;--accent:#a8c7fa}}
*{box-sizing:border-box}
body{margin:0;display:flex;background:var(--bg);color:var(--text);
font-family:system-ui,-apple-system,"Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif;line-height:1.8}
nav{width:260px;flex:0 0 260px;padding:24px 16px;background:var(--sunken);height:100vh;position:sticky;top:0;overflow:auto}
nav .brand{font-weight:700;font-size:18px;margin:0 0 16px;display:block;color:var(--text);text-decoration:none}
nav .nav-group{margin:16px 0 4px;font-size:12px;color:var(--muted)}
nav ul{list-style:none;margin:0;padding:0}
nav li{margin:2px 0}
nav a{display:block;padding:6px 10px;border-radius:999px;color:var(--text);text-decoration:none;font-size:14px}
nav a:hover{background:var(--bg)}
nav a.active{background:#d3e3fd;color:#041e49}
@media(prefers-color-scheme:dark){nav a.active{background:#0842a0;color:#d3e3fd}}
main{flex:1;min-width:0;padding:40px 48px;max-width:900px}
h1{font-size:28px;margin:0 0 24px}
h2{font-size:20px;margin:40px 0 12px;padding-bottom:6px;border-bottom:1px solid var(--line)}
h3{font-size:16px;margin:28px 0 8px}
code{background:var(--sunken);padding:2px 5px;border-radius:4px;font-size:.9em}
pre{background:var(--sunken);padding:14px 16px;border-radius:12px;overflow:auto}
pre code{background:none;padding:0}
table{border-collapse:collapse;width:100%;margin:12px 0;font-size:14px}
th,td{border-bottom:1px solid var(--line);padding:8px 10px;text-align:left}
th{color:var(--muted);font-weight:600}
blockquote{margin:12px 0;padding:10px 16px;border-left:4px solid var(--accent);background:var(--sunken);border-radius:0 8px 8px 0}
blockquote p{margin:4px 0}
blockquote ul{margin:4px 0}
a{color:var(--accent)}
footer{margin-top:64px;padding-top:16px;border-top:1px solid var(--line);color:var(--muted);font-size:13px}
`;

function page(title, body, nav) {
	return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — Tsubame</title><style>${CSS}</style></head>
<body><nav><a class="brand" href="/spec/index.html">Tsubame 仕様書</a>${nav}</nav>
<main>${body}<footer>この文書は <code>docs/</code> の Markdown から生成しています。
要件の「検証済み」は e2e から自動で差し込んでいるので、実際に確かめていない仕様は載りません。</footer></main></body></html>`;
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

for (const file of PAGES) {
	let md = readFileSync(file, "utf8");
	if (file.endsWith("requirements.md")) md = injectCoverage(md);
	md = md.replace(/\]\(([^)]+)\.md([)#])/g, "]($1.html$2");
	const html = marked.parse(md);
	const out = join(OUT, hrefFor(file));
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, page(firstHeading(file) ?? basename(file), html, navHtml(file)));
}

writeFileSync(
	join(OUT, "index.html"),
	`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/spec/index.html">`,
);

console.log(`${PAGES.length} ページを docs/build/ に出力しました。`);

if (serve) {
	const port = 4173;
	createServer((req, res) => {
		const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
		const file = join(OUT, path === "/" ? "index.html" : path);
		try {
			const body = readFileSync(file);
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(body);
		} catch {
			res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
			res.end("見つかりません");
		}
	}).listen(port, () => console.log(`http://localhost:${port}/ で配っています。`));
}
