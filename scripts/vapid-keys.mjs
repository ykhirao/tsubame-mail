#!/usr/bin/env node
// Web Push 用の VAPID 鍵ペアを作る。秘密鍵は JWK（d/x/y）の JSON、公開鍵は
// base64url の非圧縮点を出力する。鍵を変えると全購読が無効になるので、新規に
// 一度だけ作って VAPID_PRIVATE_KEY（Secret）と公開鍵（クライアントの照合）に使う。

const encoder = new TextEncoder();

function toBase64Url(bytes) {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const { publicKey, privateKey } = await crypto.subtle.generateKey(
	{ name: "ECDSA", namedCurve: "P-256" },
	true,
	["sign"],
);
const jwk = await crypto.subtle.exportKey("jwk", privateKey);
const point = new Uint8Array(await crypto.subtle.exportKey("raw", publicKey));

console.log("VAPID_PRIVATE_KEY  (Worker Secret に入れる JSON):");
console.log(JSON.stringify(jwk));
console.log();
console.log("公開鍵（クライアント起動時の照合 / /v1/push/key で配る base64url）:");
console.log(toBase64Url(point));
