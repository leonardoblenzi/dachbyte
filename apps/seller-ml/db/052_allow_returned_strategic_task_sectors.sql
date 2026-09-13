BEGIN;

ALTER TABLE IF EXISTS ml_strategic_task_sectors
  DROP CONSTRAINT IF EXISTS ck_ml_strategic_task_sectors_status;

ALTER TABLE IF EXISTS ml_strategic_task_sectors
  ADD CONSTRAINT ck_ml_strategic_task_sectors_status CHECK (
    status IN ('pending','in_progress','review','returned','completed','canceled')
  );

COMMIT;
