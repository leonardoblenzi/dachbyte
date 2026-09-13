BEGIN;

ALTER TABLE public.usuarios
  DROP CONSTRAINT IF EXISTS usuarios_nivel_check;

ALTER TABLE public.usuarios
  ADD CONSTRAINT usuarios_nivel_check
  CHECK (nivel IN ('usuario', 'administrador', 'admin_master'));

COMMIT;
