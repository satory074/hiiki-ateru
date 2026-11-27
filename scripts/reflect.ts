// 答え合わせの集計を読み、確率表の直し案を出す（オーナーだけが手元で実行する）。
// 実行: npm run reflect [-- --version=xxxxxxxx[,yyyyyyyy]] [-- --write]
//   .env の PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY を使い、public.hiiki_export_counts（service_role だけが呼べる）で読む。
//
//   1) 実際の的中率（計算式と比較対象つき）。見始めた年代の当たりと、区分ごとの取り違えも
//   2) 日ごとの答え合わせの数と、急増の警告（荒らしの疑い。中央値の 5 倍を超えて 50 件以上の日）
//   3) 回答が 50 件以上ある質問について、関係ごとの実際の答え方と、今のモデルの見込みの差（0.15 以上を表示）
//   4) --write のときだけ data/likelihood.json の itemOverrides を書き換える（今の見込みを 20 件分として混ぜてならす）
//      活躍が 2020年代より前に終わった選手は、「見ていた時期の人」（見始めた年代を答え、その年代がおわりの区分以下）の答えだけで直す。
//      見る前の選手の扱い（era.retain）と、年代の暮らしの質問（eralife）の数字は書かない（区分ごとの答え方を見て手で直す）
// 書き換えたら npm test と npm run simulate を流し、差分を見てからコミット・デプロイする。版が変わるので、以後の集計は新しい版に入る。
import fs from "node:fs";
import path from "node:path";
import { Model } from "../src/lib/model";
import { ERA_IDS, ERA_LABELS, type EraId } from "../src/lib/types";
import { makeReflect } from "./lib/reflect-core";
import { ROOT, compileBank, loadSource } from "./lib/source";

const MIN_N = 50;
const PSEUDO = 20;
const SHOW_DIFF = 0.15;

const args = process.argv.slice(2);
const write = args.includes("--write");
const envFile = path.join(ROOT, ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const url = process.env.PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error(".env に PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY を書いてください（service role キーはリポジトリに入れない）");
  process.exit(2);
}

const src = loadSource();
const bank = compileBank(src);
const model = new Model(bank);
const versions = (args.find((a) => a.startsWith("--version="))?.slice(10) ?? bank.version).split(",");
const teamIds = bank.teams.map((t) => t.id);

// guess_era・actual_era は 003 で足した列（'' は年代なし: 見ない人・年代を送らない古い版）。actual_era は ERA_IDS か unknown
type ResultRow = { v: string; day: string; guess: string; actual_main: string; guess_era?: string; actual_era?: string; n: number };
type AnswerRow = { v: string; day: string; item_id: string; answer: number; actual_main: string; actual_others: string; actual_era?: string; n: number };
const eraIndex = (id: string | undefined): number => ERA_IDS.indexOf((id ?? "") as EraId);
const result: ResultRow[] = [];
const answers: AnswerRow[] = [];
for (const v of versions) {
  const res = await fetch(`${url.replace(/\/$/, "")}/rest/v1/rpc/hiiki_export_counts`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_version: v }),
  });
  if (!res.ok) throw new Error(`読み出しに失敗: HTTP ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { result: ResultRow[]; answers: AnswerRow[] };
  result.push(...body.result);
  answers.push(...body.answers);
}
const sum = (rows: { n: number }[]) => rows.reduce((a, r) => a + r.n, 0);
console.log(`版 ${versions.join(",")}: 答え合わせ ${sum(result)} 件（今の質問データの版は ${bank.version}）`);

// 1) 的中率
const fanRows = result.filter((r) => teamIds.includes(r.actual_main));
const hitFan = sum(fanRows.filter((r) => r.guess === r.actual_main));
const pctOf = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%（${a}/${b}）` : "—");
console.log("\n■ 実際の的中率");
console.log(`本命の球団を当てた: ${pctOf(hitFan, sum(fanRows))} ＝ 推定が本命と一致した人数 ÷ 本命の球団を答えた人数`);
console.log(`  比較: 当てずっぽうで 12 球団から 1 つ言うと ${(100 / teamIds.length).toFixed(1)}%`);
const neutralRows = result.filter((r) => r.actual_main === "none");
console.log(`贔屓なしの人を「贔屓なし」と判定: ${pctOf(sum(neutralRows.filter((r) => r.guess === "neutral")), sum(neutralRows))}`);
const noRows = result.filter((r) => r.actual_main === "nobaseball");
console.log(`野球を見ない人を「見ない」と判定: ${pctOf(sum(noRows.filter((r) => r.guess === "none")), sum(noRows))}`);
console.log(`「複数」と言った件数: ${sum(result.filter((r) => r.guess === "multi"))}（組まで当たったかは集計に入れていない）`);
const eraRows = result.filter((r) => eraIndex(r.actual_era) >= 0 && eraIndex(r.guess_era) >= 0);
console.log(
  `見始めた年代を当てた: ${pctOf(sum(eraRows.filter((r) => r.guess_era === r.actual_era)), sum(eraRows))} ＝ 推定した年代が本当の年代と一致した人数 ÷ 年代を答えた人数（覚えていない・見ない・年代を送らない古い版は除く）`,
);
console.log(`  比較: 当てずっぽうで 4 区分から 1 つ言うと 25.0%`);
if (eraRows.length) {
  console.log("  取り違えの表（行が本当の年代・列が推定）:");
  for (const a of ERA_IDS)
    console.log(`    ${ERA_LABELS[a].padEnd(8, "　")} ${ERA_IDS.map((g) => String(sum(eraRows.filter((r) => r.actual_era === a && r.guess_era === g))).padStart(5)).join("")}`);
}
console.log("本当の答えの内訳:", Object.entries(Object.groupBy(result, (r) => (teamIds.includes(r.actual_main) ? "本命あり" : r.actual_main === "none" ? "贔屓なし" : "見ない"))).map(([k, rows]) => `${k} ${sum(rows ?? [])}`).join("・"));

// 2) 日ごとの数と急増
console.log("\n■ 日ごとの答え合わせ");
const byDay = new Map<string, number>();
for (const r of result) byDay.set(r.day, (byDay.get(r.day) ?? 0) + r.n);
const days = [...byDay].sort(([a], [b]) => a.localeCompare(b));
const sorted = days.map(([, n]) => n).sort((a, b) => a - b);
const median = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0;
for (const [d, n] of days) console.log(`  ${d}: ${n}${n > 5 * median && n >= 50 ? "  ⚠️ 急増（中央値の 5 倍超）。荒らしの疑いがあれば --version で版を分けるか、その日を除いて判断する" : ""}`);

// 3) 質問ごとの差
const { relationOf, modelDist, deOverclaim, collapse } = makeReflect(model);
type Key = ReturnType<typeof relationOf>;

// 活躍が 2020年代より前に終わった選手か（見る前の人の答えを、直す材料から外す）
const pastPlayer = (item: { span?: [number, number] }) => item.span !== undefined && item.span[1] < ERA_IDS.length - 1;
const counts = new Map<string, number[]>();
const eraLife = new Map<string, number[]>();
for (const r of answers) {
  const item = model.itemById.get(r.item_id);
  if (!item || item.kind === "foil" || item.kind === "region") continue;
  if (item.kind === "eralife") {
    // 年代の暮らしの質問は、本当の年代ごとの答え方を見せるだけ（書かない）
    const k = `${item.id}|${r.actual_main === "nobaseball" ? "none" : eraIndex(r.actual_era) >= 0 ? r.actual_era : "?"}`;
    const c = eraLife.get(k) ?? new Array(item.options.length).fill(0);
    c[r.answer] += r.n;
    eraLife.set(k, c);
    continue;
  }
  const rel = relationOf(item, r.actual_main, r.actual_others ? r.actual_others.split(",") : []);
  if (pastPlayer(item) && rel !== "none") {
    const e = eraIndex(r.actual_era);
    if (e < 0 || e > item.span![1]) continue;
  }
  const k = `${item.id}|${rel}`;
  const c = counts.get(k) ?? new Array(item.options.length).fill(0);
  c[r.answer] += r.n;
  counts.set(k, c);
}
for (const [k, c] of counts) counts.set(k, collapse(model.itemById.get(k.split("|")[0]!)!, c));
console.log(`\n■ 回答が ${MIN_N} 件以上ある質問で、見込みとの差が ${SHOW_DIFF} 以上のもの`);
const overrides: NonNullable<typeof bank.params.itemOverrides> = { ...(src.params.itemOverrides ?? {}) };
let shown = 0;
let updated = 0;
for (const [k, c] of [...counts].sort()) {
  const n = c.reduce((a, b) => a + b, 0);
  if (n < MIN_N) continue;
  const [id, rel] = k.split("|") as [string, Key];
  const item = model.itemById.get(id)!;
  const m = pastPlayer(item) && rel !== "none" ? modelDist(item, rel, Array.from({ length: item.span![1] + 1 }, (_, e) => e)) : modelDist(item, rel);
  const emp = c.map((x) => x / n);
  const diff = Math.max(...emp.map((x, a) => Math.abs(x - m[a]!)));
  const smoothed = deOverclaim(item, c.map((x, a) => (x + PSEUDO * m[a]!) / (n + PSEUDO)));
  if (diff >= SHOW_DIFF) {
    shown++;
    console.log(`  ${id}（${rel}・${n}件）: 実際 [${emp.map((x) => x.toFixed(2)).join(", ")}] / 見込み [${m.map((x) => x.toFixed(2)).join(", ")}]`);
  }
  overrides[id] = { ...(overrides[id] ?? {}), [rel]: smoothed };
  updated++;
}
if (shown === 0) console.log("  なし");

console.log("\n■ 年代の暮らしの質問: 本当の年代ごとの答え方（--write では書かない。likelihood ではなく data/items/life.yaml の probs を手で直す）");
if (eraLife.size === 0) console.log("  まだ無い");
for (const [k, c] of [...eraLife].sort()) {
  const n = c.reduce((a, b) => a + b, 0);
  const [id, era] = k.split("|") as [string, string];
  const item = model.itemById.get(id)!;
  const want = era === "?" ? null : item.eralife![era as EraId | "none"];
  console.log(`  ${id}（${era === "none" ? "見ない" : era === "?" ? "年代なし" : ERA_LABELS[era as EraId]}・${n}件）: 実際 [${c.map((x) => (x / n).toFixed(2)).join(", ")}]${want ? ` / 見込み [${want.map((x) => x.toFixed(2)).join(", ")}]` : ""}`);
}

if (write) {
  const file = path.join(ROOT, "data", "likelihood.json");
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  json.itemOverrides = overrides;
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
  console.log(`\n data/likelihood.json の itemOverrides を ${updated} 組ぶん書き換えた。npm test と npm run simulate を流して差分を確かめる`);
} else {
  console.log(`\n（--write を付けると、回答 ${MIN_N} 件以上の ${updated} 組を data/likelihood.json に書く）`);
}
