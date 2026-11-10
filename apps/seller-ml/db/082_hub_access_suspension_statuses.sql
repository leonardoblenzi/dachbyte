-- O hub de acessos passa a avisar o módulo quando desliga uma conta paga (atraso depois
-- do período pago, estorno, contestação, período vencido). Esses estados já existem na
-- tela de status (services/accountBillingStatus.js) e agora podem ser gravados.
ALTER TABLE meli_contas
  DROP CONSTRAINT IF EXISTS meli_contas_billing_status_check;

ALTER TABLE meli_contas
  ADD CONSTRAINT meli_contas_billing_status_check
  CHECK (billing_status IN (
    'legacy_active',
    'active',
    'awaiting_subscription',
    'range_exceeded',
    'suspended_by_range',
    'suspended_by_payment',
    'courtesy_unlimited',
    'internal_unlimited',
    'unlinked',
    'expired',
    'past_due',
    'refunded',
    'chargeback'
  ));
