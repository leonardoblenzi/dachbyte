alter table empresa_usuarios
  add column if not exists default_meli_conta_id bigint references meli_contas (id) on delete set null;

create index if not exists ix_empresa_usuarios_default_meli_conta
  on empresa_usuarios (default_meli_conta_id);
