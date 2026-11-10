-- Teste grátis do ML: os dados da empresa vêm de um formulário ANTES da autorização
-- no Mercado Livre (e-mail, CNPJ, nome, empresa). Ficam na sessão do teste até o
-- retorno da autorização, quando a empresa e o usuário são criados.
ALTER TABLE ml.public_trial_oauth_sessions ADD COLUMN IF NOT EXISTS full_name TEXT NULL;
ALTER TABLE ml.public_trial_oauth_sessions ADD COLUMN IF NOT EXISTS company_name TEXT NULL;
ALTER TABLE ml.public_trial_oauth_sessions ADD COLUMN IF NOT EXISTS document_number TEXT NULL;

-- Medição da faixa: falha tenta de novo (até 3 vezes, a cada 10 min) em vez de
-- ficar "Validando faixa" até o mês virar.
ALTER TABLE ml.ml_closed_month_order_measurements ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
