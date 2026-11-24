// 当てる仕組みの本体（ベイズ更新）。
//
// 仮説は 80 個: 本命1球団 ×12、2球団の組 ×66、贔屓なし（野球は見る）×1、野球を見ない ×1。
// それぞれに「詳しさ G（ライト／ふつう／コア）」と「知ったかぶり O（低／高）」を掛け合わせた
// 80×3×2 = 480 状態の確率を、答えるたびに厳密に更新する（近似なし）。
//
// 1問の答えの確率は「その質問の球団が、その人にとって何か（relation）」で決まる:
//   fan     … 質問の球団のどれかが、仮説の贔屓球団に入っている（移籍した選手はどれか1球団でも）
//   same    … 贔屓と同じリーグの他球団
//   other   … 別リーグの球団
//   neutral … 贔屓なしの野球好き
//   none    … 野球を見ない
// 確信度が膨らみすぎないよう、更新では答えの確率を τ 乗する（params.tau）。
import {
  N_OUTCOMES,
  OUTCOME_MULTI,
  OUTCOME_NEUTRAL,
  OUTCOME_NONE,
  type Bank,
  type Hyp,
  type Item,
  type Relation,
} from "./types";

export const N_G = 3;
export const N_O = 2;
/** 確率 0 の答えが1回で仮説を消さないよう、答えの確率の下限を置く */
const FLOOR = 1e-4;

export function buildHypotheses(nTeams: number): Hyp[] {
  const hyps: Hyp[] = [];
  for (let t = 0; t < nTeams; t++) hyps.push({ kind: "fan1", teams: [t] });
  for (let a = 0; a < nTeams; a++) for (let b = a + 1; b < nTeams; b++) hyps.push({ kind: "fan2", teams: [a, b] });
  hyps.push({ kind: "neutral", teams: [] });
  hyps.push({ kind: "none", teams: [] });
  return hyps;
}

export const stateIndex = (h: number, g: number, o: number): number => (h * N_G + g) * N_O + o;

function normalize(v: number[]): number[] {
  const s = v.reduce((a, b) => a + b, 0);
  return s > 0 ? v.map((x) => x / s) : v.map(() => 1 / v.length);
}

export class Model {
  readonly hyps: Hyp[];
  readonly nStates: number;
  readonly prior: Float64Array;
  /** 状態 → 結果（15種類）の番号 */
  readonly outcomeOfState: Int8Array;
  /** 仮説 → 結果（15種類）の番号 */
  readonly outcomeOfHyp: Int8Array;
  readonly itemById: Map<string, Item>;
  private readonly likCache = new Map<string, Float64Array>();
  private readonly likTauCache = new Map<string, Float64Array>();

  constructor(readonly bank: Bank) {
    const nTeams = bank.teams.length;
    this.hyps = buildHypotheses(nTeams);
    this.nStates = this.hyps.length * N_G * N_O;
    this.itemById = new Map(bank.items.map((i) => [i.id, i]));

    const p = bank.params;
    const nFan2 = (nTeams * (nTeams - 1)) / 2;
    this.prior = new Float64Array(this.nStates);
    this.outcomeOfState = new Int8Array(this.nStates);
    this.outcomeOfHyp = new Int8Array(this.hyps.length);
    this.hyps.forEach((h, hi) => {
      const ph =
        h.kind === "fan1" ? p.prior.fan1 / nTeams : h.kind === "fan2" ? p.prior.fan2 / nFan2 : p.prior[h.kind];
      const outcome =
        h.kind === "fan1" ? h.teams[0]! : h.kind === "fan2" ? OUTCOME_MULTI : h.kind === "neutral" ? OUTCOME_NEUTRAL : OUTCOME_NONE;
      this.outcomeOfHyp[hi] = outcome;
      for (let g = 0; g < N_G; g++)
        for (let o = 0; o < N_O; o++) {
          const s = stateIndex(hi, g, o);
          this.prior[s] = ph * p.priorG[g]! * p.priorO[o]!;
          this.outcomeOfState[s] = outcome;
        }
    });
    const total = this.prior.reduce((a, b) => a + b, 0);
    for (let s = 0; s < this.nStates; s++) this.prior[s]! /= total;
  }

  relation(h: Hyp, item: Item): Relation {
    if (h.kind === "none") return "none";
    if (h.kind === "neutral") return "neutral";
    if (item.teams.some((t) => h.teams.includes(t))) return "fan";
    const teams = this.bank.teams;
    const leagues = new Set(h.teams.map((t) => teams[t]!.league));
    return item.teams.some((t) => leagues.has(teams[t]!.league)) ? "same" : "other";
  }

  /** 仮説 h・詳しさ g・知ったかぶり o の人が、この質問の各選択肢を選ぶ確率（合計 1） */
  answerProbs(item: Item, h: Hyp, g: number, o: number): number[] {
    const p = this.bank.params;
    const lambda = o === 1 ? p.overclaimLambda : 0;
    const ov = p.itemOverrides?.[item.id];
    switch (item.kind) {
      case "player":
      case "culture": {
        const rel = this.relation(h, item);
        const [w, n, no] = ov?.[rel] ?? p.know[rel][item.tier][g]!;
        return normalize([w!, n! + lambda * no!, no! * (1 - lambda)]);
      }
      case "foil": {
        const [w, n, no] = p.foil;
        return normalize([w!, n! + lambda * no!, no! * (1 - lambda)]);
      }
      case "quiz": {
        const rel = this.relation(h, item);
        const [c0, w0, dk0] = ov?.[rel] ?? p.quiz[rel][g]!;
        const nChoices = item.options.length - 1; // 最後が「わからない」
        const guessed = lambda * dk0!;
        const c = c0! + guessed / nChoices;
        const w = w0! + (guessed * (nChoices - 1)) / nChoices;
        const dk = dk0! - guessed;
        return normalize(item.options.map((_, i) => (i === nChoices ? dk : i === item.correct ? c : w / (nChoices - 1))));
      }
      case "life": {
        const table = item.life![h.kind];
        const row = ov?.[h.kind] ?? (Array.isArray(table[0]) ? (table as number[][])[g]! : (table as number[]));
        return normalize(row);
      }
      case "league2": {
        const key =
          h.kind === "fan2"
            ? this.bank.teams[h.teams[0]!]!.league === this.bank.teams[h.teams[1]!]!.league
              ? "sameLeague"
              : "crossLeague"
            : h.kind;
        return normalize(ov?.[key] ?? item.league2![key]);
      }
      case "region": {
        const r = p.regions;
        const pop = normalize(r.population);
        const home = (t: number) => r.names.indexOf(this.bank.teams[t]!.region);
        const base =
          h.teams.length === 0
            ? pop
            : pop.map((q, ri) => {
                const share = h.teams.filter((t) => home(t) === ri).length / h.teams.length;
                return r.homeShare * share + (1 - r.homeShare) * q;
              });
        return [...base.map((q) => q * (1 - r.elsewhere.p)), r.elsewhere.p];
      }
    }
  }

  /** 状態ごとの答えの確率（nStates × 選択肢数、行優先） */
  lik(item: Item): Float64Array {
    let L = this.likCache.get(item.id);
    if (L) return L;
    const nA = item.options.length;
    L = new Float64Array(this.nStates * nA);
    this.hyps.forEach((h, hi) => {
      for (let g = 0; g < N_G; g++)
        for (let o = 0; o < N_O; o++) {
          const s = stateIndex(hi, g, o);
          const probs = this.answerProbs(item, h, g, o);
          for (let a = 0; a < nA; a++) L![s * nA + a] = Math.max(FLOOR, probs[a]!);
        }
    });
    this.likCache.set(item.id, L);
    return L;
  }

  /** 更新に使う、τ 乗した答えの確率 */
  likTau(item: Item): Float64Array {
    let T = this.likTauCache.get(item.id);
    if (T) return T;
    const tau = this.bank.params.tau;
    T = this.lik(item).map((x) => Math.pow(x, tau));
    this.likTauCache.set(item.id, T);
    return T;
  }
}

/** 確率の合計を 1 にそろえる（その場で書き換える） */
export function normalizeInPlace(v: Float64Array): Float64Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i]!;
  if (!(s > 0)) throw new Error("posterior collapsed");
  for (let i = 0; i < v.length; i++) v[i]! /= s;
  return v;
}

export function initialPosterior(model: Model): Float64Array {
  return Float64Array.from(model.prior);
}

/** 1問の答えで事後確率を更新した新しい配列を返す */
export function update(model: Model, post: Float64Array, item: Item, answer: number): Float64Array {
  const nA = item.options.length;
  if (!(answer >= 0 && answer < nA)) throw new Error(`answer out of range: ${item.id} ${answer}`);
  const T = model.likTau(item);
  const next = new Float64Array(post.length);
  for (let s = 0; s < post.length; s++) next[s] = post[s]! * T[s * nA + answer]!;
  return normalizeInPlace(next);
}

export function outcomeProbs(model: Model, post: Float64Array): Float64Array {
  const out = new Float64Array(N_OUTCOMES);
  for (let s = 0; s < post.length; s++) out[model.outcomeOfState[s]!]! += post[s]!;
  return out;
}

/** 球団ごとの「ファン側（本命か2球団の片方）である確率」＝知識の偏りグラフ */
export function fanShare(model: Model, post: Float64Array): Float64Array {
  const out = new Float64Array(model.bank.teams.length);
  const per = N_G * N_O;
  model.hyps.forEach((h, hi) => {
    let m = 0;
    for (let k = 0; k < per; k++) m += post[hi * per + k]!;
    for (const t of h.teams) out[t]! += m;
  });
  return out;
}

/** 2球団の組のうち一番ありそうなもの */
export function bestPair(model: Model, post: Float64Array): { teams: [number, number]; p: number } {
  const per = N_G * N_O;
  let best: { teams: [number, number]; p: number } = { teams: [0, 1], p: -1 };
  model.hyps.forEach((h, hi) => {
    if (h.kind !== "fan2") return;
    let m = 0;
    for (let k = 0; k < per; k++) m += post[hi * per + k]!;
    if (m > best.p) best = { teams: [h.teams[0]!, h.teams[1]!], p: m };
  });
  return best;
}

/** 知ったかぶり（O=高）である確率 */
export function overclaimProb(post: Float64Array): number {
  let m = 0;
  for (let s = 1; s < post.length; s += N_O) m += post[s]!;
  return m;
}

/** 仮説 80 個の確率（詳しさ・知ったかぶりを足し合わせたもの） */
export function hypProbs(model: Model, post: Float64Array): Float64Array {
  const per = N_G * N_O;
  const out = new Float64Array(model.hyps.length);
  for (let s = 0; s < post.length; s++) out[Math.floor(s / per)]! += post[s]!;
  return out;
}

export interface Verdict {
  /** 言い切る仮説（本命の球団・2球団の組・贔屓なし・見ない のどれか1つ） */
  hyp: number;
  /** その仮説の結果（15種類）の番号 */
  outcome: number;
  /** 言い切る仮説そのものの確率。2球団なら「その組である確率」で、「複数のどれか」の確率ではない */
  confidence: number;
  /** 結果に出す球団（本命なら1つ、複数なら2つ、それ以外は空） */
  teams: number[];
  /** 2番目にありそうな仮説 */
  runnerUp: number;
}

/** 一番ありそうな仮説を言い切る */
export function verdict(model: Model, post: Float64Array): Verdict {
  const hp = hypProbs(model, post);
  let hyp = 0;
  for (let h = 1; h < hp.length; h++) if (hp[h]! > hp[hyp]!) hyp = h;
  let runnerUp = hyp === 0 ? 1 : 0;
  for (let h = 0; h < hp.length; h++) if (h !== hyp && hp[h]! > hp[runnerUp]!) runnerUp = h;
  return { hyp, outcome: model.outcomeOfHyp[hyp]!, confidence: hp[hyp]!, teams: [...model.hyps[hyp]!.teams], runnerUp };
}
