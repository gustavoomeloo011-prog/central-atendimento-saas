-- Protocolos SG persistentes por empresa e índice para retenção de atendimentos.
-- A migração preserva todos os registros encerrados existentes por 24h após
-- a aplicação, em vez de removê-los imediatamente no primeiro deploy.

alter table public.conversations add column if not exists closed_at timestamptz;
update public.conversations
   set closed_at = now()
 where status = 'closed'
   and closed_at is null;

create index if not exists conversations_closed_retention_idx
    on public.conversations(company_id, closed_at, id)
 where status = 'closed';

-- Reatribui os protocolos já existentes para o padrão SG + 11 dígitos,
-- preservando a unicidade e atualizando a cópia usada pelas avaliações.
update public.conversations
   set protocol = 'MIGRATING-' || id;

with numbered as (
  select id, company_id,
         row_number() over (partition by company_id order by created_at, id) as seq
    from public.conversations
)
update public.conversations c
   set protocol = 'SG' || lpad(n.seq::text, 11, '0')
  from numbered n
 where c.company_id = n.company_id
   and c.id = n.id;

update public.conversation_ratings r
   set protocol = c.protocol
  from public.conversations c
 where c.company_id = r.company_id
   and c.id = r.conversation_id;

alter table public.conversations alter column protocol set not null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'conversations_protocol_sg_format') then
    alter table public.conversations
      add constraint conversations_protocol_sg_format
      check (protocol ~ '^SG[0-9]{11}$');
  end if;
end $$;

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

insert into public.protocol_sequences(company_id, value)
select company_id, count(*)::bigint
  from public.conversations
 group by company_id
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
