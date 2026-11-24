// @ts-check
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

// GitHub Pages のプロジェクトページ（https://satory074.github.io/hiiki-ateru/）。
export default defineConfig({
  site: "https://satory074.github.io",
  base: "/hiiki-ateru",
  trailingSlash: "always",
  build: { format: "directory" },
  // 結果ページ（/result/）はシェアのカード用で noindex なのでサイトマップに載せない
  integrations: [sitemap({ filter: (page) => !page.includes("/404") && !page.includes("/result/") })],
});
