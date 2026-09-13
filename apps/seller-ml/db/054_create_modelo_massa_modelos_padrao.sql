create table if not exists ml_modelo_massa_modelos_padrao (
  id bigserial primary key,
  empresa_id bigint not null references empresas (id) on delete cascade,
  modelo text not null,
  modelo_normalizado text not null,
  ativo boolean not null default true,
  criado_por_usuario_id bigint references usuarios (id) on delete set null,
  atualizado_por_usuario_id bigint references usuarios (id) on delete set null,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  constraint ck_ml_modelo_massa_modelos_padrao_modelo
    check (char_length(btrim(modelo)) between 1 and 120),
  constraint ck_ml_modelo_massa_modelos_padrao_normalizado
    check (char_length(btrim(modelo_normalizado)) between 1 and 120)
);

create unique index if not exists ux_ml_modelo_massa_modelos_padrao_empresa_normalizado_ativo
  on ml_modelo_massa_modelos_padrao (empresa_id, modelo_normalizado)
  where ativo = true;

create index if not exists ix_ml_modelo_massa_modelos_padrao_empresa_modelo
  on ml_modelo_massa_modelos_padrao (empresa_id, modelo);
