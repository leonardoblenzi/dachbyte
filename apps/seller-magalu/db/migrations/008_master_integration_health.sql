-- DACHBYTE Seller · Magalu · Etapa 6
-- Vincula o OAuth iniciado pelo Painel Master à conta/tenant já existente.
-- Nenhum token ou secret adicional é persistido nesta migration.

alter table magalu.oauth_states
  add column if not exists flow_mode text not null default 'tenant',
  add column if not exists target_account_id bigint references magalu.accounts(id) on delete cascade,
  add column if not exists expected_magalu_tenant_id text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'ck_magalu_oauth_states_flow_mode'
       and conrelid = 'magalu.oauth_states'::regclass
  ) then
    alter table magalu.oauth_states
      add constraint ck_magalu_oauth_states_flow_mode
      check (flow_mode in ('tenant','master_reconnect'));
  end if;
end $$;

create index if not exists idx_magalu_oauth_states_master_target
  on magalu.oauth_states(target_account_id, expires_at)
  where flow_mode='master_reconnect' and used_at is null;
