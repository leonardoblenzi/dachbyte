alter table magalu.accounts
  add column if not exists last_oauth_at timestamptz;

alter table magalu.tokens
  add column if not exists last_refresh_attempt_at timestamptz;

alter table magalu.oauth_states
  add column if not exists requested_scopes text[] not null default '{}'::text[];

create index if not exists idx_magalu_tokens_expiry
  on magalu.tokens(access_expires_at)
  where refresh_token_ciphertext is not null;

create index if not exists idx_magalu_accounts_status
  on magalu.accounts(dach_tenant_id, status, updated_at desc);
