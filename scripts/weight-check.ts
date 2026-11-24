// ゲーム画面の 1 回の読み込みの重さ（gzip 後）を測る。実行: npm run build && npm run weight
// 目標 150KB 以下（GitHub Pages の通信量の目安は月 100GB。1 日 30 万人 × 150KB ≒ 45GB/日 なので、軽く保つ）。
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { ROOT } from "./lib/source";

const LIMIT_KB = 150;
const dist = path.join(ROOT, "dist");
const html = fs.readFileSync(path.join(dist, "index.html"), "utf8");
const refs = [...html.matchAll(/(?:src|href)="\/hiiki-ateru\/([^"]+\.(?:js|css|svg))"/g)].map((m) => m[1]!);
const files = ["index.html", ...new Set(refs)];
let total = 0;
for (const f of files) {
  const buf = fs.readFileSync(path.join(dist, f));
  const gz = zlib.gzipSync(buf).length;
  total += gz;
  console.log(`  ${f}: ${(buf.length / 1024).toFixed(1)}KB → gzip ${(gz / 1024).toFixed(1)}KB`);
}
console.log(`ゲーム画面の合計（gzip 後）: ${(total / 1024).toFixed(1)}KB（目標 ${LIMIT_KB}KB 以下。Cloudflare のビーコンは別）`);
if (total / 1024 > LIMIT_KB) process.exit(1);
