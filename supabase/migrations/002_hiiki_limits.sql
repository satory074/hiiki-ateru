-- 002: 答え合わせの集計に「受け付ける版」と「上限」を足す（2026-11-25）。001 のあとに流す。
--   なぜ: 001 は版を「16 進 8 桁なら何でも」受け付けたので、版を変えて送り続けると行がいくらでも増えた。
--   同じ Supabase プロジェクトの xword まで、無料枠の超過（API が 402 で止まる）に巻き込みうる。
--   適用: Supabase MCP でマイグレーション hiiki_002_limits として流し、続けて supabase/items.sql（今の版を hiiki.versions に入れる）を流す（2026-11-25 適用済み）。
--
-- 誰が何をできるか（001 からの変更点。変えるときは scripts/sqltest.ts も直す）:
--   通す  誰でも  public.hiiki_record_result(p): 001 と同じ検査に加えて、版が hiiki.versions にあること。
--                 ただし、その版・その日の answer_counts が hiiki.limits.day_rows 行（5万）以上か、
--                 集計の表（answer_counts と result_counts）が hiiki.limits.total_bytes（150MB）以上なら、何も足さずに終わる
--   拒否  誰でも  hiiki.versions にない版 → BAD_INPUT（22023）
--   拒否  誰でも  hiiki.versions・hiiki.limits の直接の読み書き（001 と同じく、hiiki スキーマの使用権そのものが無い）
--   変える オーナーだけ  上限の値は SQL Editor か MCP で hiiki.limits を update する

-- 受け付ける版。今の版は supabase/items.sql が入れる。古い版も消さない（キャッシュに残った画面から送られることがある）
create table if not exists hiiki.versions (
  v text primary key check (v ~ '^[0-9a-f]{8}$'),
  added date not null default current_date
);
-- 00000000 は npm run live-check のテスト用（本物の集計とは版で分かれる）。fec2bdc9 は 2026-11-25 まで公開していた最初の版
insert into hiiki.versions (v) values ('00000000'), ('fec2bdc9') on conflict (v) do nothing;

-- 上限（1 行だけ）。5万行は、正しい答え合わせなら 1 日に数千人ぶん。150MB は無料枠 500MB の 3 割
create table if not exists hiiki.limits (
  id boolean primary key default true check (id),
  day_rows integer not null default 50000 check (day_rows > 0),
  total_bytes bigint not null default 157286400 check (total_bytes > 0)
);
insert into hiiki.limits default values on conflict (id) do nothing;

alter table hiiki.versions enable row level security;
alter table hiiki.limits enable row level security;
revoke all on hiiki.versions, hiiki.limits from public, anon, authenticated;
grant select on hiiki.versions, hiiki.limits to service_role;

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

  -- 上限: その版・その日の行が多すぎるか、集計の表が大きくなりすぎたら、何も足さずに終わる（エラーにしない）。
  -- 同じプロジェクトの xword を無料枠の超過（API が 402 で止まる）から守るため。送る側はもともと結果を気にしない
  select l.day_rows, l.total_bytes into v_day_rows, v_total_bytes from hiiki.limits l;
  if (select count(*) from hiiki.answer_counts c where c.v = v_ver and c.day = v_day) >= v_day_rows
     or pg_catalog.pg_total_relation_size('hiiki.answer_counts'::regclass)
        + pg_catalog.pg_total_relation_size('hiiki.result_counts'::regclass) >= v_total_bytes then
    return;
  end if;

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
