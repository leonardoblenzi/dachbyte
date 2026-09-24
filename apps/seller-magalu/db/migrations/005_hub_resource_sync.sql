-- DACHBYTE Seller · Magalu · Etapa 5
-- Estado de sincronização do recurso da conta Magalu no Hub.

alter table magalu.accounts
  add column if not exists hub_resource_key text,
  add column if not exists hub_sync_status text not null default 'pending'
    check (hub_sync_status in ('pending', 'queued', 'syncing', 'synced', 'failed')),
  add column if not exists hub_synced_at timestamptz,
  add column if not exists hub_sync_error text;

create index if not exists idx_magalu_accounts_hub_sync_status
  on magalu.accounts(hub_sync_status, updated_at asc);
