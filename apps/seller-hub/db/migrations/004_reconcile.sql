-- DACH Hub · Etapa E4: reconciliação (estoque mudado fora do Hub), alertas e piloto.

-- Quando o Hub viu o estoque do canal pela última vez (importação, envio conferido ou conferência).
alter table hub.listings add column if not exists channel_checked_at timestamptz;

-- O que fazer quando o estoque de uma conta ativa muda fora do Hub:
-- overwrite = reenviar o valor do Hub (padrão); alert = só avisar e esperar decisão.
alter table hub.channel_accounts
  add column if not exists divergence_policy text not null default 'overwrite' check (divergence_policy in ('overwrite','alert')),
  add column if not exists last_reconciled_at timestamptz;

-- Conferências: uma por conta de cada vez, com progresso (mesmo padrão da importação).
create table if not exists hub.reconcile_runs (
  id bigserial primary key,
  channel_account_id bigint not null references hub.channel_accounts(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued','running','succeeded','failed')),
  trigger text not null default 'schedule' check (trigger in ('manual','schedule')),
  requested_by text,
  checked integer not null default 0,
  divergences integer not null default 0,
  overwritten integer not null default 0,
  error_message text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  heartbeat_at timestamptz not null default now(),
  finished_at timestamptz
);
create unique index if not exists uq_hub_reconcile_active on hub.reconcile_runs(channel_account_id) where status in ('queued','running');
create index if not exists idx_hub_reconcile_runs_account on hub.reconcile_runs(channel_account_id, id desc);

-- Estoque mudado fora do Hub: o canal mostra um valor que vendas e envios do Hub não explicam.
-- recurring = o mesmo anúncio divergiu várias vezes em 24h (outro sistema escrevendo): o Hub para de sobrescrever.
create table if not exists hub.stock_divergences (
  id bigserial primary key,
  tenant_id text not null,
  listing_id bigint not null references hub.listings(id) on delete cascade,
  channel_account_id bigint not null references hub.channel_accounts(id) on delete cascade,
  run_id bigint references hub.reconcile_runs(id) on delete set null,
  expected numeric(14,4),
  observed numeric(14,4),
  recurring boolean not null default false,
  status text not null default 'open' check (status in ('open','overwritten','ignored','resolved')),
  resolved_by text,
  resolved_at timestamptz,
  detected_at timestamptz not null default now()
);
create index if not exists idx_hub_divergences_open on hub.stock_divergences(tenant_id, status, detected_at desc);
create index if not exists idx_hub_divergences_listing on hub.stock_divergences(listing_id, detected_at desc);
