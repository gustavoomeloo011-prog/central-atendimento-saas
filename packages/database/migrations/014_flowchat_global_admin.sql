-- The initial FlowChat owner can administer the tenant catalog.
update public.profiles
set role='superadmin'
where lower(coalesce(email,'')) in ('gustavo@demo.local','gustavoomeloo011@gmail.com')
  and lower(coalesce(name,'')) like 'gustavo%';
