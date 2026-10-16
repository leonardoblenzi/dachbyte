insert into volt_core.role_permissions (role_id, permission_key, allowed)
select 'role_manager', permission_key, true
from (values ('sales:correct'), ('sales:cancel'), ('sales:archive')) as permissions(permission_key)
on conflict (role_id, permission_key) do update set allowed = excluded.allowed;

update volt_core.user_companies
set permissions = permissions || '["sales:correct","sales:cancel","sales:archive"]'::jsonb
where lower(role) in ('manager', 'gerente')
  and permissions ? 'sales:write';
