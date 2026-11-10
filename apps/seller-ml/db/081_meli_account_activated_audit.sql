INSERT INTO ml.auth_audit_retention_rules (evento, descricao, retention_days)
VALUES ('meli_account_activated', 'Ativacao no modulo ML de conta ja conectada na DACHBYTE', 365)
ON CONFLICT (evento) DO NOTHING;
