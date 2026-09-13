create table if not exists ml_ranking_anuncios_snapshots (
  id bigserial primary key,
  meli_conta_id bigint not null references meli_contas (id) on delete cascade,
  periodo_inicio date not null,
  periodo_fim date not null,
  tipo_ranking text not null,
  limite integer not null default 30,
  total_faturamento_cents bigint not null default 0,
  total_quantidade integer not null default 0,
  payload_summary jsonb not null default '{}'::jsonb,
  payload_ranking jsonb not null default '[]'::jsonb,
  payload_insights jsonb not null default '[]'::jsonb,
  gerado_em timestamptz not null default now(),
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  constraint ml_ranking_anuncios_snapshots_tipo_check
    check (tipo_ranking in ('faturamento', 'quantidade')),
  constraint ml_ranking_anuncios_snapshots_limite_check
    check (limite = 30),
  constraint ml_ranking_anuncios_snapshots_periodo_check
    check (periodo_inicio <= periodo_fim)
);

create unique index if not exists ux_ml_ranking_snapshots_monthly
  on ml_ranking_anuncios_snapshots (
    meli_conta_id,
    periodo_inicio,
    periodo_fim,
    tipo_ranking,
    limite
  );

create index if not exists ix_ml_ranking_snapshots_conta_periodo
  on ml_ranking_anuncios_snapshots (meli_conta_id, periodo_inicio, periodo_fim);

create table if not exists ml_ranking_anuncios_snapshot_items (
  id bigserial primary key,
  snapshot_id bigint not null references ml_ranking_anuncios_snapshots (id) on delete cascade,
  meli_conta_id bigint not null references meli_contas (id) on delete cascade,
  periodo_inicio date not null,
  periodo_fim date not null,
  tipo_ranking text not null,
  mlb text not null,
  posicao integer not null,
  titulo text,
  imagem text,
  variacao text,
  categoria_id text,
  listing_type_id text,
  catalogo boolean not null default false,
  clips boolean not null default false,
  is_full boolean not null default false,
  promocao boolean not null default false,
  ads_ativo boolean not null default false,
  frete_gratis boolean not null default false,
  vendas_brutas_cents bigint not null default 0,
  quantidade_vendas integer not null default 0,
  preco_medio_cents bigint not null default 0,
  ticket_medio_cents bigint not null default 0,
  participacao_percentual numeric(10,4) not null default 0,
  payload_item jsonb not null default '{}'::jsonb,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  constraint ml_ranking_snapshot_items_tipo_check
    check (tipo_ranking in ('faturamento', 'quantidade')),
  constraint ml_ranking_snapshot_items_posicao_check
    check (posicao between 1 and 30)
);

create unique index if not exists ux_ml_ranking_snapshot_items_position
  on ml_ranking_anuncios_snapshot_items (snapshot_id, posicao);

create unique index if not exists ux_ml_ranking_snapshot_items_mlb
  on ml_ranking_anuncios_snapshot_items (snapshot_id, mlb);

create index if not exists ix_ml_ranking_snapshot_items_lookup
  on ml_ranking_anuncios_snapshot_items (
    meli_conta_id,
    periodo_inicio,
    periodo_fim,
    tipo_ranking,
    mlb
  );
