#!/usr/bin/env node
// 使い方: 別の端末で npx wrangler dev を起動してから npm run seed:local（--reset で作り直し）。
//
// メールは必ず本物の受信ハンドラ（/cdn-cgi/handler/email）を通すこと。SQL で messages に
// 直接入れるとスレッドの無い行ができ、「サイドバーの未読は 1 なのに一覧は空」になる。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const BASE = process.env.TSUBAME_BASE ?? "http://127.0.0.1:8787";

// bootstrap は配布済みの既知の合言葉を拒否する（精査 #48）ので、既定値は持たず
// wrangler dev が読む .dev.vars と同じ値を使う。
function readDevVarsSecret() {
	try {
		const m = readFileSync(".dev.vars", "utf8").match(/^INTERNAL_SECRET\s*=\s*"?([^"\n]*)"?\s*$/m);
		return m?.[1]?.trim() || undefined;
	} catch {
		return undefined;
	}
}
const secret = process.env.TSUBAME_INTERNAL_SECRET ?? readDevVarsSecret();
if (!secret) {
	console.error("INTERNAL_SECRET が見つかりません。.dev.vars に 20 文字以上の値を入れるか TSUBAME_INTERNAL_SECRET を指定してください。");
	process.exit(1);
}
const OWNER = {
	email: "owner@example.com",
	name: "オーナー",
	password: "correct-horse-battery",
	secret,
};
const reset = process.argv.includes("--reset");

function d1(sql) {
	execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "--command", sql], {
		stdio: ["ignore", "ignore", "inherit"],
	});
}

const DOMAINS = [
	{ id: "dom_example", name: "example.com", zone: "example.com", mode: "apex" },
	{ id: "dom_sample", name: "sample.test", zone: "sample.test", mode: "apex" },
	{ id: "dom_mail", name: "mail.example.com", zone: "example.com", mode: "subdomain" },
];

const COLORS = ["#1a73e8", "#d93025", "#188038", "#e8710a", "#8430ce"];

const ADDRESSES = [
	{ id: "adr_tanaka_ex", domainId: "dom_example", local: "tanaka", name: "田中 太郎" },
	{ id: "adr_info_ex", domainId: "dom_example", local: "info", name: "お問い合わせ" },
	{ id: "adr_tanaka_sm", domainId: "dom_sample", local: "tanaka", name: "田中（sample）" },
	{ id: "adr_ai", domainId: "dom_mail", local: "ai", name: "AI エージェント" },
	{ id: "adr_hito", domainId: "dom_mail", local: "hito", name: "人間用" },
];

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const addrOf = (a) => `${a.local}@${DOMAINS.find((d) => d.id === a.domainId).name}`;

let ageMinutes = 60 * 30; // 一番古いメールを 30 時間前にして、順に新しくしていく

function nextDate() {
	const d = new Date(Date.now() - ageMinutes * 60 * 1000);
	ageMinutes -= 180 + Math.floor(Math.random() * 120);
	if (ageMinutes < 5) ageMinutes = 5;
	return d.toUTCString();
}

function mime({ from, to, cc, subject, messageId, inReplyTo, body, attachment }) {
	const head = [
		`From: ${from}`,
		`To: ${to}`,
		...(cc ? [`Cc: ${cc}`] : []),
		`Subject: ${subject}`,
		`Message-ID: <${messageId}>`,
		`Date: ${nextDate()}`,
		"MIME-Version: 1.0",
	];
	if (inReplyTo) {
		head.push(`In-Reply-To: <${inReplyTo}>`, `References: <${inReplyTo}>`);
	}
	if (!attachment) {
		head.push('Content-Type: text/plain; charset="UTF-8"');
		return `${head.join("\r\n")}\r\n\r\n${body}\r\n`;
	}
	const b = "b0undary-tsubame-seed";
	head.push(`Content-Type: multipart/mixed; boundary="${b}"`);
	const payload = Buffer.from(attachment.content, "utf8").toString("base64");
	return [
		head.join("\r\n"),
		"",
		`--${b}`,
		'Content-Type: text/plain; charset="UTF-8"',
		"",
		body,
		`--${b}`,
		`Content-Type: ${attachment.type}; name="${attachment.filename}"`,
		"Content-Transfer-Encoding: base64",
		`Content-Disposition: attachment; filename="${attachment.filename}"`,
		"",
		payload,
		`--${b}--`,
		"",
	].join("\r\n");
}

async function deliver(mail) {
	const url = `${BASE}/cdn-cgi/handler/email?from=${encodeURIComponent(mail.envelopeFrom)}&to=${encodeURIComponent(mail.envelopeTo)}`;
	const res = await fetch(url, {
		method: "POST",
		headers: { "content-type": "message/rfc822" },
		body: mime(mail),
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`配送に失敗: ${res.status} ${text}`);
	return text;
}

const health = await fetch(`${BASE}/api/health`).catch(() => null);
if (!health?.ok) {
	console.error(`${BASE} に繋がりません。別の端末で npx wrangler dev を起動してください。`);
	process.exit(1);
}

if (reset) {
	console.log("既存のメール・アドレス・ドメインを消しています…");
	d1(
		"delete from attachments; delete from messages; delete from threads; delete from address_grants; delete from addresses; delete from domains;",
	);
}

console.log("ドメインとアドレスを作成…");
const domainSql = DOMAINS.map(
	(d) =>
		`insert or ignore into domains (id,name,zone_id,zone_name,mode,routing_status,sending_status,catch_all_enabled,created_at) values (${q(d.id)},${q(d.name)},${q("zone_" + d.zone)},${q(d.zone)},${q(d.mode)},'active','active',0,unixepoch());`,
).join(" ");
const addressSql = ADDRESSES.map(
	(a, i) =>
		`insert or ignore into addresses (id,domain_id,local_part,address,display_name,kind,is_catch_all,color,created_at) values (${q(a.id)},${q(a.domainId)},${q(a.local)},${q(addrOf(a))},${q(a.name)},'mailbox',0,${q(COLORS[i % COLORS.length])},unixepoch());`,
).join(" ");
d1(domainSql + " " + addressSql);

const AI = addrOf(ADDRESSES.find((a) => a.id === "adr_ai"));
const HITO = addrOf(ADDRESSES.find((a) => a.id === "adr_hito"));
const TANAKA_EX = addrOf(ADDRESSES.find((a) => a.id === "adr_tanaka_ex"));
const TANAKA_SM = addrOf(ADDRESSES.find((a) => a.id === "adr_tanaka_sm"));
const INFO = addrOf(ADDRESSES.find((a) => a.id === "adr_info_ex"));

const mails = [
	{
		envelopeFrom: "sales@torihikisaki.co.jp",
		envelopeTo: TANAKA_EX,
		from: "取引先 営業部 <sales@torihikisaki.co.jp>",
		to: `${TANAKA_EX}, ${INFO}`,
		subject: "10月分のお見積書をお送りします",
		messageId: "seed-quote-001@torihikisaki.co.jp",
		body: "田中さま\n\nお世話になっております。\n10月分のお見積書を添付にてお送りいたします。\nご確認のほどよろしくお願いいたします。",
		attachment: { filename: "mitsumori-10.csv", type: "text/csv", content: "品目,数量,金額\n保守,1,120000\n" },
	},
	{
		envelopeFrom: "sales@torihikisaki.co.jp",
		envelopeTo: TANAKA_EX,
		from: "取引先 営業部 <sales@torihikisaki.co.jp>",
		to: TANAKA_EX,
		subject: "Re: 10月分のお見積書をお送りします",
		messageId: "seed-quote-002@torihikisaki.co.jp",
		inReplyTo: "seed-quote-001@torihikisaki.co.jp",
		body: "先ほどの見積書に誤りがありました。金額を修正した版を改めてお送りします。",
	},
	{
		envelopeFrom: "no-reply@shiharai.example.net",
		envelopeTo: TANAKA_EX,
		from: "支払通知 <no-reply@shiharai.example.net>",
		to: TANAKA_EX,
		subject: "【重要】口座振替のお知らせ",
		messageId: "seed-bank-001@shiharai.example.net",
		body: "口座振替を実施しました。明細は管理画面をご確認ください。",
	},
	{
		envelopeFrom: "user@example.jp",
		envelopeTo: INFO,
		from: "問い合わせ 花子 <user@example.jp>",
		to: INFO,
		subject: "資料請求について",
		messageId: "seed-info-001@example.jp",
		body: "はじめまして。御社のサービス資料を拝見したく、ご連絡いたしました。",
	},
	{
		envelopeFrom: "team@sample-partner.test",
		envelopeTo: TANAKA_SM,
		from: "サンプル提携先 <team@sample-partner.test>",
		to: TANAKA_SM,
		cc: TANAKA_EX,
		subject: "定例ミーティングの日程調整",
		messageId: "seed-sample-001@sample-partner.test",
		body: "来週の定例について、火曜 15 時か水曜 10 時でいかがでしょうか。",
	},
	{
		envelopeFrom: "team@sample-partner.test",
		envelopeTo: TANAKA_SM,
		from: "サンプル提携先 <team@sample-partner.test>",
		to: TANAKA_SM,
		subject: "Re: 定例ミーティングの日程調整",
		messageId: "seed-sample-002@sample-partner.test",
		inReplyTo: "seed-sample-001@sample-partner.test",
		body: "火曜 15 時で確定しました。会議リンクは前回と同じです。",
	},
	{
		envelopeFrom: "bot@monitoring.example.org",
		envelopeTo: AI,
		from: "監視 <bot@monitoring.example.org>",
		to: AI,
		subject: "日次レポート 2026-09-10",
		messageId: "seed-ai-001@monitoring.example.org",
		body: "エラー率 0.2%、平均応答 128ms。異常はありません。",
	},
	{
		envelopeFrom: "sales@torihikisaki.co.jp",
		envelopeTo: AI,
		from: "取引先 営業部 <sales@torihikisaki.co.jp>",
		to: AI,
		subject: "請求書の送付先を確認させてください",
		messageId: "seed-ai-002@torihikisaki.co.jp",
		body: "請求書の送付先は経理部宛でよろしいでしょうか。",
	},
	{
		envelopeFrom: "shanai@example.com",
		envelopeTo: HITO,
		from: "社内連絡 <shanai@example.com>",
		to: HITO,
		subject: "勤怠の締め切りについて",
		messageId: "seed-hito-001@example.com",
		body: "今月の勤怠入力は 25 日までにお願いします。",
	},
];

console.log(`メールを ${mails.length} 通、受信ハンドラ経由で配送…`);
for (const m of mails) {
	await deliver(m);
	process.stdout.write(".");
}
console.log("");

await new Promise((r) => setTimeout(r, 2000));

console.log("オーナーを用意…");
const boot = await fetch(`${BASE}/api/v1/auth/bootstrap`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify(OWNER),
});
if (boot.status === 409) console.log("  既にオーナーがいます");
else if (!boot.ok) console.log("  作成できませんでした:", await boot.text());

// owner も割り当てたアドレスしか見ない（FR-11 / FR-19）。seed のアドレスは全部オーナーに割り当て、最初をプライマリにする。
const ownerSelect = `(select id from users where external_email = ${q(OWNER.email)})`;
d1(
	ADDRESSES.map(
		(a) => `insert or ignore into address_grants (user_id,address_id,level) select id, ${q(a.id)}, 'write' from users where external_email = ${q(OWNER.email)};`,
	).join(" ") +
		` update users set primary_address_id = ${q(ADDRESSES[0].id)} where id = ${ownerSelect} and primary_address_id is null;`,
);

console.log(`
できました。

  ${BASE}/login
  ${addrOf(ADDRESSES[0])} / ${OWNER.password}
  （プライマリでログインする。${OWNER.email} は外部アドレスで、設定から確認するまではログインに使えない）

アドレス:
${ADDRESSES.map((a) => `  ${addrOf(a)}`).join("\n")}
`);
