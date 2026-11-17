create table if not exists public.company_integrations (
  company_id uuid primary key references public.companies(id) on delete cascade,
  sgp_base_url text,
  sgp_username text,
  sgp_password_ciphertext text,
  sgp_token_ciphertext text,
  updated_at timestamptz not null default now()
);

alter table public.company_integrations enable row level security;
