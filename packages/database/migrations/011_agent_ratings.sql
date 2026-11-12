alter table public.conversations add column if not exists closed_by_profile_id text references public.profiles(id);
alter table public.conversation_ratings add column if not exists profile_id text references public.profiles(id);
create index if not exists conversation_ratings_company_profile_idx on public.conversation_ratings(company_id, profile_id, created_at desc);
