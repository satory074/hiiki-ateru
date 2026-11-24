// data/ から配信用の src/generated/bank.json を作る（dev / build / test の前に毎回走る）。
// 出典 URL や確認状態は配信しない（質問と数字だけ）。
import fs from "node:fs";
import path from "node:path";
import { ROOT, compileBank, loadSource } from "./lib/source";

const bank = compileBank(loadSource());
const out = path.join(ROOT, "src", "generated", "bank.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(bank));
console.log(`[bank] ${bank.items.length} 問・版 ${bank.version} → src/generated/bank.json (${(fs.statSync(out).size / 1024).toFixed(1)}KB)`);
