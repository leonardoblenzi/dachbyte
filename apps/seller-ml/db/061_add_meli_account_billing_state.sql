-- Billing state is local metadata while Davantti Pay becomes the source of truth.
-- Existing accounts remain operational during the multiconta migration.
ALTER TABLE meli_contas
  ADD COLUMN IF NOT EXISTS billing_status text NOT NULL DEFAULT 'legacy_active',
  ADD COLUMN IF NOT EXISTS billing_mode text NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS usage_policy text NOT NULL DEFAULT 'metered',
  ADD COLUMN IF NOT EXISTS range_enforcement boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS plan_code text,
  ADD COLUMN IF NOT EXISTS order_range_code text,
  ADD COLUMN IF NOT EXISTS last_closed_period_start date,
  ADD COLUMN IF NOT EXISTS last_closed_period_end date,
  ADD COLUMN IF NOT EXISTS last_closed_period_orders integer,
  ADD COLUMN IF NOT EXISTS recommended_range_code text,
  ADD COLUMN IF NOT EXISTS billing_grace_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS billing_review_due_at timestamptz,
  ADD COLUMN IF NOT EXISTS billing_updated_at timestamptz NOT NULL DEFAULT now();

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
    'internal_unlimited'
  ));

ALTER TABLE meli_contas
  DROP CONSTRAINT IF EXISTS meli_contas_billing_mode_check;

ALTER TABLE meli_contas
  ADD CONSTRAINT meli_contas_billing_mode_check
  CHECK (billing_mode IN ('legacy', 'paid', 'trial', 'courtesy', 'internal'));

ALTER TABLE meli_contas
  DROP CONSTRAINT IF EXISTS meli_contas_usage_policy_check;

ALTER TABLE meli_contas
  ADD CONSTRAINT meli_contas_usage_policy_check
  CHECK (usage_policy IN ('metered', 'unlimited'));

CREATE INDEX IF NOT EXISTS ix_meli_contas_billing_status
  ON meli_contas (empresa_id, billing_status);

CREATE INDEX IF NOT EXISTS ix_meli_contas_billing_review
  ON meli_contas (billing_review_due_at)
  WHERE billing_review_due_at IS NOT NULL;

-- Explicitly preserve all existing accounts as operational legacy accounts.
-- This migration does not touch subscription/end-date fields; current access
-- validity remains controlled by the existing Hub tenant/module entitlement.
UPDATE meli_contas
   SET billing_status = 'legacy_active',
       billing_mode = 'legacy',
       usage_policy = 'unlimited',
       range_enforcement = false,
       billing_updated_at = now()
 WHERE billing_status = 'legacy_active'
   AND billing_mode = 'legacy';
