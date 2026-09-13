CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS volt_price;

CREATE OR REPLACE FUNCTION volt_price.current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.vp_tenant_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION volt_price.is_platform_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('app.vp_platform_admin', true), 'false') = 'true' $$;

CREATE TABLE IF NOT EXISTS volt_price.migrations (
  id bigserial PRIMARY KEY, filename text NOT NULL UNIQUE, checksum text, applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS volt_price.tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, slug text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','offboarding','deleted')),
  timezone text NOT NULL DEFAULT 'America/Sao_Paulo', currency text NOT NULL DEFAULT 'BRL', settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS volt_price.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL UNIQUE CHECK(email=lower(email)), full_name text NOT NULL,
  password_hash text NOT NULL, status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled','locked')),
  last_login_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS volt_price.memberships (
  tenant_id uuid NOT NULL REFERENCES volt_price.tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES volt_price.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK(role IN ('owner','admin','finance','pricing','marketing','analyst','viewer')),
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,user_id)
);
CREATE TABLE IF NOT EXISTS volt_price.platform_admins (
  user_id uuid PRIMARY KEY REFERENCES volt_price.users(id) ON DELETE CASCADE,
  platform_role text NOT NULL DEFAULT 'platform_super_admin', status text NOT NULL DEFAULT 'active',
  mfa_required boolean NOT NULL DEFAULT true, totp_secret_cipher text, mfa_confirmed boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS volt_price.sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES volt_price.users(id) ON DELETE CASCADE,
  tenant_id uuid REFERENCES volt_price.tenants(id) ON DELETE CASCADE, token_hash text NOT NULL UNIQUE, csrf_hash text NOT NULL,
  expires_at timestamptz NOT NULL, revoked_at timestamptz, ip text, user_agent text, support_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vp_sessions_user_active ON volt_price.sessions(user_id,expires_at DESC) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS volt_price.oauth_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), state_hash text NOT NULL UNIQUE, tenant_id uuid NOT NULL REFERENCES volt_price.tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES volt_price.users(id) ON DELETE CASCADE, channel text NOT NULL, payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz NOT NULL, used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS volt_price.audit_logs (
  id bigserial PRIMARY KEY, tenant_id uuid REFERENCES volt_price.tenants(id) ON DELETE SET NULL, actor_user_id uuid REFERENCES volt_price.users(id) ON DELETE SET NULL,
  actor_type text NOT NULL DEFAULT 'user', action text NOT NULL, resource_type text, resource_id text, metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip text, user_agent text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vp_audit_tenant_time ON volt_price.audit_logs(tenant_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vp_audit_action_time ON volt_price.audit_logs(action,created_at DESC);

CREATE OR REPLACE FUNCTION volt_price.prevent_audit_log_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'volt_price.audit_logs is append-only';
END $$;
DROP TRIGGER IF EXISTS trg_vp_audit_logs_append_only ON volt_price.audit_logs;
CREATE TRIGGER trg_vp_audit_logs_append_only
BEFORE UPDATE OR DELETE ON volt_price.audit_logs
FOR EACH ROW EXECUTE FUNCTION volt_price.prevent_audit_log_mutation();

CREATE TABLE IF NOT EXISTS volt_price.integration_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES volt_price.tenants(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK(channel IN ('tray','meli','shopee')), status text NOT NULL DEFAULT 'active', display_name text NOT NULL,
  external_account_id text NOT NULL DEFAULT 'default', api_base_url text, token_cipher text, refresh_token_cipher text,
  token_expires_at timestamptz, refresh_expires_at timestamptz, metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_refresh_at timestamptz, last_sync_at timestamptz, last_error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,channel,external_account_id)
);
CREATE INDEX IF NOT EXISTS idx_vp_integrations_tenant_channel ON volt_price.integration_connections(tenant_id,channel,status);

CREATE TABLE IF NOT EXISTS volt_price.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES volt_price.tenants(id) ON DELETE CASCADE,
  source_channel text NOT NULL, source_order_id text NOT NULL, status text, order_date date, modified_at timestamptz,
  total_amount numeric(18,2), marketplace text, marketplace_order_id text, raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,source_channel,source_order_id)
);
CREATE INDEX IF NOT EXISTS idx_vp_orders_tenant_date ON volt_price.orders(tenant_id,order_date DESC);
CREATE INDEX IF NOT EXISTS idx_vp_orders_marketplace_order ON volt_price.orders(tenant_id,marketplace,marketplace_order_id);

CREATE TABLE IF NOT EXISTS volt_price.fee_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES volt_price.tenants(id) ON DELETE CASCADE,
  channel text NOT NULL, external_order_id text NOT NULL, summary jsonb NOT NULL DEFAULT '{}'::jsonb, raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vp_fees_order_time ON volt_price.fee_snapshots(tenant_id,channel,external_order_id,fetched_at DESC);

CREATE TABLE IF NOT EXISTS volt_price.commission_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid REFERENCES volt_price.tenants(id) ON DELETE CASCADE,
  marketplace text NOT NULL, category text, title text NOT NULL, commission_percent_min numeric(9,4), commission_percent_max numeric(9,4), fixed_fee numeric(18,2),
  extra_fees jsonb NOT NULL DEFAULT '[]'::jsonb, notes text, source_url text, source_type text NOT NULL DEFAULT 'MANUAL',
  valid_from date, valid_to date, last_verified_at date, status text NOT NULL DEFAULT 'current',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vp_commission_marketplace ON volt_price.commission_references(marketplace,category,status);

CREATE TABLE IF NOT EXISTS volt_price.module_state (
  tenant_id uuid NOT NULL REFERENCES volt_price.tenants(id) ON DELETE CASCADE, module_key text NOT NULL, payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,module_key)
);
CREATE TABLE IF NOT EXISTS volt_price.products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES volt_price.tenants(id) ON DELETE CASCADE, sku text NOT NULL,
  name text NOT NULL, cost numeric(18,4), stock numeric(18,4), metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,sku)
);
CREATE TABLE IF NOT EXISTS volt_price.profit_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES volt_price.tenants(id) ON DELETE CASCADE, source_order_id text,
  source_channel text, gross_amount numeric(18,2), fees_amount numeric(18,2), shipping_amount numeric(18,2), ads_amount numeric(18,2), tax_amount numeric(18,2), cost_amount numeric(18,2), contribution_amount numeric(18,2), payload jsonb NOT NULL DEFAULT '{}'::jsonb, calculated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS volt_price.pricing_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES volt_price.tenants(id) ON DELETE CASCADE, product_id uuid REFERENCES volt_price.products(id) ON DELETE SET NULL,
  state text, current_price numeric(18,2), recommended_price numeric(18,2), confidence numeric(5,2), recommendation text, evidence jsonb NOT NULL DEFAULT '[]'::jsonb, status text NOT NULL DEFAULT 'suggested', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS volt_price.market_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES volt_price.tenants(id) ON DELETE CASCADE, product_id uuid REFERENCES volt_price.products(id) ON DELETE SET NULL,
  channel text, competitor text, observed_price numeric(18,2), payload jsonb NOT NULL DEFAULT '{}'::jsonb, observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS volt_price.ads_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES volt_price.tenants(id) ON DELETE CASCADE, channel text NOT NULL, metric_date date NOT NULL,
  spend numeric(18,2), revenue numeric(18,2), orders integer, payload jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS volt_price.cash_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES volt_price.tenants(id) ON DELETE CASCADE, entry_type text NOT NULL, due_date date,
  amount numeric(18,2) NOT NULL, status text NOT NULL DEFAULT 'open', description text, payload jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS volt_price.audit_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES volt_price.tenants(id) ON DELETE CASCADE, source_channel text, source_order_id text,
  severity text, status text NOT NULL DEFAULT 'open', title text NOT NULL, expected jsonb NOT NULL DEFAULT '{}'::jsonb, realized jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS volt_price.actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES volt_price.tenants(id) ON DELETE CASCADE, action_type text NOT NULL, status text NOT NULL DEFAULT 'planned',
  reason text, before_state jsonb NOT NULL DEFAULT '{}'::jsonb, after_state jsonb NOT NULL DEFAULT '{}'::jsonb, result jsonb NOT NULL DEFAULT '{}'::jsonb, created_by uuid REFERENCES volt_price.users(id) ON DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT now(), evaluated_at timestamptz
);
CREATE TABLE IF NOT EXISTS volt_price.forecasts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES volt_price.tenants(id) ON DELETE CASCADE, forecast_type text NOT NULL, scenario text NOT NULL,
  period_start date, period_end date, payload jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
);

DO $$ DECLARE tbl text; BEGIN
  FOREACH tbl IN ARRAY ARRAY['integration_connections','orders','fee_snapshots','module_state','products','profit_snapshots','pricing_decisions','market_observations','ads_metrics','cash_entries','audit_cases','actions','forecasts']
  LOOP
    EXECUTE format('ALTER TABLE volt_price.%I ENABLE ROW LEVEL SECURITY',tbl);
    EXECUTE format('ALTER TABLE volt_price.%I FORCE ROW LEVEL SECURITY',tbl);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON volt_price.%I',tbl);
    EXECUTE format('CREATE POLICY tenant_isolation ON volt_price.%I USING (volt_price.is_platform_admin() OR tenant_id=volt_price.current_tenant_id()) WITH CHECK (volt_price.is_platform_admin() OR tenant_id=volt_price.current_tenant_id())',tbl);
  END LOOP;
END $$;
ALTER TABLE volt_price.commission_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE volt_price.commission_references FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS commission_select ON volt_price.commission_references;
DROP POLICY IF EXISTS commission_write ON volt_price.commission_references;
CREATE POLICY commission_select ON volt_price.commission_references FOR SELECT USING (volt_price.is_platform_admin() OR tenant_id IS NULL OR tenant_id=volt_price.current_tenant_id());
CREATE POLICY commission_write ON volt_price.commission_references FOR ALL USING (volt_price.is_platform_admin() OR tenant_id=volt_price.current_tenant_id()) WITH CHECK (volt_price.is_platform_admin() OR tenant_id=volt_price.current_tenant_id());

SELECT set_config('app.vp_platform_admin', 'true', true);
-- Tabela puramente informativa. Nao e usada nos calculos de Profit/Pricing.
INSERT INTO volt_price.commission_references (marketplace,category,title,commission_percent_min,commission_percent_max,fixed_fee,extra_fees,notes,source_url,source_type,valid_from,last_verified_at,status)
SELECT v.marketplace,v.category,v.title,v.commission_percent_min::numeric,v.commission_percent_max::numeric,v.fixed_fee::numeric,v.extra_fees,v.notes,v.source_url,v.source_type,v.valid_from,v.last_verified_at,v.status FROM (VALUES
 ('Mercado Livre',NULL,'Clássico/Premium por categoria',10.0,19.0,NULL,'[{"name":"Tarifa fixa","description":"Pode existir conforme faixa de preço/logística"}]'::jsonb,'Referência pública. A taxa exata depende de categoria, tipo de anúncio, preço e logística.','https://developers.mercadolivre.com.br/pt_br/product-identifiers/tarifas-para-anunciar','OFFICIAL_PUBLIC','2026-01-01'::date,'2026-08-07'::date,'current'),
 ('Shopee',NULL,'Tarifas variáveis por conta/programa',NULL,NULL,NULL,'[]'::jsonb,'Manter ajustável conforme Seller Centre, contrato, campanhas, afiliados e logística. Uso somente informativo.','https://open.shopee.com/','OFFICIAL_PUBLIC','2026-01-01'::date,'2026-08-07'::date,'review'),
 ('Magalu',NULL,'Referência marketplace / programas',9.9,18.0,NULL,'[]'::jsonb,'Condições podem variar por programa, repasse e campanha.','https://universo.magalu.com/','OFFICIAL_PUBLIC','2026-01-01'::date,'2026-08-07'::date,'current'),
 ('TikTok Shop',NULL,'Comissão base por faixa de preço',6.0,10.0,NULL,'[{"name":"Taxa fixa por item","description":"Varia por faixa de preço"},{"name":"Programa de frete","description":"Pode adicionar percentual específico"}]'::jsonb,'Referência informativa; validar programas ativos da conta.','https://seller-br.tiktok.com/','OFFICIAL_PUBLIC','2026-07-15'::date,'2026-08-07'::date,'current'),
 ('MadeiraMadeira','Móveis e Estofados','Comissão Móveis/Estofados',19.0,19.0,NULL,'[{"name":"Frete na base","description":"Conforme política vigente do canal"}]'::jsonb,'Referência informativa para móveis/estofados.','https://marketplace.madeiramadeira.com.br/','OFFICIAL_PUBLIC','2026-01-01'::date,'2026-08-07'::date,'current'),
 ('Amazon Brasil',NULL,'Comissão por categoria',10.0,15.0,NULL,'[]'::jsonb,'Referência geral pública; validar categoria, plano e logística.','https://venda.amazon.com.br/','OFFICIAL_PUBLIC','2026-01-01'::date,'2026-08-07'::date,'current'),
 ('Casas Bahia',NULL,'Comissão por categoria',18.5,21.0,NULL,'[]'::jsonb,'Referência pública; móveis e decoração podem ficar na faixa superior.','https://marketplace.grupocasasbahia.com.br/','OFFICIAL_PUBLIC','2026-01-01'::date,'2026-08-07'::date,'current'),
 ('Carrefour',NULL,'Comissão de referência',16.0,16.0,NULL,'[]'::jsonb,'Referência pública sujeita a condições comerciais.','https://marketplace.carrefour.com.br/','OFFICIAL_PUBLIC','2026-01-01'::date,'2026-08-07'::date,'current')
) AS v(marketplace,category,title,commission_percent_min,commission_percent_max,fixed_fee,extra_fees,notes,source_url,source_type,valid_from,last_verified_at,status)
WHERE NOT EXISTS (SELECT 1 FROM volt_price.commission_references c WHERE c.tenant_id IS NULL AND c.marketplace=v.marketplace AND c.title=v.title);
