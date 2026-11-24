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
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { ROOT, compileBank, loadSource } from "./lib/source";
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
  for (const t of ["items", "result_counts", "answer_counts"]) {
    assert((await failure(as(role, `select * from hiiki.${t}`))) === DENIED, `② ${role} は hiiki.${t} を読めない`);
    assert((await failure(as(role, `delete from hiiki.${t}`))) === DENIED, `② ${role} は hiiki.${t} を消せない`);
  }
  assert(
    (await failure(as(role, "insert into hiiki.result_counts values ('00000000', current_date, 'carp', 'carp', 999)"))) === DENIED,
    `② ${role} は人数を直接書けない`,
  );
  assert((await failure(as(role, "select hiiki.team_ids()"))) === DENIED, `② ${role} は内部関数を呼べない`);
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
  ["答えが 31 個", { ...good, answers: Array.from({ length: 31 }, (_, i) => ({ q: bank.items[i % bank.items.length]!.id, a: 0 })) }],
  ["同じ質問が 2 回", { ...good, answers: [{ q: someIds[0], a: 0 }, { q: someIds[0], a: 1 }] }],
  ["無い質問 id", { ...good, answers: [{ q: "no-such-item", a: 0 }] }],
  ["選択肢の番号が範囲外", { ...good, answers: [{ q: someIds[0], a: item(someIds[0]!).options.length }] }],
  ["選択肢の番号が負", { ...good, answers: [{ q: someIds[0], a: -1 }] }],
  ["選択肢の番号が小数", { ...good, answers: [{ q: someIds[0], a: 0.5 }] }],
  ["選択肢の番号が文字", { ...good, answers: [{ q: someIds[0], a: "0" }] }],
  ["大きすぎる", { ...good, pad: "x".repeat(5000) }],
];
for (const [name, p] of bads) assert((await failure(record("anon", p))) === BAD, `④ ${name} は BAD_INPUT`);
assert((await failure(as("anon", "select public.hiiki_record_result(null)"))) === BAD, "④ null は BAD_INPUT");
assert(
  (await total("result_counts")) === before[0] && (await total("answer_counts")) === before[1],
  "④ 拒否されたものは何も足さない",
);

// ⑤ 表の列
const cols = await db.query<{ t: string; c: string }>(`
  select table_name as t, column_name as c from information_schema.columns where table_schema = 'hiiki' order by 1, ordinal_position`);
const got = cols.rows.map((r) => `${r.t}.${r.c}`).join(" ");
assert(
  got ===
    "answer_counts.v answer_counts.day answer_counts.item_id answer_counts.answer answer_counts.actual_main answer_counts.actual_others answer_counts.n " +
      "items.id items.n_options " +
      "result_counts.v result_counts.day result_counts.guess result_counts.actual_main result_counts.n",
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

console.log(`✅ sqltest: 権限・検査・集計の不変条件を満たした（拒否の例 ${bads.length + 1} 件）`);
