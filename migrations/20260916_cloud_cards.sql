-- Supabase project kartochka: applied through migration on 2026-09-16.
-- The public website uses ONLY a publishable key; account IDs come from auth.uid().
create table if not exists public.cards (
  user_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null,
  store text not null check (char_length(store) between 1 and 28),
  number text not null check (char_length(number) between 1 and 120),
  color_a text not null,
  color_b text not null,
  text_color text not null default '#fff',
  last_used bigint not null default 0,
  format text not null default 'code_128',
  code_image text,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
alter table public.cards enable row level security;
revoke all on table public.cards from public, anon;
grant select, insert, update, delete on table public.cards to authenticated;
drop policy if exists "Users can read own cards" on public.cards;
create policy "Users can read own cards" on public.cards for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "Users can insert own cards" on public.cards;
create policy "Users can insert own cards" on public.cards for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "Users can update own cards" on public.cards;
create policy "Users can update own cards" on public.cards for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "Users can delete own cards" on public.cards;
create policy "Users can delete own cards" on public.cards for delete to authenticated using ((select auth.uid()) = user_id);
create index if not exists cards_user_last_used_idx on public.cards (user_id, last_used desc);
