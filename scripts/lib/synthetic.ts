// テスト・シミュレーション用の仮の質問（各球団 選手14・名物6・クイズ2）。本物の data/items が揃う前でも仕組みを試せる。
// 暮らし（見始めたころの質問も）・架空・地方は本物（data/items/life.yaml・foils.yaml）を使う。
import { compileBank, loadSource, type RawItem } from "./source";
import type { Bank } from "../../src/lib/types";

export function syntheticBank(): Bank {
  const src = loadSource();
  const keep = src.items.filter((i) => i.kind === "life" || i.kind === "league2" || i.kind === "eralife" || i.kind === "foil");
  const fake: RawItem[] = [];
  src.teams.forEach((t, ti) => {
    for (let k = 0; k < 14; k++) {
      // 3 人に 1 人は隣の球団にも在籍した選手にする（移籍の扱いを試す）
      const teams = k % 3 === 0 ? [t.id, src.teams[(ti + 1) % src.teams.length]!.id] : [t.id];
      fake.push({
        id: `${t.id}-p-${k}`, kind: "player", genre: "player", text: `選手${ti}-${k}`, hint: `投手・${["1990", "2000", "2010", "2020"][k % 4]}年代`,
        teams, tier: k < 9 ? "C" : "B", era: k % 2 ? "ob" : "current", file: "synthetic",
      });
    }
    for (let k = 0; k < 6; k++)
      fake.push({ id: `${t.id}-c-${k}`, kind: "culture", genre: ["mascot", "food", "cheer"][k % 3]!, text: `名物${ti}-${k}`, teams: [t.id], tier: k < 3 ? "C" : "B", file: "synthetic" });
    for (let k = 0; k < 2; k++)
      fake.push({ id: `${t.id}-q-${k}`, kind: "quiz", genre: "quiz", text: `クイズ${ti}-${k}`, teams: [t.id], tier: "C", choices: ["あ", "い", "う", "え"], answer: k, file: "synthetic" });
  });
  return compileBank({ ...src, items: [...keep, ...fake] });
}
