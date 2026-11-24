// 結果の説明: 結果の名前、決め手（どの答えが一番効いたか）、知ったかぶり度、シェア文。
import { Model, hypProbs, verdict, type Verdict } from "./model";
import { OUTCOME_MULTI, OUTCOME_NEUTRAL, OUTCOME_NONE, type Answer, type Item, type Team } from "./types";

/** 結果ページの URL に使うキー（球団 id / multi / neutral / none） */
export function outcomeKey(teams: Team[], outcome: number): string {
  if (outcome < teams.length) return teams[outcome]!.id;
  if (outcome === OUTCOME_MULTI) return "multi";
  if (outcome === OUTCOME_NEUTRAL) return "neutral";
  if (outcome === OUTCOME_NONE) return "none";
  throw new Error(`unknown outcome ${outcome}`);
}

export function outcomeKeys(teams: Team[]): string[] {
  return [...teams.map((t) => t.id), "multi", "neutral", "none"];
}

/** 結果の短い名前（グラフや「2位」の表示用） */
export function outcomeLabel(teams: Team[], outcome: number): string {
  if (outcome < teams.length) return teams[outcome]!.name;
  if (outcome === OUTCOME_MULTI) return "2球団以上";
  if (outcome === OUTCOME_NEUTRAL) return "贔屓なし（野球は好き）";
  return "野球はあまり見ない";
}

/** 結果の言い切り（画面の大見出し） */
export function headline(teams: Team[], v: Pick<Verdict, "outcome" | "teams">): string {
  if (v.outcome < teams.length) return `あなたの贔屓は、${teams[v.outcome]!.name}です。`;
  if (v.outcome === OUTCOME_MULTI) {
    const [a, b] = v.teams.map((t) => teams[t]!.name);
    return `あなたの贔屓は、${a}と${b}です。`;
  }
  if (v.outcome === OUTCOME_NEUTRAL) return "あなたに贔屓の球団はありません。でも、野球は好きですね。";
  return "あなたは、野球をあまり見ませんね。";
}

/** 質問を、種明かし用の一文にする（球団名つき） */
export function describeItem(teams: Team[], item: Item): string {
  const names = item.teams.map((t) => teams[t]!.name).join("・");
  switch (item.kind) {
    case "player":
      return `${item.text}（${names}${item.hint ? `・${item.hint}` : ""}）`;
    case "culture":
    case "quiz":
      return names ? `${item.text}（${names}）` : item.text;
    case "foil":
      return `${item.text}（実在しない${item.look === "culture" ? "名物" : "選手"}）`;
    default:
      return item.text;
  }
}

export interface Decisive {
  item: Item;
  answer: number;
  /** 結果と2位の差を、この答えがどれだけ広げたか（対数尤度比、自然対数） */
  llr: number;
}

/**
 * 決め手: 言い切った仮説 k と2位の仮説 k2 について、各答えの「k ならこう答える確率 ÷ k2 ならこう答える確率」の対数を比べ、
 * 一番大きいものを返す。k・k2 の中の状態（詳しさ・知ったかぶり）は、最後の事後確率で重みを付けて混ぜる。
 */
export function decisive(model: Model, post: Float64Array, answers: Answer[]): Decisive | null {
  const v = verdict(model, post);
  const wk = new Float64Array(post.length);
  const wk2 = new Float64Array(post.length);
  let sk = 0;
  let sk2 = 0;
  const per = post.length / model.hyps.length;
  for (let s = 0; s < post.length; s++) {
    const h = Math.floor(s / per);
    if (h === v.hyp) {
      wk[s] = post[s]!;
      sk += post[s]!;
    } else if (h === v.runnerUp) {
      wk2[s] = post[s]!;
      sk2 += post[s]!;
    }
  }
  if (!(sk > 0) || !(sk2 > 0)) return null;
  let best: Decisive | null = null;
  for (const ans of answers) {
    const item = model.itemById.get(ans.itemId);
    if (!item || item.kind === "foil") continue;
    const nA = item.options.length;
    const L = model.lik(item);
    let pk = 0;
    let pk2 = 0;
    for (let s = 0; s < post.length; s++) {
      const l = L[s * nA + ans.answer]!;
      pk += wk[s]! * l;
      pk2 += wk2[s]! * l;
    }
    const llr = Math.log(pk / sk) - Math.log(pk2 / sk2);
    if (!best || llr > best.llr) best = { item, answer: ans.answer, llr };
  }
  return best;
}

export interface Overclaim {
  asked: number;
  claimed: number;
}

/** 架空の質問のうち、何問を「知ってる」側で答えたか */
export function overclaim(model: Model, answers: Answer[]): Overclaim {
  let asked = 0;
  let claimed = 0;
  for (const a of answers) {
    const item = model.itemById.get(a.itemId);
    if (item?.kind !== "foil") continue;
    asked++;
    if (a.answer !== item.options.length - 1) claimed++;
  }
  return { asked, claimed };
}

export function shareText(teams: Team[], v: Verdict, nQuestions: number): string {
  const pct = Math.round(v.confidence * 100);
  const what =
    v.outcome < teams.length
      ? `私の贔屓は「${teams[v.outcome]!.name}」`
      : v.outcome === OUTCOME_MULTI
        ? `私の贔屓は「${v.teams.map((t) => teams[t]!.name).join("」と「")}」`
        : v.outcome === OUTCOME_NEUTRAL
          ? "「贔屓はないけど、野球は好き」"
          : "「野球はあまり見ない」";
  return `【12球団当て】${nQuestions}問で、${what}と当てられました（確信度${pct}%）`;
}

/** 仮説の名前（本命なら球団名、2球団なら「A・B」） */
export function hypLabel(model: Model, hyp: number): string {
  const h = model.hyps[hyp]!;
  const teams = model.bank.teams;
  if (h.kind === "fan1" || h.kind === "fan2") return h.teams.map((t) => teams[t]!.name).join("・");
  return outcomeLabel(teams, model.outcomeOfHyp[hyp]!);
}

/** 仮説の確率を大きい順に（2位以下の表示用） */
export function rankedHyps(model: Model, post: Float64Array): { hyp: number; p: number }[] {
  return Array.from(hypProbs(model, post), (p, hyp) => ({ hyp, p })).sort((a, b) => b.p - a.p);
}
