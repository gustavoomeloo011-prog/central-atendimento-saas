-- Keep the transport pinned to the conversation. The company setting selects
-- the provider for newly created conversations; open conversations continue
-- on the provider that received their first message.
alter table public.conversations
  add column if not exists transport text;

update public.conversations c
set transport = coalesce(s.whatsapp_transport, 'baileys')
from public.company_settings s
where s.company_id = c.company_id and c.transport is null;

update public.conversations
set transport = 'baileys'
where transport is null;

alter table public.conversations
  alter column transport set default 'baileys',
  alter column transport set not null;

alter table public.conversations
  drop constraint if exists conversations_transport_check;

alter table public.conversations
  add constraint conversations_transport_check check (transport in ('meta', 'baileys'));

alter table public.whatsapp_outbox
  add column if not exists interactive_payload jsonb not null default '{}'::jsonb;
