-- Supabase/PostgreSQL preparation for the hybrid architecture.
-- Apply only after configuring Supabase Auth and a private server-side service role.
-- Existing SQLite IDs are text values and are preserved exactly; they are not regenerated.

alter table if exists profiles add column if not exists display_name text;
alter table if exists profiles add column if not exists avatar_url text;
alter table if exists profiles add column if not exists phone text;
alter table if exists profiles add column if not exists department_id text;
alter table if exists profiles add column if not exists last_seen_at timestamptz;
alter table if exists conversations add column if not exists protocol text;
alter table if exists conversations add column if not exists closed_at timestamptz;

create unique index if not exists conversations_protocol_unique on conversations(company_id, protocol) where protocol is not null;

create table if not exists internal_notes (
  id text primary key,
  company_id text not null references companies(id),
  conversation_id text not null references conversations(id),
  profile_id text references profiles(id),
  body text not null check (length(body) between 1 and 10000),
  created_at timestamptz not null default now()
);

create table if not exists conversation_ratings (
  id text primary key,
  company_id text not null references companies(id),
  conversation_id text not null references conversations(id),
  protocol text,
  stars integer not null check (stars between 1 and 5),
  comment text,
  created_at timestamptz not null default now(),
  unique (conversation_id)
);

create table if not exists connector_sessions (
  id text primary key,
  company_id text not null references companies(id),
  connector_name text not null,
  status text not null,
  phone text,
  profile_name text,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (company_id, connector_name)
);

create table if not exists connector_events (
  event_id text primary key,
  company_id text not null references companies(id),
  connector_id text references connector_sessions(id),
  event_type text not null,
  provider_message_id text,
  payload jsonb not null default '{}'::jsonb,
  processed_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists connector_events_provider_message on connector_events(company_id, provider_message_id) where provider_message_id is not null;

create table if not exists whatsapp_outbox (
  id text primary key,
  company_id text not null references companies(id),
  conversation_id text references conversations(id),
  connector_id text references connector_sessions(id),
  idempotency_key text not null,
  to_phone text not null,
  body text not null,
  status text not null default 'pending' check (status in ('pending','leased','sent','delivered','failed','unknown')),
  attempts integer not null default 0,
  provider_message_id text,
  last_error text,
  available_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, idempotency_key)
);

alter table companies enable row level security;
alter table profiles enable row level security;
alter table departments enable row level security;
alter table conversations enable row level security;
alter table messages enable row level security;
alter table audit_events enable row level security;
alter table internal_notes enable row level security;
alter table conversation_ratings enable row level security;
alter table connector_sessions enable row level security;
alter table connector_events enable row level security;
alter table whatsapp_outbox enable row level security;

-- The API uses the Supabase service role after validating the application session.
-- No client-side policy is granted here by default; add narrowly scoped policies
-- only after the JWT company_id/role claims are defined.
