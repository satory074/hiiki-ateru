// 結果を 1 枚の画像（1080×1080 PNG）にする。ブラウザの canvas だけで描く（ライブラリも画像も使わない）。
// 文字は端末の日本語フォント。球団ロゴ・写真は使わない。

export interface ShareCard {
  headline: string;
  sub: string;
  bars: { name: string; color: string; p: number }[];
  url: string;
}

const W = 1080;
const H = 1080;
const BOARD = "#123d30";
const INK = "#f3efe0";
const SOFT = "#b9c9bf";
const LED = "#ffb000";
const FONT = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic", "Meiryo", sans-serif';

/** 長い見出しを、幅に収まるように何行かに折る。なるべく「、」の後で折る */
function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const piece of text.split(/(?<=、)/)) {
    if (ctx.measureText(line + piece).width <= maxWidth) {
      line += piece;
      continue;
    }
    if (line) lines.push(line);
    line = "";
    for (const ch of piece) {
      if (ctx.measureText(line + ch).width > maxWidth && line) {
        lines.push(line);
        line = ch;
      } else line += ch;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function drawShareCard(canvas: HTMLCanvasElement, card: ShareCard): void {
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d unavailable");
  ctx.fillStyle = "#f4f1e8";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = BOARD;
  ctx.beginPath();
  ctx.roundRect(40, 40, W - 80, H - 80, 36);
  ctx.fill();

  ctx.fillStyle = LED;
  ctx.font = `700 40px ${FONT}`;
  ctx.fillText("12球団当て", 100, 140);

  // 見出しは 2 行に収まる大きさまで文字を小さくする（3 行になると下の棒グラフと重なるため）
  ctx.fillStyle = INK;
  let size = 68;
  let lines: string[] = [];
  for (; size >= 44; size -= 6) {
    ctx.font = `800 ${size}px ${FONT}`;
    lines = wrap(ctx, card.headline, W - 200);
    if (lines.length <= 2) break;
  }
  let y = 260;
  for (const line of lines.slice(0, 3)) {
    ctx.fillText(line, 100, y);
    y += Math.round(size * 1.3);
  }
  ctx.fillStyle = SOFT;
  ctx.font = `500 34px ${FONT}`;
  ctx.fillText(card.sub, 100, y + 4);

  ctx.font = `700 32px ${FONT}`;
  ctx.fillStyle = INK;
  y += 90;
  ctx.fillText("知識の偏り", 100, y);
  y += 30;
  const top = Math.max(0.0001, ...card.bars.map((b) => b.p));
  // URL の行（H - 100）に重ならない本数だけ描く
  const room = Math.max(1, Math.min(5, Math.floor((H - 150 - y) / 64)));
  for (const b of card.bars.slice(0, room)) {
    y += 64;
    ctx.fillStyle = INK;
    ctx.font = `500 32px ${FONT}`;
    ctx.fillText(b.name, 100, y);
    ctx.fillStyle = "#2b5446";
    ctx.fillRect(330, y - 26, 560, 28);
    ctx.fillStyle = b.color;
    ctx.fillRect(330, y - 26, Math.max(4, (560 * b.p) / top), 28);
    ctx.fillStyle = SOFT;
    ctx.font = `500 28px ${FONT}`;
    ctx.fillText(`${Math.round(b.p * 100)}%`, 910, y);
  }

  ctx.fillStyle = SOFT;
  ctx.font = `500 28px ${FONT}`;
  ctx.fillText(card.url, 100, H - 100);
}

export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/png"));
}
