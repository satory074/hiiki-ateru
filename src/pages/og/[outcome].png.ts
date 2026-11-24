// 結果ページ（15 種類）の OG 画像。
import type { APIRoute } from "astro";
import { renderOgCard } from "../../lib/og";
import { OG_RESULT_SUB } from "../../lib/og-text";
import { bank } from "../../lib/site";
import { outcomeKeys } from "../../lib/explain";
import { resultCopy } from "../../lib/result-copy";

export function getStaticPaths() {
  return outcomeKeys(bank.teams).map((outcome) => ({ params: { outcome } }));
}

export const GET: APIRoute = async ({ params }) => {
  const copy = resultCopy(bank.teams, String(params.outcome));
  const png = await renderOgCard(copy.card, OG_RESULT_SUB, copy.color);
  return new Response(png, { headers: { "Content-Type": "image/png" } });
};
