// 画像だけが広まっても公式と誤解されないよう、OG 画像とシェア画像の両方に入れる一文（2026-11-25）。
// 依存の無い小さなモジュールにして、画面の層（canvas-share）からも軽く読めるようにしている。
// OG 画像のフォントのサブセットにも入る（og-text.ts の ogTexts が集める）。文言を変えたら npm run import:font。
export const UNOFFICIAL_NOTE = "非公式・NPB／各球団とは無関係";
