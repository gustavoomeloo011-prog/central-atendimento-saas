-- Add closed-attendance retention metadata and SG + 11-digit protocols.
-- Existing protocol values are preserved. Only missing protocols are backfilled.

alter table public.conversations add column if not exists closed_at timestamptz;

update public.conversations
   set closed_at = now()
 where status = 'closed'
   and closed_at is null;

create index if not exists conversations_closed_retention_idx
    on public.conversations(company_id, closed_at, id)
 where status = 'closed';

create table if not exists public.protocol_sequences (
  company_id text primary key references public.companies(id) on delete cascade,
  value bigint not null default 0 check (value >= 0 and value <= 99999999999),
  updated_at timestamptz not null default now()
);

alter table public.protocol_sequences enable row level security;
drop policy if exists protocol_sequences_tenant_read on public.protocol_sequences;
create policy protocol_sequences_tenant_read
  on public.protocol_sequences for select to authenticated
  using (company_id = public.current_company_id());

-- Continue after the highest existing SG protocol so the unique index remains safe.
insert into public.protocol_sequences(company_id, value)
select c.company_id,
       coalesce(max((substring(c.protocol from '^SG([0-9]{11})$'))::bigint), 0)
  from public.conversations c
 group by c.company_id
on conflict(company_id) do update
  set value = greatest(public.protocol_sequences.value, excluded.value),
      updated_at = now();

create or replace function public.next_protocol(p_company_id text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  n bigint;
begin
  insert into public.protocol_sequences(company_id, value, updated_at)
  values (p_company_id, 1, now())
  on conflict(company_id) do update
    set value = public.protocol_sequences.value + 1,
        updated_at = now()
  returning value into n;

  if n > 99999999999 then
    raise exception 'Limite de protocolos desta empresa excedido';
  end if;

  return 'SG' || lpad(n::text, 11, '0');
end;
$$;

revoke execute on function public.next_protocol(text) from public, anon, authenticated;
grant execute on function public.next_protocol(text) to service_role;

-- Backfill only rows that have no protocol; do not change historical references.
with missing as (
  select id, company_id
    from public.conversations
   where protocol is null or btrim(protocol) = ''
   order by company_id, created_at, id
)
update public.conversations c
   set protocol = public.next_protocol(c.company_id)
  from missing m
 where c.id = m.id
   and c.company_id = m.company_id;

update public.conversation_ratings r
   set protocol = c.protocol
  from public.conversations c
 where c.company_id = r.company_id
   and c.id = r.conversation_id
   and r.protocol is null;

alter table public.conversations alter column protocol set not null;
