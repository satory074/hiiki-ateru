// 当てる仕組みの不変条件。実行: npx tsx scripts/smoketest.ts（npm test にも入っている）
//   Ⓐ 事前確率と、どの質問・どの状態の答えの確率も合計 1・0 以上
//   Ⓑ どんな答え方をしても、毎問のあとで 480 状態と結果 15 種類の確率が合計 1・0 以上・有限
//   Ⓒ 質問は 10〜30 問で終わり、同じ質問は 2 度出ない。架空は決めた番手だけ、地方は 1 回まで
//   Ⓓ 結果の球団の数が形と合う（本命 1・複数 2・それ以外 0）。決め手は答えた質問から選ばれる
//   Ⓔ reflect の逆算: モデル自身の答え方（知ったかぶりの人も混ざった形）を読ませると、モデルの元の数字（知ったかぶりでない人の形）に戻る
// 本物の質問（src/generated/bank.json）と、仮の質問（scripts/lib/synthetic.ts）の両方で確かめる。
import fs from "node:fs";
import path from "node:path";
import { Model, outcomeProbs, verdict } from "../src/lib/model";
import { answer, expectedGain, newSession, nextItem } from "../src/lib/select";
import { decisive, headline, outcomeKey, overclaim, shareText } from "../src/lib/explain";
import { createRng } from "../src/lib/rng";
import { OUTCOME_MULTI, type Bank } from "../src/lib/types";
import { ROOT } from "./lib/source";
import { syntheticBank } from "./lib/synthetic";
import { playOnce, sampleTruth } from "./lib/play";
import { makeReflect, type Key } from "./lib/reflect-core";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`❌ FAILED: ${msg}`);
    process.exit(1);
  }
}
const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

function checkBank(name: string, bank: Bank, runs: number): void {
  const model = new Model(bank);
  const p = bank.params;

  // Ⓐ
  assert(close(model.prior.reduce((a, b) => a + b, 0), 1), `${name}: 事前確率の合計が 1`);
  for (const item of bank.items)
    model.hyps.forEach((h) => {
      for (let g = 0; g < 3; g++)
        for (let o = 0; o < 2; o++) {
          const probs = model.answerProbs(item, h, g, o);
          assert(probs.length === item.options.length, `${name}: ${item.id} の確率の数 = 選択肢の数`);
          assert(probs.every((x) => x >= 0 && Number.isFinite(x)), `${name}: ${item.id} の確率が 0 以上`);
          assert(close(probs.reduce((a, b) => a + b, 0), 1), `${name}: ${item.id} の確率の合計が 1`);
        }
    });
  const s0 = newSession(model);
  for (const item of bank.items) assert(expectedGain(model, s0.post, item) > -1e-9, `${name}: ${item.id} の利得が負でない`);

  // Ⓑ Ⓒ Ⓓ: 事前確率どおりの回答者と、でたらめに押す回答者
  const rng = createRng(20261125);
  const t0 = performance.now();
  for (let r = 0; r < runs; r++) {
    const random = r % 4 === 3;
    let session;
    if (random) {
      session = newSession(model);
      for (;;) {
        const next = nextItem(model, session, rng);
        if (!next) break;
        answer(model, session, next.item, Math.floor(rng() * next.item.options.length));
        checkStep(name, model, session.post);
      }
    } else {
      session = playOnce(model, sampleTruth(model, rng), rng, (s) => checkStep(name, model, s.post)).session;
    }
    const n = session.answers.length;
    assert(n >= p.stop.min && n <= p.stop.max, `${name}: 質問数が ${p.stop.min}〜${p.stop.max}（${n}）`);
    assert(new Set(session.answers.map((a) => a.itemId)).size === n, `${name}: 同じ質問が 2 度出ない`);
    session.answers.forEach((a, i) => {
      const item = model.itemById.get(a.itemId)!;
      if (item.kind === "foil") assert(p.foilAt.includes(i + 1), `${name}: 架空は決めた番手だけ（${i + 1} 問目）`);
    });
    assert(session.answers.filter((a) => a.itemId === "region").length <= 1, `${name}: 地方は 1 回まで`);

    const v = verdict(model, session.post);
    const want = v.outcome < bank.teams.length ? 1 : v.outcome === OUTCOME_MULTI ? 2 : 0;
    assert(v.teams.length === want, `${name}: 結果の球団の数が形と合う`);
    if (want === 2) assert(v.teams[0] !== v.teams[1], `${name}: 複数の 2 球団が別`);
    const d = decisive(model, session.post, session.answers);
    if (d) assert(session.asked.has(d.item.id) && d.item.kind !== "foil", `${name}: 決め手は答えた本物の質問`);
    const oc = overclaim(model, session.answers);
    assert(oc.claimed <= oc.asked, `${name}: 知ったかぶり度は出した架空の数以下`);
    const text = `${headline(bank.teams, v)}${shareText(bank.teams, v, n)}${outcomeKey(bank.teams, v.outcome)}`;
    assert(!/undefined|NaN/.test(text), `${name}: 結果の文に undefined / NaN が出ない（${text}）`);
  }
  const ms = (performance.now() - t0) / runs;
  console.log(`✅ ${name}: ${bank.items.length} 問・${runs} 回遊ばせて不変条件を満たした（1 回あたり ${ms.toFixed(0)}ms）`);
}

function checkReflect(name: string, bank: Bank): void {
  const model = new Model(bank);
  const { modelDist, deOverclaim, collapse } = makeReflect(model);
  const pick = (kind: string) => bank.items.filter((i) => i.kind === kind).slice(0, 3);
  for (const item of [...pick("player"), ...pick("culture"), ...pick("quiz"), ...pick("life")]) {
    const rels: Key[] = item.kind === "life" ? ["fan1", "fan2", "neutral", "none"] : ["fan", "same", "other", "neutral", "none"];
    for (const rel of rels) {
      const back = deOverclaim(item, modelDist(item, rel));
      // 元の数字: 同じ関係の人の、知ったかぶりでない（O=0）答え方を詳しさで混ぜたもの
      const o1 = modelDist(item, rel);
      const lambda = bank.params.overclaimLambda;
      const base = item.kind === "life" ? o1 : (() => {
        const t0 = item.teams[0] ?? 0;
        const h = rel === "fan" ? { kind: "fan1" as const, teams: [t0] } : null;
        return h ? collapse(item, [0, 1, 2].reduce((acc, g) => model.answerProbs(item, h, g, 0).map((x, a) => (acc[a] ?? 0) + bank.params.priorG[g]! * x), [] as number[])) : null;
      })();
      if (base) assert(back.every((x, a) => Math.abs(x - base[a]!) < 2e-3), `Ⓔ ${name}: ${item.id}（${rel}）の逆算が元に戻る（${back} / ${base}）`);
      assert(Math.abs(back.reduce((a, b) => a + b, 0) - 1) < 2e-3 && back.every((x) => x >= 0), `Ⓔ ${name}: ${item.id}（${rel}）の逆算が確率になる（λ=${lambda}）`);
    }
  }
  console.log(`✅ ${name}: reflect の逆算がモデルの数字に戻る`);
}

function checkStep(name: string, model: Model, post: Float64Array): void {
  let sum = 0;
  for (const x of post) {
    assert(x >= 0 && Number.isFinite(x), `${name}: 状態の確率が 0 以上・有限`);
    sum += x;
  }
  assert(close(sum, 1), `${name}: 状態の確率の合計が 1（${sum}）`);
  assert(close(outcomeProbs(model, post).reduce((a, b) => a + b, 0), 1), `${name}: 結果の確率の合計が 1`);
}

checkBank("仮の質問", syntheticBank(), 120);
checkReflect("仮の質問", syntheticBank());
const real = path.join(ROOT, "src", "generated", "bank.json");
const bank = JSON.parse(fs.readFileSync(real, "utf8")) as Bank;
if (bank.items.some((i) => i.kind === "player")) {
  checkBank("本物の質問", bank, 120);
  checkReflect("本物の質問", bank);
}
else console.log("（本物の選手の質問がまだ無いので、本物の質問での確認は飛ばした）");
