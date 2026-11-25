// 質問データの不変条件（壊れたら困ることだけ。件数をテストの成果にはしない）。
// 実行: npm run check（npm test にも入っている）。破ったら exit 1。
//
//   ① 形: id が一意で、build-bank が変換できる
//   ② 各球団の質問（選手・名物・クイズ）が 18〜30 問
//   ③ 架空・暮らし以外の質問に出典 URL がある
//   ④ 質問文・手がかり・選択肢に球団名が出ない（出たら答えがばれる）。からかいの決まり文句（33-4 など）も出ない
//   ほか: 1問目（firstItem）が暮らしの質問にあり、架空の窓（foilWindows）が重ならず、最低問数までに2つ以上ある
//   ⑤ 選手の手がかりが「守備・年代」の形
//   ⑥ 選手の在籍球団が intai-fa の在籍記録と一致する（記録に無い人はオーナー確認に回す）
//   ⑦ 架空の選手名が、intai-fa の名簿のどの人とも一致しない
//   ⑧ 現役（era: current）の選手に、intai-fa の最新年度の戦力外・引退・FA 宣言・ポスティング・
//      ほかの球団へのトレードが無い（古くなった選手を出さない。intai-fa に入っていない球団発表は拾えないので、
//      10〜12月にウェブでも確かめ直す。CLAUDE.md「運用」）
//
// ⑥⑦⑧ は隣の ../intai-fa/data が要る。手元で照合した結果を data/verified.json に書き、
// intai-fa の無い所（GitHub Actions）では「照合の記録が今の内容と一致しているか」だけを見る。
// 選手や架空の名前を変えたら、手元で npm run check を流して verified.json を更新してコミットすること。
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { ROOT, compileBank, loadSource, type RawItem } from "./lib/source";

const errors: string[] = [];
const warnings: string[] = [];
const err = (it: RawItem | null, msg: string) => errors.push(it ? `${it.file} ${it.id}: ${msg}` : msg);
const warn = (it: RawItem, msg: string) => warnings.push(`${it.file} ${it.id}: ${msg}`);

const src = loadSource();
// ① 形
try {
  compileBank(src);
} catch (e) {
  err(null, `① ${(e as Error).message}`);
}

const TEAM_WORDS = [
  ...src.teams.flatMap((t) => [t.name, t.full]),
  "読売", "ジャイアンツ", "タイガース", "ドラゴンズ", "ベイスターズ", "横浜", "カープ", "スワローズ",
  "ホークス", "ファイターズ", "日ハム", "バファローズ", "イーグルス", "ライオンズ", "マリーンズ",
];
const teamIds = new Set(src.teams.map((t) => t.id));
// NFKC でそろえてから比べる（全角の数字も拾う）
const TAUNT_WORDS = ["33-4", "なんでや", "暗黒", "ダメ虎", "身売り", "にわか", "アンチ", "老害", "最下位", "借金", "消滅", "蔑称"];

// 当てる仕組みの数字のうち、質問の出し方の決まり（1問目・架空の窓）
{
  const p = src.params;
  const first = p.firstItem ? src.items.find((i) => i.id === p.firstItem) : undefined;
  if (p.firstItem && first?.kind !== "life") err(null, `firstItem「${p.firstItem}」が暮らしの質問に無い`);
  let prevEnd = 1; // 1問目は firstItem なので、窓は2問目以降
  for (const [a, b] of p.foilWindows ?? []) {
    if (!(Number.isInteger(a) && Number.isInteger(b) && a > prevEnd && a <= b && b <= p.stop.max))
      err(null, `foilWindows の窓 [${a}, ${b}] が不正（前の窓より後ろ・はじめ≦おわり・${p.stop.max} 問以内）`);
    prevEnd = b;
  }
  if (!(p.foilWindows?.length && p.foilWindows.filter(([, b]) => b <= p.stop.min).length >= 2))
    err(null, `最低問数（${p.stop.min}）までに架空が2問入るよう、foilWindows の窓を2つ以上 ${p.stop.min} 問目までに置く`);
}

// ② 各球団の問題数
const perTeam = new Map(src.teams.map((t) => [t.id, 0]));
for (const it of src.items)
  if (it.kind === "player" || it.kind === "culture" || it.kind === "quiz")
    for (const t of it.teams ?? []) if (perTeam.has(t)) perTeam.set(t, perTeam.get(t)! + 1);
for (const [t, n] of perTeam) if (n < 18 || n > 30) err(null, `② ${t} の質問が ${n} 問（18〜30 問にする）`);

for (const it of src.items) {
  // ③ 出典
  if (it.kind !== "foil" && it.kind !== "life" && it.kind !== "league2" && !/^https?:\/\/\S+$/.test(it.source ?? "")) err(it, "③ 出典 URL がない");
  // ④ 球団名と、からかいの決まり文句（球団・ファン・選手を笑うネタは炎上のもと。2026-11-25 に足した）
  const texts = [it.text, it.hint ?? "", ...(it.choices ?? []), ...(it.options ?? [])];
  for (const w of TEAM_WORDS) if (texts.some((s) => s.includes(w))) err(it, `④ 球団名「${w}」が文に出ている`);
  const folded = texts.map((s) => s.normalize("NFKC"));
  for (const w of TAUNT_WORDS) if (folded.some((s) => s.includes(w))) err(it, `④ からかいの決まり文句「${w}」が文に出ている`);
  // ⑤ 選手の手がかり
  if (it.kind === "player" && !/^(投手|捕手|内野手|外野手)・\S*年代$/.test(it.hint ?? ""))
    err(it, `⑤ 手がかりは「投手・2010年代」の形（今: ${it.hint ?? "なし"}）`);
  if (it.kind === "player" && it.era !== "current" && it.era !== "ob") err(it, "⑤ era は current か ob");
  if (it.text.length > 40) err(it, "文が長すぎる（40 文字まで）");
  for (const t of it.teams ?? []) if (!teamIds.has(t)) err(it, `球団 id が不正: ${t}`);
}

// ⑥⑦ intai-fa との照合
const VERIFIED = path.join(ROOT, "data", "verified.json");
const INTAI = path.resolve(ROOT, "..", "intai-fa", "data");
type Verified = Record<string, { key: string; by: "intai-fa" | "owner" | "absent" }>;
const fold = (s: string) => s.normalize("NFKC").replace(/\s+/g, "");
const keyOf = (it: RawItem) => `${fold(it.text)}|${[...(it.teams ?? [])].sort().join(",")}`;
const players = src.items.filter((i) => i.kind === "player");
const foils = src.items.filter((i) => i.kind === "foil" && i.look !== "culture");

// HIIKI_SKIP_INTAI=1 で、intai-fa の無い所（CI）と同じ確かめ方を手元でも試せる
if (!process.env.HIIKI_SKIP_INTAI && fs.existsSync(path.join(INTAI, "people.jsonl"))) {
  const readJsonl = <T>(f: string): T[] =>
    fs.existsSync(path.join(INTAI, f))
      ? fs.readFileSync(path.join(INTAI, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T)
      : [];
  type Person = { id: string; name: string; names?: { name: string }[] };
  type Stint = { person: string; franchise: string; from: number; to?: number; role: string };
  const people = [...readJsonl<Person>("people.jsonl"), ...readJsonl<Person>("people-extra.jsonl")];
  const byName = new Map<string, Person[]>();
  for (const p of people)
    // 改名の履歴に今の名前が重なっていることがあるので、同じ人は 1 回だけ数える
    for (const k of new Set([p.name, ...(p.names ?? []).map((x) => x.name)].map(fold))) {
      const list = byName.get(k) ?? [];
      if (!list.some((q) => q.id === p.id)) byName.set(k, [...list, p]);
    }
  const stints = new Map<string, Stint[]>();
  for (const s of readJsonl<Stint>("stints.jsonl"))
    if (s.role === "player" || s.role === "ikusei") stints.set(s.person, [...(stints.get(s.person) ?? []), s]);

  // ⑧ 用: intai-fa の最新年度の出来事（NPB 公示と、球団発表の下書き）
  type Ev = { id: string; season: number; date?: string; type: string; person: string; team?: string; toTeam?: string };
  const evDir = path.join(INTAI, "events");
  const season = Math.max(
    ...fs.readdirSync(path.join(evDir, "npb")).map((f) => Number(f.replace(/\.json$/, ""))).filter(Number.isFinite),
  );
  const evs: Ev[] = [];
  const npbFile = path.join(evDir, "npb", `${season}.json`);
  const manualFile = path.join(evDir, "manual", `${season}.yaml`);
  if (fs.existsSync(npbFile)) evs.push(...(JSON.parse(fs.readFileSync(npbFile, "utf8")) as Ev[]));
  if (fs.existsSync(manualFile)) evs.push(...((YAML.parse(fs.readFileSync(manualFile, "utf8")) as Ev[] | null) ?? []));
  const STALE = new Set(["release", "retire", "voluntary_retired", "fa_declare", "posting", "ikusei_recontract", "trade"]);
  const staleByPerson = new Map<string, Ev[]>();
  for (const e of evs)
    if (e.season === season && STALE.has(e.type)) staleByPerson.set(e.person, [...(staleByPerson.get(e.person) ?? []), e]);

  const verified: Verified = {};
  for (const it of players) {
    const cands = byName.get(fold(it.text)) ?? [];
    // 同姓同名は、主張した球団に全部在籍している人だけに絞る
    const matches = cands.filter((p) => (it.teams ?? []).every((t) => (stints.get(p.id) ?? []).some((s) => s.franchise === t)));
    if (matches.length === 1) {
      const p = matches[0]!;
      const played = new Set((stints.get(p.id) ?? []).map((s) => s.franchise).filter((f) => teamIds.has(f)));
      const missing = [...played].filter((f) => !(it.teams ?? []).includes(f));
      if (missing.length) err(it, `⑥ 在籍した球団 ${missing.join(",")} が teams に無い（移籍先も全部書く）`);
      const last = Math.max(...(stints.get(p.id) ?? []).map((s) => s.to ?? 9999));
      if (it.era === "current" && last < 2025) warn(it, `current だが intai-fa の在籍は ${last} 年まで`);
      if (it.era === "current")
        for (const e of staleByPerson.get(p.id) ?? []) {
          // 載っている球団へのトレードなら teams に入っているので古くない
          if (e.type === "trade" && e.toTeam && (it.teams ?? []).includes(e.toTeam)) continue;
          err(it, `⑧ 現役だが ${season} 年に ${e.type}${e.date ? `（${e.date}）` : ""}。外すか era: ob に（intai-fa: ${e.id}）`);
        }
      verified[it.id] = { key: keyOf(it), by: "intai-fa" };
    } else if (matches.length > 1) {
      err(it, `⑥ 同姓同名が ${matches.length} 人いて決められない（${matches.map((p) => p.id).join(",")}）`);
    } else if (cands.length > 0) {
      err(it, `⑥ 名簿に同じ名前の人はいるが、${(it.teams ?? []).join(",")} の在籍記録が無い`);
    } else if (it.check === "owner" || it.check === "ok") {
      // 2026 年の新人など、名簿（2025 年まで）に載っていない人
      verified[it.id] = { key: keyOf(it), by: "owner" };
      if (it.check === "owner") warn(it, "名簿に無い（2026 年の新人など）。オーナー確認待ち");
    } else {
      err(it, "⑥ intai-fa の名簿に見つからない（表記を確かめるか、2026 年の新人なら check: owner）");
    }
  }
  for (const it of foils) {
    if ((byName.get(fold(it.text)) ?? []).length > 0) err(it, "⑦ 架空の選手名が実在の人と一致する");
    else verified[it.id] = { key: keyOf(it), by: "absent" };
  }
  if (errors.length === 0) {
    const sorted = Object.fromEntries(Object.entries(verified).sort(([a], [b]) => a.localeCompare(b)));
    fs.writeFileSync(VERIFIED, JSON.stringify(sorted, null, 2) + "\n");
    console.log(`[check] intai-fa と照合し data/verified.json を更新（${Object.keys(verified).length} 件）`);
  }
} else {
  // intai-fa の無い所: 手元で照合した記録が、今の選手・架空の内容と一致しているかだけを見る
  const verified: Verified = fs.existsSync(VERIFIED) ? JSON.parse(fs.readFileSync(VERIFIED, "utf8")) : {};
  for (const it of [...players, ...foils])
    if (verified[it.id]?.key !== keyOf(it)) err(it, "⑥⑦ 照合の記録が無いか古い（手元で npm run check を流して data/verified.json を更新）");
  console.log("[check] ../intai-fa が無いので、data/verified.json の記録と突き合わせた");
}

const pending = src.items.filter((i) => i.check === "owner").length;
for (const w of warnings) console.warn(`⚠️  ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`❌ ${e}`);
  console.error(`[check] ${errors.length} 件の違反`);
  process.exit(1);
}
console.log(
  `[check] OK: ${src.items.length} 問（球団ごと ${[...perTeam].map(([t, n]) => `${t}:${n}`).join(" ")}）。オーナー確認待ち ${pending} 問`,
);
