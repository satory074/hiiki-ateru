// 本番の Supabase（xword のプロジェクト）に SQL を適用したあと、権限が決めたとおりかを外から叩いて確かめる。
// 実行: npm run live-check（.env の PUBLIC_SUPABASE_URL と PUBLIC_SUPABASE_ANON_KEY を使う。service role キーは使わない）
//
//   ① キーなしで関数を呼ぶ → 401
//   ② 匿名で hiiki の表を読む → 見えない（hiiki スキーマは API に出していない）
//   ③ 匿名で読み出し関数 hiiki_export_counts を呼ぶ → 拒否（401 / 403）
//   ④ 匿名で不正な答え合わせ（実在しない球団 id）→ 400
//   ⑤ 匿名で正しい答え合わせ → 成功（版は 00000000 にして本物の集計に混ぜない）
import fs from "node:fs";
import path from "node:path";
import { ROOT, compileBank, loadSource } from "./lib/source";

const envFile = path.join(ROOT, ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const url = process.env.PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
const anon = process.env.PUBLIC_SUPABASE_ANON_KEY;
if (!url || !anon) {
  console.error(".env に PUBLIC_SUPABASE_URL と PUBLIC_SUPABASE_ANON_KEY を書いてください");
  process.exit(2);
}
const bank = compileBank(loadSource());
const auth = { apikey: anon, Authorization: `Bearer ${anon}`, "Content-Type": "application/json" };
const post = (fn: string, body: unknown, headers: Record<string, string> = auth) =>
  fetch(`${url}/rest/v1/rpc/${fn}`, { method: "POST", headers, body: JSON.stringify(body) });

const good = {
  v: "00000000",
  guess: "carp",
  actual: { main: "carp", others: [] },
  answers: [{ q: bank.items[0]!.id, a: 0 }],
};
let failed = 0;
const check = (ok: boolean, msg: string, got: string) => {
  console.log(`${ok ? "✅" : "❌"} ${msg}（${got}）`);
  if (!ok) failed++;
};

const r1 = await post("hiiki_record_result", { p: good }, { "Content-Type": "application/json" });
check(r1.status === 401, "① キーなしで関数を呼ぶと 401", `HTTP ${r1.status}`);

for (const table of ["result_counts", "answer_counts", "items"]) {
  const r = await fetch(`${url}/rest/v1/${table}?select=*&limit=1`, { headers: auth });
  check(r.status >= 400, `② 匿名で ${table} を読めない`, `HTTP ${r.status}`);
}

const r3 = await post("hiiki_export_counts", { p_version: bank.version });
check(r3.status === 401 || r3.status === 403, "③ 匿名で読み出し関数を呼ぶと拒否", `HTTP ${r3.status}`);

const r4 = await post("hiiki_record_result", { p: { ...good, actual: { main: "tokyo", others: [] } } });
check(r4.status === 400, "④ 実在しない球団 id は 400", `HTTP ${r4.status} ${(await r4.text()).slice(0, 80)}`);

const r5 = await post("hiiki_record_result", { p: good });
check(r5.ok, "⑤ 正しい答え合わせは通る（版 00000000）", `HTTP ${r5.status}`);

if (failed) {
  console.error(`${failed} 件が決めたとおりではない。公開を止めて SQL を見直す`);
  process.exit(1);
}
console.log("権限は決めたとおり。");
