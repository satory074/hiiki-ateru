// OG カード（1200x630 PNG）の生成。ビルド時のみ実行（satori/resvg は Node 専用）。samesaengil/src/lib/og.ts と同じ作り。
// 字形は src/lib/og-text.ts の文言だけ（scripts/buildFontSubset.ts がそこからサブセットを作る）。文言を変えたら npm run import:font。
import fs from "node:fs";
import path from "node:path";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import { OG_WORDMARK } from "./og-text";

const FONT = fs.readFileSync(path.join(process.cwd(), "src", "assets", "fonts", "NotoSansJP-Subset.ttf"));

type Node = { type: string; props: Record<string, unknown> };
const el = (type: string, style: Record<string, unknown>, children?: unknown): Node => ({ type, props: { style, children } });

/** スコアボード風のカード。accent は大見出しの下線の色（球団カラー） */
export async function renderOgCard(headline: string, sub: string, accent: string): Promise<ArrayBuffer> {
  const markup = el(
    "div",
    { width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: "#f4f1e8", fontFamily: "NotoSansJP" },
    [
      el(
        "div",
        { display: "flex", flexDirection: "column", justifyContent: "center", boxSizing: "border-box", width: 1100, height: 530, borderRadius: 36, backgroundColor: "#123d30", padding: "0 80px" },
        [
          el("div", { display: "flex", fontSize: 40, color: "#ffb000", letterSpacing: 2 }, OG_WORDMARK),
          el("div", { display: "flex", alignSelf: "flex-start", fontSize: 88, color: "#f3efe0", marginTop: 28, paddingBottom: 10, borderBottom: `10px solid ${accent}` }, headline),
          el("div", { display: "flex", fontSize: 40, color: "#b9c9bf", marginTop: 28 }, sub),
        ],
      ),
    ],
  );
  const svg = await satori(markup as never, { width: 1200, height: 630, fonts: [{ name: "NotoSansJP", data: FONT, weight: 700, style: "normal" }] });
  const png = new Resvg(svg).render().asPng();
  return png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer;
}
