-- Mantém bancos já existentes compatíveis com o cadastro multiempresa.
-- Sem estes campos o ORM não consegue ler /platform/companies e a rota responde 500.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS cnpj VARCHAR(32);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS responsible_name VARCHAR(255);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS phone_primary VARCHAR(40);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS phone_secondary VARCHAR(40);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS status VARCHAR(40) NOT NULL DEFAULT 'active';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE companies ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS ux_companies_cnpj ON companies (cnpj);
CREATE INDEX IF NOT EXISTS ix_companies_name ON companies (name);
CREATE INDEX IF NOT EXISTS ix_companies_status ON companies (status);
