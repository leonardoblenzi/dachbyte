CREATE TABLE IF NOT EXISTS ticket_assignees (
  id SERIAL PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ux_ticket_assignees_ticket_user UNIQUE (ticket_id, user_id)
);

CREATE INDEX IF NOT EXISTS ix_ticket_assignees_ticket_id ON ticket_assignees (ticket_id);
CREATE INDEX IF NOT EXISTS ix_ticket_assignees_user_id ON ticket_assignees (user_id);

CREATE TABLE IF NOT EXISTS ticket_departments (
  id SERIAL PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  department_id VARCHAR(36) NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ux_ticket_departments_ticket_department UNIQUE (ticket_id, department_id)
);

CREATE INDEX IF NOT EXISTS ix_ticket_departments_ticket_id ON ticket_departments (ticket_id);
CREATE INDEX IF NOT EXISTS ix_ticket_departments_department_id ON ticket_departments (department_id);
