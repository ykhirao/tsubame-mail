import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 元絵は public/icons/icon.svg。PNG はコミットしてあるので、絵を変えたときだけ流す。
// 依存を足せないので、ラスタライズは手元の rsvg-convert（brew install librsvg）に任せる。
const dir = resolve(dirname(fileURLToPath(import.meta.url)), "../public/icons");
const src = resolve(dir, "icon.svg");

// 背景を全面に塗った絵なので、maskable も同じ絵で安全領域（中央 80%）に収まる。
const outputs = [
	["icon-192.png", 192],
	["icon-512.png", 512],
	["maskable-512.png", 512],
	["apple-touch-icon.png", 180],
];

for (const [name, size] of outputs) {
	execFileSync("rsvg-convert", ["-w", String(size), "-h", String(size), src, "-o", resolve(dir, name)]);
	console.log(`${name} ${size}px`);
}
