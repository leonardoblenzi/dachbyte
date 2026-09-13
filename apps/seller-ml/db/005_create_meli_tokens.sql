create table
    if not exists meli_tokens (
        meli_conta_id bigint primary key references meli_contas (id) on delete cascade,
        -- Tokens (recomendado criptografar em app antes de salvar)
        access_token text not null,
        access_expires_at timestamptz not null,
        refresh_token text not null,
        scope text, -- ex: "offline_access read write"
        refresh_obtido_em timestamptz not null default now (),
        ultimo_refresh_em timestamptz
    );

-- Ajuda consultas: quais tokens vencem primeiro
create index if not exists ix_meli_tokens_expires on meli_tokens (access_expires_at);