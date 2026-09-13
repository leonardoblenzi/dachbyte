CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(40);
ALTER TABLE users ADD COLUMN IF NOT EXISTS uuid VARCHAR(36);
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_platform_admin BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(40) NOT NULL DEFAULT 'active';

UPDATE users
SET is_platform_admin = TRUE
WHERE access_level = 'master' OR username = 'admin';

UPDATE users
SET uuid = gen_random_uuid()::text
WHERE uuid IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_users_uuid ON users (uuid);

UPDATE users
SET status = CASE WHEN is_active THEN 'active' ELSE 'inactive' END
WHERE status IS NULL OR status = '';

CREATE TABLE IF NOT EXISTS companies (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  cnpj VARCHAR(32) UNIQUE,
  responsible_name VARCHAR(255),
  phone_primary VARCHAR(40),
  phone_secondary VARCHAR(40),
  status VARCHAR(40) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);

INSERT INTO companies (id, name, cnpj, responsible_name, status)
VALUES ('00000000-0000-0000-0000-000000000001', 'Empresa Padrao', NULL, 'Admin Master', 'active')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS departments (
  id VARCHAR(36) PRIMARY KEY,
  company_id VARCHAR(36) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  description TEXT,
  status VARCHAR(40) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_departments_company_name ON departments (company_id, lower(name));
CREATE INDEX IF NOT EXISTS ix_departments_company_id ON departments (company_id);

INSERT INTO departments (id, company_id, name, status)
SELECT gen_random_uuid()::text, '00000000-0000-0000-0000-000000000001', value, 'active'
FROM unnest(ARRAY['TI', 'Suporte', 'Comercial', 'Financeiro', 'Operacao', 'Produto', 'Administracao']) AS value
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS company_users (
  id VARCHAR(36) PRIMARY KEY,
  company_id VARCHAR(36) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  department_id VARCHAR(36) REFERENCES departments(id) ON DELETE SET NULL,
  role VARCHAR(40) NOT NULL DEFAULT 'user',
  status VARCHAR(40) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_company_users_company_user ON company_users (company_id, user_id);
CREATE INDEX IF NOT EXISTS ix_company_users_company_id ON company_users (company_id);
CREATE INDEX IF NOT EXISTS ix_company_users_user_id ON company_users (user_id);
CREATE INDEX IF NOT EXISTS ix_company_users_department_id ON company_users (department_id);

INSERT INTO company_users (id, company_id, user_id, department_id, role, status)
SELECT
  gen_random_uuid()::text,
  '00000000-0000-0000-0000-000000000001',
  u.id,
  d.id,
  CASE
    WHEN u.is_platform_admin OR u.access_level = 'master' THEN 'master_admin'
    WHEN u.access_level = 'coordenador' THEN 'coordinator'
    ELSE 'user'
  END,
  CASE WHEN u.is_active THEN 'active' ELSE 'inactive' END
FROM users u
LEFT JOIN departments d
  ON d.company_id = '00000000-0000-0000-0000-000000000001'
 AND lower(d.name) = lower(COALESCE(u.department, 'Operacao'))
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS audit_logs (
  id VARCHAR(36) PRIMARY KEY,
  company_id VARCHAR(36) REFERENCES companies(id) ON DELETE SET NULL,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(100) NOT NULL,
  entity_id VARCHAR(80),
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_audit_logs_company_id ON audit_logs (company_id);
CREATE INDEX IF NOT EXISTS ix_audit_logs_actor_user_id ON audit_logs (actor_user_id);
CREATE INDEX IF NOT EXISTS ix_audit_logs_action ON audit_logs (action);
CREATE INDEX IF NOT EXISTS ix_audit_logs_entity_type ON audit_logs (entity_type);

ALTER TABLE messages ADD COLUMN IF NOT EXISTS company_id VARCHAR(36) REFERENCES companies(id);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS company_id VARCHAR(36) REFERENCES companies(id);
ALTER TABLE ticket_messages ADD COLUMN IF NOT EXISTS company_id VARCHAR(36) REFERENCES companies(id);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS company_id VARCHAR(36) REFERENCES companies(id);
ALTER TABLE chat_groups ADD COLUMN IF NOT EXISTS company_id VARCHAR(36) REFERENCES companies(id);
ALTER TABLE file_uploads ADD COLUMN IF NOT EXISTS company_id VARCHAR(36) REFERENCES companies(id);

UPDATE messages SET company_id = '00000000-0000-0000-0000-000000000001' WHERE company_id IS NULL;
UPDATE tickets SET company_id = '00000000-0000-0000-0000-000000000001' WHERE company_id IS NULL;
UPDATE ticket_messages SET company_id = '00000000-0000-0000-0000-000000000001' WHERE company_id IS NULL;
UPDATE tasks SET company_id = '00000000-0000-0000-0000-000000000001' WHERE company_id IS NULL;
UPDATE chat_groups SET company_id = '00000000-0000-0000-0000-000000000001' WHERE company_id IS NULL;
UPDATE file_uploads SET company_id = '00000000-0000-0000-0000-000000000001' WHERE company_id IS NULL;

ALTER TABLE messages ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE tickets ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE ticket_messages ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE tasks ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE chat_groups ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE file_uploads ALTER COLUMN company_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS ix_messages_company_id ON messages (company_id);
CREATE INDEX IF NOT EXISTS ix_tickets_company_id ON tickets (company_id);
CREATE INDEX IF NOT EXISTS ix_ticket_messages_company_id ON ticket_messages (company_id);
CREATE INDEX IF NOT EXISTS ix_tasks_company_id ON tasks (company_id);
CREATE INDEX IF NOT EXISTS ix_chat_groups_company_id ON chat_groups (company_id);
CREATE INDEX IF NOT EXISTS ix_file_uploads_company_id ON file_uploads (company_id);
