create table if not exists empresa_estrategicos_permissoes (
  empresa_id bigint not null,
  setor text not null,
  action_key text not null,
  pode_visualizar boolean not null default true,
  pode_editar boolean not null default false,
  atualizado_em timestamptz not null default now(),
  atualizado_por bigint null,
  primary key (empresa_id, setor, action_key),
  constraint fk_empresa_estrategicos_permissoes_empresa
    foreign key (empresa_id) references empresas(id) on delete cascade
);

create index if not exists ix_empresa_estrategicos_permissoes_empresa
  on empresa_estrategicos_permissoes (empresa_id, setor);
