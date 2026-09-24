-- Behaviour check for supabase/migrations/20260922120000_card_open_history.sql
--
-- Needs a local PostgreSQL (not part of the browser QA workflow, which has no database):
--   createdb kartochka_check
--   psql -d kartochka_check -v ON_ERROR_STOP=1 -f tests/sql/open-history-check.sql
--
-- Proves the four properties the sync layer depends on:
--   1. a user can only stamp their OWN cards;
--   2. a deleted card accepts no open history;
--   3. `revision` is never touched, so an open cannot collide with an edit;
--   4. history only moves forward, and a future client clock is rejected.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
end $$;

create schema if not exists auth;
create table if not exists auth.users (id uuid primary key);
create or replace function auth.uid() returns uuid language sql stable
  as $f$ select nullif(current_setting('test.uid', true), '')::uuid $f$;

create table if not exists public.telegram_accounts (
  telegram_user_id bigint primary key,
  user_id uuid not null unique references auth.users(id) on delete cascade);
create table if not exists public.telegram_test_cards (
  user_id uuid not null references auth.users(id) on delete cascade, id uuid not null,
  store text not null, number text not null, color_a text not null, color_b text not null,
  text_color text not null default '#fff', last_used bigint not null default 0,
  format text not null default 'code_128', code_image text,
  revision bigint not null default 1, deleted_at timestamptz,
  updated_at timestamptz not null default now(), primary key (user_id, id));

\i supabase/migrations/20260922120000_card_open_history.sql

insert into auth.users values
  ('11111111-1111-1111-1111-111111111111'), ('22222222-2222-2222-2222-222222222222');
insert into public.telegram_accounts values
  (111, '11111111-1111-1111-1111-111111111111'), (222, '22222222-2222-2222-2222-222222222222');
insert into public.telegram_test_cards (user_id, id, store, number, color_a, color_b, revision) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000001', 'Alice card', 'A1', '#1', '#2', 7),
  ('22222222-2222-2222-2222-222222222222', 'bbbbbbbb-0000-4000-8000-000000000002', 'Bob card',   'B1', '#1', '#2', 3),
  ('11111111-1111-1111-1111-111111111111', 'cccccccc-0000-4000-8000-000000000003', 'Deleted',    'C1', '#1', '#2', 2);
update public.telegram_test_cards set deleted_at = now()
 where id = 'cccccccc-0000-4000-8000-000000000003';

set test.uid = '11111111-1111-1111-1111-111111111111';

do $$
declare
  v_applied jsonb;
  v_row record;
begin
  -- Alice submits opens for her own card, Bob's card and a deleted card at once.
  v_applied := public.record_telegram_test_card_opens(
    '[{"id":"aaaaaaaa-0000-4000-8000-000000000001","at":5000},
      {"id":"bbbbbbbb-0000-4000-8000-000000000002","at":5000},
      {"id":"cccccccc-0000-4000-8000-000000000003","at":5000}]'::jsonb);
  if v_applied <> '["aaaaaaaa-0000-4000-8000-000000000001"]'::jsonb then
    raise exception 'expected only Alice''s own card to be stamped, got %', v_applied;
  end if;

  select * into v_row from public.telegram_test_cards where store = 'Bob card';
  if v_row.last_opened_at <> 0 then raise exception 'another account''s card was stamped'; end if;
  select * into v_row from public.telegram_test_cards where store = 'Deleted';
  if v_row.last_opened_at <> 0 then raise exception 'a deleted card accepted open history'; end if;

  select * into v_row from public.telegram_test_cards where store = 'Alice card';
  if v_row.last_opened_at <> 5000 then raise exception 'the open was not stored'; end if;
  if v_row.revision <> 7 then raise exception 'revision changed: an open must not look like an edit'; end if;

  -- History only moves forward.
  perform public.record_telegram_test_card_opens('[{"id":"aaaaaaaa-0000-4000-8000-000000000001","at":1}]'::jsonb);
  select * into v_row from public.telegram_test_cards where store = 'Alice card';
  if v_row.last_opened_at <> 5000 then raise exception 'history moved backwards'; end if;

  -- A wildly wrong client clock is refused rather than stored.
  if public.record_telegram_test_card_opens(
       '[{"id":"aaaaaaaa-0000-4000-8000-000000000001","at":99999999999999}]'::jsonb) <> '[]'::jsonb then
    raise exception 'a future timestamp was accepted';
  end if;

  -- Malformed entries are skipped instead of failing the whole batch.
  if public.record_telegram_test_card_opens('[{"id":"not-a-uuid","at":5000},{"nope":1}]'::jsonb) <> '[]'::jsonb then
    raise exception 'malformed entries were not skipped';
  end if;

  raise notice 'PASS open history: owner check, tombstones, revision safety, monotonic time';
end
$$;

-- An unauthenticated caller is refused outright.
set test.uid = '';
do $$
begin
  perform public.record_telegram_test_card_opens('[{"id":"aaaaaaaa-0000-4000-8000-000000000001","at":9000}]'::jsonb);
  raise exception 'an anonymous caller was allowed to write open history';
exception when insufficient_privilege then
  raise notice 'PASS open history rejects unauthenticated callers';
end
$$;
