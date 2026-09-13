CREATE TABLE IF NOT EXISTS volt_price.bank_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES volt_price.tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  institution text,
  account_type text NOT NULL DEFAULT 'checking',
  currency text NOT NULL DEFAULT 'BRL',
  opening_balance numeric(18,2) NOT NULL DEFAULT 0,
  opening_balance_date date NOT NULL DEFAULT current_date,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,name)
);

CREATE TABLE IF NOT EXISTS volt_price.financial_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES volt_price.tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  direction text NOT NULL CHECK(direction IN ('inflow','outflow','both')),
  dre_group text,
  parent_id uuid REFERENCES volt_price.financial_categories(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,name)
);

CREATE TABLE IF NOT EXISTS volt_price.cost_centers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES volt_price.tenants(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,code)
);

CREATE TABLE IF NOT EXISTS volt_price.cash_recurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES volt_price.tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  direction text NOT NULL CHECK(direction IN ('inflow','outflow')),
  amount numeric(18,2) NOT NULL CHECK(amount>0),
  frequency text NOT NULL CHECK(frequency IN ('weekly','monthly','yearly')),
  interval_count integer NOT NULL DEFAULT 1 CHECK(interval_count>0),
  next_due_date date NOT NULL,
  end_date date,
  category_id uuid REFERENCES volt_price.financial_categories(id) ON DELETE SET NULL,
  cost_center_id uuid REFERENCES volt_price.cost_centers(id) ON DELETE SET NULL,
  bank_account_id uuid REFERENCES volt_price.bank_accounts(id) ON DELETE SET NULL,
  description text,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','finished')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE volt_price.cash_entries
  ADD COLUMN IF NOT EXISTS direction text,
  ADD COLUMN IF NOT EXISTS competence_date date,
  ADD COLUMN IF NOT EXISTS expected_date date,
  ADD COLUMN IF NOT EXISTS realized_date date,
  ADD COLUMN IF NOT EXISTS realized_amount numeric(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bank_account_id uuid REFERENCES volt_price.bank_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS category_id uuid REFERENCES volt_price.financial_categories(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cost_center_id uuid REFERENCES volt_price.cost_centers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS recurrence_id uuid REFERENCES volt_price.cash_recurrences(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS parent_entry_id uuid REFERENCES volt_price.cash_entries(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS installment_number integer,
  ADD COLUMN IF NOT EXISTS installment_total integer,
  ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS source_ref text,
  ADD COLUMN IF NOT EXISTS is_fixed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS variable_percent numeric(9,4),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

UPDATE volt_price.cash_entries
SET direction=CASE
  WHEN lower(entry_type) LIKE '%in%' OR lower(entry_type) LIKE '%receiv%' THEN 'inflow'
  ELSE 'outflow'
END,
competence_date=coalesce(competence_date,due_date,created_at::date),
expected_date=coalesce(expected_date,due_date,created_at::date)
WHERE direction IS NULL OR competence_date IS NULL OR expected_date IS NULL;

ALTER TABLE volt_price.cash_entries ALTER COLUMN direction SET NOT NULL;
DO $$ BEGIN
  ALTER TABLE volt_price.cash_entries ADD CONSTRAINT vp_cash_direction_check CHECK(direction IN ('inflow','outflow'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_vp_cash_due_status ON volt_price.cash_entries(tenant_id,expected_date,status);
CREATE INDEX IF NOT EXISTS idx_vp_cash_competence ON volt_price.cash_entries(tenant_id,competence_date,direction);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vp_cash_source
  ON volt_price.cash_entries(tenant_id,source_type,source_ref)
  WHERE source_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS volt_price.cash_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES volt_price.tenants(id) ON DELETE CASCADE,
  cash_entry_id uuid NOT NULL REFERENCES volt_price.cash_entries(id) ON DELETE CASCADE,
  bank_account_id uuid REFERENCES volt_price.bank_accounts(id) ON DELETE SET NULL,
  amount numeric(18,2) NOT NULL CHECK(amount>0),
  settled_at timestamptz NOT NULL DEFAULT now(),
  note text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES volt_price.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vp_cash_settlements_entry ON volt_price.cash_settlements(cash_entry_id,settled_at);

CREATE TABLE IF NOT EXISTS volt_price.marketplace_receivables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES volt_price.tenants(id) ON DELETE CASCADE,
  order_id uuid REFERENCES volt_price.orders(id) ON DELETE SET NULL,
  channel text NOT NULL,
  external_order_id text NOT NULL,
  gross_amount numeric(18,2) NOT NULL DEFAULT 0,
  fees_amount numeric(18,2) NOT NULL DEFAULT 0,
  net_amount numeric(18,2) NOT NULL DEFAULT 0,
  expected_date date,
  realized_date date,
  status text NOT NULL DEFAULT 'expected' CHECK(status IN ('expected','available','received','held','adjusted','cancelled')),
  cash_entry_id uuid REFERENCES volt_price.cash_entries(id) ON DELETE SET NULL,
  version integer NOT NULL DEFAULT 1,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,channel,external_order_id,version)
);
CREATE INDEX IF NOT EXISTS idx_vp_receivables_expected ON volt_price.marketplace_receivables(tenant_id,expected_date,status);

DO $$ DECLARE tbl text; BEGIN
  FOREACH tbl IN ARRAY ARRAY['bank_accounts','financial_categories','cost_centers','cash_recurrences','cash_settlements','marketplace_receivables']
  LOOP
    EXECUTE format('ALTER TABLE volt_price.%I ENABLE ROW LEVEL SECURITY',tbl);
    EXECUTE format('ALTER TABLE volt_price.%I FORCE ROW LEVEL SECURITY',tbl);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON volt_price.%I',tbl);
    EXECUTE format('CREATE POLICY tenant_isolation ON volt_price.%I USING (volt_price.is_platform_admin() OR tenant_id=volt_price.current_tenant_id()) WITH CHECK (volt_price.is_platform_admin() OR tenant_id=volt_price.current_tenant_id())',tbl);
  END LOOP;
END $$;
