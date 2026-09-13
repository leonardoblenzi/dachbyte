begin;

alter table if exists empresa_setores
  add column if not exists ativo boolean not null default true;

create index if not exists ix_empresa_setores_empresa_ativo_label
  on empresa_setores (empresa_id, ativo, label);

commit;
