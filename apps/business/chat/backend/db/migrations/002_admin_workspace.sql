ALTER TABLE users ADD COLUMN IF NOT EXISTS department VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_extension VARCHAR(40);
ALTER TABLE users ADD COLUMN IF NOT EXISTS birthday VARCHAR(10);
ALTER TABLE users ADD COLUMN IF NOT EXISTS role_title VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

UPDATE users
SET access_level = 'usuario'
WHERE access_level = 'padrao';

UPDATE users
SET department = COALESCE(department, 'Administracao'),
    role_title = COALESCE(role_title, 'Administrador do sistema'),
    phone_extension = COALESCE(phone_extension, '1000'),
    birthday = COALESCE(birthday, '01-01')
WHERE username = 'admin';

UPDATE users
SET department = COALESCE(department, 'TI'),
    role_title = COALESCE(role_title, 'Coordenador de TI'),
    phone_extension = COALESCE(phone_extension, '2000'),
    birthday = COALESCE(birthday, '02-02')
WHERE username = 'coordenador';

UPDATE users
SET department = COALESCE(department, 'TI'),
    role_title = COALESCE(role_title, 'Analista'),
    phone_extension = COALESCE(phone_extension, '2001'),
    birthday = COALESCE(birthday, '03-03')
WHERE username = 'usuario';

CREATE TABLE IF NOT EXISTS tickets (
  id SERIAL PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  description TEXT NOT NULL,
  priority VARCHAR(40) NOT NULL DEFAULT 'Media',
  status VARCHAR(40) NOT NULL DEFAULT 'Aberto',
  department VARCHAR(100),
  channel VARCHAR(80) NOT NULL DEFAULT 'Web',
  created_by_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_to_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ
);

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS priority VARCHAR(40) DEFAULT 'Media';
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS status VARCHAR(40) DEFAULT 'Aberto';
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS department VARCHAR(100);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS channel VARCHAR(80) DEFAULT 'Web';
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS ix_users_department ON users (department);
CREATE INDEX IF NOT EXISTS ix_tickets_department ON tickets (department);
CREATE INDEX IF NOT EXISTS ix_tickets_status ON tickets (status);
CREATE INDEX IF NOT EXISTS ix_tickets_created_by ON tickets (created_by_id);
CREATE INDEX IF NOT EXISTS ix_tickets_assigned_to ON tickets (assigned_to_id);
