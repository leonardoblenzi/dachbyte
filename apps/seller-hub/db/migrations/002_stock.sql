-- DACH Hub · Etapa E2: estoque mestre (ledger, saldos, regras) em modo observação.
-- Nada aqui escreve nos canais: o Hub só calcula e mostra "o que mudaria".

-- Toda conta nova começa observando (calcula, não escreve). "active" chega na E3.
alter table hub.channel_accounts alter column stock_sync_mode set default 'observe';

-- Local de estoque (CD). Na E2 existe só o padrão; vários CDs ficam para depois.
create table if not exists hub.locations (
  id bigserial primary key,
  tenant_id text not null,
  name text not null,
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index if not exists uq_hub_locations_default on hub.locations(tenant_id) where is_default;

-- Ledger: o saldo é a soma dos movimentos. Todo número tem origem (usuário, planilha, venda...).
create table if not exists hub.stock_movements (
  id bigserial primary key,
  tenant_id text not null,
  item_id bigint not null references hub.items(id) on delete cascade,
  location_id bigint not null references hub.locations(id) on delete restrict,
  kind text not null check (kind in ('initial','adjustment','inventory','spreadsheet','sale','cancellation','return')),
  quantity numeric(14,4) not null check (quantity <> 0),
  balance_after numeric(14,4) not null,
  source_type text,
  source_id text,
  idempotency_key text,
  channel_account_id bigint references hub.channel_accounts(id) on delete set null,
  user_id text,
  note text,
  created_at timestamptz not null default now()
);
create unique index if not exists uq_hub_stock_movements_idem on hub.stock_movements(tenant_id, idempotency_key) where idempotency_key is not null;
create index if not exists idx_hub_stock_movements_item on hub.stock_movements(item_id, id desc);
create index if not exists idx_hub_stock_movements_tenant on hub.stock_movements(tenant_id, id desc);

-- Saldo atual por item e local, atualizado na mesma transação do movimento.
-- A existência da linha indica que o item já tem estoque informado (mesmo que zero).
create table if not exists hub.stock_balances (
  item_id bigint not null references hub.items(id) on delete cascade,
  location_id bigint not null references hub.locations(id) on delete restrict,
  tenant_id text not null,
  on_hand numeric(14,4) not null default 0,
  reserved numeric(14,4) not null default 0 check (reserved >= 0),
  updated_at timestamptz not null default now(),
  primary key (item_id, location_id)
);
create index if not exists idx_hub_stock_balances_tenant on hub.stock_balances(tenant_id);

-- Regras de estoque: padrão da conta e exceção por anúncio (a do anúncio vence).
create table if not exists hub.stock_rules (
  id bigserial primary key,
  tenant_id text not null,
  scope text not null check (scope in ('account','listing')),
  channel_account_id bigint references hub.channel_accounts(id) on delete cascade,
  listing_id bigint references hub.listings(id) on delete cascade,
  mode text not null default 'same' check (mode in ('same','fixed','percent')),
  value numeric(14,4) not null default 0 check (value >= 0),
  cap numeric(14,4) check (cap is null or cap >= 0),
  min_lock numeric(14,4) not null default 0 check (min_lock >= 0),
  safety_reserve numeric(14,4) not null default 0 check (safety_reserve >= 0),
  updated_by text,
  updated_at timestamptz not null default now(),
  constraint ck_hub_stock_rules_target check (
    (scope = 'account' and channel_account_id is not null and listing_id is null) or
    (scope = 'listing' and listing_id is not null and channel_account_id is null))
);
create unique index if not exists uq_hub_stock_rules_account on hub.stock_rules(channel_account_id) where scope = 'account';
create unique index if not exists uq_hub_stock_rules_listing on hub.stock_rules(listing_id) where scope = 'listing';
create index if not exists idx_hub_kit_components_component on hub.kit_components(component_item_id);
