import { Hono } from "hono";
import { notificationSessionGuard } from "./notifications";
import type { AppEnv } from "@/api/types";

const app = new Hono<AppEnv>();
export default app;

app.use("*", notificationSessionGuard);

function b64urlToBytes(s: string): Uint8Array {
	const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
	const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
	const bin = atob(padded);
	return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

function bytesToB64url(b: Uint8Array): string {
	let bin = "";
	for (const byte of b) bin += String.fromCharCode(byte);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

app.get("/key", (c) => {
	const raw = c.env.VAPID_PRIVATE_KEY;
	if (!raw) return c.json({ key: null });
	let jwk: { x?: unknown; y?: unknown };
	try {
		jwk = JSON.parse(raw) as { x?: unknown; y?: unknown };
	} catch {
		return c.json({ key: null });
	}
	if (typeof jwk.x !== "string" || typeof jwk.y !== "string") return c.json({ key: null });

	// 非圧縮 EC 点 0x04||x||y（64 バイト + 1）。Web Push の applicationServerKey がこの形を期待する。
	const point = new Uint8Array(1 + 32 + 32);
	point.set([0x04]);
	point.set(b64urlToBytes(jwk.x), 1);
	point.set(b64urlToBytes(jwk.y), 33);
	return c.json({ key: bytesToB64url(point) });
});

export { b64urlToBytes, bytesToB64url };
