begin;

create table if not exists empresa_usuario_setores (
  empresa_id bigint not null,
  usuario_id bigint not null,
  setor text not null,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  primary key (empresa_id, usuario_id, setor),
  constraint fk_empresa_usuario_setores_vinculo
    foreign key (empresa_id, usuario_id)
    references empresa_usuarios (empresa_id, usuario_id)
    on delete cascade,
  constraint ck_empresa_usuario_setores_setor
    check (setor in ('marketing', 'cadastro', 'comercial', 'ads', 'logistica', 'atendimento', 'gestao'))
);

create index if not exists ix_empresa_usuario_setores_empresa_setor
  on empresa_usuario_setores (empresa_id, setor);

create table if not exists empresa_usuario_modulos (
  empresa_id bigint not null,
  usuario_id bigint not null,
  modulo_key text not null,
  pode_acessar boolean not null default true,
  pode_editar boolean not null default false,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  primary key (empresa_id, usuario_id, modulo_key),
  constraint fk_empresa_usuario_modulos_vinculo
    foreign key (empresa_id, usuario_id)
    references empresa_usuarios (empresa_id, usuario_id)
    on delete cascade,
  constraint ck_empresa_usuario_modulos_modulo_key
    check (modulo_key ~ '^[a-z0-9_.-]+$')
);

create index if not exists ix_empresa_usuario_modulos_empresa_modulo
  on empresa_usuario_modulos (empresa_id, modulo_key);

commit;
