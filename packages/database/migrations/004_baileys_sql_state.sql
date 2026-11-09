-- Armazenamento persistente e criptografado para sessões Baileys.
alter table public.connector_sessions
  add column if not exists auth_state bytea,
  add column if not exists auth_state_nonce bytea,
  add column if not exists auth_state_tag bytea,
  add column if not exists lease_owner text,
  add column if not exists lease_until timestamptz;

create index if not exists connector_sessions_lease_idx
  on public.connector_sessions(company_id, connector_name, lease_until);

create or replace function public.acquire_connector_lease(
  p_company_id text, p_connector_name text, p_owner text, p_seconds integer default 60
) returns boolean language plpgsql security definer set search_path=public as $$
declare acquired boolean;
begin
  insert into connector_sessions(id, company_id, connector_name, status, lease_owner, lease_until)
  values (p_company_id || ':' || p_connector_name, p_company_id, p_connector_name, 'DISCONNECTED', p_owner, now() + make_interval(secs => p_seconds))
  on conflict (company_id, connector_name) do update
    set lease_owner = excluded.lease_owner, lease_until = excluded.lease_until
    where connector_sessions.lease_until is null
       or connector_sessions.lease_until < now()
       or connector_sessions.lease_owner = p_owner;
  select exists(select 1 from connector_sessions where company_id=p_company_id and connector_name=p_connector_name and lease_owner=p_owner and lease_until > now()) into acquired;
  return acquired;
end $$;

create or replace function public.renew_connector_lease(
  p_company_id text, p_connector_name text, p_owner text, p_seconds integer default 60
) returns boolean language sql security definer set search_path=public as $$
  update connector_sessions
     set lease_until=now()+make_interval(secs => p_seconds)
   where company_id=p_company_id and connector_name=p_connector_name
     and lease_owner=p_owner and lease_until > now()
  returning true;
$$;

create or replace function public.release_connector_lease(
  p_company_id text, p_connector_name text, p_owner text
) returns void language sql security definer set search_path=public as $$
  update connector_sessions set lease_owner=null, lease_until=null
   where company_id=p_company_id and connector_name=p_connector_name and lease_owner=p_owner;
$$;

revoke all on function public.acquire_connector_lease(text,text,text,integer) from public, anon, authenticated;
revoke all on function public.renew_connector_lease(text,text,text,integer) from public, anon, authenticated;
revoke all on function public.release_connector_lease(text,text,text) from public, anon, authenticated;
