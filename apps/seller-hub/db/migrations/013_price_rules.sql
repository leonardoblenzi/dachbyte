-- DACH Hub · Marketplaces (fase 1): regra de preço por conta ou por anúncio.
-- Nesta fase a regra só é gravada e simulada; o envio de preço aos canais chega na fase 4.

create table if not exists hub.price_rules (
  id bigserial primary key,
  tenant_id text not null,
  scope text not null check (scope in ('account','listing')),
  channel_account_id bigint references hub.channel_accounts(id) on delete cascade,
  listing_id bigint references hub.listings(id) on delete cascade,
  -- Preço de partida: venda, promocional (se houver, senão venda) ou custo do cadastro.
  base text not null default 'sale' check (base in ('sale','promo_or_sale','cost')),
  -- Ajuste: % (negativo = desconto), R$ (negativo = desconto) ou preço fixo.
  adjust text not null default 'pct' check (adjust in ('pct','amount','fixed')),
  value numeric(14,4) not null default 0,
  rounding text not null default 'none' check (rounding in ('none','90','99')),
  -- Preço "de" (riscado): o preço de venda com o mesmo ajuste, ou nenhum.
  show_from text not null default 'sale' check (show_from in ('sale','none')),
  min_price numeric(14,2) check (min_price is null or min_price >= 0),
  updated_by text,
  updated_at timestamptz not null default now(),
  constraint ck_hub_price_rules_target check (
    (scope = 'account' and channel_account_id is not null and listing_id is null) or
    (scope = 'listing' and listing_id is not null and channel_account_id is null)),
  constraint ck_hub_price_rules_value check (
    (adjust = 'pct' and value > -100) or adjust = 'amount' or (adjust = 'fixed' and value > 0))
);
create unique index if not exists uq_hub_price_rules_account on hub.price_rules(channel_account_id) where scope = 'account';
create unique index if not exists uq_hub_price_rules_listing on hub.price_rules(listing_id) where scope = 'listing';
create index if not exists idx_hub_price_rules_tenant on hub.price_rules(tenant_id);
