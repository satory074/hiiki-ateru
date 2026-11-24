// OG 画像用フォントのサブセットを作る取込スクリプト（生成物はコミットする）。実行: npm run import:font
// samesaengil/scripts/buildFontSubset.ts と同じ作り。字形は src/lib/og-text.ts の文言から集める。
// フォント: Noto Sans JP（SIL Open Font License 1.1）。再配布はライセンス同梱が条件なので OFL.txt も置く。
import fs from "node:fs";
import path from "node:path";
import subsetFont from "subset-font";
import { ogTexts } from "../src/lib/og-text";
import { outcomeKeys } from "../src/lib/explain";
import { ROOT, loadSource } from "./lib/source";

const OUT_DIR = path.join(ROOT, "src", "assets", "fonts");
const FONT_URL = "https://github.com/google/fonts/raw/main/ofl/notosansjp/NotoSansJP%5Bwght%5D.ttf";
const LICENSE_URL = "https://github.com/google/fonts/raw/main/ofl/notosansjp/OFL.txt";

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

const { teams } = loadSource();
const glyphs = [...new Set(ogTexts(teams, outcomeKeys(teams)) + "0123456789 ")].join("");
const [full, license] = await Promise.all([download(FONT_URL), download(LICENSE_URL)]);
const subset = await subsetFont(full, glyphs, { targetFormat: "truetype", variationAxes: { wght: 700 } });
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, "NotoSansJP-Subset.ttf"), subset);
fs.writeFileSync(path.join(OUT_DIR, "LICENSE-OFL.txt"), license);
console.log(`[font] ${glyphs.length} 字 → src/assets/fonts/NotoSansJP-Subset.ttf (${(subset.length / 1024).toFixed(1)}KB)`);
