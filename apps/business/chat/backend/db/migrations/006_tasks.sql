CREATE TABLE IF NOT EXISTS tasks (
  id SERIAL PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  description TEXT,
  priority VARCHAR(40) NOT NULL DEFAULT 'medium',
  category VARCHAR(100) NOT NULL DEFAULT 'Operacao',
  status VARCHAR(40) NOT NULL DEFAULT 'backlog',
  due_date VARCHAR(10),
  created_by_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_to_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ix_tasks_title ON tasks (title);
CREATE INDEX IF NOT EXISTS ix_tasks_status ON tasks (status);
CREATE INDEX IF NOT EXISTS ix_tasks_category ON tasks (category);
CREATE INDEX IF NOT EXISTS ix_tasks_created_by ON tasks (created_by_id);
CREATE INDEX IF NOT EXISTS ix_tasks_assigned_to ON tasks (assigned_to_id);
