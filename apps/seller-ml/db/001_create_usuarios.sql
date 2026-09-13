-- db/001_create_usuarios.sql
-- Tabela de usuários (login) + nível de acesso

create table if not exists usuarios (
  id bigserial primary key,

  nome text,
  email text not null unique,

  -- senha armazenada como hash (bcrypt), nunca texto puro
  senha_hash text not null,

  -- níveis permitidos: 'usuario' | 'administrador'
  nivel text not null default 'usuario',

  criado_em timestamptz not null default now(),
  ultimo_login_em timestamptz
);

alter table usuarios
  add constraint usuarios_nivel_check
  check (nivel in ('usuario', 'administrador'));
