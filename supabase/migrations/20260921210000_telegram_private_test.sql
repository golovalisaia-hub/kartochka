-- Closed Telegram test environment.
-- This migration does not modify public.cards and never publishes production data.

create table if not exists public.telegram_accounts (
  telegram_user_id bigint primary key check (telegram_user_id > 0),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  telegram_username text,
  telegram_first_name text,
  linked_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.telegram_accounts enable row level security;
revoke all on table public.telegram_accounts from public, anon, authenticated;
grant select on table public.telegram_accounts to authenticated;

drop policy if exists "Telegram account owners can read their link" on public.telegram_accounts;
create policy "Telegram account owners can read their link"
on public.telegram_accounts for select to authenticated
using ((select auth.uid()) = user_id);

create table if not exists public.telegram_test_cards (
  user_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null,
  store text not null check (char_length(store) between 1 and 28),
  number text not null check (char_length(number) between 1 and 120),
  color_a text not null,
  color_b text not null,
  text_color text not null default '#fff',
  last_used bigint not null default 0,
  format text not null default 'code_128'
    check (format in ('code_128', 'ean_13', 'qr_code', 'image')),
  code_image text,
  revision bigint not null default 1 check (revision > 0),
  deleted_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists telegram_test_cards_user_last_used_idx
  on public.telegram_test_cards (user_id, last_used desc);

alter table public.telegram_test_cards enable row level security;
revoke all on table public.telegram_test_cards from public, anon;
grant select on table public.telegram_test_cards to authenticated;

drop policy if exists "Telegram test users read only their cards" on public.telegram_test_cards;
create policy "Telegram test users read only their cards"
on public.telegram_test_cards for select to authenticated
using ((select auth.uid()) = user_id);

create or replace function public.apply_telegram_test_card_change(
  p_card_id uuid,
  p_expected_revision bigint,
  p_delete boolean,
  p_card jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_revision bigint;
begin
  if v_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.telegram_accounts where user_id = v_user
  ) then
    raise exception 'Telegram account required' using errcode = '42501';
  end if;
  if p_card_id is null or p_expected_revision is null
     or p_expected_revision < 0 or p_delete is null then
    raise exception 'Invalid card mutation' using errcode = '22023';
  end if;
  if not p_delete and (p_card is null or jsonb_typeof(p_card) <> 'object') then
    raise exception 'Card data is required' using errcode = '22023';
  end if;

  if p_expected_revision = 0 then
    if p_delete then
      raise exception 'SYNC_CONFLICT' using errcode = 'P0001';
    end if;
    begin
      insert into public.telegram_test_cards (
        user_id, id, store, number, color_a, color_b, text_color,
        last_used, format, code_image, revision, deleted_at
      ) values (
        v_user, p_card_id, p_card->>'store', p_card->>'number',
        p_card->>'color_a', p_card->>'color_b',
        coalesce(p_card->>'text_color', '#fff'),
        coalesce((p_card->>'last_used')::bigint, 0),
        coalesce(p_card->>'format', 'code_128'),
        p_card->>'code_image', 1, null
      )
      returning revision into v_revision;
    exception when unique_violation then
      raise exception 'SYNC_CONFLICT' using errcode = 'P0001';
    end;
  elsif p_delete then
    update public.telegram_test_cards
       set deleted_at = clock_timestamp(),
           revision = revision + 1,
           updated_at = clock_timestamp()
     where user_id = v_user
       and id = p_card_id
       and revision = p_expected_revision
       and deleted_at is null
    returning revision into v_revision;
    if not found then
      raise exception 'SYNC_CONFLICT' using errcode = 'P0001';
    end if;
  else
    update public.telegram_test_cards
       set store = p_card->>'store',
           number = p_card->>'number',
           color_a = p_card->>'color_a',
           color_b = p_card->>'color_b',
           text_color = coalesce(p_card->>'text_color', '#fff'),
           last_used = coalesce((p_card->>'last_used')::bigint, 0),
           format = coalesce(p_card->>'format', 'code_128'),
           code_image = p_card->>'code_image',
           deleted_at = null,
           revision = revision + 1,
           updated_at = clock_timestamp()
     where user_id = v_user
       and id = p_card_id
       and revision = p_expected_revision
       and deleted_at is null
    returning revision into v_revision;
    if not found then
      raise exception 'SYNC_CONFLICT' using errcode = 'P0001';
    end if;
  end if;

  return jsonb_build_object('revision', v_revision, 'deleted', p_delete);
end;
$$;

revoke all on function public.apply_telegram_test_card_change(uuid, bigint, boolean, jsonb)
  from public, anon;
grant execute on function public.apply_telegram_test_card_change(uuid, bigint, boolean, jsonb)
  to authenticated;

-- Sharing is a separate projection. There is deliberately no trigger on the
-- private wallet table, so revoking a share can never block editing or deletion.
create table if not exists public.telegram_test_catalog (
  owner_user_id uuid not null,
  card_id uuid not null,
  store text not null,
  number text not null,
  color_a text not null,
  color_b text not null,
  text_color text not null default '#fff',
  format text not null,
  code_image text,
  approved boolean not null default false,
  published_at timestamptz not null default now(),
  primary key (owner_user_id, card_id),
  foreign key (owner_user_id, card_id)
    references public.telegram_test_cards(user_id, id) on delete cascade
);

alter table public.telegram_test_catalog enable row level security;
revoke all on table public.telegram_test_catalog from public, anon, authenticated;
grant select on table public.telegram_test_catalog to authenticated;

drop policy if exists "Approved Telegram test catalog is readable" on public.telegram_test_catalog;
create policy "Approved Telegram test catalog is readable"
on public.telegram_test_catalog for select to authenticated
using (approved or owner_user_id = (select auth.uid()));

create or replace function public.publish_telegram_test_card(p_card_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_card public.telegram_test_cards%rowtype;
begin
  select * into v_card
    from public.telegram_test_cards
   where user_id = v_user and id = p_card_id and deleted_at is null;
  if not found then
    raise exception 'Card not found' using errcode = 'P0002';
  end if;
  if v_card.number not like 'TEST-%' then
    raise exception 'Only synthetic TEST- cards may be shared in the closed test'
      using errcode = '22023';
  end if;
  insert into public.telegram_test_catalog (
    owner_user_id, card_id, store, number, color_a, color_b,
    text_color, format, code_image, approved
  ) values (
    v_user, v_card.id, v_card.store, v_card.number, v_card.color_a,
    v_card.color_b, v_card.text_color, v_card.format, v_card.code_image, false
  )
  on conflict (owner_user_id, card_id) do update set
    store = excluded.store,
    number = excluded.number,
    color_a = excluded.color_a,
    color_b = excluded.color_b,
    text_color = excluded.text_color,
    format = excluded.format,
    code_image = excluded.code_image,
    approved = false,
    published_at = clock_timestamp();
end;
$$;

create or replace function public.revoke_telegram_test_card(p_card_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.telegram_test_catalog
   where owner_user_id = auth.uid() and card_id = p_card_id;
$$;

revoke all on function public.publish_telegram_test_card(uuid) from public, anon;
revoke all on function public.revoke_telegram_test_card(uuid) from public, anon;
grant execute on function public.publish_telegram_test_card(uuid) to authenticated;
grant execute on function public.revoke_telegram_test_card(uuid) to authenticated;
