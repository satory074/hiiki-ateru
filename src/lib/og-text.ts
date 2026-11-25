// OG 画像に出す文言（og.ts と buildFontSubset.ts の両方が使う。ここに無い字はフォントのサブセットに入らない）。
import type { Team } from "./types";
import { resultCopy } from "./result-copy";
import { UNOFFICIAL_NOTE } from "./notice";

export const OG_WORDMARK = "12球団当て";
export const OG_DEFAULT = { headline: "あなたの贔屓球団を当てます", sub: "知っている選手や名物の偏りから" };
export const OG_RESULT_SUB = "12球団当てで当てられました";
export { UNOFFICIAL_NOTE };

export function ogTexts(teams: Team[], keys: string[]): string {
  return [OG_WORDMARK, OG_DEFAULT.headline, OG_DEFAULT.sub, OG_RESULT_SUB, UNOFFICIAL_NOTE, ...keys.map((k) => resultCopy(teams, k).card)].join("");
}
