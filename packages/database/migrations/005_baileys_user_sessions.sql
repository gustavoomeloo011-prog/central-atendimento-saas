-- Associa cada sessão Baileys ao usuário autenticado, sem reutilização entre perfis.
alter table public.connector_sessions
  add column if not exists user_id uuid references auth.users(id),
  add column if not exists session_id text;

update public.connector_sessions
   set session_id = coalesce(session_id, connector_name)
 where session_id is null;

create unique index if not exists connector_sessions_user_session_uq
  on public.connector_sessions(company_id, user_id, session_id)
 where user_id is not null and session_id is not null;
