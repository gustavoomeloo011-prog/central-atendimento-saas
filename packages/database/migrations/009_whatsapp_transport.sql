-- Persist the company's selected WhatsApp provider. Keep Baileys as the
-- backwards-compatible default and retain archived automation history.
alter table public.company_settings
  add column if not exists whatsapp_transport text not null default 'baileys';

alter table public.company_settings
  drop constraint if exists company_settings_whatsapp_transport_check;

alter table public.company_settings
  add constraint company_settings_whatsapp_transport_check
  check (whatsapp_transport in ('baileys', 'meta'));
