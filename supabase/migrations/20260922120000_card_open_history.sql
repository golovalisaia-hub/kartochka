-- Card open history, recorded separately from card content.
--
-- Why a dedicated column and RPC instead of reusing `last_used`:
--   * `last_used` was written by the client both when a card was CREATED and when it was
--     OPENED, so its historic values cannot be presented as proof that a user opened a card.
--     It is left exactly as it is; nothing is renamed and no old value is reinterpreted.
--   * The content hash used by the sync layer deliberately excludes open history, and the
--     client skips a server write when the content hash is unchanged. An open therefore has
--     to travel through its own path or it would never reach the user's other devices.
--   * This path does NOT touch `revision`, so recording an open can never look like an edit
--     and can never raise a false SYNC_CONFLICT against a concurrent rename.
--
-- Safety: the functions only ever match rows whose user_id is the caller's auth.uid(),
-- so one account can neither read nor stamp another account's cards. Repeating a call is
-- harmless: the stored value only ever moves forward (greatest of stored and submitted).

alter table public.telegram_test_cards
  add column if not exists last_opened_at bigint not null default 0
  check (last_opened_at >= 0);

create index if not exists telegram_test_cards_user_last_opened_idx
  on public.telegram_test_cards (user_id, last_opened_at desc);

do $$
begin
  if exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'cards') then
    execute 'alter table public.cards add column if not exists last_opened_at bigint not null default 0';
    execute 'create index if not exists cards_user_last_opened_idx on public.cards (user_id, last_opened_at desc)';
  end if;
end
$$;

-- Accepts [{"id": "<uuid>", "at": <epoch-ms>}, ...] and returns the ids actually stored.
-- An id the caller does not own, or one that was deleted, is silently skipped and simply
-- absent from the result, so the client keeps it queued instead of reporting a false success.
create or replace function public.record_telegram_test_card_opens(p_opens jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_applied jsonb := '[]'::jsonb;
  v_entry jsonb;
  v_id uuid;
  v_at bigint;
begin
  if v_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_opens is null or jsonb_typeof(p_opens) <> 'array' then
    raise exception 'Invalid open history' using errcode = '22023';
  end if;
  if jsonb_array_length(p_opens) > 200 then
    raise exception 'Too many open events' using errcode = '22023';
  end if;

  for v_entry in select * from jsonb_array_elements(p_opens)
  loop
    begin
      v_id := (v_entry->>'id')::uuid;
      v_at := (v_entry->>'at')::bigint;
    exception when others then
      continue;
    end;
    -- A client clock cannot stamp a card into the future beyond a small tolerance.
    if v_id is null or v_at is null or v_at <= 0
       or v_at > (extract(epoch from clock_timestamp()) * 1000)::bigint + 300000 then
      continue;
    end if;

    update public.telegram_test_cards
       set last_opened_at = greatest(last_opened_at, v_at)
     where user_id = v_user
       and id = v_id
       and deleted_at is null;

    if found then
      v_applied := v_applied || to_jsonb(v_id::text);
    end if;
  end loop;

  return v_applied;
end;
$$;

revoke all on function public.record_telegram_test_card_opens(jsonb) from public, anon;
grant execute on function public.record_telegram_test_card_opens(jsonb) to authenticated;

do $$
begin
  if exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'cards') then
    execute $fn$
      create or replace function public.record_card_opens(p_opens jsonb)
      returns jsonb
      language plpgsql
      security definer
      set search_path = ''
      as $body$
      declare
        v_user uuid := auth.uid();
        v_applied jsonb := '[]'::jsonb;
        v_entry jsonb;
        v_id uuid;
        v_at bigint;
      begin
        if v_user is null then
          raise exception 'Authentication required' using errcode = '42501';
        end if;
        if p_opens is null or jsonb_typeof(p_opens) <> 'array' then
          raise exception 'Invalid open history' using errcode = '22023';
        end if;
        if jsonb_array_length(p_opens) > 200 then
          raise exception 'Too many open events' using errcode = '22023';
        end if;
        for v_entry in select * from jsonb_array_elements(p_opens)
        loop
          begin
            v_id := (v_entry->>'id')::uuid;
            v_at := (v_entry->>'at')::bigint;
          exception when others then
            continue;
          end;
          if v_id is null or v_at is null or v_at <= 0
             or v_at > (extract(epoch from clock_timestamp()) * 1000)::bigint + 300000 then
            continue;
          end if;
          update public.cards
             set last_opened_at = greatest(last_opened_at, v_at)
           where user_id = v_user
             and id = v_id;
          if found then
            v_applied := v_applied || to_jsonb(v_id::text);
          end if;
        end loop;
        return v_applied;
      end;
      $body$;
    $fn$;
    execute 'revoke all on function public.record_card_opens(jsonb) from public, anon';
    execute 'grant execute on function public.record_card_opens(jsonb) to authenticated';
  end if;
end
$$;
