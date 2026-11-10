-- Conexão única: no Mercado Livre a conta é autorizada uma vez na DACHBYTE e as chaves
-- ficam com o módulo ML. O Hub guarda só a conta ("dachbyte") e pede a chave quando precisa.
alter table hub.channel_accounts
  add column if not exists connection_source text not null default 'own';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'channel_accounts_connection_source_check') then
    alter table hub.channel_accounts
      add constraint channel_accounts_connection_source_check check (connection_source in ('own', 'dachbyte'));
  end if;
end $$;
