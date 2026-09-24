-- Поддержка в виде тикет-системы внутри бота.
--
-- Платёжный провайдер прямо указал, что группа не годится: нужен индивидуальный канал
-- обращения. Отдельного username или почты у проекта нет, поэтому обращения принимает сам
-- бот и присваивает им номер.
--
-- В тексте обращения могут оказаться личные сведения, поэтому доступ к нему имеет только
-- сам автор; администратор работает через сервисный ключ вне клиентских ролей.

create table if not exists public.support_tickets (
  id bigserial primary key,
  -- Публичный номер обращения: его называют пользователю, он не раскрывает внутренние id.
  ticket_no text not null unique,
  user_id uuid references auth.users(id) on delete set null,
  telegram_user_id bigint,
  chat_id bigint,
  message text not null check (char_length(message) between 1 and 4000),
  status text not null default 'open' check (status in ('open', 'in_progress', 'answered', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists support_tickets_user_idx on public.support_tickets (user_id, created_at desc);
create index if not exists support_tickets_tg_idx on public.support_tickets (telegram_user_id, created_at desc);

-- Режим ожидания текста обращения. Без срока действия случайное сообщение через час
-- превратилось бы в обращение, поэтому режим протухает сам.
create table if not exists public.support_ticket_state (
  telegram_user_id bigint primary key,
  chat_id bigint not null,
  awaiting_since timestamptz not null default now(),
  expires_at timestamptz not null
);

alter table public.support_tickets enable row level security;
alter table public.support_ticket_state enable row level security;
revoke all on table public.support_tickets from public, anon;
revoke all on table public.support_ticket_state from public, anon, authenticated;
grant select on table public.support_tickets to authenticated;

-- Свои обращения видит только их автор: чужой тикет прочитать нельзя.
drop policy if exists "Свои обращения видит автор" on public.support_tickets;
create policy "Свои обращения видит автор"
  on public.support_tickets for select to authenticated
  using ((select auth.uid()) = user_id);

-- Ответы администратора: хранятся отдельно, читаются автором обращения.
create table if not exists public.support_ticket_replies (
  id bigserial primary key,
  ticket_id bigint not null references public.support_tickets(id) on delete cascade,
  author text not null check (author in ('user', 'admin')),
  message text not null check (char_length(message) between 1 and 4000),
  created_at timestamptz not null default now()
);
alter table public.support_ticket_replies enable row level security;
revoke all on table public.support_ticket_replies from public, anon;
grant select on table public.support_ticket_replies to authenticated;
drop policy if exists "Ответы видит автор обращения" on public.support_ticket_replies;
create policy "Ответы видит автор обращения"
  on public.support_ticket_replies for select to authenticated
  using (exists (
    select 1 from public.support_tickets t
     where t.id = ticket_id and t.user_id = (select auth.uid())
  ));
