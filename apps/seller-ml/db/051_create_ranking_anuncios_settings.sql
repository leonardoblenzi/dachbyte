create table if not exists ml_ranking_anuncios_settings (
  id bigserial primary key,
  meli_conta_id bigint not null references meli_contas (id) on delete cascade,
  persist_enabled boolean not null default false,
  snapshot_limit integer not null default 30,
  configured_by_user_id bigint references usuarios (id) on delete set null,
  configured_at timestamptz,
  criado_em timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ml_ranking_anuncios_settings_snapshot_limit_check
    check (snapshot_limit in (30, 50, 100))
);

create unique index if not exists ux_ml_ranking_anuncios_settings_conta
  on ml_ranking_anuncios_settings (meli_conta_id);

alter table ml_ranking_anuncios_snapshots
  drop constraint if exists ml_ranking_anuncios_snapshots_limite_check;

alter table ml_ranking_anuncios_snapshots
  add constraint ml_ranking_anuncios_snapshots_limite_check
  check (limite in (30, 50, 100));

alter table ml_ranking_anuncios_snapshot_items
  drop constraint if exists ml_ranking_snapshot_items_posicao_check;

alter table ml_ranking_anuncios_snapshot_items
  add constraint ml_ranking_snapshot_items_posicao_check
  check (posicao between 1 and 100);
