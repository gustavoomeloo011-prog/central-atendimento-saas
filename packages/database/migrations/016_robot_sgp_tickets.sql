create table if not exists public.robot_sgp_tickets (
  id text primary key,
  company_id text not null references public.companies(id) on delete cascade,
  conversation_id text not null,
  protocol text,
  contact_name text,
  contact_phone text,
  kind text not null check (kind in ('slow_connection','no_connection')),
  status text not null default 'opened' check (status in ('opened','failed','closed')),
  sgp_confirmed boolean not null default false,
  created_at timestamptz not null default now(),
  unique (company_id, conversation_id, kind),
  foreign key (company_id, conversation_id) references public.conversations(company_id, id) on delete cascade
);

create index if not exists robot_sgp_tickets_company_created_idx on public.robot_sgp_tickets(company_id, created_at desc);
alter table public.robot_sgp_tickets enable row level security;

alter table public.whatsapp_outbox add column if not exists not_before timestamptz;
create index if not exists whatsapp_outbox_due_idx on public.whatsapp_outbox(status, not_before) where status = 'pending';
