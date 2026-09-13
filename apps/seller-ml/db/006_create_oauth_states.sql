create table
    if not exists oauth_states (
        -- state vem na URL de autorização e volta no callback
        state text primary key,
        empresa_id bigint not null references empresas (id) on delete cascade,
        usuario_id bigint not null references usuarios (id) on delete cascade,
        -- PKCE
        code_verifier text not null,
        -- opcional: para você voltar para uma tela específica depois do callback
        return_to text,
        criado_em timestamptz not null default now (),
        expira_em timestamptz not null
    );

create index if not exists ix_oauth_states_expira on oauth_states (expira_em);