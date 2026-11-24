// 型の無いモジュール（scripts だけで使う）
declare module "subset-font" {
  const subsetFont: (font: Buffer, text: string, options?: { targetFormat?: string; variationAxes?: Record<string, number> }) => Promise<Buffer>;
  export default subsetFont;
}
