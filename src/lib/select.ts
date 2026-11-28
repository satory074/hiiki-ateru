// 次の質問の選び方と、終わり方。
//
// 基本は「答えを聞いたあと、仮説 80 個（本命の球団・2球団の組・贔屓なし・見ない）の迷い（エントロピー）が
// 一番減る見込みの質問」（期待情報利得）。結果15種類ではなく仮説で測るのは、2球団の人の「どの組か」まで絞るため。
// 見始めた年代も当てるので（2026-11-27）、点数には「見る人に限った年代 4 区分の迷いが減る見込み × 見る人である確率」を足す。
// 見る人である確率を掛けるのは、見ない人らしいときに年代の質問を無駄に出さないため。
// そのうえで:
//   - 同じジャンルで「知らない」が続いたら、そのジャンルの点数を下げる（答えられない質問ばかりにしない）
//   - 1問目は firstItem（中継を見る頻度）に固定する
//   - 架空の質問（foil）は、窓（3〜5・8〜10・14〜18・22〜26問目）ごとにくじで選んだ番手に1問ずつ入れる
//   - 地方の質問は、行き詰まったときに1回だけ
//   - 気持ちの質問（この選手が活躍したら？）は 1 回に params.feel.maxPerGame 問まで。同じ選手は知識・気持ちのどちらか 1 回だけ
//     （「知らない」を二重に数えないため。item.twin が聞いてあれば出さない）
//   - 10〜30問。最低問数を超えて、言い切る仮説の確信度が基準（85%）を超え、
//     さらに見始めた年代の確信度も基準（80%）を超えたら終える（見ないと言い切るときは年代を問わない）
import { Model, N_E, PER_HYP, eOfState, eraProbs, hypProbs, initialPosterior, update, verdict, watchProb } from "./model";
import { OUTCOME_NONE } from "./types";
import type { Answer, Item } from "./types";
import type { Rng } from "./rng";

export interface Session {
  post: Float64Array;
  answers: Answer[];
  asked: Set<string>;
  /** ジャンルごとの、続けて「知らない」を選んだ回数 */
  dontKnowStreak: Map<string, number>;
  /** ジャンルごとの点数の掛け目（下がる一方） */
  genreWeight: Map<string, number>;
  /** 各問のあとの一番の確信度（行き詰まりの判定用） */
  topHistory: number[];
  regionAsked: boolean;
  /** 架空の質問を出す番手（窓ごとに1つ）。最初の nextItem でくじを引く。1問もどるときは引き継ぐ */
  foilAt: number[] | null;
}

export function newSession(model: Model, foilAt: number[] | null = null): Session {
  return {
    post: initialPosterior(model),
    answers: [],
    asked: new Set(),
    dontKnowStreak: new Map(),
    genreWeight: new Map(),
    topHistory: [],
    regionAsked: false,
    foilAt,
  };
}

/** 窓ごとに、架空の質問を出す番手を1つずつくじで選ぶ */
export function drawFoilPositions(windows: [number, number][], rng: Rng): number[] {
  return windows.map(([a, b]) => a + Math.floor(rng() * (b - a + 1)));
}

function entropy(p: ArrayLike<number>): number {
  let h = 0;
  for (let i = 0; i < p.length; i++) {
    const x = p[i]!;
    if (x > 0) h -= x * Math.log2(x);
  }
  return h;
}

const maxOf = (p: ArrayLike<number>): number => {
  let m = 0;
  for (let i = 0; i < p.length; i++) if (p[i]! > m) m = p[i]!;
  return m;
};

/**
 * 質問 item を聞いたときに、迷いがどれだけ減る見込みか（ビット）。
 * 仮説 80 個の迷いの減り ＋ 見る人である確率 × 見る人に限った年代 4 区分の迷いの減り
 */
export function expectedGain(model: Model, post: Float64Array, item: Item): number {
  const nA = item.options.length;
  const nH = model.hyps.length;
  const L = model.lik(item);
  const T = model.likTau(item);
  const pa = new Float64Array(nA);
  const mass = new Float64Array(nA * nH);
  const eraMass = new Float64Array(nA * N_E);
  const none = model.outcomeOfState;
  for (let s = 0; s < post.length; s++) {
    const ps = post[s]!;
    if (ps === 0) continue;
    const h = Math.floor(s / PER_HYP);
    const watching = none[s] !== OUTCOME_NONE;
    const e = eOfState(s);
    for (let a = 0; a < nA; a++) {
      pa[a]! += ps * L[s * nA + a]!;
      const t = ps * T[s * nA + a]!;
      mass[a * nH + h]! += t;
      if (watching) eraMass[a * N_E + e]! += t;
    }
  }
  const eraNow = entropy(eraProbs(model, post));
  let after = 0;
  let eraAfter = 0;
  const row = new Float64Array(nH);
  const eraRow = new Float64Array(N_E);
  for (let a = 0; a < nA; a++) {
    let sum = 0;
    for (let h = 0; h < nH; h++) sum += mass[a * nH + h]!;
    if (!(sum > 0)) continue;
    for (let h = 0; h < nH; h++) row[h] = mass[a * nH + h]! / sum;
    after += pa[a]! * entropy(row);
    let esum = 0;
    for (let e = 0; e < N_E; e++) esum += eraMass[a * N_E + e]!;
    if (esum > 0) {
      for (let e = 0; e < N_E; e++) eraRow[e] = eraMass[a * N_E + e]! / esum;
      eraAfter += pa[a]! * entropy(eraRow);
    } else eraAfter += pa[a]! * eraNow;
  }
  const pasum = pa.reduce((x, y) => x + y, 0);
  const hypGain = entropy(hypProbs(model, post)) - after / pasum;
  const eraGain = eraNow - eraAfter / pasum;
  return hypGain + watchProb(model, post) * eraGain;
}

/** 言い切る仮説の確信度（＝一番ありそうな仮説の確率） */
export function topConfidence(model: Model, post: Float64Array): number {
  return maxOf(hypProbs(model, post));
}

/** 見始めた年代の確信度（見る人に限った、一番ありそうな年代の確率） */
export function eraConfidence(model: Model, post: Float64Array): number {
  return maxOf(eraProbs(model, post));
}

/** 終えてよい確かさか: 仮説が基準に届き、見ないと言い切るのでなければ年代も基準に届いている */
export function settled(model: Model, post: Float64Array): boolean {
  const p = model.bank.params;
  if (topConfidence(model, post) < p.stop.confidence) return false;
  if (verdict(model, post).outcome === OUTCOME_NONE) return true;
  return eraConfidence(model, post) >= p.era.stopConfidence;
}

/** 「知らない」にあたる選択肢か（選手・名物・架空・気持ちは最後、クイズは「わからない」） */
export function isDontKnow(item: Item, answer: number): boolean {
  return (item.kind === "player" || item.kind === "culture" || item.kind === "foil" || item.kind === "quiz" || item.kind === "feel") &&
    answer === item.options.length - 1;
}

/** ここまでに出した気持ちの質問の数 */
export function feelCount(model: Model, s: Session): number {
  return s.answers.filter((a) => model.itemById.get(a.itemId)?.kind === "feel").length;
}

function regionStalled(model: Model, s: Session): boolean {
  const rf = model.bank.params.regionFallback;
  const n = s.answers.length;
  if (s.regionAsked || n < rf.minQuestions) return false;
  const top = s.topHistory[n - 1] ?? 0;
  const before = s.topHistory[n - 1 - rf.stallWindow] ?? 0;
  return top < rf.below && top - before < rf.stallGain;
}

export type Next = { item: Item; reason: "gain" | "foil" | "region" } | null;

/** 次に聞く質問。null なら終わり */
export function nextItem(model: Model, s: Session, rng: Rng): Next {
  const p = model.bank.params;
  const n = s.answers.length; // ここまでに答えた数
  if (n >= p.stop.max) return null;
  if (n >= p.stop.min && settled(model, s.post)) return null;

  const qNo = n + 1;
  if (n === 0 && p.firstItem) {
    const first = model.itemById.get(p.firstItem);
    if (first && !s.asked.has(first.id)) return { item: first, reason: "gain" };
  }
  s.foilAt ??= drawFoilPositions(p.foilWindows, rng);
  if (s.foilAt.includes(qNo)) {
    const foils = model.bank.items.filter((i) => i.kind === "foil" && !s.asked.has(i.id));
    if (foils.length > 0) return { item: foils[Math.floor(rng() * foils.length)]!, reason: "foil" };
  }
  if (regionStalled(model, s)) {
    const region = model.bank.items.find((i) => i.kind === "region");
    if (region && !s.asked.has(region.id)) return { item: region, reason: "region" };
  }

  const scored: { item: Item; score: number }[] = [];
  const feelFull = feelCount(model, s) >= p.feel.maxPerGame;
  for (const item of model.bank.items) {
    if (item.kind === "foil" || item.kind === "region" || s.asked.has(item.id)) continue;
    if (item.twin && s.asked.has(item.twin)) continue;
    if (item.kind === "feel" && feelFull) continue;
    const w = s.genreWeight.get(item.genre) ?? 1;
    scored.push({ item, score: expectedGain(model, s.post, item) * w });
  }
  if (scored.length === 0) return null;
  const best = Math.max(...scored.map((x) => x.score));
  if (n >= p.stop.min && best < 1e-4) return null;
  // 同じくらい良い質問が並んだら、くじで選ぶ（遊ぶたびに少し違う質問が出るように）
  const near = scored.filter((x) => x.score >= best * p.pickWithin);
  return { item: near[Math.floor(rng() * near.length)]!.item, reason: "gain" };
}

/** 答えを記録して事後確率を進める（その場で書き換える） */
export function answer(model: Model, s: Session, item: Item, a: number): void {
  if (s.asked.has(item.id)) throw new Error(`asked twice: ${item.id}`);
  s.post = update(model, s.post, item, a);
  s.asked.add(item.id);
  s.answers.push({ itemId: item.id, answer: a });
  if (item.kind === "region") s.regionAsked = true;
  if (item.kind !== "foil" && item.kind !== "region") {
    const gp = model.bank.params.genrePenalty;
    if (isDontKnow(item, a)) {
      const streak = (s.dontKnowStreak.get(item.genre) ?? 0) + 1;
      if (streak >= gp.streak) {
        s.genreWeight.set(item.genre, (s.genreWeight.get(item.genre) ?? 1) * gp.factor);
        s.dontKnowStreak.set(item.genre, 0);
      } else s.dontKnowStreak.set(item.genre, streak);
    } else s.dontKnowStreak.set(item.genre, 0);
  }
  s.topHistory.push(topConfidence(model, s.post));
}
