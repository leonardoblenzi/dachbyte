"use strict";

const db = require("../db/db");

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_INITIAL_DELAY_MS = 75 * 1000;
let started = false;

function normalizeConfigValue(value) {
  return String(value || "").trim().replace(/^["']|["']$/g, "");
}

function isDisabled(value) {
  return ["0", "false", "off", "disabled", "no"].includes(normalizeConfigValue(value).toLowerCase());
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getHubConfig() {
  return { baseUrl: normalizeConfigValue(process.env.HUB_BASE_URL).replace(/\/+$/, ""), token: normalizeConfigValue(process.env.HUB_INTERNAL_TOKEN) };
}

function buildReport(row, metricKey, value) {
  const tenantId = String(row.tenant_id || "").trim();
  const usageDate = String(row.usage_date || "").slice(0, 10);
  const amount = Number(value || 0);
  if (!tenantId || !usageDate || !Number.isFinite(amount) || amount < 0) return null;
  return { tenant_id: tenantId, module: "ml", usage_date: usageDate, metrics: { [metricKey]: amount } };
}

async function tableExists(tableName) {
  const result = await db.query("select to_regclass($1) as table_name", [tableName]);
  return Boolean(result.rows?.[0]?.table_name);
}

async function collectHubUsageReports() {
  const reportsByKey = new Map();
  const mergeMetric = (row, metricKey, value, overwrite = true) => {
    const report = buildReport(row, metricKey, value);
    if (!report) return;
    const key = `${report.tenant_id}:${report.usage_date}`;
    const current = reportsByKey.get(key) || { ...report, metrics: {} };
    if (overwrite || current.metrics[metricKey] == null) current.metrics[metricKey] = report.metrics[metricKey];
    reportsByKey.set(key, current);
  };
  const addMetric = (row, metricKey, value) => {
    const report = buildReport(row, metricKey, value);
    if (!report) return;
    const key = `${report.tenant_id}:${report.usage_date}`;
    const current = reportsByKey.get(key) || { ...report, metrics: {} };
    current.metrics[metricKey] = Number(current.metrics[metricKey] || 0) + Number(report.metrics[metricKey] || 0);
    reportsByKey.set(key, current);
  };
  if (await tableExists("ml_stock_watch_items")) {
    const result = await db.query(`
      select coalesce(nullif(trim(e.tenant_global_id), ''), 'ml_empresa_' || e.id::text) as tenant_id,
             current_date::text as usage_date,
             greatest(0, ceil(coalesce(sum(w.sales_30d), 0)::numeric / 30))::int as orders
        from empresas e
        join meli_contas mc on mc.empresa_id = e.id
        join ml_stock_watch_items w on w.account_key = mc.id::text
       where coalesce(nullif(trim(e.tenant_global_id), ''), '') <> ''
       group by e.id, e.tenant_global_id`);
    for (const row of result.rows || []) {
      mergeMetric(row, "orders", row.orders);
    }
  }
  if (await tableExists("anuncios_full")) {
    const result = await db.query(`
      select coalesce(nullif(trim(e.tenant_global_id), ''), 'ml_empresa_' || e.id::text) as tenant_id,
             current_date::text as usage_date,
             greatest(0, ceil(coalesce(sum(a.sold_40d), 0)::numeric / 40))::int as orders,
             count(*)::int as products
        from empresas e
        join meli_contas mc on mc.empresa_id = e.id
        join anuncios_full a on a.meli_conta_id = mc.id
       where coalesce(nullif(trim(e.tenant_global_id), ''), '') <> ''
       group by e.id, e.tenant_global_id`);
    for (const row of result.rows || []) {
      mergeMetric(row, "orders", row.orders, false);
      mergeMetric(row, "products", row.products);
      addMetric(row, "stored_records", row.products);
    }
  }
  const footprintSources = [
    { table: "ml.mercadolivre_sku_catalog", join: "t.account_key = mc.id::text" },
    { table: "ml.mercadolivre_sku_catalog_items", join: "t.account_key = mc.id::text" },
    { table: "ml.mercadolivre_sku_price_history", join: "t.account_key = mc.id::text" },
    { table: "ml.reputation_snapshots", join: "t.account_key = mc.id::text" },
    { table: "ml_stock_watch_items", join: "t.account_key = mc.id::text" },
    { table: "ml_stock_watch_events", join: "t.account_key = mc.id::text" },
    { table: "ml_ranking_anuncios_snapshots", join: "t.meli_conta_id = mc.id" },
    { table: "ml_ranking_anuncios_snapshot_items", join: "t.meli_conta_id = mc.id" },
    { table: "ml_strategic_items", join: "t.account_key = mc.id::text" },
    { table: "ml_strategic_rounds", join: "t.account_key = mc.id::text" },
    { table: "ml_strategic_tasks", join: "t.account_key = mc.id::text" },
    { table: "ml_strategic_watchlist", join: "t.account_key = mc.id::text" },
    { table: "ml_strategic_watchlist_events", join: "t.account_key = mc.id::text" }
  ];
  for (const source of footprintSources) {
    if (!(await tableExists(source.table))) continue;
    const result = await db.query(`
      select e.tenant_global_id as tenant_id,
             current_date::text as usage_date,
             count(t.*)::int as stored_records
        from empresas e
        join meli_contas mc on mc.empresa_id = e.id
        join ${source.table} t on ${source.join}
       where coalesce(nullif(trim(e.tenant_global_id), ''), '') <> ''
       group by e.tenant_global_id`);
    for (const row of result.rows || []) addMetric(row, "stored_records", row.stored_records);
  }
  if (await tableExists("ml.mercadolivre_sku_sync_runs")) {
    const result = await db.query(`
      select e.tenant_global_id as tenant_id,
             r.created_at::date::text as usage_date,
             sum(greatest(r.processed_items, r.total_items, 1))::int as processed_items
        from empresas e
        join meli_contas mc on mc.empresa_id = e.id
        join ml.mercadolivre_sku_sync_runs r on r.account_key = mc.id::text
       where r.created_at >= current_date - interval '30 days'
         and coalesce(nullif(trim(e.tenant_global_id), ''), '') <> ''
       group by e.tenant_global_id, r.created_at::date`);
    for (const row of result.rows || []) addMetric(row, "processed_items", row.processed_items);
  }
  if (await tableExists("ml_ranking_anuncios_snapshot_items")) {
    const result = await db.query(`
      select e.tenant_global_id as tenant_id,
             s.gerado_em::date::text as usage_date,
             count(i.*)::int as processed_items
        from empresas e
        join meli_contas mc on mc.empresa_id = e.id
        join ml_ranking_anuncios_snapshots s on s.meli_conta_id = mc.id
        join ml_ranking_anuncios_snapshot_items i on i.snapshot_id = s.id
       where s.gerado_em >= current_date - interval '30 days'
         and coalesce(nullif(trim(e.tenant_global_id), ''), '') <> ''
       group by e.tenant_global_id, s.gerado_em::date`);
    for (const row of result.rows || []) addMetric(row, "processed_items", row.processed_items);
  }
  return Array.from(reportsByKey.values()).map((report) => ({
    ...report,
    metrics: {
      ...report.metrics,
      activity_units: Number(report.metrics.stored_records || report.metrics.products || 0)
        + Number(report.metrics.processed_items || 0) * 2
        + Number(report.metrics.orders || 0)
    }
  }));
}

async function postUsageReports(reports) {
  const { baseUrl, token } = getHubConfig();
  if (!baseUrl || !token || !reports.length) return;
  const response = await fetch(`${baseUrl}/v1/internal/usage/report`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ reports }) });
  if (!response.ok) throw new Error(`Hub usage HTTP ${response.status}: ${(await response.text().catch(() => "")).slice(0, 180)}`);
}

async function runHubUsageReport() {
  try {
    const reports = await collectHubUsageReports();
    await postUsageReports(reports);
    if (reports.length) console.log(`[ml.usage] ${reports.length} reporte(s) enviados ao Hub.`);
  } catch (error) {
    console.warn("[ml.usage] Falha ao reportar consumo ao Hub:", error?.message || error);
  }
}

function startHubUsageReporter() {
  if (started || isDisabled(process.env.HUB_USAGE_REPORTING)) return;
  const { baseUrl, token } = getHubConfig();
  if (!baseUrl || !token) return;
  started = true;
  const firstTimer = setTimeout(() => void runHubUsageReport(), positiveInt(process.env.HUB_USAGE_REPORT_INITIAL_DELAY_MS, DEFAULT_INITIAL_DELAY_MS));
  firstTimer.unref?.();
  const interval = setInterval(() => void runHubUsageReport(), positiveInt(process.env.HUB_USAGE_REPORT_INTERVAL_MS, DEFAULT_INTERVAL_MS));
  interval.unref?.();
}

module.exports = { collectHubUsageReports, runHubUsageReport, startHubUsageReporter };
