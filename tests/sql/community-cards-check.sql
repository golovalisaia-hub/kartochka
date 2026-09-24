-- Поведенческая проверка supabase/migrations/20260924100000_community_cards.sql
--
-- Нужен локальный PostgreSQL (в браузерном CI базы нет):
--   createdb kartochka_community
--   psql -d kartochka_community -v ON_ERROR_STOP=1 -f tests/sql/community-cards-check.sql
--
-- Проверяет инварианты, на которых держится весь раздел сообщества:
--   1. без активной подписки карта не выдаётся;
--   2. общий доступ выключен по умолчанию и включается только владельцем;
--   3. fair rotation выбирает строго по 24 ч → 7 дней → давности;
--   4. свою карту, выключенную и удалённую карту подписчик не получает;
--   5. перерывы и дневные пределы исключают карту из ротации;
--   6. подписчик не может прочитать пул напрямую (RLS);
--   7. владелец видит только агрегаты, без подписчиков;
--   8. аварийный выключатель гасит раздел, не трогая кошелёк.

do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
end $$;
create extension if not exists pgcrypto;
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

\i supabase/migrations/20260924100000_community_cards.sql

-- ------------------------------------------------------------ участники ----
insert into auth.users (id) values
  ('a0000000-0000-4000-8000-000000000001'),   -- владелец A
  ('b0000000-0000-4000-8000-000000000002'),   -- владелец B
  ('c0000000-0000-4000-8000-000000000003'),   -- владелец C
  ('50000000-0000-4000-8000-000000000009')    -- подписчик S
on conflict do nothing;

insert into public.telegram_test_cards (user_id, id, store, number, color_a, color_b) values
  ('a0000000-0000-4000-8000-000000000001','aaaa0000-0000-4000-8000-00000000000a','Пятёрочка','TEST-A','#1','#2'),
  ('b0000000-0000-4000-8000-000000000002','bbbb0000-0000-4000-8000-00000000000b','Пятёрочка','TEST-B','#1','#2'),
  ('c0000000-0000-4000-8000-000000000003','cccc0000-0000-4000-8000-00000000000c','Пятёрочка','TEST-C','#1','#2'),
  ('50000000-0000-4000-8000-000000000009','55550000-0000-4000-8000-000000000005','Пятёрочка','TEST-SELF','#1','#2')
on conflict do nothing;

do $$
declare
  v_a uuid := 'a0000000-0000-4000-8000-000000000001';
  v_b uuid := 'b0000000-0000-4000-8000-000000000002';
  v_c uuid := 'c0000000-0000-4000-8000-000000000003';
  v_s uuid := '50000000-0000-4000-8000-000000000009';
  v_result jsonb;
  v_x5 uuid;
  v_id_a uuid; v_id_b uuid; v_id_c uuid;
  v_store text;
begin
  select id into v_x5 from public.loyalty_programs where key = 'x5_club';

  -- 1. По умолчанию общего доступа нет.
  perform set_config('test.uid', v_a::text, true);
  if (public.owner_sharing_stats('aaaa0000-0000-4000-8000-00000000000a')->>'sharing_enabled')::boolean then
    raise exception 'общий доступ включён по умолчанию';
  end if;

  -- 2. Без подписки карта не выдаётся, даже если пул не пуст.
  perform public.set_card_sharing('aaaa0000-0000-4000-8000-00000000000a', 'x5_club', 'pyaterochka', true);
  perform set_config('test.uid', v_s::text, true);
  v_result := public.claim_shared_card('x5_club', 'pyaterochka');
  if v_result->>'status' <> 'denied' then
    raise exception 'без Premium карта выдана: %', v_result;
  end if;

  -- 3. С подпиской карта выдаётся, и владелец в ответе не фигурирует.
  perform public.grant_test_subscription(v_s, 30);
  perform set_config('test.uid', v_s::text, true);
  v_result := public.claim_shared_card('x5_club', 'pyaterochka');
  if v_result->>'status' <> 'served' then
    raise exception 'с Premium карта не выдана: %', v_result;
  end if;
  if v_result::text ilike '%owner%' or v_result::text like '%' || v_a::text || '%' then
    raise exception 'в ответе просочился владелец: %', v_result;
  end if;
  if v_result->'card'->>'number' is null then
    raise exception 'карта выдана без номера';
  end if;
  if v_result->>'session_id' is null or v_result->>'expires_at' is null then
    raise exception 'сессия не создана';
  end if;

  -- 4. Статистика владельца выросла и содержит только агрегаты.
  perform set_config('test.uid', v_a::text, true);
  if (public.owner_sharing_stats('aaaa0000-0000-4000-8000-00000000000a')->>'total')::int <> 1 then
    raise exception 'статистика владельца не обновилась';
  end if;
  if public.owner_sharing_stats('aaaa0000-0000-4000-8000-00000000000a')::text ilike '%subscriber%' then
    raise exception 'в статистике владельца виден подписчик';
  end if;

  -- 5. Свою карту подписчик не получает.
  perform set_config('test.uid', v_s::text, true);
  perform public.set_card_sharing('55550000-0000-4000-8000-000000000005', 'x5_club', 'pyaterochka', true);
  perform set_config('test.uid', v_a::text, true);
  perform public.set_card_sharing('aaaa0000-0000-4000-8000-00000000000a', 'x5_club', 'pyaterochka', false);
  perform set_config('test.uid', v_s::text, true);
  -- Обходим перерыв: единственная оставшаяся карта — своя собственная.
  delete from public.community_requests where user_id = v_s;
  v_result := public.claim_shared_card('x5_club', 'pyaterochka');
  if v_result->>'status' <> 'no_card' then
    raise exception 'подписчику выдали его собственную карту: %', v_result;
  end if;
  perform set_config('test.uid', v_s::text, true);
  perform public.set_card_sharing('55550000-0000-4000-8000-000000000005', 'x5_club', 'pyaterochka', false);

  raise notice 'PASS право доступа, согласие владельца, приватность и защита от своей карты';

  -- ---------------------------------------------------------------------
  -- 6. Fair rotation по примеру из бизнес-требования:
  --    A: 24ч = 5; B: 24ч = 3, показ в 15:00; C: 24ч = 3, показ в 14:00.
  --    Следующей обязана стать C.
  -- ---------------------------------------------------------------------
  perform set_config('test.uid', v_a::text, true);
  v_id_a := (public.set_card_sharing('aaaa0000-0000-4000-8000-00000000000a','x5_club','pyaterochka',true)->>'shared_card_id')::uuid;
  perform set_config('test.uid', v_b::text, true);
  v_id_b := (public.set_card_sharing('bbbb0000-0000-4000-8000-00000000000b','x5_club','pyaterochka',true)->>'shared_card_id')::uuid;
  perform set_config('test.uid', v_c::text, true);
  v_id_c := (public.set_card_sharing('cccc0000-0000-4000-8000-00000000000c','x5_club','pyaterochka',true)->>'shared_card_id')::uuid;

  delete from public.shared_card_serves;
  -- Показы ставим от лица другого подписчика, чтобы не сработал перерыв для S.
  insert into public.shared_card_serves (shared_card_id, subscriber_user_id, program_id, served_at)
  select v_id_a, v_b, v_x5, now() - interval '3 hours' from generate_series(1,5);
  insert into public.shared_card_serves (shared_card_id, subscriber_user_id, program_id, served_at)
  select v_id_b, v_a, v_x5, now() - interval '3 hours' from generate_series(1,3);
  insert into public.shared_card_serves (shared_card_id, subscriber_user_id, program_id, served_at)
  select v_id_c, v_a, v_x5, now() - interval '3 hours' from generate_series(1,3);
  update public.shared_cards set last_served_at = now() - interval '9 hours', enabled_at = now() - interval '30 days' where id = v_id_a;
  update public.shared_cards set last_served_at = now() - interval '9 hours', enabled_at = now() - interval '30 days' where id = v_id_b;
  update public.shared_cards set last_served_at = now() - interval '10 hours', enabled_at = now() - interval '30 days' where id = v_id_c;

  perform set_config('test.uid', v_s::text, true);
  delete from public.community_requests where user_id = v_s;
  delete from public.shared_card_serves where subscriber_user_id = v_s;
  v_result := public.claim_shared_card('x5_club', 'pyaterochka');
  if v_result->'card'->>'number' <> 'TEST-C' then
    raise exception 'fair rotation выбрала не C, а %', v_result->'card'->>'number';
  end if;
  if (select count(*) from public.shared_card_serves where shared_card_id = v_id_c
       and served_at > now() - interval '24 hours') <> 4 then
    raise exception 'счётчик C после выдачи не равен 4';
  end if;
  raise notice 'PASS fair rotation: при равных 24ч выбрана карта с самым давним показом';

  -- 7. Карта без показов обязана обойти всех, у кого показы есть.
  delete from public.shared_card_serves;
  update public.shared_cards set last_served_at = null, served_total = 0 where id = v_id_b;
  insert into public.shared_card_serves (shared_card_id, subscriber_user_id, program_id, served_at)
  select v_id_a, v_c, v_x5, now() - interval '2 hours' from generate_series(1,2);
  insert into public.shared_card_serves (shared_card_id, subscriber_user_id, program_id, served_at)
  select v_id_c, v_a, v_x5, now() - interval '2 hours' from generate_series(1,2);
  perform set_config('test.uid', v_s::text, true);
  delete from public.community_requests where user_id = v_s;
  v_result := public.claim_shared_card('x5_club', 'pyaterochka');
  if v_result->'card'->>'number' <> 'TEST-B' then
    raise exception 'карта без показов не получила приоритет, выдана %', v_result->'card'->>'number';
  end if;
  raise notice 'PASS новая карта входит в ротацию первой, а не простаивает';

  -- 8. Выключение общего доступа действует немедленно.
  delete from public.shared_card_serves;
  delete from public.community_requests;
  perform set_config('test.uid', v_a::text, true);
  perform public.set_card_sharing('aaaa0000-0000-4000-8000-00000000000a','x5_club','pyaterochka',false);
  perform set_config('test.uid', v_b::text, true);
  perform public.set_card_sharing('bbbb0000-0000-4000-8000-00000000000b','x5_club','pyaterochka',false);
  perform set_config('test.uid', v_c::text, true);
  perform public.set_card_sharing('cccc0000-0000-4000-8000-00000000000c','x5_club','pyaterochka',false);
  perform set_config('test.uid', v_s::text, true);
  v_result := public.claim_shared_card('x5_club', 'pyaterochka');
  if v_result->>'status' <> 'no_card' then
    raise exception 'выключенные карты продолжают выдаваться: %', v_result;
  end if;

  -- 9. Удалённая карта не выдаётся, даже если строка общего доступа осталась.
  perform set_config('test.uid', v_a::text, true);
  perform public.set_card_sharing('aaaa0000-0000-4000-8000-00000000000a','x5_club','pyaterochka',true);
  update public.telegram_test_cards set deleted_at = now()
   where user_id = v_a and id = 'aaaa0000-0000-4000-8000-00000000000a';
  perform set_config('test.uid', v_s::text, true);
  delete from public.community_requests where user_id = v_s;
  v_result := public.claim_shared_card('x5_club', 'pyaterochka');
  if v_result->>'status' <> 'no_card' then
    raise exception 'удалённая карта выдана: %', v_result;
  end if;
  update public.telegram_test_cards set deleted_at = null
   where user_id = v_a and id = 'aaaa0000-0000-4000-8000-00000000000a';
  raise notice 'PASS выключение доступа и удаление карты убирают её из пула немедленно';

  -- 10. Дневной предел на карту исключает её из ротации.
  delete from public.shared_card_serves;
  delete from public.community_requests;
  update public.loyalty_programs set per_card_daily_limit = 2, cooldown_seconds = 0,
         subscriber_cooldown_seconds = 0, warmup_hours = 0 where id = v_x5;
  insert into public.shared_card_serves (shared_card_id, subscriber_user_id, program_id, served_at)
  select v_id_a, v_b, v_x5, now() - interval '1 hour' from generate_series(1,2);
  perform set_config('test.uid', v_s::text, true);
  v_result := public.claim_shared_card('x5_club', 'pyaterochka');
  if v_result->>'status' <> 'no_card' then
    raise exception 'карта выдана сверх дневного предела: %', v_result;
  end if;

  -- 11. Перерыв между показами одной карты.
  update public.loyalty_programs set per_card_daily_limit = null, cooldown_seconds = 3600 where id = v_x5;
  delete from public.shared_card_serves;
  delete from public.community_requests;
  update public.shared_cards set last_served_at = now() where id = v_id_a;
  perform set_config('test.uid', v_s::text, true);
  v_result := public.claim_shared_card('x5_club', 'pyaterochka');
  if v_result->>'status' <> 'no_card' then
    raise exception 'перерыв между показами не соблюдён: %', v_result;
  end if;
  update public.loyalty_programs set cooldown_seconds = 120 where id = v_x5;
  raise notice 'PASS дневной предел и перерыв исключают карту из ротации';

  -- 12. Ограничение частоты обращений.
  delete from public.community_requests;
  update public.shared_cards set last_served_at = null where id = v_id_a;
  perform set_config('test.uid', v_s::text, true);
  insert into public.community_requests (user_id, program_id, outcome)
  select v_s, v_x5, 'no_card' from generate_series(1,10);
  v_result := public.claim_shared_card('x5_club', 'pyaterochka');
  if v_result->>'status' <> 'rate_limited' then
    raise exception 'ограничение частоты не сработало: %', v_result;
  end if;
  delete from public.community_requests;
  raise notice 'PASS ограничение частоты не даёт перебрать пул';

  -- 13. Аварийный выключатель гасит только раздел сообщества.
  update public.feature_flags set enabled = true where key = 'community_kill_switch';
  perform set_config('test.uid', v_s::text, true);
  v_result := public.claim_shared_card('x5_club', 'pyaterochka');
  if v_result->>'status' <> 'disabled' then
    raise exception 'аварийный выключатель не сработал: %', v_result;
  end if;
  if (public.community_programs()->>'available')::boolean then
    raise exception 'список программ доступен при включённом выключателе';
  end if;
  -- Личный кошелёк при этом не затронут: карты на месте.
  if (select count(*) from public.telegram_test_cards where user_id = v_a) = 0 then
    raise exception 'аварийный выключатель затронул карты пользователя';
  end if;
  update public.feature_flags set enabled = false where key = 'community_kill_switch';

  -- 14. Отдельное отключение X5 не трогает Ленту.
  update public.feature_flags set enabled = false where key = 'x5_community_enabled';
  perform set_config('test.uid', v_s::text, true);
  delete from public.community_requests;
  v_result := public.claim_shared_card('x5_club', 'pyaterochka');
  if v_result->>'status' <> 'disabled' then
    raise exception 'отключение X5 не сработало: %', v_result;
  end if;
  perform set_config('test.uid', v_s::text, true);
  if exists (select 1 from jsonb_array_elements(public.community_programs()->'programs') e
              where e->>'program' = 'x5_club') then
    raise exception 'отключённая X5 осталась в списке магазинов';
  end if;
  if not exists (select 1 from jsonb_array_elements(public.community_programs()->'programs') e
                  where e->>'program' = 'lenta') then
    raise exception 'отключение X5 задело Ленту';
  end if;
  update public.feature_flags set enabled = true where key = 'x5_community_enabled';
  raise notice 'PASS аварийный выключатель и отключение отдельной программы';

  -- 15. Истёкшая подписка закрывает доступ.
  update public.subscriptions set expires_at = now() - interval '1 day' where user_id = v_s;
  perform set_config('test.uid', v_s::text, true);
  delete from public.community_requests;
  v_result := public.claim_shared_card('x5_club', 'pyaterochka');
  if v_result->>'status' <> 'denied' then
    raise exception 'истёкшая подписка продолжает давать доступ: %', v_result;
  end if;
  raise notice 'PASS истёкшая подписка закрывает доступ к сообществу';
end
$$;

-- ------------------------------------------------------------------ RLS ----
-- Проверяем от лица обычной роли authenticated, а не суперпользователя.
grant usage on schema public to authenticated;
set role authenticated;
set test.uid = '50000000-0000-4000-8000-000000000009';

do $$
declare v_visible int;
begin
  -- Свои строки владелец видеть обязан: без этого он не увидит собственный статус.
  -- Запрещено другое — видеть ЧУЖИЕ строки пула, то есть выгрузить пул запросом.
  select count(*) into v_visible from public.shared_cards
   where owner_user_id <> '50000000-0000-4000-8000-000000000009';
  if v_visible <> 0 then
    raise exception 'подписчик видит % чужих строк пула — пул можно выгрузить', v_visible;
  end if;
  select count(*) into v_visible from public.shared_cards;
  if v_visible <> 1 then
    raise exception 'владелец не видит собственную строку общего доступа (видно %)', v_visible;
  end if;

  begin
    update public.shared_cards set sharing_enabled = false;
    raise exception 'подписчик смог изменить чужую карту';
  exception when insufficient_privilege then null;
  end;

  begin
    delete from public.shared_cards;
    raise exception 'подписчик смог удалить чужую карту';
  exception when insufficient_privilege then null;
  end;

  begin
    perform 1 from public.shared_card_serves limit 1;
    raise exception 'подписчик читает журнал показов';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.subscriptions (user_id, status, provider)
    values ('50000000-0000-4000-8000-000000000009', 'active', 'self');
    raise exception 'подписчик смог выдать себе Premium';
  exception when insufficient_privilege then null;
  end;

  raise notice 'PASS RLS: пул не читается, чужие карты не меняются, Premium себе не выдаётся';
end
$$;
reset role;
\echo 'ВСЕ ПРОВЕРКИ СООБЩЕСТВА ПРОЙДЕНЫ'
