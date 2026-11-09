-- DACH Hub: apelido da conta, link de autorização (conectar conta de outra pessoa ou uma segunda conta
-- do mesmo marketplace) e o state OAuth ligado ao link. O limite de contas vem do plano (hub de acessos).

alter table hub.channel_accounts add column if not exists nickname text;

create table if not exists hub.authorization_links (
  id bigserial primary key,
  tenant_id text not null,
  channel text not null,
  token_hash text not null unique,
  created_by text not null,
  -- Limite do plano no momento em que o link foi gerado (quem abre o link não tem sessão na DACHBYTE).
  account_limit integer,
  expires_at timestamptz not null,
  opened_at timestamptz,
  used_at timestamptz,
  cancelled_at timestamptz,
  channel_account_id bigint references hub.channel_accounts(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_hub_authorization_links_tenant on hub.authorization_links(tenant_id, created_at desc);

alter table hub.oauth_states add column if not exists link_id bigint references hub.authorization_links(id) on delete cascade;
