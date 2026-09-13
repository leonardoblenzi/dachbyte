create table
    if not exists meli_contas (
        id bigserial primary key,
        empresa_id bigint not null references empresas (id) on delete cascade,
        -- Conta ML autorizada (vem do OAuth)
        meli_user_id bigint not null,
        -- Nome amigável exibido no app (ex: "Drossi", "Dmov", "Outlet")
        apelido text not null,
        site_id text not null default 'MLB',
        -- Estado da conexão (controle interno do seu app)
        status text not null default 'ativa', -- 'ativa' | 'revogada' | 'erro'
        criado_em timestamptz not null default now (),
        atualizado_em timestamptz not null default now (),
        ultimo_uso_em timestamptz
    );

-- Não duplicar a mesma conta ML na mesma empresa
create unique index if not exists ux_meli_contas_empresa_meli_user on meli_contas (empresa_id, meli_user_id);

-- Não permitir dois apelidos iguais na mesma empresa
create unique index if not exists ux_meli_contas_empresa_apelido on meli_contas (empresa_id, apelido);

alter table meli_contas add constraint meli_contas_status_check check (status in ('ativa', 'revogada', 'erro'));