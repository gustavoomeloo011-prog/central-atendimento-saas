alter table public.conversations add column if not exists channel_address text;
create index if not exists conversations_channel_address_idx on public.conversations(company_id,channel_address) where channel_address is not null;
