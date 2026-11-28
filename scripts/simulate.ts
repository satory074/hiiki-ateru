// 仮想の回答者で何回も遊ばせ、当たり方を数える。実行: npm run simulate [-- --synthetic] [-- --runs=2000] [-- --hard-core]
//   --hard-core: 回答者を全員「詳しさ＝コア」にし、「詳しい人は他球団もかなり知っている」表（hardCoreBank）で答えさせる。
//                当てるモデルはそのまま。モデルの前提が外れたときに、詳しい人の贔屓がどれだけ外れるかを見る（2026-11-28）
//
// ⚠️ 回答者は「モデル自身の確率表どおりに答える」。だからこれは、モデルが自分の前提どおりに動いているか
// （質問の選び方・終わり方・確信度の付け方が壊れていないか）の確認であって、実際の人の的中率ではない。
// 実際の的中率は、公開後の答え合わせ（scripts/reflect.ts）で「本命が一致した数 ÷ 答え合わせした数」として出す。
import fs from "node:fs";
import path from "node:path";
import { Model, N_E, eraVerdict } from "../src/lib/model";
import { eraLabel } from "../src/lib/explain";
import { createRng } from "../src/lib/rng";
import { OUTCOME_MULTI, OUTCOME_NEUTRAL, OUTCOME_NONE, type Bank } from "../src/lib/types";
import { ROOT } from "./lib/source";
import { syntheticBank } from "./lib/synthetic";
import { hardCoreBank, playOnce, sampleTruth } from "./lib/play";

const args = process.argv.slice(2);
const runs = Number(args.find((a) => a.startsWith("--runs="))?.slice(7) ?? 2000);
const bank: Bank = args.includes("--synthetic")
  ? syntheticBank()
  : (JSON.parse(fs.readFileSync(path.join(ROOT, "src", "generated", "bank.json"), "utf8")) as Bank);
const model = new Model(bank);
const hardCore = args.includes("--hard-core");
const responder = hardCore ? new Model(hardCoreBank(bank)) : model;
const rng = createRng(1);
const G_LABELS = ["ライト", "ふつう", "コア"];
const nTeams = bank.teams.length;

type Tally = { n: number; ok: number };
const tally = (): Tally => ({ n: 0, ok: 0 });
const byKind = { fan1: tally(), fan2: tally(), fan2pair: tally(), neutral: tally(), none: tally() };
const buckets = Array.from({ length: 10 }, tally); // 確信度 0-10%, …, 90-100%
const perTeam = bank.teams.map(tally); // 本命1球団の人を、球団ごとに
let questions = 0;
let exact = 0;
let hitMax = 0;
// 見始めた年代（見る人だけ。見ない人には年代を出さない）
const eraAll = tally();
const eraByTrue = Array.from({ length: N_E }, tally);
const eraBuckets = Array.from({ length: 10 }, tally);
// 詳しさ別（本命1球団の人の当たり・年代の当たり）
const fan1ByG = G_LABELS.map(tally);
const eraByG = G_LABELS.map(tally);
let feelAsked = 0;

for (let r = 0; r < runs; r++) {
  const truth = sampleTruth(model, rng);
  if (hardCore) truth.g = 2;
  const h = model.hyps[truth.h]!;
  const { session, verdict: v } = playOnce(model, truth, rng, undefined, responder);
  feelAsked += session.answers.filter((a) => model.itemById.get(a.itemId)?.kind === "feel").length;
  questions += session.answers.length;
  if (session.answers.length >= bank.params.stop.max) hitMax++;
  if (h.kind !== "none") {
    const ev = eraVerdict(model, session.post);
    const ok = ev.era === truth.e ? 1 : 0;
    eraAll.n++;
    eraAll.ok += ok;
    eraByTrue[truth.e]!.n++;
    eraByTrue[truth.e]!.ok += ok;
    const eb = eraBuckets[Math.min(9, Math.floor(ev.confidence * 10))]!;
    eb.n++;
    eb.ok += ok;
    eraByG[truth.g]!.n++;
    eraByG[truth.g]!.ok += ok;
  }
  const trueOutcome =
    h.kind === "fan1" ? h.teams[0]! : h.kind === "fan2" ? OUTCOME_MULTI : h.kind === "neutral" ? OUTCOME_NEUTRAL : OUTCOME_NONE;
  const hit = v.outcome === trueOutcome;
  if (hit) exact++;
  // 確信度は「言い切った仮説そのもの」の確率なので、帯の当たりも仮説（2球団なら組まで）が一致したかで数える
  const b = buckets[Math.min(9, Math.floor(v.confidence * 10))]!;
  b.n++;
  if (v.hyp === truth.h) b.ok++;
  const t = byKind[h.kind];
  t.n++;
  if (hit) t.ok++;
  if (h.kind === "fan1") {
    fan1ByG[truth.g]!.n++;
    if (hit) fan1ByG[truth.g]!.ok++;
    perTeam[h.teams[0]!]!.n++;
    if (hit) perTeam[h.teams[0]!]!.ok++;
  }
  if (h.kind === "fan2") {
    byKind.fan2pair.n++;
    if (hit && [...v.teams].sort().join() === [...h.teams].sort().join()) byKind.fan2pair.ok++;
  }
}

const pct = (t: Tally) => (t.n ? `${((100 * t.ok) / t.n).toFixed(1)}%（${t.ok}/${t.n}）` : "—");
const priorBest = Math.max(bank.params.prior.neutral, bank.params.prior.none, bank.params.prior.fan2, bank.params.prior.fan1 / nTeams);
console.log(`仮想の回答者 ${runs} 人（${args.includes("--synthetic") ? "仮の質問" : "本物の質問"} ${bank.items.length} 問・版 ${bank.version}）`);
if (hardCore) console.log("⚠️ --hard-core: 回答者は全員コアで、「他球団もかなり知っている」表で答える（当てるモデルはそのまま）");
console.log(`平均の質問数: ${(questions / runs).toFixed(1)} 問（上限 ${bank.params.stop.max} 問まで行った人 ${((100 * hitMax) / runs).toFixed(1)}%）`);
console.log(`結果 15 種類の完全一致: ${((100 * exact) / runs).toFixed(1)}%  ＝ 一致した人数 ÷ ${runs}`);
console.log(`  比較: いつも事前確率の一番大きい結果を言う場合 ${(100 * priorBest).toFixed(1)}%、本命を当てずっぽうで言う場合 ${(100 / nTeams).toFixed(1)}%`);
console.log(`本命1球団の人を、その球団と当てた:   ${pct(byKind.fan1)}`);
console.log(`  詳しさ別: ${G_LABELS.map((g, i) => `${g} ${pct(fan1ByG[i]!)}`).join("・")}`);
console.log(`  気持ちの質問: 1 回あたり平均 ${(feelAsked / runs).toFixed(1)} 問（上限 ${bank.params.feel.maxPerGame}）`);
console.log(`  球団ごと: ${bank.teams.map((t, i) => `${t.name} ${pct(perTeam[i]!).replace(/（.*）/, "")}`).join("・")}`);
console.log(`2球団の人を「複数」と判定:           ${pct(byKind.fan2)}（組まで一致 ${pct(byKind.fan2pair)}）`);
console.log(`贔屓なしの人を「贔屓なし」と判定:     ${pct(byKind.neutral)}`);
console.log(`野球を見ない人を「見ない」と判定:     ${pct(byKind.none)}`);
console.log(`見始めた年代を当てた（見る人のうち）: ${pct(eraAll)} ＝ 推定した年代が本当の年代と一致した人数 ÷ 見る人の数`);
console.log(`  比較: 当てずっぽうで 4 区分から 1 つ言うと ${(100 / N_E).toFixed(1)}%`);
console.log(`  詳しさ別: ${G_LABELS.map((g, i) => `${g} ${pct(eraByG[i]!)}`).join("・")}`);
console.log(`  本当の年代ごと: ${eraByTrue.map((t, e) => `${eraLabel(e)} ${pct(t).replace(/（.*）/, "")}`).join("・")}`);
console.log("年代の確信度ごとの実際の当たり:");
eraBuckets.forEach((b, i) => {
  if (b.n) console.log(`  確信度 ${i * 10}〜${i * 10 + 10}%: 当たり ${pct(b)}`);
});
console.log("確信度ごとの実際の当たり（言い切った仮説が一致した割合。確信度どおりなら各帯の値に近いはず）:");
buckets.forEach((b, i) => {
  if (b.n) console.log(`  確信度 ${i * 10}〜${i * 10 + 10}%: 当たり ${pct(b)}`);
});
