-- Conexão única do Mercado Livre: a conta é autorizada uma vez na DACHBYTE e cada
-- produto (módulo DACH ML, DACH Hub) ativa as contas que usa. Telas, rotinas e
-- cobrança do módulo ML consideram só contas ativas em 'ml'.

CREATE TABLE IF NOT EXISTS ml.meli_conta_produtos (
  meli_conta_id BIGINT NOT NULL REFERENCES ml.meli_contas(id) ON DELETE CASCADE,
  produto TEXT NOT NULL CHECK (produto IN ('ml', 'dach_hub')),
  ativado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ativado_por TEXT NULL,
  PRIMARY KEY (meli_conta_id, produto)
);

CREATE INDEX IF NOT EXISTS ix_meli_conta_produtos_produto
  ON ml.meli_conta_produtos (produto, meli_conta_id);

-- Todas as contas existentes continuam no módulo ML: nada muda para quem já usa.
INSERT INTO ml.meli_conta_produtos (meli_conta_id, produto, ativado_por)
SELECT id, 'ml', 'migration_080'
  FROM ml.meli_contas
ON CONFLICT DO NOTHING;

-- Toda conta nova nasce ativa no produto que iniciou a autorização. Os fluxos
-- antigos (OAuth do módulo, teste grátis, painel admin) não definem nada e caem
-- em 'ml'. A autorização iniciada pelo Hub define ml.connection_product = 'dach_hub'
-- com SET LOCAL na mesma transação.
CREATE OR REPLACE FUNCTION ml.meli_contas_produto_inicial() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  origem TEXT := NULLIF(current_setting('ml.connection_product', true), '');
BEGIN
  INSERT INTO ml.meli_conta_produtos (meli_conta_id, produto, ativado_por)
  VALUES (NEW.id, CASE WHEN origem = 'dach_hub' THEN 'dach_hub' ELSE 'ml' END, COALESCE(origem, 'ml'))
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_meli_contas_produto_inicial ON ml.meli_contas;
CREATE TRIGGER trg_meli_contas_produto_inicial
  AFTER INSERT ON ml.meli_contas
  FOR EACH ROW EXECUTE FUNCTION ml.meli_contas_produto_inicial();

-- Autorização iniciada por outro produto: não há usuário do módulo ML, só a
-- pessoa do hub de acessos (id global) e o produto de origem.
ALTER TABLE ml.oauth_states ALTER COLUMN usuario_id DROP NOT NULL;
ALTER TABLE ml.oauth_states ADD COLUMN IF NOT EXISTS produto TEXT NOT NULL DEFAULT 'ml';
ALTER TABLE ml.oauth_states ADD COLUMN IF NOT EXISTS origem_usuario_global_id TEXT NULL;
