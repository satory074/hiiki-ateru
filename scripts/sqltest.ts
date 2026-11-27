// SQL のテスト: PGlite（プロセス内の Postgres）を Supabase に似せて、supabase/migrations/*.sql と items.sql を本物のまま流す。
// 実行: npx tsx scripts/sqltest.ts（Supabase には一切接続しない）。xword/scripts/sqltest.ts と同じ作り。
// 不変条件（001_hiiki.sql 冒頭の「誰が何をできるか」）:
//   ①anon が実行できる関数は public.hiiki_record_result だけ（xword の関数は別のマイグレーションなのでここには無い）
//   ②anon・authenticated は hiiki の表を読めず書けず、内部関数も呼べない
//   ③正しい答え合わせは、人数を 1 ずつ足すだけ（同じものをもう一度送ると行は増えず n が 2 になる）
//   ④検査に通らないものは BAD_INPUT（22023）で、何も足さない
//   ⑤表の列は決めたものだけ（一人ひとりの回答・IP・時刻の列が無い）
//   ⑥SQL の球団一覧が data/teams.yaml と一致し、items.sql が質問データ全部を入れる
//   ⑦読み出しの hiiki_export_counts は service_role だけが呼べ、その版の人数だけを返す
//   ⑧受け付けるのは hiiki.versions にある版だけ（items.sql が今の版を入れる。テスト用の 00000000 と最初の版 fec2bdc9 は 002 が入れる）
//   ⑨その版・その日の行か、集計の表の大きさが hiiki.limits を超えたら、何も足さずに終わる（エラーにしない）
//   ⑩見始めた年代（003）: 当てた年代・本当の年代は決めた値だけ。無くても通り（古い版の画面）、'' として数える。
//     見ないと当てた・見ないと答えたのに年代があるものは拒否。SQL の年代の一覧が src/lib/types.ts の ERA_IDS と同じ
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { ROOT, compileBank, loadSource } from "./lib/source";
import { ERA_IDS } from "../src/lib/types";
import { itemsSql } from "./gen-items-sql";

const MIGRATIONS = path.join(ROOT, "supabase", "migrations");
const DENIED = "42501";
const BAD = "22023";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`❌ FAILED: ${msg}`);
    process.exit(1);
  }
}

// Supabase のうち、権限の検査が依存する最小限（public の表・関数に anon / authenticated の全権限を既定で付ける）
const SUPABASE_STUB = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`;

const db = new PGlite();
await db.exec(SUPABASE_STUB);
for (const f of fs.readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort())
  await db.exec(fs.readFileSync(path.join(MIGRATIONS, f), "utf8"));
await db.exec(itemsSql());

const src = loadSource();
const bank = compileBank(src);

async function as<T = unknown>(role: string, sql: string, params: unknown[] = []): Promise<T[]> {
  await db.exec(`set role ${role}`);
  try {
    return (await db.query<T>(sql, params)).rows;
  } finally {
    await db.exec("reset role");
  }
}
async function failure(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? "unknown";
  }
}
const record = (role: string, p: unknown) => as(role, "select public.hiiki_record_result($1::jsonb)", [JSON.stringify(p)]);
const total = async (table: string) =>
  Number((await db.query<{ n: number }>(`select coalesce(sum(n), 0)::int as n from hiiki.${table}`)).rows[0]!.n);
const rows = async (table: string) => Number((await db.query<{ n: number }>(`select count(*)::int as n from hiiki.${table}`)).rows[0]!.n);

// ① anon が実行できる関数
const fns = await db.query<{ fn: string }>(`
  select n.nspname || '.' || p.proname as fn
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_%'
    and has_function_privilege('anon', p.oid, 'execute')`);
assert(
  JSON.stringify(fns.rows.map((r) => r.fn).sort()) === JSON.stringify(["public.hiiki_record_result"]),
  `① anon が実行できる関数は hiiki_record_result だけ（今: ${fns.rows.map((r) => r.fn).join(", ")}）`,
);

// ② 表と内部関数
for (const role of ["anon", "authenticated"]) {
  for (const t of ["items", "result_counts", "answer_counts", "versions", "limits"]) {
    assert((await failure(as(role, `select * from hiiki.${t}`))) === DENIED, `② ${role} は hiiki.${t} を読めない`);
    assert((await failure(as(role, `delete from hiiki.${t}`))) === DENIED, `② ${role} は hiiki.${t} を消せない`);
  }
  assert(
    (await failure(as(role, "insert into hiiki.result_counts values ('00000000', current_date, 'carp', 'carp', 999)"))) === DENIED,
    `② ${role} は人数を直接書けない`,
  );
  assert((await failure(as(role, "select hiiki.team_ids()"))) === DENIED, `② ${role} は内部関数を呼べない`);
  assert((await failure(as(role, "select hiiki.era_ids()"))) === DENIED, `② ${role} は内部関数 era_ids を呼べない`);
}
const grants = await db.query<{ n: number }>(`
  select count(*)::int as n from information_schema.role_table_grants
  where grantee in ('anon', 'authenticated') and table_schema in ('public', 'hiiki')`);
assert(grants.rows[0]!.n === 0, "② anon・authenticated に表の権限が 1 つも無い");

// ③ 正しい答え合わせ
const item = (id: string) => bank.items.find((i) => i.id === id)!;
const someIds = bank.items.slice(0, 3).map((i) => i.id);
const good = {
  v: bank.version,
  guess: "carp",
  actual: { main: "carp", others: ["swallows", "hawks"] },
  answers: someIds.map((q) => ({ q, a: item(q).options.length - 1 })),
};
await record("anon", good);
assert((await total("result_counts")) === 1, "③ 結果の人数が 1 になる");
assert((await total("answer_counts")) === someIds.length, "③ 答えの人数が質問の数だけ足される");
const rowsBefore = await rows("answer_counts");
await record("authenticated", good);
assert((await rows("answer_counts")) === rowsBefore && (await total("result_counts")) === 2, "③ 同じものを送ると行は増えず人数が 2 になる");
const others = await db.query<{ o: string }>("select distinct actual_others as o from hiiki.answer_counts");
assert(others.rows.length === 1 && others.rows[0]!.o === "hawks,swallows", "③ ほかに好きな球団は並べ替えて 1 つの文字列にする");
await record("anon", { ...good, guess: "neutral", actual: { main: "none", others: [] } });
assert((await total("result_counts")) === 3, "③ 贔屓なしの答え合わせも通る");

// ④ 検査に通らないもの
const before = [await total("result_counts"), await total("answer_counts")];
const bads: [string, unknown][] = [
  ["オブジェクトでない", [1, 2]],
  ["版が不正", { ...good, v: "xyz" }],
  ["推定が不正", { ...good, guess: "kintetsu" }],
  ["本命が不正", { ...good, actual: { main: "tokyo", others: [] } }],
  ["ほかに好きな球団が不正", { ...good, actual: { main: "carp", others: ["yokohama"] } }],
  ["ほかに好きな球団に本命", { ...good, actual: { main: "carp", others: ["carp"] } }],
  ["ほかに好きな球団が重複", { ...good, actual: { main: "carp", others: ["hawks", "hawks"] } }],
  ["ほかに好きな球団が 4 つ", { ...good, actual: { main: "carp", others: ["hawks", "lions", "eagles", "marines"] } }],
  ["贔屓なしなのにほかがある", { ...good, actual: { main: "none", others: ["hawks"] } }],
  ["答えが 0 個", { ...good, answers: [] }],
  ["答えが 41 個", { ...good, answers: Array.from({ length: 41 }, (_, i) => ({ q: bank.items[i]!.id, a: 0 })) }],
  ["同じ質問が 2 回", { ...good, answers: [{ q: someIds[0], a: 0 }, { q: someIds[0], a: 1 }] }],
  ["無い質問 id", { ...good, answers: [{ q: "no-such-item", a: 0 }] }],
  ["選択肢の番号が範囲外", { ...good, answers: [{ q: someIds[0], a: item(someIds[0]!).options.length }] }],
  ["選択肢の番号が負", { ...good, answers: [{ q: someIds[0], a: -1 }] }],
  ["選択肢の番号が小数", { ...good, answers: [{ q: someIds[0], a: 0.5 }] }],
  ["選択肢の番号が文字", { ...good, answers: [{ q: someIds[0], a: "0" }] }],
  ["大きすぎる", { ...good, pad: "x".repeat(5000) }],
  ["当てた年代が不正", { ...good, guess_era: "1980" }],
  ["当てた年代が数", { ...good, guess_era: 2000 }],
  ["当てた年代が null", { ...good, guess_era: null }],
  ["見ないと当てたのに年代", { ...good, guess: "none", guess_era: "2000" }],
  ["本当の年代が不正", { ...good, actual: { ...good.actual, era: "1980s" } }],
  ["本当の年代が数", { ...good, actual: { ...good.actual, era: 2010 } }],
  ["見ないと答えたのに年代", { ...good, actual: { main: "nobaseball", others: [], era: "unknown" } }],
];
for (const [name, p] of bads) assert((await failure(record("anon", p))) === BAD, `④ ${name} は BAD_INPUT`);
assert((await failure(as("anon", "select public.hiiki_record_result(null)"))) === BAD, "④ null は BAD_INPUT");
assert(
  (await total("result_counts")) === before[0] && (await total("answer_counts")) === before[1],
  "④ 拒否されたものは何も足さない",
);

// ⑩ 見始めた年代
{
  const eraRow = async (ge: string, ae: string) =>
    Number((await db.query<{ n: number }>("select coalesce(sum(n), 0)::int as n from hiiki.result_counts where guess_era = $1 and actual_era = $2", [ge, ae])).rows[0]!.n);
  const withEra = { ...good, guess_era: "2000", actual: { ...good.actual, era: "2010" } };
  await record("anon", withEra);
  await record("anon", withEra);
  assert((await eraRow("2000", "2010")) === 2, "⑩ 年代つきの答え合わせは、当てた年代・本当の年代ごとに数える（同じものは n=2）");
  const ansEra = await db.query<{ n: number }>("select coalesce(sum(n), 0)::int as n from hiiki.answer_counts where actual_era = '2010'");
  assert(ansEra.rows[0]!.n === 2 * someIds.length, "⑩ 質問の答えも本当の年代ごとに数える");
  await record("anon", { ...good, actual: { ...good.actual, era: "unknown" } });
  assert((await eraRow("", "unknown")) === 1, "⑩ 覚えていない（unknown）も通り、当てた年代が無ければ '' で数える");
  assert((await eraRow("", "")) >= 3, "⑩ 年代の無い古い形（③）は '' で数える");
  await record("anon", { ...good, guess: "none", actual: { main: "nobaseball", others: [] } });
  assert((await eraRow("", "")) >= 4, "⑩ 見ないと当てて、見ないと答えた人は年代なしで通る");
  const sqlEras = (await db.query<{ t: string[] }>("select hiiki.era_ids() as t")).rows[0]!.t;
  assert(JSON.stringify(sqlEras) === JSON.stringify(ERA_IDS), "⑩ SQL の年代の一覧が ERA_IDS と同じ並び");
}

// ⑤ 表の列
const cols = await db.query<{ t: string; c: string }>(`
  select table_name as t, column_name as c from information_schema.columns where table_schema = 'hiiki' order by 1, ordinal_position`);
const got = cols.rows.map((r) => `${r.t}.${r.c}`).join(" ");
assert(
  got ===
    "answer_counts.v answer_counts.day answer_counts.item_id answer_counts.answer answer_counts.actual_main answer_counts.actual_others answer_counts.n answer_counts.actual_era " +
      "items.id items.n_options " +
      "limits.id limits.day_rows limits.total_bytes " +
      "result_counts.v result_counts.day result_counts.guess result_counts.actual_main result_counts.n result_counts.guess_era result_counts.actual_era " +
      "versions.v versions.added",
  `⑤ 表の列は決めたものだけ（今: ${got}）`,
);

// ⑥ 球団一覧と質問一覧
const sqlTeams = (await db.query<{ t: string[] }>("select hiiki.team_ids() as t")).rows[0]!.t;
assert(JSON.stringify(sqlTeams) === JSON.stringify(src.teams.map((t) => t.id)), "⑥ SQL の球団一覧が data/teams.yaml と同じ並び");
assert((await rows("items")) === bank.items.length, "⑥ items.sql が質問データ全部を入れる");
const shipped = path.join(ROOT, "supabase", "items.sql");
assert(
  fs.existsSync(shipped) && fs.readFileSync(shipped, "utf8") === itemsSql(),
  "⑥ supabase/items.sql が今の質問データと同じ（質問を変えたら npm run items-sql で作り直し、オーナーが流し直す）",
);

// ⑦ 読み出し
for (const role of ["anon", "authenticated"])
  assert((await failure(as(role, "select public.hiiki_export_counts($1)", [bank.version]))) === DENIED, `⑦ ${role} は読み出せない`);
const exported = (await as<{ r: { result: { n: number }[]; answers: unknown[] } }>("service_role", "select public.hiiki_export_counts($1) as r", [bank.version]))[0]!.r;
assert(exported.result.reduce((a, r) => a + r.n, 0) === (await total("result_counts")), "⑦ service_role は人数の表を読める");
const other = (await as<{ r: { result: unknown[] } }>("service_role", "select public.hiiki_export_counts('ffffffff') as r"))[0]!.r;
assert(other.result.length === 0, "⑦ 別の版の数は混ざらない");

// ⑧ 登録の無い版は受け付けない（形が正しくても）
{
  const before8 = [await total("result_counts"), await total("answer_counts")];
  assert((await failure(record("anon", { ...good, v: "abcdef01" }))) === BAD, "⑧ 登録の無い版は BAD_INPUT");
  for (const v of ["00000000", "fec2bdc9", bank.version])
    assert((await db.query("select 1 from hiiki.versions where v = $1", [v])).rows.length === 1, `⑧ 版 ${v} が登録されている`);
  assert((await total("result_counts")) === before8[0] && (await total("answer_counts")) === before8[1], "⑧ 拒否された版は何も足さない");
}

// ⑨ 上限を超えたら何も足さない（上限を小さくして試し、元に戻す）
{
  const test = { ...good, v: "00000000" };
  await db.exec("update hiiki.limits set day_rows = 1");
  await record("anon", test); // その版・その日の行が 0 → 足す
  const r1 = [await total("result_counts"), await total("answer_counts")];
  await record("anon", test); // 上限に達している → 何も足さない
  assert((await total("result_counts")) === r1[0] && (await total("answer_counts")) === r1[1], "⑨ その日の行が上限なら何も足さない（エラーにもしない）");
  await db.exec("update hiiki.limits set day_rows = 50000, total_bytes = 1");
  await record("anon", test);
  assert((await total("result_counts")) === r1[0] && (await total("answer_counts")) === r1[1], "⑨ 表の大きさが上限なら何も足さない");
  await db.exec("update hiiki.limits set total_bytes = 157286400");
  await record("anon", test);
  assert((await total("result_counts")) === r1[0]! + 1, "⑨ 上限を戻せば、また足す");
  const lim = (await db.query<{ d: number; b: string }>("select day_rows as d, total_bytes::text as b from hiiki.limits")).rows;
  assert(lim.length === 1 && lim[0]!.d === 50000 && lim[0]!.b === "157286400", "⑨ hiiki.limits は 1 行で、既定は 5万行・150MB");
}

console.log(`✅ sqltest: 権限・検査・集計の不変条件を満たした（拒否の例 ${bads.length + 1} 件）`);
