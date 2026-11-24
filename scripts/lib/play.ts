// 仮想の回答者に1回遊ばせる（smoketest と simulate で共有）。
// 回答者は「真の状態（仮説 h・詳しさ g・知ったかぶり o）」を持ち、モデル自身の確率表どおりに答える。
// だからここで出る的中率は「モデルが自分の前提どおりに動くか」の確認であって、実際の人の的中率ではない。
import { Model, verdict, type Verdict } from "../../src/lib/model";
import { answer, newSession, nextItem, type Session } from "../../src/lib/select";
import type { Rng } from "../../src/lib/rng";

export interface Truth {
  h: number;
  g: number;
  o: number;
}

function sample(probs: number[], rng: Rng): number {
  let r = rng();
  for (let i = 0; i < probs.length; i++) {
    r -= probs[i]!;
    if (r < 0) return i;
  }
  return probs.length - 1;
}

export interface Played {
  session: Session;
  verdict: Verdict;
  /** 各問の後に呼ぶ（不変条件の検査用） */
}

export function playOnce(model: Model, truth: Truth, rng: Rng, onStep?: (s: Session) => void): Played {
  const s = newSession(model);
  const h = model.hyps[truth.h]!;
  for (;;) {
    const next = nextItem(model, s, rng);
    if (!next) break;
    const a = sample(model.answerProbs(next.item, h, truth.g, truth.o), rng);
    answer(model, s, next.item, a);
    onStep?.(s);
  }
  return { session: s, verdict: verdict(model, s.post) };
}

/** 事前確率どおりに真の状態を引く */
export function sampleTruth(model: Model, rng: Rng): Truth {
  const s = sample(Array.from(model.prior), rng);
  const per = 3 * 2;
  return { h: Math.floor(s / per), g: Math.floor((s % per) / 2), o: s % 2 };
}
