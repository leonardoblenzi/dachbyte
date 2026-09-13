create table
    if not exists empresa_usuarios (
        empresa_id bigint not null references empresas (id) on delete cascade,
        usuario_id bigint not null references usuarios (id) on delete cascade,
        -- papel dentro da empresa
        papel text not null default 'admin', -- 'owner' | 'admin' | 'operador'
        criado_em timestamptz not null default now (),
        primary key (empresa_id, usuario_id)
    );

alter table empresa_usuarios add constraint empresa_usuarios_papel_check check (papel in ('owner', 'admin', 'operador'));