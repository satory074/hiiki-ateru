// 当てる仕組みの不変条件。実行: npx tsx scripts/smoketest.ts（npm test にも入っている）
//   Ⓐ 事前確率と、どの質問・どの状態（1920）の答えの確率も合計 1・0 以上
//   Ⓐ' 見始めた年代: 見ない人の答え方は年代で変わらない。活躍を終えた選手は、見始めたのが後の人ほど「知らない」が減らない
//   Ⓐ'' 気持ちの質問: 「知らない」の確率は、同じ選手の知識の質問の「知らない」とどの状態でも同じ
//   Ⓑ どんな答え方をしても、毎問のあとで 1920 状態と結果 15 種類・年代 4 区分の確率が合計 1・0 以上・有限
//   Ⓒ 質問は 10〜40 問で終わり、同じ質問は 2 度出ない。架空は決めた番手だけ、地方は 1 回まで
//   Ⓓ 結果の球団の数が形と合う（本命 1・複数 2・それ以外 0）。決め手は答えた質問から選ばれる
//      上限（40問）より前に終わったなら、仮説の確信度が基準に届き、見ないと言い切る以外は年代の確信度も基準に届いている
//   Ⓖ 気持ちの質問は 1 回に feel.maxPerGame 問まで。同じ選手を知識と気持ちの両方で聞かない
//   Ⓕ 次の質問を選ぶ計算が、1問あたり 200ms 以内（状態が 4 倍になったので測る）
//   Ⓔ reflect の逆算: モデル自身の答え方（知ったかぶりの人も混ざった形）を読ませると、モデルの元の数字（知ったかぶりでない人の形）に戻る
// 本物の質問（src/generated/bank.json）と、仮の質問（scripts/lib/synthetic.ts）の両方で確かめる。
import fs from "node:fs";
import path from "node:path";
import { Model, N_E, eraProbs, eraVerdict, outcomeProbs, verdict } from "../src/lib/model";
import { answer, eraConfidence, expectedGain, newSession, nextItem, settled, topConfidence } from "../src/lib/select";
import { decisive, eraLine, headline, outcomeKey, overclaim, shareText } from "../src/lib/explain";
import { createRng } from "../src/lib/rng";
import { OUTCOME_MULTI, OUTCOME_NONE, type Bank } from "../src/lib/types";
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
          const byEra = Array.from({ length: N_E }, (_, e) => model.answerProbs(item, h, g, o, e));
          for (const probs of byEra) {
            assert(probs.length === item.options.length, `${name}: ${item.id} の確率の数 = 選択肢の数`);
            assert(probs.every((x) => x >= 0 && Number.isFinite(x)), `${name}: ${item.id} の確率が 0 以上`);
            assert(close(probs.reduce((a, b) => a + b, 0), 1), `${name}: ${item.id} の確率の合計が 1`);
          }
          // Ⓐ'' 気持ちの「知らない」= 同じ選手の知識の「知らない」
          if (item.kind === "feel" && item.twin) {
            const twin = model.itemById.get(item.twin)!;
            for (let e = 0; e < N_E; e++) {
              const a = byEra[e]!;
              const b = model.answerProbs(twin, h, g, o, e);
              assert(close(a[a.length - 1]!, b[b.length - 1]!), `${name}: ${item.id} の「知らない」が ${twin.id} と同じ`);
            }
          }
          // Ⓐ' 見ない人は年代を問わない
          if (h.kind === "none")
            assert(byEra.every((pr) => pr.every((x, a) => close(x, byEra[0]![a]!))), `${name}: ${item.id} 見ない人の答え方が年代で変わらない`);
          // Ⓐ' 活躍を終えた選手は、後に見始めた人ほど「知らない」が増える（減らない）。おわりの区分までは同じ
          if (item.kind === "player" && item.span && h.kind !== "none") {
            const dk = byEra.map((pr) => pr[pr.length - 1]!);
            for (let e = 1; e < N_E; e++) {
              assert(dk[e]! >= dk[e - 1]! - 1e-12, `${name}: ${item.id} 後に見始めた人ほど「知らない」が減らない（${dk}）`);
              if (e <= item.span[1]) assert(close(dk[e]!, dk[0]!), `${name}: ${item.id} 活躍中に見始めた人は同じ答え方（${dk}）`);
            }
            if (item.span[1] < N_E - 1) assert(dk[N_E - 1]! > dk[0]! + 1e-6, `${name}: ${item.id} 見る前の選手は「知らない」が増える`);
          }
        }
    });
  const s0 = newSession(model);
  for (const item of bank.items) assert(expectedGain(model, s0.post, item) > -1e-9, `${name}: ${item.id} の利得が負でない`);

  // Ⓑ Ⓒ Ⓓ: 事前確率どおりの回答者と、でたらめに押す回答者
  const rng = createRng(20261125);
  const t0 = performance.now();
  let picks = 0;
  let pickMs = 0;
  const timedNext = (session: ReturnType<typeof newSession>) => {
    const t = performance.now();
    const next = nextItem(model, session, rng);
    pickMs = Math.max(pickMs, performance.now() - t);
    picks++;
    return next;
  };
  for (let r = 0; r < runs; r++) {
    const random = r % 4 === 3;
    let session;
    if (random) {
      session = newSession(model);
      for (;;) {
        const next = timedNext(session);
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
    // 架空は窓の中だけ・窓ごとに1問まで。最低問数までに終わる窓（3〜5・8〜10）には必ず1問ある
    const foilPos = session.answers.flatMap((a, i) => (model.itemById.get(a.itemId)!.kind === "foil" ? [i + 1] : []));
    for (const q of foilPos) assert(p.foilWindows.some(([a, b]) => q >= a && q <= b), `${name}: 架空は窓の中だけ（${q} 問目）`);
    for (const [a, b] of p.foilWindows) {
      const k = foilPos.filter((q) => q >= a && q <= b).length;
      assert(k <= 1, `${name}: 架空は窓ごとに1問まで（${a}〜${b} 問目に ${k} 問）`);
      if (b <= n) assert(k === 1, `${name}: 通り過ぎた窓には架空が1問ある（${a}〜${b} 問目）`);
    }
    if (p.firstItem) assert(session.answers[0]?.itemId === p.firstItem, `${name}: 1問目は ${p.firstItem}`);
    // Ⓖ 気持ちの質問の上限と、同じ選手を二度聞かないこと
    const askedItems = session.answers.map((a) => model.itemById.get(a.itemId)!);
    assert(askedItems.filter((i) => i.kind === "feel").length <= p.feel.maxPerGame, `${name}: 気持ちの質問は ${p.feel.maxPerGame} 問まで`);
    for (const i of askedItems) if (i.twin) assert(!session.asked.has(i.twin), `${name}: ${i.id} と ${i.twin} を両方聞いていない`);
    assert(session.answers.filter((a) => a.itemId === "region").length <= 1, `${name}: 地方は 1 回まで`);

    const v = verdict(model, session.post);
    // Ⓓ 上限より前に終わったなら、決めた確かさに届いている（どの質問でも、もう迷いが減らないので終えた場合を除く）
    if (n < p.stop.max && !settled(model, session.post)) {
      const rest = bank.items.filter((i) => i.kind !== "foil" && i.kind !== "region" && !session.asked.has(i.id));
      const best = Math.max(0, ...rest.map((i) => expectedGain(model, session.post, i) * (session.genreWeight.get(i.genre) ?? 1)));
      assert(best < 1e-4 + 1e-12, `${name}: 確かさが基準に届く前に終えていない（${n} 問・仮説 ${topConfidence(model, session.post).toFixed(2)}・年代 ${eraConfidence(model, session.post).toFixed(2)}）`);
    }
    const ev = eraVerdict(model, session.post);
    assert(ev.era >= 0 && ev.era < N_E && close(eraProbs(model, session.post).reduce((a, b) => a + b, 0), 1), `${name}: 年代の確率の合計が 1`);
    const want = v.outcome < bank.teams.length ? 1 : v.outcome === OUTCOME_MULTI ? 2 : 0;
    assert(v.teams.length === want, `${name}: 結果の球団の数が形と合う`);
    if (want === 2) assert(v.teams[0] !== v.teams[1], `${name}: 複数の 2 球団が別`);
    const d = decisive(model, session.post, session.answers);
    if (d) assert(session.asked.has(d.item.id) && d.item.kind !== "foil", `${name}: 決め手は答えた本物の質問`);
    const oc = overclaim(model, session.answers);
    assert(oc.claimed <= oc.asked, `${name}: 知ったかぶり度は出した架空の数以下`);
    const text = `${headline(bank.teams, v)}${eraLine(v, ev) ?? ""}${shareText(bank.teams, v, n, ev)}${outcomeKey(bank.teams, v.outcome)}`;
    assert((eraLine(v, ev) === null) === (v.outcome === OUTCOME_NONE), `${name}: 見ないと言い切るときだけ年代の行を出さない`);
    assert(!/undefined|NaN/.test(text), `${name}: 結果の文に undefined / NaN が出ない（${text}）`);
  }
  const ms = (performance.now() - t0) / runs;
  // Ⓕ 画面では1問ごとにこの計算が走る。遅い端末も考えて手元で 200ms 以内に収める
  assert(pickMs < 200, `${name}: 次の質問を選ぶ計算が 200ms 以内（一番遅かった回 ${pickMs.toFixed(0)}ms）`);
  console.log(`✅ ${name}: ${bank.items.length} 問・${runs} 回遊ばせて不変条件を満たした（1 回あたり ${ms.toFixed(0)}ms・次の質問を選ぶ計算は最長 ${pickMs.toFixed(0)}ms）`);
}

function checkReflect(name: string, bank: Bank): void {
  const model = new Model(bank);
  const { modelDist, deOverclaim, collapse } = makeReflect(model);
  const pick = (kind: string) => bank.items.filter((i) => i.kind === kind).slice(0, 3);
  for (const item of [...pick("player"), ...pick("culture"), ...pick("quiz"), ...pick("life"), ...pick("feel")]) {
    const rels: Key[] = item.kind === "life" ? ["fan1", "fan2", "neutral", "none"] : ["fan", "same", "other", "neutral", "none"];
    for (const rel of rels) {
      const back = deOverclaim(item, modelDist(item, rel));
      // 元の数字: 同じ関係の人の、知ったかぶりでない（O=0）答え方を詳しさで混ぜたもの
      const o1 = modelDist(item, rel);
      const lambda = bank.params.overclaimLambda;
      const base = item.kind === "life" ? o1 : (() => {
        const t0 = item.teams[0] ?? 0;
        const h = rel === "fan" ? { kind: "fan1" as const, teams: [t0] } : null;
        const ep = bank.params.era.prior;
        return h
          ? collapse(item, [0, 1, 2].reduce((acc, g) => {
              for (let e = 0; e < N_E; e++) model.answerProbs(item, h, g, 0, e).forEach((x, a) => (acc[a] = (acc[a] ?? 0) + bank.params.priorG[g]! * ep[e]! * x));
              return acc;
            }, [] as number[]))
          : null;
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
