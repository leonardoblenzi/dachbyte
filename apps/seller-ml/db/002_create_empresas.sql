create table
    if not exists empresas (
        id bigserial primary key,
        nome text not null,
        criado_em timestamptz not null default now ()
    );