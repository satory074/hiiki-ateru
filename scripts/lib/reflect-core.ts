// reflect.ts の計算部分（ネットにつながずに smoketest から確かめられるよう分けた）。
import { Model, N_G, N_O } from "../../src/lib/model";
import type { Hyp, Item, LifeClass, Relation } from "../../src/lib/types";

export type Key = Relation | LifeClass | "sameLeague" | "crossLeague";

export function makeReflect(model: Model) {
  const bank = model.bank;
  const teamIds = bank.teams.map((t) => t.id);
  const leagueOf = new Map(bank.teams.map((t) => [t.id, t.league]));
  function relationOf(item: Item, main: string, others: string[]): Key {
    if (item.kind === "life") return main === "none" ? "neutral" : main === "nobaseball" ? "none" : others.length ? "fan2" : "fan1";
    if (item.kind === "league2") {
      if (main === "none" || main === "nobaseball") return main === "none" ? "neutral" : "none";
      if (!others.length) return "fan1";
      return others.some((o) => leagueOf.get(o) === leagueOf.get(main)) ? "sameLeague" : "crossLeague";
    }
    if (main === "none") return "neutral";
    if (main === "nobaseball") return "none";
    const fans = [main, ...others];
    const itemTeams = item.teams.map((t) => teamIds[t]!);
    if (itemTeams.some((t) => fans.includes(t))) return "fan";
    const leagues = new Set(fans.map((t) => leagueOf.get(t)));
    return itemTeams.some((t) => leagues.has(leagueOf.get(t))) ? "same" : "other";
  }
  /** クイズは選択肢ごとの数を [正解, 不正解, わからない] にまとめる（モデルの表と同じ形） */
  function collapse(item: Item, v: number[]): number[] {
    if (item.kind !== "quiz") return v;
    const dk = v[v.length - 1]!;
    const c = v[item.correct!]!;
    return [c, v.reduce((a, b) => a + b, 0) - c - dk, dk];
  }
  /** その関係の人について、今のモデルが見込む答え方（詳しさ・知ったかぶりを事前確率で混ぜたもの。実測と比べる形） */
  function modelDist(item: Item, rel: Key): number[] {
    const p = bank.params;
    const t0 = item.teams[0] ?? 0;
    const league = bank.teams[t0]?.league;
    const pickTeam = (same: boolean) => bank.teams.findIndex((t, i) => !item.teams.includes(i) && (t.league === league) === same);
    const crossPartner = bank.teams.findIndex((t) => t.league !== bank.teams[t0]?.league);
    const h: Hyp =
      rel === "sameLeague"
        ? { kind: "fan2", teams: [t0, bank.teams.findIndex((t, i) => i !== t0 && t.league === bank.teams[t0]?.league)] }
        : rel === "crossLeague"
          ? { kind: "fan2", teams: [t0, crossPartner] }
          : rel === "fan" || rel === "fan1"
        ? { kind: "fan1", teams: [t0] }
        : rel === "fan2"
          ? { kind: "fan2", teams: [t0, t0 === 0 ? 1 : 0] }
          : rel === "same"
            ? { kind: "fan1", teams: [pickTeam(true)] }
            : rel === "other"
              ? { kind: "fan1", teams: [pickTeam(false)] }
              : { kind: rel === "neutral" ? "neutral" : "none", teams: [] };
    const out = new Array(item.options.length).fill(0);
    for (let g = 0; g < N_G; g++)
      for (let o = 0; o < N_O; o++) {
        const w = p.priorG[g]! * p.priorO[o]!;
        model.answerProbs(item, h, g, o).forEach((x, a) => (out[a] += w * x));
      }
    return collapse(item, out);
  }
  /**
   * 実測（知ったかぶりの人も混ざった答え方）から、モデルに書く「知ったかぶりでない人の答え方」に戻す。
   * モデルは知ったかぶりの人に λ の補正を後から掛けるので、そのまま書くと二重に掛かる。
   * 混ざり方は線形（割合 π = 事前の知ったかぶり率）なので、逆に解ける。
   */
  function deOverclaim(item: Item, e: number[]): number[] {
    if (item.kind === "life" || item.kind === "league2") return e;
    const p = bank.params;
    const k = p.priorO[1]! * p.overclaimLambda;
    let out: number[];
    if (item.kind === "quiz") {
      const nC = item.options.length - 1;
      const dk = e[2]! / (1 - k);
      out = [e[0]! - (k * dk) / nC, e[1]! - (k * dk * (nC - 1)) / nC, dk];
    } else {
      const no = e[2]! / (1 - k);
      out = [e[0]!, 1 - e[0]! - no, no];
    }
    const clipped = out.map((x) => Math.max(0.001, x));
    const s = clipped.reduce((a, b) => a + b, 0);
    return clipped.map((x) => Number((x / s).toFixed(3)));
  }

  return { relationOf, modelDist, deOverclaim, collapse };
}
