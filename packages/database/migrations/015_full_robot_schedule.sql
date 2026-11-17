alter table public.automation_settings add column if not exists full_robot_enabled boolean not null default false;
alter table public.automation_settings add column if not exists full_robot_start time not null default '21:00';
alter table public.automation_settings add column if not exists full_robot_end time not null default '09:00';
alter table public.automation_settings add column if not exists full_robot_timezone text not null default 'America/Sao_Paulo';
