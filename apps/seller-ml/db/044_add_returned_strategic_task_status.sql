BEGIN;

ALTER TABLE IF EXISTS ml_strategic_tasks
  DROP CONSTRAINT IF EXISTS ck_ml_strategic_tasks_status;

ALTER TABLE IF EXISTS ml_strategic_tasks
  ADD CONSTRAINT ck_ml_strategic_tasks_status CHECK (
    status IN ('pending', 'in_progress', 'review', 'returned', 'completed', 'canceled')
  );

UPDATE ml_strategic_tasks t
   SET status = 'returned',
       completed_at = NULL,
       completed_by_user_id = NULL,
       created_round_id = NULL,
       updated_at = NOW()
  FROM ml_strategic_rounds r
 WHERE r.source_task_id = t.id
   AND r.status = 'interrupted'
   AND coalesce(r.error, '') ILIKE 'Devolvido para tarefas:%'
   AND t.status = 'review';

DROP INDEX IF EXISTS ux_ml_strategic_tasks_open_account_mlb;

CREATE UNIQUE INDEX IF NOT EXISTS ux_ml_strategic_tasks_open_account_mlb
  ON ml_strategic_tasks (account_key, mlb)
  WHERE status IN ('pending', 'in_progress', 'review', 'returned');

COMMIT;
