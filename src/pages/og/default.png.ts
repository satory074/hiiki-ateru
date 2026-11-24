// トップ・しくみページの OG 画像。
import type { APIRoute } from "astro";
import { renderOgCard } from "../../lib/og";
import { OG_DEFAULT } from "../../lib/og-text";

export const GET: APIRoute = async () => {
  const png = await renderOgCard(OG_DEFAULT.headline, OG_DEFAULT.sub, "#ffb000");
  return new Response(png, { headers: { "Content-Type": "image/png" } });
};
