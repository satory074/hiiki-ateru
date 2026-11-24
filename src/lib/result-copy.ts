// 結果ページ・OG 画像の文言（15 種類）。シェアされた人が見る側の文。
import type { Team } from "./types";

export interface ResultCopy {
  title: string;
  description: string;
  headline: string;
  sub: string;
  /** OG 画像の大見出し */
  card: string;
  color: string;
}

export function resultCopy(teams: Team[], key: string): ResultCopy {
  const t = teams.find((x) => x.id === key);
  if (t)
    return {
      title: `贔屓は${t.name}と当てられました`,
      description: `12球団当てで「${t.full}ファン」と当てられた人の結果です。知っている選手や名物から、あなたの贔屓球団も当てます。`,
      headline: `贔屓は、${t.name}と当てられました。`,
      sub: "知っている選手や名物の偏りから当てました。",
      card: `贔屓は ${t.name}`,
      color: t.color,
    };
  if (key === "multi")
    return {
      title: "贔屓は2球団と当てられました",
      description: "12球団当てで「2つの球団を応援している」と当てられた人の結果です。あなたの贔屓球団も当てます。",
      headline: "贔屓は、2球団と当てられました。",
      sub: "どちらの球団の選手もよく知っている人でした。",
      card: "贔屓は 2球団",
      color: "#b3261e",
    };
  if (key === "neutral")
    return {
      title: "贔屓はないけど野球好きと当てられました",
      description: "12球団当てで「贔屓はないけれど野球は好き」と当てられた人の結果です。あなたの贔屓球団も当てます。",
      headline: "贔屓はないけど、野球は好きと当てられました。",
      sub: "どの球団のことも、ほどよく知っている人でした。",
      card: "贔屓なし・野球は好き",
      color: "#4f5752",
    };
  if (key === "none")
    return {
      title: "野球はあまり見ないと当てられました",
      description: "12球団当てで「野球はあまり見ない」と見抜かれた人の結果です。あなたの贔屓球団も当てます。",
      headline: "野球は、あまり見ないと当てられました。",
      sub: "選手も名物も、ほとんど知らない人でした。",
      card: "野球はあまり見ない",
      color: "#4f5752",
    };
  throw new Error(`unknown result key: ${key}`);
}
