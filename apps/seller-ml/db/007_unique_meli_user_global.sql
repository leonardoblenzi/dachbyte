-- db/007_unique_meli_user_global.sql
-- Garante que uma conta ML (meli_user_id) não possa existir em mais de uma empresa.

do $$
begin
  -- Cria um índice UNIQUE global em meli_user_id.
  -- Observação: se já existir duplicidade no banco (mesmo meli_user_id em empresas diferentes),
  -- esta migration vai falhar. Aí você precisa decidir qual vínculo manter e remover o outro antes.
  if not exists (
    select 1
      from pg_indexes
     where schemaname = 'public'
       and indexname = 'ux_meli_contas_meli_user_global'
  ) then
    execute 'create unique index ux_meli_contas_meli_user_global on meli_contas (meli_user_id)';
  end if;
end $$;
