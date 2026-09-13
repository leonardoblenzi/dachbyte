BEGIN;

-- 1) garante tabela oficial
CREATE TABLE IF NOT EXISTS public.migracoes (
  id bigserial primary key,
  arquivo text not null unique,
  aplicado_em timestamptz not null default now()
);

-- 2) se schema_migrations existir, copia histórico
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'schema_migrations'
  ) THEN
    INSERT INTO public.migracoes (arquivo, aplicado_em)
    SELECT filename, COALESCE(applied_at, now())
    FROM public.schema_migrations
    ON CONFLICT (arquivo) DO NOTHING;
  END IF;
END $$;

-- 3) opcional (recomendado): remove tabela antiga pra não haver ambiguidade
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'schema_migrations'
  ) THEN
    DROP TABLE public.schema_migrations;
  END IF;
END $$;

COMMIT;
