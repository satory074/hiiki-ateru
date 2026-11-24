// 本物の依存を差し込んでゲームを起動する（index.astro から読み込む）。
import bankJson from "../generated/bank.json";
import type { Bank } from "../lib/types";
import { createRng } from "../lib/rng";
import { mountGame } from "./game";
import { nullApi, supabaseApi } from "./api";
import { canvasToBlob, drawShareCard, type ShareCard } from "./canvas-share";

const bank = bankJson as unknown as Bank;
const url = import.meta.env.PUBLIC_SUPABASE_URL;
const key = import.meta.env.PUBLIC_SUPABASE_ANON_KEY;
const api = url && key ? supabaseApi(url, key) : nullApi;

/** 画像を作り、共有できる端末なら共有シート、できなければ保存・コピーのボタンを出す */
async function shareImage(card: ShareCard, area: HTMLElement): Promise<boolean> {
  const canvas = document.createElement("canvas");
  drawShareCard(canvas, card);
  const blob = await canvasToBlob(canvas);
  if (!blob) return false;
  const file = new File([blob], "12kyudan-ateru.png", { type: "image/png" });
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], text: card.headline });
      return true;
    }
  } catch {
    /* 共有をやめた・使えない → 下の保存に回す */
  }
  const objectUrl = URL.createObjectURL(blob);
  const img = document.createElement("img");
  img.src = objectUrl;
  img.alt = `結果の画像: ${card.headline}`;
  img.className = "share-preview";
  img.width = 540;
  img.height = 540;
  const save = document.createElement("a");
  save.href = objectUrl;
  save.download = "12kyudan-ateru.png";
  save.className = "btn";
  save.textContent = "画像を保存";
  const row = document.createElement("div");
  row.className = "btn-row";
  row.append(save);
  if ("ClipboardItem" in window && navigator.clipboard?.write) {
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "btn";
    copy.textContent = "画像をコピー";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        copy.textContent = "コピーしました";
      } catch {
        copy.textContent = "コピーできませんでした";
      }
    });
    row.append(copy);
  }
  area.replaceChildren(img, row);
  return true;
}

const root = document.getElementById("game");
if (root) {
  const siteUrl = new URL(import.meta.env.BASE_URL.replace(/\/?$/, "/"), location.origin).toString();
  const seed = (crypto.getRandomValues(new Uint32Array(1))[0] ?? Date.now()) >>> 0;
  mountGame(root, { bank, api, rng: createRng(seed), siteUrl, shareImage });
}
