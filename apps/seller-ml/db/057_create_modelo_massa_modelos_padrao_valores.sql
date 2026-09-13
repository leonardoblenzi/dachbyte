create table if not exists ml_modelo_massa_modelos_padrao_valores (
  id bigserial primary key,
  modelo_padrao_id bigint not null references ml_modelo_massa_modelos_padrao (id) on delete cascade,
  valor text not null,
  valor_normalizado text not null,
  ativo boolean not null default true,
  criado_por_usuario_id bigint references usuarios (id) on delete set null,
  atualizado_por_usuario_id bigint references usuarios (id) on delete set null,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  constraint ck_ml_modelo_massa_modelos_padrao_valores_valor
    check (char_length(btrim(valor)) between 1 and 120),
  constraint ck_ml_modelo_massa_modelos_padrao_valores_normalizado
    check (char_length(btrim(valor_normalizado)) between 1 and 120)
);

create unique index if not exists ux_ml_modelo_massa_modelos_padrao_valores_modelo_valor_ativo
  on ml_modelo_massa_modelos_padrao_valores (modelo_padrao_id, valor_normalizado)
  where ativo = true;

create index if not exists ix_ml_modelo_massa_modelos_padrao_valores_modelo
  on ml_modelo_massa_modelos_padrao_valores (modelo_padrao_id, valor);
