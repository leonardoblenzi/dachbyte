begin;

alter table empresa_usuario_setores
  drop constraint if exists ck_empresa_usuario_setores_setor;

create table if not exists empresa_setores (
  empresa_id bigint not null references empresas (id) on delete cascade,
  setor text not null,
  label text not null,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  primary key (empresa_id, setor),
  constraint ck_empresa_setores_setor_key
    check (setor ~ '^[a-z0-9][a-z0-9_-]{1,48}$')
);

create index if not exists ix_empresa_setores_empresa_label
  on empresa_setores (empresa_id, label);

insert into empresa_setores (empresa_id, setor, label)
select distinct
       eus.empresa_id,
       eus.setor,
       initcap(replace(replace(eus.setor, '_', ' '), '-', ' '))
  from empresa_usuario_setores eus
 where eus.setor is not null
   and trim(eus.setor) <> ''
on conflict (empresa_id, setor) do nothing;

commit;
