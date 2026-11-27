-- 003: 答え合わせに「見始めた年代」を足す（2026-11-27）。001・002 のあとに流す。
--   なぜ: 見始めた年代（1990年代以前／2000年代／2010年代／2020年代）も当てるようにしたので、
--   当てた年代と本当の年代を数え、年代の当たり方と確率表を直す材料にする。
--   適用: Supabase MCP でマイグレーション hiiki_003_era として流し、続けて supabase/items.sql（今の版を hiiki.versions に入れる）を流す。
--
-- 誰が何をできるか（002 からの変更点。変えるときは scripts/sqltest.ts も直す）:
--   通す  誰でも  public.hiiki_record_result(p): 002 と同じ検査に加えて、次の 2 つを受け取る。どちらも無くてよい
--                 （年代を送らない古い版の画面からも、これまでどおり送れる。無ければ '' として数える）
--                   p.guess_era      当てた年代   '1990' / '2000' / '2010' / '2020'
--                   p.actual.era     本当の年代   上の 4 つか 'unknown'（覚えていない）
--   拒否  誰でも  BAD_INPUT（22023）: 上の値以外・文字列でない値、
--                 当てた結果が none（見ない）なのに guess_era がある、本当の答えが nobaseball（見ない）なのに actual.era がある
--   拒否  誰でも  内部関数 hiiki.era_ids() の実行（hiiki.team_ids() と同じく revoke）
--   変える        答えの数の上限を 30 個 → 40 個（問数の上限を 40 問にしたため。41 個以上は BAD_INPUT のまま）
--   変えない      表の直接の読み書きの拒否・RLS・読み出し関数（service_role だけ。新しい列も to_jsonb でそのまま出る）・上限（002）
--
-- 保存しないもの（001 から変わらない）: 一人ひとりの回答の組、IP、日付より細かい時刻。表には (版, 日, …) ごとの「人数」しか入らない。

create or replace function hiiki.era_ids()
returns text[]
language sql immutable
set search_path = ''
as $$
  select array['1990', '2000', '2010', '2020']
$$;
revoke all on function hiiki.era_ids() from public, anon, authenticated;

-- 当てた年代・本当の年代の列。'' は「年代なし」（見ない人・年代を送らない古い版）
alter table hiiki.result_counts add column if not exists guess_era text not null default '';
alter table hiiki.result_counts add column if not exists actual_era text not null default '';
alter table hiiki.answer_counts add column if not exists actual_era text not null default '';

-- 主キーに新しい列を入れ直す（同じ年代どうしの人数を 1 行にまとめるため）
alter table hiiki.result_counts drop constraint if exists result_counts_pkey;
alter table hiiki.result_counts add primary key (v, day, guess, actual_main, guess_era, actual_era);
alter table hiiki.answer_counts drop constraint if exists answer_counts_pkey;
alter table hiiki.answer_counts add primary key (v, day, item_id, answer, actual_main, actual_others, actual_era);

create or replace function public.hiiki_record_result(p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  teams text[] := hiiki.team_ids();
  eras text[] := hiiki.era_ids();
  v_day date := (now() at time zone 'Asia/Tokyo')::date;
  v_ver text;
  v_guess text;
  v_guess_era text := '';
  v_main text;
  v_actual_era text := '';
  v_others text[] := '{}';
  v_x text;
  v_answers jsonb;
  v_e jsonb;
  v_q text;
  v_a int;
  v_n smallint;
  v_seen text[] := '{}';
  v_day_rows int;
  v_total_bytes bigint;
begin
  if p is null or jsonb_typeof(p) <> 'object' or octet_length(p::text) > 4000 then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'payload';
  end if;

  v_ver := p ->> 'v';
  if v_ver is null or v_ver !~ '^[0-9a-f]{8}$' or not exists (select 1 from hiiki.versions x where x.v = v_ver) then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'version';
  end if;

  v_guess := p ->> 'guess';
  if v_guess is null or not (v_guess = any (teams || array['multi', 'neutral', 'none'])) then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'guess';
  end if;

  -- 当てた年代（無くてよい。見ないと当てたときは年代を当てていないので、あれば拒否）
  if p ? 'guess_era' then
    if jsonb_typeof(p -> 'guess_era') <> 'string' or not ((p ->> 'guess_era') = any (eras)) or v_guess = 'none' then
      raise exception 'BAD_INPUT' using errcode = '22023', detail = 'guess_era';
    end if;
    v_guess_era := p ->> 'guess_era';
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

  -- 本当の年代（無くてよい。「野球はあまり見ない」と答えた人には聞かないので、あれば拒否）
  if (p -> 'actual') ? 'era' then
    if jsonb_typeof(p -> 'actual' -> 'era') <> 'string' or not ((p -> 'actual' ->> 'era') = any (eras || array['unknown']))
       or v_main = 'nobaseball' then
      raise exception 'BAD_INPUT' using errcode = '22023', detail = 'era';
    end if;
    v_actual_era := p -> 'actual' ->> 'era';
  end if;

  v_answers := p -> 'answers';
  -- 答えの数は 40 個まで（2026-11-28 に問数の上限を 30 → 40 にした。002 までは 30 個）
  if jsonb_typeof(v_answers) is distinct from 'array' or jsonb_array_length(v_answers) not between 1 and 40 then
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

  -- 上限（002 と同じ）: その版・その日の行が多すぎるか、集計の表が大きくなりすぎたら、何も足さずに終わる（エラーにしない）
  select l.day_rows, l.total_bytes into v_day_rows, v_total_bytes from hiiki.limits l;
  if (select count(*) from hiiki.answer_counts c where c.v = v_ver and c.day = v_day) >= v_day_rows
     or pg_catalog.pg_total_relation_size('hiiki.answer_counts'::regclass)
        + pg_catalog.pg_total_relation_size('hiiki.result_counts'::regclass) >= v_total_bytes then
    return;
  end if;

  insert into hiiki.result_counts as r (v, day, guess, actual_main, guess_era, actual_era, n)
  values (v_ver, v_day, v_guess, v_main, v_guess_era, v_actual_era, 1)
  on conflict (v, day, guess, actual_main, guess_era, actual_era) do update set n = r.n + 1;

  insert into hiiki.answer_counts as c (v, day, item_id, answer, actual_main, actual_others, actual_era, n)
  select v_ver, v_day, e ->> 'q', (e ->> 'a')::smallint, v_main,
         coalesce(array_to_string((select array_agg(x order by x) from unnest(v_others) x), ','), ''), v_actual_era, 1
  from jsonb_array_elements(v_answers) e
  on conflict (v, day, item_id, answer, actual_main, actual_others, actual_era) do update set n = c.n + 1;
end;
$$;
revoke all on function public.hiiki_record_result(jsonb) from public;
grant execute on function public.hiiki_record_result(jsonb) to anon, authenticated;
