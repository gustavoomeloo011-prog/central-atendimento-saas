alter table public.messages add column if not exists reply_to_id text;
alter table public.messages add column if not exists attachment_path text;
alter table public.messages add column if not exists attachment_name text;
alter table public.messages add column if not exists attachment_type text;
alter table public.messages add column if not exists delivery_status text not null default 'received';
create unique index if not exists messages_company_id_id on public.messages(company_id,id);
alter table public.messages add constraint messages_reply_company_fk
  foreign key(company_id,reply_to_id) references public.messages(company_id,id);

create index if not exists messages_conversation_created_idx on public.messages(company_id,conversation_id,created_at);

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('chat-attachments','chat-attachments',false,10485760,array['image/jpeg','image/png','image/webp','video/mp4','application/pdf'])
on conflict(id) do update set public=false,file_size_limit=10485760,allowed_mime_types=excluded.allowed_mime_types;

-- Arquivos são manipulados somente pelo backend autenticado com service role.
-- Nenhuma política direta é concedida ao navegador.
