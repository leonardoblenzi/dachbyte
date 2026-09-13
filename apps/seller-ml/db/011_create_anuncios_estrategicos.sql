-- db/00X_create_anuncios_estrategicos.sql
-- Produtos Estratégicos (por meli_conta_id)
-- Compatível com EstrategicosController.js (TABLE = 'anuncios_estrategicos')
create table
    if not exists anuncios_estrategicos (
        id bigserial primary key,
        -- vínculo com a conta Mercado Livre selecionada (cookie meli_conta_id)
        meli_conta_id bigint not null references meli_contas (id) on delete cascade,
        -- MLB do anúncio/item no Mercado Livre
        mlb text not null,
        -- título do anúncio/produto (pode ser vazio e preencher no sync)
        name text,
        -- % padrão salvo (ex: 19.0)
        percent_default numeric(6, 2),
        -- % do ciclo (se você quiser separar do default; hoje você está setando igual no apply)
        percent_cycle numeric(6, 2),
        -- % aplicada atualmente (vinda do sync/prices)
        percent_applied numeric(6, 2),
        -- status textual para UI (ex: "Promoção aplicada", "Falha na aplicação", etc.)
        status text,
        -- status do anúncio no ML (active/paused/closed/inactive...)
        listing_status text,
        -- quando foi sincronizado com ML por último
        last_synced_at timestamptz,
        -- timestamps
        created_at timestamptz not null default now (),
        updated_at timestamptz not null default now ()
    );

-- IMPORTANTÍSSIMO:
-- Necessário para o seu INSERT ... ON CONFLICT (meli_conta_id, mlb)
create unique index if not exists ux_anuncios_estrategicos_conta_mlb on anuncios_estrategicos (meli_conta_id, mlb);

-- Índices para performance de listagem e filtros comuns
create index if not exists ix_anuncios_estrategicos_conta_updated on anuncios_estrategicos (meli_conta_id, updated_at desc);

create index if not exists ix_anuncios_estrategicos_conta_created on anuncios_estrategicos (meli_conta_id, created_at desc);

create index if not exists ix_anuncios_estrategicos_mlb on anuncios_estrategicos (mlb);

-- (Opcional) Se você fizer busca por nome no futuro
-- create index if not exists ix_anuncios_estrategicos_name_trgm
--   on anuncios_estrategicos using gin (name gin_trgm_ops);