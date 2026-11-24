// オーナーが確かめる質問の一覧を出す（Markdown のチェックリスト）。実行: npm run review -- --team=carp [--random=30] [--seed=1]
//   --team の球団の質問は全部、それ以外の「オーナー確認待ち（check: owner）」からは --random 問を無作為に選ぶ。
//   確かめたら、その質問の check を ok に変える（違っていたら直すか消す）。出力は review.md にも書く（コミットしない）。
import fs from "node:fs";
import path from "node:path";
import { ROOT, loadSource, type RawItem } from "./lib/source";
import { createRng } from "../src/lib/rng";

const args = process.argv.slice(2);
const opt = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const team = opt("team");
const nRandom = Number(opt("random") ?? 30);
const rng = createRng(Number(opt("seed") ?? 1));
const { items, teams } = loadSource();
if (team && !teams.some((t) => t.id === team)) {
  console.error(`--team は ${teams.map((t) => t.id).join(" / ")} のどれか`);
  process.exit(2);
}
const name = (id: string) => teams.find((t) => t.id === id)?.name ?? id;
const own = items.filter((i) => team && i.teams?.includes(team));
const pool = items.filter((i) => i.check === "owner" && !own.includes(i));
const picked: RawItem[] = [];
while (picked.length < Math.min(nRandom, pool.length)) {
  const i = pool.splice(Math.floor(rng() * pool.length), 1)[0]!;
  picked.push(i);
}
const line = (i: RawItem) => {
  const what = i.kind === "quiz" ? `${i.text} → 正解「${i.choices![i.answer!]}」（${i.choices!.join("／")}）` : `${i.text}${i.hint ? `（${i.hint}）` : ""}`;
  return `- [ ] **${(i.teams ?? []).map(name).join("・")}** ${what} — 知名度 ${i.tier ?? "C"}${i.era ? `・${i.era}` : ""}\n  - 出典: ${i.source ?? "なし"}\n  - ${i.file} \`${i.id}\`（今の check: ${i.check ?? "なし"}）${i.note ? `\n  - メモ: ${i.note}` : ""}`;
};
const md = [
  `# 質問の確認リスト（${new Date().toISOString().slice(0, 10)}）`,
  "",
  "事実が合っているか、その球団のファンなら知っていそうか（知名度 B＝野球好きなら名前は知っている／C＝その球団のファンでないとまず知らない）を見る。",
  "合っていたら YAML の `check:` を `ok` に、違っていたら直すか消す。",
  "",
  ...(team ? [`## ${name(team)}の質問（全部・${own.length}問）`, "", ...own.map(line), ""] : []),
  `## ほかの球団の確認待ちから無作為に ${picked.length} 問`,
  "",
  ...picked.map(line),
  "",
].join("\n");
fs.writeFileSync(path.join(ROOT, "review.md"), md);
console.log(md);
