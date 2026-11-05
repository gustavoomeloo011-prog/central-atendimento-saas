-- Estado de execução de cada conversa. A versão fica fixada até o atendimento terminar.
create table if not exists public.flow_runs (
  conversation_id text primary key,
  company_id text not null,
  flow_id text not null,
  version_id text not null,
  node_id text,
  steps integer not null default 0,
  variables jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('active','paused','finished')),
  updated_at timestamptz not null default now(),
  foreign key(company_id,conversation_id) references public.conversations(company_id,id),
  foreign key(company_id,flow_id) references public.automation_flows(company_id,id),
  foreign key(version_id) references public.automation_flow_versions(id)
);
create index if not exists flow_runs_company_status on public.flow_runs(company_id,status);
alter table public.flow_runs enable row level security;
create policy flow_runs_tenant_read on public.flow_runs for select to authenticated
  using(company_id=public.current_company_id());
