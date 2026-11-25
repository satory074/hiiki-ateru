// 画面のテスト（jsdom。Supabase には接続しない。送り先は偽物を差し込む）。実行: npx tsx scripts/domtest.ts
//   ⓐ 「はじめる」→ 10〜30 問 → 結果、と進み、質問中の画面に球団名が一度も出ない
//   ⓑ 「1問もどる」で 1 つ前の質問に戻り、答えの数が 1 つ減る
//   ⓒ 答え合わせで送るのは v・guess・actual・answers の 4 つだけで、答えは遊んだ質問と一致する。送り先が無ければ送らない。
//      送った記録がある端末からは、同じ版をもう一度送らない
//   ⓓ X のシェアは結果ページの URL を載せる
//   ⓔ 当たり判定（本命・2番手・2球団・贔屓なし・見ない）
import fs from "node:fs";
import path from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";
import { mountGame, judge } from "../src/app/game";
import { nullApi, type ResultApi, type ResultPayload } from "../src/app/api";
import { createRng } from "../src/lib/rng";
import { OUTCOME_MULTI, OUTCOME_NEUTRAL, OUTCOME_NONE, type Bank } from "../src/lib/types";
import type { Verdict } from "../src/lib/model";
import { ROOT } from "./lib/source";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`❌ FAILED: ${msg}`);
    process.exit(1);
  }
}

// 画面の処理で投げた例外は jsdom が握りつぶすので、拾って落とす
const vc = new VirtualConsole();
vc.on("jsdomError", (e) => {
  console.error(`❌ FAILED: 画面の処理で例外 ${(e as { detail?: Error }).detail?.stack ?? e.stack}`);
  process.exit(1);
});
const dom = new JSDOM(`<!doctype html><html><body><div id="game"><button data-action="start">はじめる</button></div></body></html>`, { virtualConsole: vc });
const g = globalThis as Record<string, unknown>;
for (const k of ["document", "window", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "HTMLButtonElement", "Event", "Node"])
  g[k] = (dom.window as unknown as Record<string, unknown>)[k];

const bank = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "generated", "bank.json"), "utf8")) as Bank;
const teamWords = bank.teams.flatMap((t) => [t.name, t.full]);
const SITE = "https://satory074.github.io/hiiki-ateru/";

function setup(api: ResultApi, seed: number, sentStore?: { has(v: string): boolean; mark(v: string): void }) {
  // 回ごとに新しい要素にする（前の回のクリック処理を残さない）
  const doc = dom.window.document;
  const root = doc.createElement("div");
  root.id = "game";
  root.innerHTML = '<button data-action="start">はじめる</button>';
  doc.getElementById("game")!.replaceWith(root);
  const opened: string[] = [];
  const game = mountGame(root as unknown as HTMLElement, { bank, api, rng: createRng(seed), siteUrl: SITE, openUrl: (u) => opened.push(u), sentStore });
  const click = (sel: string) => {
    const el = root.querySelector(sel) as HTMLElement | null;
    assert(el, `押すものがある: ${sel}`);
    el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  };
  return { root, game, click, opened };
}

// ⓐ ⓑ
for (let seed = 1; seed <= 6; seed++) {
  const sent: ResultPayload[] = [];
  const api: ResultApi = { enabled: true, record: async (p) => (sent.push(p), true) };
  const { root, game, click, opened } = setup(api, seed);
  click('[data-action="start"]');
  let n = 0;
  while (root.querySelector('[data-view="question"]')) {
    const board = root.querySelector('[data-view="question"]')!;
    const text = board.textContent ?? "";
    for (const w of teamWords) assert(!text.includes(w), `ⓐ 質問中の画面に球団名「${w}」が出ない（${text}）`);
    n++;
    if (n === 3) {
      const before = game.state().steps.length;
      const shown = board.getAttribute("data-item");
      click('[data-view="question"] .opt');
      click('[data-action="back"]');
      assert(game.state().steps.length === before, "ⓑ もどると答えの数が元に戻る");
      assert(root.querySelector('[data-view="question"]')!.getAttribute("data-item") === shown, "ⓑ もどると同じ質問が出る");
    }
    const opts = [...board.querySelectorAll(".opt")];
    // 種ごとに答え方を変える（全部「知らない」/ 最初の選択肢 / ばらばら）
    const pick = seed % 3 === 0 ? opts.length - 1 : seed % 3 === 1 ? 0 : (n * 7 + seed) % opts.length;
    (opts[pick] as HTMLElement).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    assert(n <= 40, "ⓐ 終わらないことはない");
  }
  const steps = game.state().steps.length;
  assert(steps >= bank.params.stop.min && steps <= bank.params.stop.max, `ⓐ 質問数が範囲内（${steps}）`);
  const result = root.querySelector('[data-view="result"]');
  assert(result, "ⓐ 結果の画面になる");
  assert((root.querySelector(".verdict")?.textContent ?? "").startsWith("あなた"), "ⓐ 言い切りの文がある");
  assert(root.querySelectorAll(".bar").length === bank.teams.length, "ⓐ 知識の偏りは 12 球団ぶん");
  assert(root.querySelectorAll(".answers-list li").length === steps, "ⓐ 答えた問題の一覧が答えの数と同じ");

  // ⓒ 答え合わせ
  const select = root.querySelector("#check-main") as unknown as HTMLSelectElement;
  select.value = "carp";
  select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  const hawks = root.querySelector('input[name="others"][value="hawks"]') as unknown as HTMLInputElement;
  hawks.checked = true;
  root.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 0));
  assert(sent.length === 1, "ⓒ 答え合わせを 1 回送る");
  const p = sent[0]!;
  assert(JSON.stringify(Object.keys(p).sort()) === JSON.stringify(["actual", "answers", "guess", "v"]), "ⓒ 送るのは 4 つだけ");
  assert(JSON.stringify(Object.keys(p.actual).sort()) === JSON.stringify(["main", "others"]), "ⓒ actual は main と others だけ");
  assert(p.v === bank.version && p.actual.main === "carp" && p.actual.others.join() === "hawks", "ⓒ 版と本当の答えがそのまま入る");
  assert(p.answers.length === steps && p.answers.every((a, i) => a.q === game.state().steps[i]!.item.id), "ⓒ 答えは遊んだ質問と一致");
  assert((root.querySelector(".thanks")?.textContent ?? "").length > 0, "ⓒ 当たり・はずれが出る");
  root.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 0));

  // ⓓ シェア
  click('[data-action="share-x"]');
  const key = result.getAttribute("data-outcome");
  assert(opened.length === 1 && opened[0]!.includes(encodeURIComponent(`${SITE}result/${key}/`)), "ⓓ X に結果ページの URL を載せる");
  click('[data-action="again"]');
  assert(root.querySelector('[data-view="question"]') && game.state().steps.length === 0, "ⓐ もう一度で最初の質問に戻る");
}

// ⓒ 送り先が無いときは送らない
{
  let called = 0;
  const off: ResultApi = { ...nullApi, record: async () => (called++, false) };
  const { root, click } = setup(off, 99);
  click('[data-action="start"]');
  while (root.querySelector('[data-view="question"] .opt')) click('[data-view="question"] .opt:last-child');
  const select = root.querySelector("#check-main") as unknown as HTMLSelectElement;
  select.value = "none";
  root.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 0));
  assert(called === 0, "ⓒ 送り先が無いときは送らない");
}

// ⓒ 送った記録がある端末からは、同じ版をもう一度送らない（記録は送れたときだけ付ける）
{
  const sent: ResultPayload[] = [];
  const marked = new Set<string>();
  const store = { has: (v: string) => marked.has(v), mark: (v: string) => void marked.add(v) };
  const api: ResultApi = { enabled: true, record: async (p) => (sent.push(p), true) };
  const { root, click } = setup(api, 7, store);
  for (let round = 0; round < 2; round++) {
    if (round === 0) click('[data-action="start"]');
    else click('[data-action="again"]');
    while (root.querySelector('[data-view="question"] .opt')) click('[data-view="question"] .opt:last-child');
    const select = root.querySelector("#check-main") as unknown as HTMLSelectElement;
    select.value = "nobaseball";
    root.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
  }
  assert(sent.length === 1 && marked.has(bank.version), "ⓒ 同じ端末・同じ版の答え合わせは 1 回だけ送る");
  assert((root.querySelector(".thanks")?.textContent ?? "").includes("今回は数えません"), "ⓒ 2回目は数えないと伝える");
}

// ⓔ 当たり判定
const T = bank.teams;
const ix = (id: string) => T.findIndex((t) => t.id === id);
const v = (outcome: number, teams: number[]): Verdict => ({ hyp: 0, outcome, confidence: 0.9, teams, runnerUp: 1 });
assert(judge(v(ix("carp"), [ix("carp")]), T, "carp", []) === "hit", "ⓔ 本命が一致で当たり");
assert(judge(v(ix("carp"), [ix("carp")]), T, "hawks", ["carp"]) === "near", "ⓔ 2番手なら惜しい");
assert(judge(v(ix("carp"), [ix("carp")]), T, "none", []) === "miss", "ⓔ 贔屓なしの人に球団を言えばはずれ");
assert(judge(v(OUTCOME_MULTI, [ix("carp"), ix("hawks")]), T, "hawks", ["carp"]) === "hit", "ⓔ 2球団が両方そろえば当たり");
assert(judge(v(OUTCOME_MULTI, [ix("carp"), ix("hawks")]), T, "carp", []) === "near", "ⓔ 2球団の片方だけなら惜しい");
assert(judge(v(OUTCOME_NEUTRAL, []), T, "none", []) === "hit", "ⓔ 贔屓なし");
assert(judge(v(OUTCOME_NONE, []), T, "nobaseball", []) === "hit", "ⓔ 野球を見ない");
assert(judge(v(OUTCOME_NONE, []), T, "none", []) === "miss", "ⓔ 見ないと贔屓なしは別");

console.log("✅ domtest: 画面の流れ・答え合わせ・シェア・当たり判定の不変条件を満たした");
