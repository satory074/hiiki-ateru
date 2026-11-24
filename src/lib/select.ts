// 次の質問の選び方と、終わり方。
//
// 基本は「答えを聞いたあと、仮説 80 個（本命の球団・2球団の組・贔屓なし・見ない）の迷い（エントロピー）が
// 一番減る見込みの質問」（期待情報利得）。結果15種類ではなく仮説で測るのは、2球団の人の「どの組か」まで絞るため。
// そのうえで:
//   - 同じジャンルで「知らない」が続いたら、そのジャンルの点数を下げる（答えられない質問ばかりにしない）
//   - 架空の質問（foil）は決めた番手に入れる
//   - 地方の質問は、行き詰まったときに1回だけ
//   - 10〜30問。最低問数を超えて、どれかの結果の確信度が基準を超えたら終える
import { Model, N_G, N_O, hypProbs, initialPosterior, update } from "./model";
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
}

export function newSession(model: Model): Session {
  return {
    post: initialPosterior(model),
    answers: [],
    asked: new Set(),
    dontKnowStreak: new Map(),
    genreWeight: new Map(),
    topHistory: [],
    regionAsked: false,
  };
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

/** 質問 item を聞いたときに、仮説の迷いがどれだけ減る見込みか（ビット） */
export function expectedGain(model: Model, post: Float64Array, item: Item): number {
  const nA = item.options.length;
  const nH = model.hyps.length;
  const per = N_G * N_O;
  const L = model.lik(item);
  const T = model.likTau(item);
  const pa = new Float64Array(nA);
  const mass = new Float64Array(nA * nH);
  for (let s = 0; s < post.length; s++) {
    const ps = post[s]!;
    if (ps === 0) continue;
    const h = Math.floor(s / per);
    for (let a = 0; a < nA; a++) {
      pa[a]! += ps * L[s * nA + a]!;
      mass[a * nH + h]! += ps * T[s * nA + a]!;
    }
  }
  let after = 0;
  const row = new Float64Array(nH);
  for (let a = 0; a < nA; a++) {
    let sum = 0;
    for (let h = 0; h < nH; h++) sum += mass[a * nH + h]!;
    if (!(sum > 0)) continue;
    for (let h = 0; h < nH; h++) row[h] = mass[a * nH + h]! / sum;
    after += pa[a]! * entropy(row);
  }
  const pasum = pa.reduce((x, y) => x + y, 0);
  return entropy(hypProbs(model, post)) - after / pasum;
}

/** 言い切る仮説の確信度（＝一番ありそうな仮説の確率） */
export function topConfidence(model: Model, post: Float64Array): number {
  return maxOf(hypProbs(model, post));
}

/** 「知らない」にあたる選択肢か（選手・名物・架空は最後、クイズは「わからない」） */
export function isDontKnow(item: Item, answer: number): boolean {
  return (item.kind === "player" || item.kind === "culture" || item.kind === "foil" || item.kind === "quiz") &&
    answer === item.options.length - 1;
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
  if (n >= p.stop.min && topConfidence(model, s.post) >= p.stop.confidence) return null;

  const qNo = n + 1;
  if (p.foilAt.includes(qNo)) {
    const foils = model.bank.items.filter((i) => i.kind === "foil" && !s.asked.has(i.id));
    if (foils.length > 0) return { item: foils[Math.floor(rng() * foils.length)]!, reason: "foil" };
  }
  if (regionStalled(model, s)) {
    const region = model.bank.items.find((i) => i.kind === "region");
    if (region && !s.asked.has(region.id)) return { item: region, reason: "region" };
  }

  const scored: { item: Item; score: number }[] = [];
  for (const item of model.bank.items) {
    if (item.kind === "foil" || item.kind === "region" || s.asked.has(item.id)) continue;
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
