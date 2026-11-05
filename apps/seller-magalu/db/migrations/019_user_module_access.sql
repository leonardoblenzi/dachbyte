-- Usuarios que ja entraram no modulo Magalu e suas permissoes por modulo.
-- A identidade continua sendo do Hub; aqui ficam so a replica de quem
-- acessou (para a tela Usuarios) e as caixas Acessar/Editar de cada modulo.
-- Usuario sem nenhuma linha em user_module_access tem acesso completo.

create table if not exists magalu.tenant_users (
  dach_tenant_id text not null,
  dach_user_id text not null,
  email text not null,
  name text,
  company_role text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (dach_tenant_id, dach_user_id)
);

create table if not exists magalu.user_module_access (
  dach_tenant_id text not null,
  dach_user_id text not null,
  module_key text not null,
  can_access boolean not null default true,
  can_edit boolean not null default false,
  updated_by_user_id text,
  updated_at timestamptz not null default now(),
  primary key (dach_tenant_id, dach_user_id, module_key),
  constraint user_module_access_edit_requires_access check (can_access or not can_edit)
);

create index if not exists user_module_access_tenant_idx
  on magalu.user_module_access (dach_tenant_id);
