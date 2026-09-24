#!/usr/bin/env bash
# Проверка параллельного выбора карт сообщества.
#
# Что здесь важно: claim_shared_card выполняет отбор, запись показа, обновление
# счётчиков и создание сессии в одной транзакции с FOR UPDATE ... SKIP LOCKED.
# Если бы это делалось в несколько шагов, параллельные запросы выбрали бы одну
# карту, счётчики разошлись бы с журналом, а честность распределения сломалась.
#
# Запуск (нужен локальный PostgreSQL):
#   bash tests/sql/community-concurrency-check.sh
set -uo pipefail

DB="${DB:-kartochka_conc}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PSQL="su postgres -c"
SUBSCRIBERS=10
CARDS=5

$PSQL "psql -q -c 'drop database if exists $DB' -c 'create database $DB'" >/dev/null 2>&1

# Схема и данные.
$PSQL "psql -q -d $DB -v ON_ERROR_STOP=1" <<SQL >/dev/null 2>&1
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
end \$\$;
create extension if not exists pgcrypto;
create schema if not exists auth;
create table auth.users (id uuid primary key);
create or replace function auth.uid() returns uuid language sql stable
  as \$f\$ select nullif(current_setting('test.uid', true), '')::uuid \$f\$;
create table public.telegram_accounts (telegram_user_id bigint primary key,
  user_id uuid not null unique references auth.users(id) on delete cascade);
create table public.telegram_test_cards (
  user_id uuid not null references auth.users(id) on delete cascade, id uuid not null,
  store text not null, number text not null, color_a text not null, color_b text not null,
  text_color text not null default '#fff', last_used bigint not null default 0,
  format text not null default 'code_128', code_image text,
  revision bigint not null default 1, deleted_at timestamptz,
  updated_at timestamptz not null default now(), primary key (user_id, id));
\i $ROOT/supabase/migrations/20260924100000_community_cards.sql
SQL

$PSQL "psql -q -d $DB -v ON_ERROR_STOP=1" <<SQL >/dev/null 2>&1
-- Перерывы обнуляем: проверяем именно параллельность, а не тайминги.
update public.loyalty_programs
   set cooldown_seconds = 0, subscriber_cooldown_seconds = 0, warmup_hours = 0,
       per_card_daily_limit = null, daily_usage_limit = null
 where key = 'x5_club';

do \$\$
declare v_owner uuid; v_card uuid; v_sub uuid;
begin
  for i in 1..$CARDS loop
    v_owner := ('00000000-0000-4000-8000-0000000001' || lpad(i::text, 2, '0'))::uuid;
    v_card  := ('00000000-0000-4000-8000-0000000002' || lpad(i::text, 2, '0'))::uuid;
    insert into auth.users (id) values (v_owner);
    insert into public.telegram_test_cards (user_id, id, store, number, color_a, color_b)
    values (v_owner, v_card, 'Пятёрочка', 'TEST-CARD-' || i, '#1', '#2');
    perform set_config('test.uid', v_owner::text, true);
    perform public.set_card_sharing(v_card, 'x5_club', 'pyaterochka', true);
  end loop;
  for i in 1..$SUBSCRIBERS loop
    v_sub := ('00000000-0000-4000-8000-0000000003' || lpad(i::text, 2, '0'))::uuid;
    insert into auth.users (id) values (v_sub);
    perform public.grant_test_subscription(v_sub, 30);
  end loop;
end \$\$;
SQL

echo "Запускаю $SUBSCRIBERS одновременных запросов к пулу из $CARDS карт…"
pids=()
for i in $(seq 1 $SUBSCRIBERS); do
  sub="00000000-0000-4000-8000-0000000003$(printf '%02d' "$i")"
  $PSQL "psql -q -t -A -d $DB -c \"set test.uid='$sub'; select public.claim_shared_card('x5_club','pyaterochka')->>'status';\"" \
    > "/tmp/conc_$i.out" 2>&1 &
  pids+=($!)
done
for pid in "${pids[@]}"; do wait "$pid"; done

served=$(grep -lc '^served$' /tmp/conc_*.out 2>/dev/null | wc -l)
echo "  выдано карт: $served из $SUBSCRIBERS"

$PSQL "psql -q -t -A -d $DB" <<'SQL'
do $$
declare
  v_serves int; v_total int; v_sessions int; v_max int; v_min int; v_distinct int;
begin
  select count(*) into v_serves from public.shared_card_serves;
  select coalesce(sum(served_total),0) into v_total from public.shared_cards;
  select count(*) into v_sessions from public.shared_card_sessions;

  -- Счётчик в строке обязан совпадать с журналом: расхождение означало бы,
  -- что запись показа и инкремент разъехались под нагрузкой.
  if v_serves <> v_total then
    raise exception 'счётчики разошлись: журнал %, сумма served_total %', v_serves, v_total;
  end if;
  if v_sessions <> v_serves then
    raise exception 'сессий % при % показах — сессия создаётся не на каждую выдачу', v_sessions, v_serves;
  end if;

  -- Одна карта не должна забрать все запросы: это и есть поломка честности.
  select max(cnt), min(cnt), count(*) into v_max, v_min, v_distinct
    from (select shared_card_id, count(*) cnt from public.shared_card_serves group by 1) t;
  if v_distinct < 3 then
    raise exception 'показы ушли всего % картам из 5 — честность нарушена', v_distinct;
  end if;
  if v_max > v_min + 2 then
    raise exception 'перекос распределения: максимум %, минимум %', v_max, v_min;
  end if;

  -- Ни одна сессия не должна ссылаться на несуществующую карту.
  if exists (select 1 from public.shared_card_sessions s
              left join public.shared_cards c on c.id = s.shared_card_id where c.id is null) then
    raise exception 'сессия ссылается на несуществующую карту';
  end if;

  raise notice 'PASS параллельность: показов %, сессий %, карт задействовано %, разброс %..%',
    v_serves, v_sessions, v_distinct, v_min, v_max;
end
$$;
SQL

rm -f /tmp/conc_*.out
