// 本番の Supabase（xword のプロジェクト）に SQL を適用したあと、権限が決めたとおりかを外から叩いて確かめる。
// 実行: npm run live-check（.env の PUBLIC_SUPABASE_URL と PUBLIC_SUPABASE_ANON_KEY を使う。service role キーは使わない）
//
//   ① キーなしで関数を呼ぶ → 401
//   ② 匿名で hiiki の表を読む → 見えない（hiiki スキーマは API に出していない）
//   ③ 匿名で読み出し関数 hiiki_export_counts を呼ぶ → 拒否（401 / 403）
//   ④ 匿名で不正な答え合わせ（実在しない球団 id）→ 400
//   ⑤ 匿名で正しい答え合わせ → 成功（版は 00000000 にして本物の集計に混ぜない）
//   ⑥ 匿名で登録の無い版の答え合わせ → 400（002 の hiiki.versions）
//   ⑦ 今の版（bank.version）が登録済み＝空の答えで送ると版ではなく答えの検査で 400 になる（items.sql の流し忘れを見つける）
//   ⑧ 匿名で不正な年代（決めた値以外・見ないと答えたのに年代）→ 400（003）
//   ⑨ 匿名で年代つきの正しい答え合わせ → 成功（版 00000000）
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

for (const table of ["result_counts", "answer_counts", "items", "versions", "limits"]) {
  const r = await fetch(`${url}/rest/v1/${table}?select=*&limit=1`, { headers: auth });
  check(r.status >= 400, `② 匿名で ${table} を読めない`, `HTTP ${r.status}`);
}

const r3 = await post("hiiki_export_counts", { p_version: bank.version });
check(r3.status === 401 || r3.status === 403, "③ 匿名で読み出し関数を呼ぶと拒否", `HTTP ${r3.status}`);

const r4 = await post("hiiki_record_result", { p: { ...good, actual: { main: "tokyo", others: [] } } });
check(r4.status === 400, "④ 実在しない球団 id は 400", `HTTP ${r4.status} ${(await r4.text()).slice(0, 80)}`);

const r5 = await post("hiiki_record_result", { p: good });
check(r5.ok, "⑤ 正しい答え合わせは通る（版 00000000）", `HTTP ${r5.status}`);

const r6 = await post("hiiki_record_result", { p: { ...good, v: "abcdef01" } });
const t6 = await r6.text();
check(r6.status === 400 && t6.includes("version"), "⑥ 登録の無い版は 400", `HTTP ${r6.status} ${t6.slice(0, 80)}`);

// 答えを 0 個にして送ると、版の検査を通ったあと答えの検査で落ちる（何も足さない）。版で落ちたら items.sql の流し忘れ
const r7 = await post("hiiki_record_result", { p: { ...good, v: bank.version, answers: [] } });
const t7 = await r7.text();
check(r7.status === 400 && t7.includes("answers"), `⑦ 今の版 ${bank.version} が登録済み（答えの検査まで進む）`, `HTTP ${r7.status} ${t7.slice(0, 80)}`);

const r8a = await post("hiiki_record_result", { p: { ...good, guess_era: "1980" } });
const t8a = await r8a.text();
check(r8a.status === 400 && t8a.includes("guess_era"), "⑧ 決めた値以外の当てた年代は 400", `HTTP ${r8a.status} ${t8a.slice(0, 80)}`);
const r8b = await post("hiiki_record_result", { p: { ...good, actual: { main: "nobaseball", others: [], era: "2000" } } });
const t8b = await r8b.text();
check(r8b.status === 400 && t8b.includes("era"), "⑧ 見ないと答えたのに年代があると 400", `HTTP ${r8b.status} ${t8b.slice(0, 80)}`);

const r9 = await post("hiiki_record_result", { p: { ...good, guess_era: "2000", actual: { ...good.actual, era: "unknown" } } });
check(r9.ok, "⑨ 年代つきの正しい答え合わせは通る（版 00000000）", `HTTP ${r9.status}`);

if (failed) {
  console.error(`${failed} 件が決めたとおりではない。公開を止めて SQL を見直す`);
  process.exit(1);
}
console.log("権限は決めたとおり。");
