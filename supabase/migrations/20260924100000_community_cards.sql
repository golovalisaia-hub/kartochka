-- Карты сообщества: добровольный общий доступ к скидочным картам.
--
-- Главные инварианты, которые обеспечивает эта схема:
--   * общий доступ выключен по умолчанию и включается только владельцем;
--   * подписчик никогда не получает пул целиком и не видит владельца;
--   * выбор карты атомарен: выбор, счётчики и сессия — в одной транзакции;
--   * показы распределяются честно по окну 24 часа, затем 7 дней;
--   * правила программ лежат в таблице, а не в коде приложения.
--
-- Миграция только добавляет объекты. Существующие карты не изменяются и не удаляются.

-- ---------------------------------------------------------------- флаги ----
create table if not exists public.feature_flags (
  key text primary key,
  enabled boolean not null default false,
  description text,
  updated_at timestamptz not null default now()
);

insert into public.feature_flags (key, enabled, description) values
  ('community_sharing_enabled', true,  'Владелец может включить общий доступ к своей карте'),
  ('community_access_enabled',  true,  'Подписчик может запросить карту сообщества'),
  ('premium_payments_enabled',  false, 'Реальная оплата Premium. Выключено до отдельного этапа'),
  ('community_kill_switch',     false, 'Аварийное отключение всего раздела сообщества'),
  ('x5_community_enabled',      true,  'Программа X5 Клуб в разделе сообщества'),
  ('lenta_community_enabled',   true,  'Программа Лента в разделе сообщества')
on conflict (key) do nothing;

alter table public.feature_flags enable row level security;
revoke all on table public.feature_flags from public, anon;
grant select on table public.feature_flags to authenticated;
drop policy if exists "Флаги читают все вошедшие" on public.feature_flags;
create policy "Флаги читают все вошедшие"
  on public.feature_flags for select to authenticated using (true);

create or replace function public.flag_enabled(p_key text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select enabled from public.feature_flags where key = p_key), false);
$$;

-- ------------------------------------------------------ программы лояльности ----
create table if not exists public.loyalty_programs (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  display_name text not null,
  enabled boolean not null default true,
  community_enabled boolean not null default false,
  sharing_mode text not null default 'opt_in' check (sharing_mode in ('opt_in', 'disabled')),
  kill_switch_flag text,
  -- Ограничения: null означает «без ограничения».
  daily_usage_limit integer check (daily_usage_limit is null or daily_usage_limit > 0),
  per_card_daily_limit integer check (per_card_daily_limit is null or per_card_daily_limit > 0),
  cooldown_seconds integer not null default 120 check (cooldown_seconds >= 0),
  subscriber_cooldown_seconds integer not null default 900 check (subscriber_cooldown_seconds >= 0),
  -- Разогрев: новая карта входит в ротацию постепенно, но не простаивает.
  warmup_hours integer not null default 24 check (warmup_hours >= 0),
  warmup_max_serves integer not null default 3 check (warmup_max_serves >= 0),
  session_ttl_seconds integer not null default 180 check (session_ttl_seconds between 30 and 3600),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Бренды внутри одной программы: у X5 единый счёт лояльности, но разные магазины.
create table if not exists public.loyalty_brand_contexts (
  id uuid primary key default gen_random_uuid(),
  program_id uuid not null references public.loyalty_programs(id) on delete cascade,
  key text not null,
  display_name text not null,
  enabled boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (program_id, key)
);

insert into public.loyalty_programs (key, display_name, community_enabled, kill_switch_flag, per_card_daily_limit, daily_usage_limit)
values
  ('x5_club', 'X5 Клуб', true, 'x5_community_enabled', 12, 2000),
  ('lenta',   'Лента',   true, 'lenta_community_enabled', 12, 2000)
on conflict (key) do nothing;

insert into public.loyalty_brand_contexts (program_id, key, display_name, sort_order)
select p.id, b.key, b.display_name, b.sort_order
from public.loyalty_programs p
join (values
  ('x5_club', 'pyaterochka', 'Пятёрочка', 1),
  ('x5_club', 'perekrestok', 'Перекрёсток', 2),
  ('lenta',   'lenta',       'Лента',      1)
) as b(program_key, key, display_name, sort_order) on b.program_key = p.key
on conflict (program_id, key) do nothing;

alter table public.loyalty_programs enable row level security;
alter table public.loyalty_brand_contexts enable row level security;
revoke all on table public.loyalty_programs from public, anon;
revoke all on table public.loyalty_brand_contexts from public, anon;
grant select on table public.loyalty_programs to authenticated;
grant select on table public.loyalty_brand_contexts to authenticated;
drop policy if exists "Программы видны вошедшим" on public.loyalty_programs;
create policy "Программы видны вошедшим"
  on public.loyalty_programs for select to authenticated using (true);
drop policy if exists "Бренды видны вошедшим" on public.loyalty_brand_contexts;
create policy "Бренды видны вошедшим"
  on public.loyalty_brand_contexts for select to authenticated using (true);

-- ------------------------------------------------------------- подписки ----
create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'inactive'
    check (status in ('inactive', 'pending', 'active', 'past_due', 'cancelled', 'expired')),
  provider text not null default 'test',
  provider_customer_id text,
  provider_subscription_id text,
  plan_id text,
  started_at timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  expires_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider)
);

create index if not exists subscriptions_user_status_idx on public.subscriptions (user_id, status);

alter table public.subscriptions enable row level security;
revoke all on table public.subscriptions from public, anon;
grant select on table public.subscriptions to authenticated;
-- Подписку клиент только читает. Изменить её может лишь серверная функция:
-- активация Premium никогда не должна зависеть от того, что прислал клиент.
drop policy if exists "Свою подписку видно" on public.subscriptions;
create policy "Свою подписку видно"
  on public.subscriptions for select to authenticated using ((select auth.uid()) = user_id);

-- Идемпотентность будущих платёжных событий.
create table if not exists public.payment_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_event_id text not null,
  user_id uuid references auth.users(id) on delete set null,
  kind text,
  received_at timestamptz not null default now(),
  unique (provider, provider_event_id)
);
alter table public.payment_events enable row level security;
revoke all on table public.payment_events from public, anon, authenticated;

create or replace function public.has_community_access(p_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.subscriptions s
     where s.user_id = p_user
       and s.status = 'active'
       and (s.expires_at is null or s.expires_at > now())
  );
$$;
revoke all on function public.has_community_access(uuid) from public, anon;
grant execute on function public.has_community_access(uuid) to authenticated;

-- --------------------------------------------------------- общие карты ----
create table if not exists public.shared_cards (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  program_id uuid not null references public.loyalty_programs(id) on delete cascade,
  brand_context_id uuid references public.loyalty_brand_contexts(id) on delete set null,
  sharing_enabled boolean not null default false,
  enabled_at timestamptz,
  disabled_at timestamptz,
  served_total bigint not null default 0 check (served_total >= 0),
  last_served_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_user_id, card_id)
);

create index if not exists shared_cards_pool_idx
  on public.shared_cards (program_id, sharing_enabled, last_served_at);

-- Журнал показов: из него считаются окна 24 часа и 7 дней. Счётчики в строке
-- пришлось бы обнулять по расписанию, а журнал даёт точное скользящее окно.
create table if not exists public.shared_card_serves (
  id bigserial primary key,
  shared_card_id uuid not null references public.shared_cards(id) on delete cascade,
  subscriber_user_id uuid not null references auth.users(id) on delete cascade,
  program_id uuid not null references public.loyalty_programs(id) on delete cascade,
  served_at timestamptz not null default now()
);
create index if not exists shared_card_serves_card_time_idx
  on public.shared_card_serves (shared_card_id, served_at desc);
create index if not exists shared_card_serves_subscriber_idx
  on public.shared_card_serves (subscriber_user_id, served_at desc);

create table if not exists public.shared_card_sessions (
  id uuid primary key default gen_random_uuid(),
  subscriber_user_id uuid not null references auth.users(id) on delete cascade,
  shared_card_id uuid not null references public.shared_cards(id) on delete cascade,
  program_id uuid not null references public.loyalty_programs(id) on delete cascade,
  brand_context_id uuid references public.loyalty_brand_contexts(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index if not exists shared_card_sessions_subscriber_idx
  on public.shared_card_sessions (subscriber_user_id, expires_at desc);

-- Журнал обращений: нужен для ограничения частоты и для безопасных метрик.
create table if not exists public.community_requests (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  program_id uuid references public.loyalty_programs(id) on delete set null,
  outcome text not null check (outcome in ('served', 'no_card', 'rate_limited', 'denied', 'disabled')),
  created_at timestamptz not null default now()
);
create index if not exists community_requests_user_time_idx
  on public.community_requests (user_id, created_at desc);

-- Аудит. Номера карт и штрихкоды сюда не попадают ни при каких условиях.
create table if not exists public.community_audit (
  id bigserial primary key,
  event text not null,
  actor_user_id uuid references auth.users(id) on delete set null,
  shared_card_id uuid,
  program_id uuid,
  details jsonb,
  created_at timestamptz not null default now()
);

alter table public.shared_cards enable row level security;
alter table public.shared_card_serves enable row level security;
alter table public.shared_card_sessions enable row level security;
alter table public.community_requests enable row level security;
alter table public.community_audit enable row level security;

revoke all on table public.shared_cards from public, anon;
revoke all on table public.shared_card_serves from public, anon, authenticated;
revoke all on table public.shared_card_sessions from public, anon;
revoke all on table public.community_requests from public, anon, authenticated;
revoke all on table public.community_audit from public, anon, authenticated;

grant select on table public.shared_cards to authenticated;
grant select on table public.shared_card_sessions to authenticated;

-- Владелец видит только свои строки. Пул целиком не виден никому, включая Premium:
-- получить чужую карту можно исключительно через claim_shared_card.
drop policy if exists "Владелец видит свои общие карты" on public.shared_cards;
create policy "Владелец видит свои общие карты"
  on public.shared_cards for select to authenticated
  using ((select auth.uid()) = owner_user_id);

drop policy if exists "Подписчик видит свои сессии" on public.shared_card_sessions;
create policy "Подписчик видит свои сессии"
  on public.shared_card_sessions for select to authenticated
  using ((select auth.uid()) = subscriber_user_id);

-- ----------------------------------------------- владелец включает доступ ----
-- Включение всегда исходит от владельца: функция работает только со своей картой
-- и только если карта существует и не удалена.
create or replace function public.set_card_sharing(
  p_card_id uuid,
  p_program_key text,
  p_brand_key text,
  p_enabled boolean
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_program public.loyalty_programs%rowtype;
  v_brand_id uuid;
  v_shared public.shared_cards%rowtype;
begin
  if v_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_enabled and not public.flag_enabled('community_sharing_enabled') then
    raise exception 'COMMUNITY_SHARING_DISABLED' using errcode = 'P0001';
  end if;
  if p_enabled and public.flag_enabled('community_kill_switch') then
    raise exception 'COMMUNITY_DISABLED' using errcode = 'P0001';
  end if;

  select * into v_program from public.loyalty_programs where key = p_program_key;
  if not found or not v_program.enabled then
    raise exception 'UNKNOWN_PROGRAM' using errcode = '22023';
  end if;
  if p_enabled and v_program.sharing_mode <> 'opt_in' then
    raise exception 'SHARING_NOT_ALLOWED' using errcode = 'P0001';
  end if;

  if p_brand_key is not null then
    select id into v_brand_id from public.loyalty_brand_contexts
     where program_id = v_program.id and key = p_brand_key;
  end if;

  -- Карта обязана принадлежать вызывающему и быть живой.
  if p_enabled and not exists (
    select 1 from public.telegram_test_cards c
     where c.user_id = v_user and c.id = p_card_id and c.deleted_at is null
  ) then
    raise exception 'CARD_NOT_FOUND' using errcode = '22023';
  end if;

  insert into public.shared_cards (card_id, owner_user_id, program_id, brand_context_id,
                                   sharing_enabled, enabled_at, disabled_at)
  values (p_card_id, v_user, v_program.id, v_brand_id,
          p_enabled, case when p_enabled then now() end, case when p_enabled then null else now() end)
  on conflict (owner_user_id, card_id) do update
    set sharing_enabled = excluded.sharing_enabled,
        program_id = excluded.program_id,
        brand_context_id = excluded.brand_context_id,
        enabled_at = case when excluded.sharing_enabled and not public.shared_cards.sharing_enabled
                          then now() else public.shared_cards.enabled_at end,
        disabled_at = case when excluded.sharing_enabled then null else now() end,
        updated_at = now()
  returning * into v_shared;

  insert into public.community_audit (event, actor_user_id, shared_card_id, program_id, details)
  values (case when p_enabled then 'sharing_enabled' else 'sharing_disabled' end,
          v_user, v_shared.id, v_program.id, jsonb_build_object('program', p_program_key));

  return jsonb_build_object(
    'shared_card_id', v_shared.id,
    'sharing_enabled', v_shared.sharing_enabled,
    'program', p_program_key
  );
end;
$$;
revoke all on function public.set_card_sharing(uuid, text, text, boolean) from public, anon;
grant execute on function public.set_card_sharing(uuid, text, text, boolean) to authenticated;

-- Статистика владельца: только агрегаты, ни одного подписчика.
create or replace function public.owner_sharing_stats(p_card_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_shared public.shared_cards%rowtype;
begin
  if v_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  select * into v_shared from public.shared_cards
   where owner_user_id = v_user and card_id = p_card_id;
  if not found then
    return jsonb_build_object('sharing_enabled', false, 'today', 0, 'week', 0, 'total', 0, 'last_served_at', null);
  end if;
  return jsonb_build_object(
    'sharing_enabled', v_shared.sharing_enabled,
    'today', (select count(*) from public.shared_card_serves s
               where s.shared_card_id = v_shared.id and s.served_at > now() - interval '24 hours'),
    'week',  (select count(*) from public.shared_card_serves s
               where s.shared_card_id = v_shared.id and s.served_at > now() - interval '7 days'),
    'total', v_shared.served_total,
    'last_served_at', v_shared.last_served_at
  );
end;
$$;
revoke all on function public.owner_sharing_stats(uuid) from public, anon;
grant execute on function public.owner_sharing_stats(uuid) to authenticated;

-- Список магазинов строит сервер: клиент не решает, что доступно.
create or replace function public.community_programs()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if public.flag_enabled('community_kill_switch') then
    return jsonb_build_object('available', false, 'reason', 'disabled', 'programs', '[]'::jsonb);
  end if;
  return jsonb_build_object(
    'available', public.has_community_access(v_user),
    'reason', null,
    'programs', coalesce((
      select jsonb_agg(entry order by entry->>'display_name')
      from (
        select jsonb_build_object(
                 'program', p.key,
                 'brand', b.key,
                 'display_name', b.display_name,
                 'cards_available', (
                   select count(*) from public.shared_cards sc
                    where sc.program_id = p.id and sc.sharing_enabled
                      and sc.owner_user_id <> v_user
                 )
               ) as entry
          from public.loyalty_programs p
          join public.loyalty_brand_contexts b on b.program_id = p.id
         where p.enabled and p.community_enabled and b.enabled
           and (p.kill_switch_flag is null or public.flag_enabled(p.kill_switch_flag))
      ) as rows
    ), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.community_programs() from public, anon;
grant execute on function public.community_programs() to authenticated;

-- ============================================================================
-- claim_shared_card — единственный путь к чужой карте.
--
-- Всё происходит в одной транзакции: отбор, блокировка строки, запись показа,
-- обновление счётчиков и создание сессии. Разделить их нельзя — между SELECT и
-- UPDATE два параллельных запроса выбрали бы одну карту и сломали честность.
--
-- Порядок отбора (пункт «fair rotation» бизнес-требования):
--   1. показы за 24 часа по возрастанию — основное окно;
--   2. показы за 7 дней по возрастанию;
--   3. самый давний показ, карты без показов идут первыми;
--   4. случайный разрыв полного равенства.
-- served_total намеренно НЕ используется для отбора: иначе новая карта получала
-- бы весь поток, догоняя старые.
-- ============================================================================
create or replace function public.claim_shared_card(p_program_key text, p_brand_key text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_program public.loyalty_programs%rowtype;
  v_brand_id uuid;
  v_card_id uuid;
  v_shared_id uuid;
  v_owner uuid;
  v_session public.shared_card_sessions%rowtype;
  v_card record;
  v_recent integer;
begin
  if v_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if public.flag_enabled('community_kill_switch') or not public.flag_enabled('community_access_enabled') then
    insert into public.community_requests (user_id, outcome) values (v_user, 'disabled');
    return jsonb_build_object('status', 'disabled');
  end if;

  -- Право доступа проверяется только здесь. Клиент не является источником истины.
  if not public.has_community_access(v_user) then
    insert into public.community_requests (user_id, outcome) values (v_user, 'denied');
    return jsonb_build_object('status', 'denied');
  end if;

  select * into v_program from public.loyalty_programs where key = p_program_key;
  if not found or not v_program.enabled or not v_program.community_enabled
     or (v_program.kill_switch_flag is not null and not public.flag_enabled(v_program.kill_switch_flag)) then
    insert into public.community_requests (user_id, program_id, outcome)
    values (v_user, v_program.id, 'disabled');
    return jsonb_build_object('status', 'disabled');
  end if;

  if p_brand_key is not null then
    select id into v_brand_id from public.loyalty_brand_contexts
     where program_id = v_program.id and key = p_brand_key and enabled;
  end if;

  -- Ограничение частоты: не даёт перебрать пул нажатием «обновить».
  select count(*) into v_recent from public.community_requests
   where user_id = v_user and created_at > now() - interval '1 minute';
  if v_recent >= 10 then
    insert into public.community_requests (user_id, program_id, outcome)
    values (v_user, v_program.id, 'rate_limited');
    return jsonb_build_object('status', 'rate_limited');
  end if;
  select count(*) into v_recent from public.community_requests
   where user_id = v_user and created_at > now() - interval '1 hour';
  if v_recent >= 60 then
    insert into public.community_requests (user_id, program_id, outcome)
    values (v_user, v_program.id, 'rate_limited');
    return jsonb_build_object('status', 'rate_limited');
  end if;

  -- Дневной предел всей программы.
  if v_program.daily_usage_limit is not null and (
       select count(*) from public.shared_card_serves s
        where s.program_id = v_program.id and s.served_at > now() - interval '24 hours'
     ) >= v_program.daily_usage_limit then
    insert into public.community_requests (user_id, program_id, outcome)
    values (v_user, v_program.id, 'no_card');
    return jsonb_build_object('status', 'no_card');
  end if;

  with eligible as (
    select sc.id,
           sc.card_id,
           sc.owner_user_id,
           sc.enabled_at,
           (select count(*) from public.shared_card_serves s
             where s.shared_card_id = sc.id and s.served_at > now() - interval '24 hours') as served_24h,
           (select count(*) from public.shared_card_serves s
             where s.shared_card_id = sc.id and s.served_at > now() - interval '7 days') as served_7d,
           sc.last_served_at
      from public.shared_cards sc
      join public.telegram_test_cards c
        on c.user_id = sc.owner_user_id and c.id = sc.card_id and c.deleted_at is null
     where sc.program_id = v_program.id
       and sc.sharing_enabled
       -- Свою же карту подписчику не выдаём.
       and sc.owner_user_id <> v_user
       -- Общий перерыв между показами одной карты.
       and (sc.last_served_at is null
            or sc.last_served_at <= now() - make_interval(secs => v_program.cooldown_seconds))
       -- Тот же подписчик не получает ту же карту слишком часто.
       and not exists (
         select 1 from public.shared_card_serves s
          where s.shared_card_id = sc.id
            and s.subscriber_user_id = v_user
            and s.served_at > now() - make_interval(secs => v_program.subscriber_cooldown_seconds)
       )
  ), within_limits as (
    select * from eligible e
     where (v_program.per_card_daily_limit is null or e.served_24h < v_program.per_card_daily_limit)
       -- Разогрев: свежая карта входит в ротацию, но не забирает весь поток сразу.
       and (v_program.warmup_hours = 0
            or e.enabled_at is null
            or e.enabled_at <= now() - make_interval(hours => v_program.warmup_hours)
            or e.served_24h < v_program.warmup_max_serves)
  )
  select w.id, w.card_id, w.owner_user_id
    into v_shared_id, v_card_id, v_owner
    from within_limits w
    join public.shared_cards lock_row on lock_row.id = w.id
   order by w.served_24h asc,
            w.served_7d asc,
            w.last_served_at asc nulls first,
            random()
   limit 1
   for update of lock_row skip locked;

  if v_shared_id is null then
    insert into public.community_requests (user_id, program_id, outcome)
    values (v_user, v_program.id, 'no_card');
    return jsonb_build_object('status', 'no_card');
  end if;

  insert into public.shared_card_serves (shared_card_id, subscriber_user_id, program_id)
  values (v_shared_id, v_user, v_program.id);

  update public.shared_cards
     set served_total = served_total + 1,
         last_served_at = now(),
         updated_at = now()
   where id = v_shared_id;

  insert into public.shared_card_sessions (subscriber_user_id, shared_card_id, program_id, brand_context_id, expires_at)
  values (v_user, v_shared_id, v_program.id, v_brand_id,
          now() + make_interval(secs => v_program.session_ttl_seconds))
  returning * into v_session;

  insert into public.community_requests (user_id, program_id, outcome)
  values (v_user, v_program.id, 'served');
  insert into public.community_audit (event, actor_user_id, shared_card_id, program_id, details)
  values ('shared_card_served', v_user, v_shared_id, v_program.id,
          jsonb_build_object('program', p_program_key, 'brand', p_brand_key));

  select c.store, c.number, c.format, c.code_image, c.color_a, c.color_b, c.text_color
    into v_card
    from public.telegram_test_cards c
   where c.user_id = v_owner and c.id = v_card_id;

  -- Владелец в ответе не фигурирует: ни идентификатора, ни имени, ни контакта.
  return jsonb_build_object(
    'status', 'served',
    'session_id', v_session.id,
    'expires_at', v_session.expires_at,
    'card', jsonb_build_object(
      'store', v_card.store,
      'number', v_card.number,
      'format', v_card.format,
      'code_image', v_card.code_image,
      'color_a', v_card.color_a,
      'color_b', v_card.color_b,
      'text_color', v_card.text_color
    )
  );
end;
$$;
revoke all on function public.claim_shared_card(text, text) from public, anon;
grant execute on function public.claim_shared_card(text, text) to authenticated;

-- Тестовый Premium только на сервере. Клиент такую подписку выдать себе не может:
-- права на запись в subscriptions не выданы никому, кроме функций с definer.
create or replace function public.grant_test_subscription(p_user uuid, p_days integer default 30)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  insert into public.subscriptions (user_id, status, provider, plan_id, started_at,
                                    current_period_start, current_period_end, expires_at)
  values (p_user, 'active', 'test', 'community_test', now(), now(),
          now() + make_interval(days => p_days), now() + make_interval(days => p_days))
  on conflict (user_id, provider) do update
    set status = 'active', expires_at = excluded.expires_at,
        current_period_end = excluded.current_period_end, updated_at = now();
  insert into public.community_audit (event, actor_user_id, details)
  values ('subscription_changed', p_user, jsonb_build_object('provider', 'test', 'status', 'active'));
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.grant_test_subscription(uuid, integer) from public, anon, authenticated;
