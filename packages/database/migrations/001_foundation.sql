create table if not exists companies (
  id text primary key,
  name text not null,
  kind text not null check (kind in ('isp','general')),
  enabled_modules jsonb not null default '[]',
  created_at timestamptz not null default now()
);
create table if not exists profiles (
  id text primary key,
  company_id text not null references companies(id),
  role text not null check (role in ('superadmin','company_admin','supervisor','agent')),
  display_name text not null,
  status text not null default 'available',
  created_at timestamptz not null default now()
);
create table if not exists departments (
  id text primary key,
  company_id text not null references companies(id),
  name text not null
);
create table if not exists conversations (
  id text primary key,
  company_id text not null references companies(id),
  department_id text references departments(id),
  assigned_profile_id text references profiles(id),
  contact_name text not null,
  contact_phone text not null,
  status text not null check (status in ('waiting','open','closed')),
  priority text not null default 'normal',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists messages (
  id text primary key,
  company_id text not null references companies(id),
  conversation_id text not null references conversations(id),
  profile_id text references profiles(id),
  body text not null,
  direction text not null check (direction in ('inbound','outbound','internal')),
  provider_message_id text unique,
  created_at timestamptz not null default now()
);
create table if not exists audit_events (
  id text primary key,
  company_id text not null references companies(id),
  profile_id text references profiles(id),
  action text not null,
  entity_type text not null,
  entity_id text not null,
  created_at timestamptz not null default now()
);
create table if not exists automation_settings (
  company_id text primary key references companies(id),
  welcome_message text not null,
  fallback_message text not null,
  max_attempts integer not null check (max_attempts between 1 and 5)
);
create table if not exists quick_replies (
  id text primary key,
  company_id text not null references companies(id),
  department_id text references departments(id),
  shortcut text not null,
  body text not null,
  unique (company_id, shortcut)
);

alter table companies enable row level security;
alter table profiles enable row level security;
alter table departments enable row level security;
alter table conversations enable row level security;
alter table messages enable row level security;
alter table audit_events enable row level security;
alter table automation_settings enable row level security;
alter table quick_replies enable row level security;
