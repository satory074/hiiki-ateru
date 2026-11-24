-- 001: 12球団当て（hiiki-ateru）の答え合わせの集計。xword の Supabase プロジェクトに同居させる（スキーマ hiiki）。
--   適用: オーナーが xword プロジェクトの SQL Editor でこのファイルを流し、続けて supabase/items.sql（npm run items-sql で作る）を流す。
--
-- 誰が何をできるか（変えるときは scripts/sqltest.ts も直す）:
--   通す  誰でも（anon・authenticated） public.hiiki_record_result(p jsonb): 値を検査して、人数を 1 足すだけ。何も返さない
--   拒否  誰でも                        hiiki スキーマの表（items / result_counts / answer_counts）の直接の読み書き
--                                       （スキーマの使用権そのものを与えない。RLS も有効でポリシーなし）
--   拒否  誰でも                        内部関数 hiiki.team_ids() の実行
--   拒否  値の検査に通らないもの        BAD_INPUT（SQLSTATE 22023）:
--                                       p がオブジェクトでない・4000 バイト超、版が 8 桁の 16 進でない、
--                                       推定・本命が決められた値でない、ほかに好きな球団が 4 つ以上・重複・本命と同じ・
--                                       「贔屓なし／見ない」なのにある、答えが 0 個か 31 個以上・同じ質問が 2 回・
--                                       hiiki.items に無い質問 id・選択肢の番号が範囲外
--   読む  オーナーだけ（service_role）  public.hiiki_export_counts(版): その版の人数の表を返す。scripts/reflect.ts が呼ぶ
--                                       （anon・authenticated は実行できない。キーはオーナーの手元の .env だけ）
--
-- 保存しないもの: 一人ひとりの回答の組、IP、日付より細かい時刻。表には (版, 日, …) ごとの「人数」しか入らない。
-- 防げないこと: 誰でも呼べるので、数の水増しはできる。確率表への反映は手動（reflect.ts が急増を警告し、オーナーが見てから決める）。

create schema if not exists hiiki;
revoke all on schema hiiki from public, anon, authenticated;
grant usage on schema hiiki to service_role;

-- 質問 id と選択肢の数（npm run items-sql が作る supabase/items.sql で入れる。古い版の質問も消さない）
create table if not exists hiiki.items (
  id text primary key,
  n_options smallint not null check (n_options between 2 and 12)
);

-- 当てた結果 × 本当の本命 の人数
create table if not exists hiiki.result_counts (
  v text not null,
  day date not null,
  guess text not null,
  actual_main text not null,
  n integer not null default 0,
  primary key (v, day, guess, actual_main)
);

-- 質問 × 選んだ選択肢 × 本当の本命・ほかに好きな球団（カンマ区切り・並べ替え済み）の人数
create table if not exists hiiki.answer_counts (
  v text not null,
  day date not null,
  item_id text not null,
  answer smallint not null,
  actual_main text not null,
  actual_others text not null,
  n integer not null default 0,
  primary key (v, day, item_id, answer, actual_main, actual_others)
);

alter table hiiki.items enable row level security;
alter table hiiki.result_counts enable row level security;
alter table hiiki.answer_counts enable row level security;
revoke all on all tables in schema hiiki from public, anon, authenticated;
grant select on all tables in schema hiiki to service_role;

-- 現行 12 球団の id（data/teams.yaml と同じ。sqltest が一致を確かめる）
create or replace function hiiki.team_ids()
returns text[]
language sql immutable
set search_path = ''
as $$
  select array['giants', 'tigers', 'dragons', 'baystars', 'carp', 'swallows',
               'hawks', 'fighters', 'buffaloes', 'eagles', 'lions', 'marines']
$$;
revoke all on function hiiki.team_ids() from public, anon, authenticated;

create or replace function public.hiiki_record_result(p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  teams text[] := hiiki.team_ids();
  v_day date := (now() at time zone 'Asia/Tokyo')::date;
  v_ver text;
  v_guess text;
  v_main text;
  v_others text[] := '{}';
  v_x text;
  v_answers jsonb;
  v_e jsonb;
  v_q text;
  v_a int;
  v_n smallint;
  v_seen text[] := '{}';
begin
  if p is null or jsonb_typeof(p) <> 'object' or octet_length(p::text) > 4000 then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'payload';
  end if;

  v_ver := p ->> 'v';
  if v_ver is null or v_ver !~ '^[0-9a-f]{8}$' then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'version';
  end if;

  v_guess := p ->> 'guess';
  if v_guess is null or not (v_guess = any (teams || array['multi', 'neutral', 'none'])) then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'guess';
  end if;

  if jsonb_typeof(p -> 'actual') is distinct from 'object' then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'actual';
  end if;
  v_main := p -> 'actual' ->> 'main';
  if v_main is null or not (v_main = any (teams || array['none', 'nobaseball'])) then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'main';
  end if;
  if jsonb_typeof(p -> 'actual' -> 'others') is distinct from 'array' or jsonb_array_length(p -> 'actual' -> 'others') > 3 then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'others';
  end if;
  for v_e in select * from jsonb_array_elements(p -> 'actual' -> 'others') loop
    v_x := v_e #>> '{}';
    if jsonb_typeof(v_e) <> 'string' or not (v_x = any (teams)) or v_x = v_main or v_x = any (v_others) then
      raise exception 'BAD_INPUT' using errcode = '22023', detail = 'others';
    end if;
    v_others := v_others || v_x;
  end loop;
  if v_main in ('none', 'nobaseball') and cardinality(v_others) > 0 then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'others';
  end if;

  v_answers := p -> 'answers';
  if jsonb_typeof(v_answers) is distinct from 'array' or jsonb_array_length(v_answers) not between 1 and 30 then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'answers';
  end if;
  for v_e in select * from jsonb_array_elements(v_answers) loop
    if jsonb_typeof(v_e) <> 'object' or jsonb_typeof(v_e -> 'q') is distinct from 'string'
       or jsonb_typeof(v_e -> 'a') is distinct from 'number' or (v_e ->> 'a') !~ '^[0-9]{1,2}$' then
      raise exception 'BAD_INPUT' using errcode = '22023', detail = 'answer';
    end if;
    v_q := v_e ->> 'q';
    v_a := (v_e ->> 'a')::int;
    select i.n_options into v_n from hiiki.items i where i.id = v_q;
    if v_n is null or v_a >= v_n or v_q = any (v_seen) then
      raise exception 'BAD_INPUT' using errcode = '22023', detail = 'answer';
    end if;
    v_seen := v_seen || v_q;
  end loop;

  insert into hiiki.result_counts as r (v, day, guess, actual_main, n)
  values (v_ver, v_day, v_guess, v_main, 1)
  on conflict (v, day, guess, actual_main) do update set n = r.n + 1;

  insert into hiiki.answer_counts as c (v, day, item_id, answer, actual_main, actual_others, n)
  select v_ver, v_day, e ->> 'q', (e ->> 'a')::smallint, v_main,
         coalesce(array_to_string((select array_agg(x order by x) from unnest(v_others) x), ','), ''), 1
  from jsonb_array_elements(v_answers) e
  on conflict (v, day, item_id, answer, actual_main, actual_others) do update set n = c.n + 1;
end;
$$;

revoke all on function public.hiiki_record_result(jsonb) from public;
grant execute on function public.hiiki_record_result(jsonb) to anon, authenticated;

-- オーナーだけが呼べる読み出し（scripts/reflect.ts）。hiiki スキーマは API に出していないので、表はこの関数経由でだけ読む
create or replace function public.hiiki_export_counts(p_version text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'result', coalesce((select jsonb_agg(to_jsonb(r)) from hiiki.result_counts r where r.v = p_version), '[]'::jsonb),
    'answers', coalesce((select jsonb_agg(to_jsonb(c)) from hiiki.answer_counts c where c.v = p_version), '[]'::jsonb)
  )
$$;

revoke all on function public.hiiki_export_counts(text) from public, anon, authenticated;
grant execute on function public.hiiki_export_counts(text) to service_role;
