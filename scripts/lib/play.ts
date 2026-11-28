// 仮想の回答者に1回遊ばせる（smoketest と simulate で共有）。
// 回答者は「真の状態（仮説 h・詳しさ g・知ったかぶり o・見始めた年代 e）」を持ち、モデル自身の確率表どおりに答える。
// だからここで出る的中率は「モデルが自分の前提どおりに動くか」の確認であって、実際の人の的中率ではない。
import { Model, eOfState, gOfState, hypOfState, oOfState, verdict, type Verdict } from "../../src/lib/model";
import { answer, newSession, nextItem, type Session } from "../../src/lib/select";
import type { Rng } from "../../src/lib/rng";
import type { Bank } from "../../src/lib/types";

export interface Truth {
  h: number;
  g: number;
  o: number;
  /** 見始めた年代の番号（ERA_IDS の並び）。見ない人にもあるが、答え方には効かない */
  e: number;
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

/**
 * responder を渡すと、回答者はそのモデルの確率表どおりに答える（当てるほうは model のまま）。
 * モデルの前提が外れたときに崩れないかを見るため（hardCoreBank）
 */
export function playOnce(model: Model, truth: Truth, rng: Rng, onStep?: (s: Session) => void, responder: Model = model): Played {
  const s = newSession(model);
  const h = model.hyps[truth.h]!;
  for (;;) {
    const next = nextItem(model, s, rng);
    if (!next) break;
    const a = sample(responder.answerProbs(next.item, h, truth.g, truth.o, truth.e), rng);
    answer(model, s, next.item, a);
    onStep?.(s);
  }
  return { session: s, verdict: verdict(model, s.post) };
}

/** 事前確率どおりに真の状態を引く */
export function sampleTruth(model: Model, rng: Rng): Truth {
  const s = sample(Array.from(model.prior), rng);
  return { h: hypOfState(s), g: gOfState(s), o: oOfState(s), e: eOfState(s) };
}

/**
 * 「詳しい人（コア）は他球団のこともかなり知っている」回答者の表（2026-11-28）。答えるほうだけに使い、当てるモデルは変えない。
 * モデルは「コアでも他球団の控え級の選手を『よく知ってる』のは同じリーグ 8%・別リーグ 4%」と置いているが、
 * それが外れていたら崩れないかを見る物差し。この表で、気持ちの質問を足す前のコアの本命1球団ファンは 77.5% だった（240 人）。
 */
export function hardCoreBank(bank: Bank): Bank {
  const b = JSON.parse(JSON.stringify(bank)) as Bank;
  const K = b.params.know;
  K.same.B[2] = [0.45, 0.45, 0.1];
  K.same.C[2] = [0.2, 0.45, 0.35];
  K.same.D[2] = [0.08, 0.2, 0.72];
  K.other.B[2] = [0.35, 0.5, 0.15];
  K.other.C[2] = [0.12, 0.4, 0.48];
  K.other.D[2] = [0.04, 0.12, 0.84];
  K.neutral.B[2] = [0.4, 0.45, 0.15];
  K.neutral.C[2] = [0.15, 0.4, 0.45];
  K.neutral.D[2] = [0.06, 0.16, 0.78];
  b.params.quiz.same[2] = [0.5, 0.2, 0.3];
  b.params.quiz.other[2] = [0.4, 0.2, 0.4];
  b.params.quiz.neutral[2] = [0.45, 0.2, 0.35];
  return b;
}
