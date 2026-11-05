-- Base nova do projeto Central-atendimento. Executar em banco Supabase vazio.
create table if not exists public.contacts (
 id text primary key, company_id text not null references public.companies(id),
 name text not null, phone text not null, created_at timestamptz not null default now(),
 unique(company_id, phone), unique(company_id,id)
);
alter table public.profiles add column if not exists auth_user_id uuid unique references auth.users(id);
alter table public.profiles add column if not exists name text;
alter table public.profiles add column if not exists email text;
alter table public.profiles add column if not exists phone text;
alter table public.profiles add column if not exists avatar_url text;
alter table public.profiles add column if not exists department_id text;
create unique index if not exists profiles_company_id_id on public.profiles(company_id,id);
create unique index if not exists departments_company_id_id on public.departments(company_id,id);
create unique index if not exists conversations_company_id_id on public.conversations(company_id,id);
alter table public.conversations add column if not exists contact_id text;
alter table public.conversations add column if not exists subject text not null default '';
alter table public.conversations add column if not exists queue_type text not null default 'support';
alter table public.conversations add column if not exists bot_attempts integer not null default 0;
alter table public.conversations add column if not exists human_started_at timestamptz;
alter table public.conversations add constraint conversations_contact_company_fk foreign key(company_id,contact_id) references public.contacts(company_id,id);
alter table public.conversations add constraint conversations_department_company_fk foreign key(company_id,department_id) references public.departments(company_id,id);
alter table public.conversations add constraint conversations_assignee_company_fk foreign key(company_id,assigned_profile_id) references public.profiles(company_id,id);
alter table public.messages add constraint messages_conversation_company_fk foreign key(company_id,conversation_id) references public.conversations(company_id,id);
alter table public.messages add constraint messages_profile_company_fk foreign key(company_id,profile_id) references public.profiles(company_id,id);
create table if not exists public.automation_flows (
 id text primary key, company_id text not null references public.companies(id), name text not null,
 status text not null default 'draft' check(status in ('draft','published','archived')),
 published_version integer, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(company_id,id)
);
create table if not exists public.automation_flow_versions (
 id text primary key, company_id text not null, flow_id text not null,
 version integer not null, status text not null check(status in ('draft','published','archived')),
 definition jsonb not null, created_at timestamptz not null default now(), published_at timestamptz,
 foreign key(company_id,flow_id) references public.automation_flows(company_id,id), unique(flow_id,version)
);
create table if not exists public.company_settings (
 company_id text primary key references public.companies(id), auto_reply_enabled boolean not null default false,
 satisfaction_enabled boolean not null default false, updated_at timestamptz not null default now()
);
create table if not exists public.protocol_counters (
 company_id text not null references public.companies(id), day date not null,
 value bigint not null default 0, primary key(company_id,day)
);
create or replace function public.next_protocol(p_company_id text) returns text language plpgsql security definer set search_path=public as $$
declare n bigint; d date := (now() at time zone 'America/Sao_Paulo')::date;
begin
 insert into protocol_counters(company_id,day,value) values(p_company_id,d,1)
 on conflict(company_id,day) do update set value=protocol_counters.value+1 returning value into n;
 return to_char(d,'YYYYMMDD')||'-'||lpad(n::text,6,'0');
end $$;
revoke execute on function public.next_protocol(text) from public, anon, authenticated;
alter table public.contacts enable row level security;
alter table public.automation_flows enable row level security;
alter table public.automation_flow_versions enable row level security;
alter table public.company_settings enable row level security;
alter table public.protocol_counters enable row level security;
create or replace function public.current_company_id() returns text language sql stable security definer set search_path=public as $$
 select company_id from public.profiles where auth_user_id=auth.uid() limit 1
$$;
do $$ declare t text; begin
 foreach t in array array['profiles','departments','contacts','conversations','messages','audit_events','automation_settings','quick_replies','automation_flows','automation_flow_versions','internal_notes','conversation_ratings','connector_sessions','connector_events','whatsapp_outbox','company_settings'] loop
  execute format('create policy %I on public.%I for select to authenticated using (company_id = public.current_company_id())',t||'_tenant_read',t);
 end loop;
end $$;
create policy companies_tenant_read on public.companies for select to authenticated using(id=public.current_company_id());
-- Mutations use the private backend service role after application authorization.
-- No browser INSERT/UPDATE/DELETE policies are granted.
