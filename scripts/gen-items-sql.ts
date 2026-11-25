// supabase/items.sql を作る: 答え合わせの関数が「実在する質問 id・選択肢の数」を検査するための一覧。
// あわせて、今の版を hiiki.versions に入れる（002。登録の無い版の答え合わせは受け付けない）。
// 実行: npm run items-sql。質問を足した・変えたら作り直し、xword の Supabase に流す（古い質問・古い版は消さない）。
import fs from "node:fs";
import path from "node:path";
import { ROOT, compileBank, loadSource } from "./lib/source";

export function itemsSql(): string {
  const bank = compileBank(loadSource());
  const rows = bank.items.map((i) => `  ('${i.id.replace(/'/g, "''")}', ${i.options.length})`);
  return [
    `-- 生成物（npm run items-sql）。質問データの版 ${bank.version}・${bank.items.length} 問。手で直さない。`,
    "insert into hiiki.items (id, n_options) values",
    rows.join(",\n"),
    "on conflict (id) do update set n_options = excluded.n_options;",
    "-- この版の答え合わせを受け付ける（002 の hiiki.versions。古い版も消さない）",
    `insert into hiiki.versions (v) values ('${bank.version}') on conflict (v) do nothing;`,
    "",
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = path.join(ROOT, "supabase", "items.sql");
  fs.writeFileSync(out, itemsSql());
  console.log(`[items-sql] supabase/items.sql を書いた`);
}
