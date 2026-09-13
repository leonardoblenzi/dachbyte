"use strict";

const crypto = require("crypto");

let pg = null;
try {
  pg = require("pg");
} catch (_error) {
  pg = null;
}

const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
const pool =
  pg && DATABASE_URL
    ? new pg.Pool({
        connectionString: DATABASE_URL,
        ssl: DATABASE_URL.includes("sslmode=require")
          ? { rejectUnauthorized: false }
          : undefined,
      })
    : null;

let schemaReady = false;

function isDbEnabled() {
  return Boolean(pool);
}

async function query(sql, params = []) {
  if (!pool) {
    const error = new Error("Banco Davantti Log nao configurado.");
    error.code = "DAVANTTILOG_DB_DISABLED";
    throw error;
  }
  await ensureSchema();
  return pool.query(sql, params);
}

async function ensureSchema() {
  if (!pool || schemaReady) return;
  await pool.query(`
    create table if not exists log_intelipost_integrations (
      id text primary key,
      company_id text not null,
      account_id text,
      client_id text,
      api_key_secret_ref text,
      api_key_ciphertext text,
      rest_base_url text not null default 'https://api.intelipost.com.br/api/v1',
      tracking_graphql_url text not null default 'https://tracking-graphql.intelipost.com.br/',
      shipment_search_path text not null default '/shipment_order',
      sync_enabled boolean not null default false,
      last_sync_at timestamptz,
      created_by text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (company_id, account_id)
    );

    create table if not exists log_reconciliation_batches (
      id text primary key,
      company_id text not null,
      account_id text,
      start_date date,
      end_date date,
      status text not null default 'open',
      source text not null default 'manual',
      total_orders integer not null default 0,
      total_carrier_amount numeric(14,2) not null default 0,
      total_tms_amount numeric(14,2) not null default 0,
      total_customer_amount numeric(14,2) not null default 0,
      total_davantti_expected_amount numeric(14,2) not null default 0,
      total_difference numeric(14,2) not null default 0,
      created_by text not null default 'system',
      created_at timestamptz not null default now(),
      closed_at timestamptz
    );

    create table if not exists log_reconciliation_items (
      id text primary key,
      batch_id text,
      company_id text not null,
      account_id text,
      order_id text not null,
      marketplace_order_number text,
      intelipost_order_number text,
      sales_channel text,
      customer_name text,
      carrier_id text,
      carrier_name text,
      delivery_method_id text,
      delivery_service text,
      destination_uf text,
      destination_zipcode text,
      tracking_code text,
      invoice_key text,
      cte_key text,
      billing_document text,
      order_amount numeric(14,2),
      customer_paid_shipping_amount numeric(14,2),
      tms_expected_amount numeric(14,2),
      carrier_charged_amount numeric(14,2),
      davantti_expected_amount numeric(14,2),
      tms_difference_amount numeric(14,2),
      davantti_difference_amount numeric(14,2),
      freight_margin_amount numeric(14,2),
      status text not null default 'aguardando_conciliacao',
      applied_rule_snapshot jsonb not null default '{}'::jsonb,
      tolerance_snapshot jsonb not null default '{}'::jsonb,
      source_payload_snapshot jsonb not null default '{}'::jsonb,
      evidence_json jsonb not null default '[]'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists log_billing_rules (
      id text primary key,
      company_id text not null,
      name text not null,
      description text,
      active boolean not null default true,
      priority integer not null default 100,
      rule_type text not null default 'freight_expected',
      operation text not null,
      value_type text not null default 'reference',
      value numeric(14,4),
      start_date date,
      end_date date,
      conditions_json jsonb not null default '{}'::jsonb,
      tolerance_json jsonb not null default '{}'::jsonb,
      version integer not null default 1,
      created_by text not null default 'system',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists log_rule_nodes (
      id text primary key,
      company_id text not null,
      rule_id text references log_billing_rules(id) on delete cascade,
      parent_node_id text,
      node_type text not null,
      label text not null,
      config_json jsonb not null default '{}'::jsonb,
      position_x numeric(10,2) not null default 0,
      position_y numeric(10,2) not null default 0,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists log_import_files (
      id text primary key,
      company_id text not null,
      file_name text not null,
      file_type text not null,
      file_hash text not null,
      source text not null,
      status text not null,
      total_rows integer not null default 0,
      processed_rows integer not null default 0,
      error_rows integer not null default 0,
      mapping_json jsonb not null default '{}'::jsonb,
      created_by text not null default 'system',
      created_at timestamptz not null default now(),
      unique (company_id, file_hash)
    );

    create table if not exists log_intelipost_sync_runs (
      id text primary key,
      company_id text not null,
      account_id text,
      sync_type text not null,
      status text not null,
      parameters_json jsonb not null default '{}'::jsonb,
      processed_rows integer not null default 0,
      success_rows integer not null default 0,
      error_rows integer not null default 0,
      errors_json jsonb not null default '[]'::jsonb,
      started_at timestamptz not null default now(),
      finished_at timestamptz,
      created_by text not null default 'system'
    );

    create table if not exists log_reconciliation_actions (
      id text primary key,
      company_id text not null,
      item_id text,
      action_type text not null,
      old_status text,
      new_status text,
      reason text,
      notes text,
      amount_before numeric(14,2),
      amount_after numeric(14,2),
      created_by text not null default 'system',
      created_at timestamptz not null default now()
    );
  `);

  await pool.query(`
    alter table log_intelipost_integrations add column if not exists api_key_ciphertext text;
    alter table log_reconciliation_items add column if not exists customer_name text;
    alter table log_reconciliation_items add column if not exists carrier_name text;
    alter table log_reconciliation_items add column if not exists delivery_service text;
    alter table log_reconciliation_items add column if not exists destination_uf text;
    alter table log_reconciliation_items add column if not exists destination_zipcode text;
    alter table log_reconciliation_items add column if not exists billing_document text;
    alter table log_reconciliation_items add column if not exists order_amount numeric(14,2);
    alter table log_reconciliation_items add column if not exists evidence_json jsonb not null default '[]'::jsonb;
    alter table log_billing_rules add column if not exists tolerance_json jsonb not null default '{}'::jsonb;
    alter table log_billing_rules add column if not exists version integer not null default 1;
    alter table log_reconciliation_actions add column if not exists company_id text;
  `);

  await pool.query(`
    create index if not exists idx_log_reconciliation_items_company_order
      on log_reconciliation_items (company_id, order_id);
    create index if not exists idx_log_reconciliation_items_company_invoice
      on log_reconciliation_items (company_id, invoice_key);
    create index if not exists idx_log_reconciliation_items_company_status
      on log_reconciliation_items (company_id, status);
    create index if not exists idx_log_billing_rules_company_active
      on log_billing_rules (company_id, active, priority);
    create index if not exists idx_log_import_files_company_status
      on log_import_files (company_id, status);
    create index if not exists idx_log_intelipost_sync_runs_company_started
      on log_intelipost_sync_runs (company_id, started_at desc);
    create index if not exists idx_log_reconciliation_actions_company_created
      on log_reconciliation_actions (company_id, created_at desc);
    create index if not exists idx_log_reconciliation_actions_item_created
      on log_reconciliation_actions (item_id, created_at desc);
  `);

  schemaReady = true;
}

function encryptionKey() {
  const raw =
    String(process.env.DAVANTTILOG_SECRET_KEY || "").trim() ||
    String(process.env.SUITE_JWT_SECRET || "").trim() ||
    String(process.env.JWT_SECRET || "").trim();
  if (!raw) return null;
  return crypto.createHash("sha256").update(raw).digest();
}

function encryptSecret(value) {
  const secret = String(value || "").trim();
  if (!secret) return null;
  const key = encryptionKey();
  if (!key) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

function decryptSecret(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const key = encryptionKey();
  if (!key || !raw.startsWith("v1:")) return "";
  const [, ivB64, tagB64, encryptedB64] = raw.split(":");
  if (!ivB64 || !tagB64 || !encryptedB64) return "";
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function jsonOrDefault(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch (_error) {
      return fallback;
    }
  }
  return value;
}

function mapIntegrationRow(row) {
  if (!row) return null;
  const apiKey = decryptSecret(row.api_key_ciphertext);
  return {
    tenant_id: row.company_id,
    account_id: row.account_id || row.company_id,
    intelipost_client_id: row.client_id || "",
    api_key_configured: Boolean(row.api_key_ciphertext || row.api_key_secret_ref),
    api_key: apiKey,
    rest_base_url: row.rest_base_url || "https://api.intelipost.com.br/api/v1",
    tracking_graphql_url:
      row.tracking_graphql_url || "https://tracking-graphql.intelipost.com.br/",
    shipment_search_path: row.shipment_search_path || "/shipment_order",
    sync_enabled: row.sync_enabled === true,
    last_sync_at: row.last_sync_at || null,
    storage: "postgres",
    updated_at: row.updated_at || null,
  };
}

function mapItemRow(row) {
  if (!row) return null;
  const rule = jsonOrDefault(row.applied_rule_snapshot, {});
  const tolerance = jsonOrDefault(row.tolerance_snapshot, {});
  const payload = jsonOrDefault(row.source_payload_snapshot, {});
  const evidence = jsonOrDefault(row.evidence_json, []);
  return {
    id: row.id,
    batch_id: row.batch_id,
    company_id: row.company_id,
    account_id: row.account_id,
    order_id: row.order_id,
    marketplace_order_number: row.marketplace_order_number,
    intelipost_order_number: row.intelipost_order_number,
    sales_channel: row.sales_channel,
    customer_name: row.customer_name,
    carrier_id: row.carrier_id,
    carrier_name: row.carrier_name,
    delivery_method_id: row.delivery_method_id,
    delivery_service: row.delivery_service,
    destination_uf: row.destination_uf,
    destination_zipcode: row.destination_zipcode,
    tracking_code: row.tracking_code,
    invoice_key: row.invoice_key,
    cte_key: row.cte_key,
    billing_document: row.billing_document,
    order_amount: numberOrNull(row.order_amount),
    customer_paid_shipping_amount: numberOrNull(row.customer_paid_shipping_amount),
    tms_expected_amount: numberOrNull(row.tms_expected_amount),
    carrier_charged_amount: numberOrNull(row.carrier_charged_amount),
    davantti_expected_amount: numberOrNull(row.davantti_expected_amount),
    tms_difference_amount: numberOrNull(row.tms_difference_amount),
    davantti_difference_amount: numberOrNull(row.davantti_difference_amount),
    freight_margin_amount: numberOrNull(row.freight_margin_amount),
    status: row.status,
    rule,
    tolerance_snapshot: tolerance,
    source_payload_snapshot: payload,
    evidence: Array.isArray(evidence) ? evidence : [],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapRuleRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    active: row.active === true,
    priority: Number(row.priority || 100),
    rule_type: row.rule_type,
    operation: row.operation,
    value_type: row.value_type,
    value: numberOrNull(row.value),
    start_date: row.start_date,
    end_date: row.end_date,
    conditions_json: jsonOrDefault(row.conditions_json, {}),
    tolerance: jsonOrDefault(row.tolerance_json, {}),
    version: Number(row.version || 1),
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function getIntelipostIntegration(companyId, accountId) {
  if (!pool) return null;
  await ensureSchema();
  const { rows } = await pool.query(
    `select *
       from log_intelipost_integrations
      where company_id = $1
        and coalesce(account_id, company_id) = $2
      limit 1`,
    [companyId, accountId || companyId],
  );
  return mapIntegrationRow(rows[0] || null);
}

async function upsertIntelipostIntegration(input) {
  if (!pool) return null;
  await ensureSchema();
  const companyId = String(input.company_id || "").trim();
  const accountId = String(input.account_id || companyId).trim();
  const userEmail = String(input.created_by || input.updated_by || "system").trim();
  if (!companyId) {
    const error = new Error("company_id obrigatorio para salvar integracao.");
    error.code = "TENANT_REQUIRED";
    throw error;
  }

  const encryptedApiKey =
    String(input.api_key || "").trim() ? encryptSecret(input.api_key) : null;

  const { rows } = await pool.query(
    `insert into log_intelipost_integrations (
        id, company_id, account_id, client_id, api_key_ciphertext,
        api_key_secret_ref, rest_base_url, tracking_graphql_url,
        shipment_search_path, sync_enabled, created_by, updated_at
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
      on conflict (company_id, account_id)
      do update set
        client_id = excluded.client_id,
        api_key_ciphertext = coalesce(excluded.api_key_ciphertext, log_intelipost_integrations.api_key_ciphertext),
        api_key_secret_ref = coalesce(excluded.api_key_secret_ref, log_intelipost_integrations.api_key_secret_ref),
        rest_base_url = excluded.rest_base_url,
        tracking_graphql_url = excluded.tracking_graphql_url,
        shipment_search_path = excluded.shipment_search_path,
        sync_enabled = excluded.sync_enabled,
        updated_at = now()
      returning *`,
    [
      crypto.randomUUID(),
      companyId,
      accountId,
      String(input.client_id || "").trim(),
      encryptedApiKey,
      String(input.api_key_secret_ref || "").trim() || null,
      String(input.rest_base_url || "https://api.intelipost.com.br/api/v1").trim(),
      String(input.tracking_graphql_url || "https://tracking-graphql.intelipost.com.br/").trim(),
      String(input.shipment_search_path || "/shipment_order").trim(),
      input.sync_enabled === true,
      userEmail || "system",
    ],
  );

  return mapIntegrationRow(rows[0] || null);
}

async function updateIntelipostLastSync(companyId, accountId, lastSyncAt = new Date()) {
  if (!pool) return;
  await ensureSchema();
  await pool.query(
    `update log_intelipost_integrations
        set last_sync_at = $3,
            updated_at = now()
      where company_id = $1
        and coalesce(account_id, company_id) = $2`,
    [companyId, accountId || companyId, lastSyncAt],
  );
}

async function findExistingItemId(companyId, item) {
  const invoiceKey = String(item.invoice_key || "").trim();
  const orderId = String(item.order_id || "").trim();
  const itemId = String(item.id || "").trim();
  const { rows } = await pool.query(
    `select id
       from log_reconciliation_items
      where company_id = $1
        and (
          ($2 <> '' and id = $2)
          or ($3 <> '' and invoice_key = $3)
          or ($4 <> '' and order_id = $4)
        )
      order by updated_at desc
      limit 1`,
    [companyId, itemId, invoiceKey, orderId],
  );
  return rows[0]?.id || null;
}

async function upsertReconciliationItems(input) {
  if (!pool) return [];
  await ensureSchema();
  const companyId = String(input.company_id || "").trim();
  const accountId = String(input.account_id || companyId).trim();
  const source = String(input.source || "manual").trim();
  const userEmail = String(input.created_by || "system").trim();
  const items = Array.isArray(input.items) ? input.items.filter(Boolean) : [];
  if (!companyId || !items.length) return [];

  const saved = [];
  for (const rawItem of items) {
    const existingId = await findExistingItemId(companyId, rawItem);
    const id = existingId || String(rawItem.id || crypto.randomUUID()).trim();
    const sourcePayload = {
      ...(rawItem.source_payload_snapshot || {}),
      source,
      captured_at: rawItem.source_payload_snapshot?.captured_at || new Date().toISOString(),
    };
    const evidence = Array.isArray(rawItem.evidence) ? rawItem.evidence : [];
    const rule = rawItem.rule || rawItem.applied_rule_snapshot || {};
    const tolerance = rawItem.tolerance_snapshot || rule.tolerance || {};

    const { rows } = await pool.query(
      `insert into log_reconciliation_items (
          id, batch_id, company_id, account_id, order_id,
          marketplace_order_number, intelipost_order_number, sales_channel,
          customer_name, carrier_id, carrier_name, delivery_method_id,
          delivery_service, destination_uf, destination_zipcode, tracking_code,
          invoice_key, cte_key, billing_document, order_amount,
          customer_paid_shipping_amount, tms_expected_amount, carrier_charged_amount,
          davantti_expected_amount, tms_difference_amount, davantti_difference_amount,
          freight_margin_amount, status, applied_rule_snapshot, tolerance_snapshot,
          source_payload_snapshot, evidence_json, created_at, updated_at
        )
        values (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
          $17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,
          $31,$32,coalesce($33, now()),now()
        )
        on conflict (id)
        do update set
          batch_id = coalesce(excluded.batch_id, log_reconciliation_items.batch_id),
          account_id = excluded.account_id,
          order_id = excluded.order_id,
          marketplace_order_number = coalesce(excluded.marketplace_order_number, log_reconciliation_items.marketplace_order_number),
          intelipost_order_number = coalesce(excluded.intelipost_order_number, log_reconciliation_items.intelipost_order_number),
          sales_channel = coalesce(excluded.sales_channel, log_reconciliation_items.sales_channel),
          customer_name = coalesce(excluded.customer_name, log_reconciliation_items.customer_name),
          carrier_id = coalesce(excluded.carrier_id, log_reconciliation_items.carrier_id),
          carrier_name = coalesce(excluded.carrier_name, log_reconciliation_items.carrier_name),
          delivery_method_id = coalesce(excluded.delivery_method_id, log_reconciliation_items.delivery_method_id),
          delivery_service = coalesce(excluded.delivery_service, log_reconciliation_items.delivery_service),
          destination_uf = coalesce(excluded.destination_uf, log_reconciliation_items.destination_uf),
          destination_zipcode = coalesce(excluded.destination_zipcode, log_reconciliation_items.destination_zipcode),
          tracking_code = coalesce(excluded.tracking_code, log_reconciliation_items.tracking_code),
          invoice_key = coalesce(excluded.invoice_key, log_reconciliation_items.invoice_key),
          cte_key = coalesce(excluded.cte_key, log_reconciliation_items.cte_key),
          billing_document = coalesce(excluded.billing_document, log_reconciliation_items.billing_document),
          order_amount = coalesce(excluded.order_amount, log_reconciliation_items.order_amount),
          customer_paid_shipping_amount = coalesce(excluded.customer_paid_shipping_amount, log_reconciliation_items.customer_paid_shipping_amount),
          tms_expected_amount = coalesce(excluded.tms_expected_amount, log_reconciliation_items.tms_expected_amount),
          carrier_charged_amount = coalesce(excluded.carrier_charged_amount, log_reconciliation_items.carrier_charged_amount),
          davantti_expected_amount = coalesce(excluded.davantti_expected_amount, log_reconciliation_items.davantti_expected_amount),
          tms_difference_amount = coalesce(excluded.tms_difference_amount, log_reconciliation_items.tms_difference_amount),
          davantti_difference_amount = coalesce(excluded.davantti_difference_amount, log_reconciliation_items.davantti_difference_amount),
          freight_margin_amount = coalesce(excluded.freight_margin_amount, log_reconciliation_items.freight_margin_amount),
          status = excluded.status,
          applied_rule_snapshot = excluded.applied_rule_snapshot,
          tolerance_snapshot = excluded.tolerance_snapshot,
          source_payload_snapshot = excluded.source_payload_snapshot,
          evidence_json = excluded.evidence_json,
          updated_at = now()
        returning *`,
      [
        id,
        rawItem.batch_id || null,
        companyId,
        accountId,
        String(rawItem.order_id || rawItem.invoice_key || id).trim(),
        rawItem.marketplace_order_number || null,
        rawItem.intelipost_order_number || null,
        rawItem.sales_channel || null,
        rawItem.customer_name || null,
        rawItem.carrier_id || null,
        rawItem.carrier_name || null,
        rawItem.delivery_method_id || null,
        rawItem.delivery_service || null,
        rawItem.destination_uf || null,
        rawItem.destination_zipcode || null,
        rawItem.tracking_code || null,
        rawItem.invoice_key || null,
        rawItem.cte_key || null,
        rawItem.billing_document || null,
        numberOrNull(rawItem.order_amount),
        numberOrNull(rawItem.customer_paid_shipping_amount),
        numberOrNull(rawItem.tms_expected_amount),
        numberOrNull(rawItem.carrier_charged_amount),
        numberOrNull(rawItem.davantti_expected_amount),
        numberOrNull(rawItem.tms_difference_amount),
        numberOrNull(rawItem.davantti_difference_amount),
        numberOrNull(rawItem.freight_margin_amount),
        rawItem.status || "aguardando_conciliacao",
        JSON.stringify(rule || {}),
        JSON.stringify(tolerance || {}),
        JSON.stringify(sourcePayload),
        JSON.stringify(evidence),
        rawItem.created_at || null,
      ],
    );
    saved.push(mapItemRow(rows[0]));
  }

  if (saved.length) {
    await recordAction({
      company_id: companyId,
      item_id: null,
      action_type: "upsert_reconciliation_items",
      reason: `${saved.length} item(ns) importado(s) de ${source}.`,
      created_by: userEmail || "system",
    });
  }

  return saved;
}

async function listReconciliationItems(companyId) {
  if (!pool) return [];
  await ensureSchema();
  const { rows } = await pool.query(
    `select *
       from log_reconciliation_items
      where company_id = $1
      order by updated_at desc, created_at desc`,
    [companyId],
  );
  return rows.map(mapItemRow);
}

async function updateReconciliationItem(companyId, item) {
  return (await upsertReconciliationItems({
    company_id: companyId,
    account_id: item.account_id || companyId,
    source: item.source_payload_snapshot?.source || "conciliation",
    created_by: "system",
    items: [item],
  }))[0] || null;
}

async function updateReconciliationItemStatus(input) {
  if (!pool) return null;
  await ensureSchema();
  const { rows } = await pool.query(
    `update log_reconciliation_items
        set status = $3,
            updated_at = now()
      where company_id = $1
        and id = $2
      returning *`,
    [input.company_id, input.item_id, input.status],
  );
  return mapItemRow(rows[0] || null);
}

async function recordAction(input) {
  if (!pool) return null;
  await ensureSchema();
  const { rows } = await pool.query(
    `insert into log_reconciliation_actions (
       id, company_id, item_id, action_type, old_status, new_status,
       reason, notes, amount_before, amount_after, created_by
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     returning *`,
    [
      input.id || `ACT-${crypto.randomUUID()}`,
      input.company_id,
      input.item_id || null,
      input.action_type,
      input.old_status || null,
      input.new_status || null,
      input.reason || null,
      input.notes || null,
      numberOrNull(input.amount_before),
      numberOrNull(input.amount_after),
      input.created_by || "system",
    ],
  );
  return rows[0] || null;
}

async function listActions(companyId, itemId = null) {
  if (!pool) return [];
  await ensureSchema();
  const params = [companyId];
  let where = "where company_id = $1";
  if (itemId) {
    params.push(itemId);
    where += " and item_id = $2";
  }
  const { rows } = await pool.query(
    `select * from log_reconciliation_actions ${where} order by created_at desc limit 500`,
    params,
  );
  return rows;
}

async function listBillingRules(companyId) {
  if (!pool) return [];
  await ensureSchema();
  const { rows } = await pool.query(
    `select *
       from log_billing_rules
      where company_id = $1
      order by active desc, priority asc, updated_at desc`,
    [companyId],
  );
  return rows.map(mapRuleRow);
}

async function seedDefaultBillingRules(companyId, createdBy = "system") {
  if (!pool || !companyId) return [];
  await ensureSchema();
  const existing = await listBillingRules(companyId);
  if (existing.length) return existing;
  const defaults = [
    {
      id: `RULE-${crypto.randomUUID()}`,
      name: "Usar valor TMS",
      operation: "use_tms",
      value_type: "reference",
      value: 0,
      priority: 20,
      conditions_json: { channel: "default" },
      tolerance_json: { fixed: 1, percent: 0 },
    },
    {
      id: `RULE-${crypto.randomUUID()}`,
      name: "Cliente -10%",
      operation: "percent_decrease",
      value_type: "percent",
      value: 10,
      priority: 40,
      conditions_json: { channel: "Mercado Livre" },
      tolerance_json: { fixed: 1, percent: 2 },
    },
  ];
  for (const rule of defaults) {
    await pool.query(
      `insert into log_billing_rules (
        id, company_id, name, active, priority, rule_type, operation,
        value_type, value, conditions_json, tolerance_json, created_by
       ) values ($1,$2,$3,true,$4,'freight_expected',$5,$6,$7,$8,$9,$10)
       on conflict (id) do nothing`,
      [
        rule.id,
        companyId,
        rule.name,
        rule.priority,
        rule.operation,
        rule.value_type,
        rule.value,
        JSON.stringify(rule.conditions_json),
        JSON.stringify(rule.tolerance_json),
        createdBy,
      ],
    );
  }
  return listBillingRules(companyId);
}

async function recordImportFile(input) {
  if (!pool) return null;
  await ensureSchema();
  const hash = crypto
    .createHash("sha256")
    .update(JSON.stringify(input.rows || []) + String(input.file_name || "inline"))
    .digest("hex");
  const { rows } = await pool.query(
    `insert into log_import_files (
      id, company_id, file_name, file_type, file_hash, source, status,
      total_rows, processed_rows, error_rows, mapping_json, created_by
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    on conflict (company_id, file_hash)
    do update set
      status = excluded.status,
      processed_rows = excluded.processed_rows,
      error_rows = excluded.error_rows
    returning *`,
    [
      input.id || `IMPFILE-${crypto.randomUUID()}`,
      input.company_id,
      input.file_name || "inline-import.json",
      input.file_type || "json",
      hash,
      input.source || "invoice_rows",
      input.status || "processed",
      Number(input.total_rows || 0),
      Number(input.processed_rows || 0),
      Number(input.error_rows || 0),
      JSON.stringify(input.mapping_json || {}),
      input.created_by || "system",
    ],
  );
  return rows[0] || null;
}

async function recordSyncRun(input) {
  if (!pool) return null;
  await ensureSchema();
  const { rows } = await pool.query(
    `insert into log_intelipost_sync_runs (
      id, company_id, account_id, sync_type, status, parameters_json,
      processed_rows, success_rows, error_rows, errors_json, started_at,
      finished_at, created_by
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    returning *`,
    [
      input.id || `SYNC-${crypto.randomUUID()}`,
      input.company_id,
      input.account_id || input.company_id,
      input.sync_type || input.type || "period",
      input.status || "finished",
      JSON.stringify(input.parameters || input.parameters_json || {}),
      Number(input.processed || input.processed_rows || 0),
      Number(input.success || input.success_rows || 0),
      Number(input.error_rows ?? (Array.isArray(input.errors) ? input.errors.length : 0)),
      JSON.stringify(input.errors || input.errors_json || []),
      input.started_at || input.created_at || new Date(),
      input.finished_at || new Date(),
      input.created_by || "system",
    ],
  );
  return rows[0] || null;
}

module.exports = {
  getIntelipostIntegration,
  isDbEnabled,
  listActions,
  listBillingRules,
  listReconciliationItems,
  query,
  recordAction,
  recordImportFile,
  recordSyncRun,
  seedDefaultBillingRules,
  updateIntelipostLastSync,
  updateReconciliationItem,
  updateReconciliationItemStatus,
  upsertIntelipostIntegration,
  upsertReconciliationItems,
};
