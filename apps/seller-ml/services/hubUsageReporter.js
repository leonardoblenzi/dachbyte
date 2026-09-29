"use strict";

const db = require("../db/db");
const { withPgAdvisoryLock } = require("./pgAdvisoryLock");

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_INITIAL_DELAY_MS = 75 * 1000;
const DEFAULT_TABLE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_REPORT_CACHE_TTL_MS = 20 * 60 * 60 * 1000;
const DEFAULT_HTTP_TIMEOUT_MS = 5000;
const REPORT_CACHE_TABLE = "ml.hub_usage_report_cache";

let started = false;
const tableExistenceCache = new Map();

function normalizeConfigValue(value) {
  return String(value || "").trim().replace(/^["']|["']$/g, "");
}

function isDisabled(value) {
  return ["0", "false", "off", "disabled", "no"].includes(
    normalizeConfigValue(value).toLowerCase(),
  );
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getHubConfig() {
  return {
    baseUrl: normalizeConfigValue(process.env.HUB_BASE_URL).replace(/\/+$/, ""),
    token: normalizeConfigValue(process.env.HUB_INTERNAL_TOKEN),
  };
}

function buildReport(row, metricKey, value) {
  const tenantId = String(row.tenant_id || "").trim();
  const usageDate = String(row.usage_date || "").slice(0, 10);
  const amount = Number(value || 0);
  if (!tenantId || !usageDate || !Number.isFinite(amount) || amount < 0) return null;
  return {
    tenant_id: tenantId,
    module: "ml",
    usage_date: usageDate,
    metrics: { [metricKey]: amount },
  };
}

async function getExistingTableSet(tableNames) {
  const uniqueNames = [...new Set((tableNames || []).map((name) => String(name || "").trim()).filter(Boolean))];
  if (!uniqueNames.length) return new Set();

  const ttlMs = positiveInt(
    process.env.HUB_USAGE_TABLE_CACHE_TTL_MS,
    DEFAULT_TABLE_CACHE_TTL_MS,
  );
  const now = Date.now();
  const existing = new Set();
  const missing = [];

  for (const name of uniqueNames) {
    const cached = tableExistenceCache.get(name);
    if (cached && now - cached.checkedAt < ttlMs) {
      if (cached.exists) existing.add(name);
    } else {
      missing.push(name);
    }
  }

  if (missing.length) {
    const result = await db.query(
      `select name, to_regclass(name) is not null as table_exists
         from unnest($1::text[]) as names(name)`,
      [missing],
    );
    const returned = new Map(
      (result.rows || []).map((row) => [String(row.name), Boolean(row.table_exists)]),
    );
    for (const name of missing) {
      const exists = returned.get(name) === true;
      tableExistenceCache.set(name, { exists, checkedAt: now });
      if (exists) existing.add(name);
    }
  }

  return existing;
}

async function tableExists(tableName) {
  const set = await getExistingTableSet([tableName]);
  return set.has(tableName);
}

async function loadFreshUsageCache() {
  if (!(await tableExists(REPORT_CACHE_TABLE))) return null;
  const ttlMs = positiveInt(
    process.env.HUB_USAGE_REPORT_CACHE_TTL_MS,
    DEFAULT_REPORT_CACHE_TTL_MS,
  );
  const result = await db.query(
    `select reports, collected_at
       from ml.hub_usage_report_cache
      where usage_date = current_date
      limit 1`,
  );
  const row = result.rows?.[0];
  if (!row) return null;
  const collectedAt = Date.parse(String(row.collected_at || ""));
  if (!Number.isFinite(collectedAt) || Date.now() - collectedAt > ttlMs) return null;
  if (!Array.isArray(row.reports)) return null;
  return row.reports;
}

async function saveUsageCache(reports) {
  if (!(await tableExists(REPORT_CACHE_TABLE))) return false;
  await db.query(
    `insert into ml.hub_usage_report_cache (usage_date, reports, collected_at, updated_at)
     values (current_date, $1::jsonb, now(), now())
     on conflict (usage_date)
     do update set reports = excluded.reports,
                   collected_at = excluded.collected_at,
                   updated_at = now()`,
    [JSON.stringify(Array.isArray(reports) ? reports : [])],
  );
  return true;
}

async function collectHubUsageReports() {
  const reportsByKey = new Map();
  const mergeMetric = (row, metricKey, value, overwrite = true) => {
    const report = buildReport(row, metricKey, value);
    if (!report) return;
    const key = `${report.tenant_id}:${report.usage_date}`;
    const current = reportsByKey.get(key) || { ...report, metrics: {} };
    if (overwrite || current.metrics[metricKey] == null) {
      current.metrics[metricKey] = report.metrics[metricKey];
    }
    reportsByKey.set(key, current);
  };
  const addMetric = (row, metricKey, value) => {
    const report = buildReport(row, metricKey, value);
    if (!report) return;
    const key = `${report.tenant_id}:${report.usage_date}`;
    const current = reportsByKey.get(key) || { ...report, metrics: {} };
    current.metrics[metricKey] =
      Number(current.metrics[metricKey] || 0) + Number(report.metrics[metricKey] || 0);
    reportsByKey.set(key, current);
  };

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
    { table: "ml_strategic_watchlist_events", join: "t.account_key = mc.id::text" },
  ];

  const requiredTables = [
    "ml_stock_watch_items",
    "anuncios_full",
    "ml.mercadolivre_sku_sync_runs",
    "ml_ranking_anuncios_snapshot_items",
    ...footprintSources.map((source) => source.table),
  ];
  const existing = await getExistingTableSet(requiredTables);

  if (existing.has("ml_stock_watch_items")) {
    const result = await db.query(`
      select coalesce(nullif(trim(e.tenant_global_id), ''), 'ml_empresa_' || e.id::text) as tenant_id,
             current_date::text as usage_date,
             greatest(0, ceil(coalesce(sum(w.sales_30d), 0)::numeric / 30))::int as orders
        from empresas e
        join meli_contas mc on mc.empresa_id = e.id
        join ml_stock_watch_items w on w.account_key = mc.id::text
       where coalesce(nullif(trim(e.tenant_global_id), ''), '') <> ''
       group by e.id, e.tenant_global_id`);
    for (const row of result.rows || []) mergeMetric(row, "orders", row.orders);
  }

  if (existing.has("anuncios_full")) {
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

  for (const source of footprintSources) {
    if (!existing.has(source.table)) continue;
    const result = await db.query(`
      select e.tenant_global_id as tenant_id,
             current_date::text as usage_date,
             count(*)::int as stored_records
        from empresas e
        join meli_contas mc on mc.empresa_id = e.id
        join ${source.table} t on ${source.join}
       where coalesce(nullif(trim(e.tenant_global_id), ''), '') <> ''
       group by e.tenant_global_id`);
    for (const row of result.rows || []) addMetric(row, "stored_records", row.stored_records);
  }

  const lookbackDays = positiveInt(process.env.HUB_USAGE_LOOKBACK_DAYS, 30);

  if (existing.has("ml.mercadolivre_sku_sync_runs")) {
    const result = await db.query(`
      select e.tenant_global_id as tenant_id,
             r.created_at::date::text as usage_date,
             sum(greatest(r.processed_items, r.total_items, 1))::int as processed_items
        from empresas e
        join meli_contas mc on mc.empresa_id = e.id
        join ml.mercadolivre_sku_sync_runs r on r.account_key = mc.id::text
       where r.created_at >= current_date - ($1::int * interval '1 day')
         and coalesce(nullif(trim(e.tenant_global_id), ''), '') <> ''
       group by e.tenant_global_id, r.created_at::date`, [lookbackDays]);
    for (const row of result.rows || []) addMetric(row, "processed_items", row.processed_items);
  }

  if (existing.has("ml_ranking_anuncios_snapshot_items")) {
    const result = await db.query(`
      select e.tenant_global_id as tenant_id,
             s.gerado_em::date::text as usage_date,
             count(*)::int as processed_items
        from empresas e
        join meli_contas mc on mc.empresa_id = e.id
        join ml_ranking_anuncios_snapshots s on s.meli_conta_id = mc.id
        join ml_ranking_anuncios_snapshot_items i on i.snapshot_id = s.id
       where s.gerado_em >= current_date - ($1::int * interval '1 day')
         and coalesce(nullif(trim(e.tenant_global_id), ''), '') <> ''
       group by e.tenant_global_id, s.gerado_em::date`, [lookbackDays]);
    for (const row of result.rows || []) addMetric(row, "processed_items", row.processed_items);
  }

  return Array.from(reportsByKey.values()).map((report) => ({
    ...report,
    metrics: {
      ...report.metrics,
      activity_units:
        Number(report.metrics.stored_records || report.metrics.products || 0) +
        Number(report.metrics.processed_items || 0) * 2 +
        Number(report.metrics.orders || 0),
    },
  }));
}

async function postUsageReports(reports) {
  const { baseUrl, token } = getHubConfig();
  if (!baseUrl || !token || !reports.length) return { skipped: true };
  if (typeof fetch !== "function") throw new Error("fetch_not_available");

  const timeoutMs = positiveInt(
    process.env.HUB_USAGE_HTTP_TIMEOUT_MS || process.env.HUB_REQUEST_TIMEOUT_MS,
    DEFAULT_HTTP_TIMEOUT_MS,
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/v1/internal/usage/report`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ reports }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(
        `Hub usage HTTP ${response.status}: ${(await response.text().catch(() => "")).slice(0, 180)}`,
      );
    }
    return { ok: true, status: response.status };
  } finally {
    clearTimeout(timer);
  }
}

async function runHubUsageReport(options = {}) {
  try {
    return await withPgAdvisoryLock("ml_hub_usage_reporter", async () => {
      const forceRefresh = options.forceRefresh === true;
      let reports = forceRefresh ? null : await loadFreshUsageCache();
      let source = "cache";

      if (!reports) {
        reports = await collectHubUsageReports();
        source = "fresh";
        await saveUsageCache(reports).catch((error) => {
          console.warn("[ml.usage] Falha ao salvar cache diario:", error?.message || error);
        });
      }

      await postUsageReports(reports);
      if (reports.length) {
        console.log(`[ml.usage] ${reports.length} reporte(s) enviados ao Hub (${source}).`);
      }
      return { ok: true, reports: reports.length, source };
    });
  } catch (error) {
    console.warn("[ml.usage] Falha ao reportar consumo ao Hub:", error?.message || error);
    return { ok: false, error: error?.message || String(error) };
  }
}

function startHubUsageReporter() {
  if (started || isDisabled(process.env.HUB_USAGE_REPORTING)) return;
  const { baseUrl, token } = getHubConfig();
  if (!baseUrl || !token) return;
  started = true;

  const firstTimer = setTimeout(
    () => void runHubUsageReport(),
    positiveInt(process.env.HUB_USAGE_REPORT_INITIAL_DELAY_MS, DEFAULT_INITIAL_DELAY_MS),
  );
  firstTimer.unref?.();

  const interval = setInterval(
    () => void runHubUsageReport(),
    positiveInt(process.env.HUB_USAGE_REPORT_INTERVAL_MS, DEFAULT_INTERVAL_MS),
  );
  interval.unref?.();
}

module.exports = {
  _test: {
    buildReport,
    getExistingTableSet,
    loadFreshUsageCache,
    saveUsageCache,
    tableExistenceCache,
  },
  collectHubUsageReports,
  postUsageReports,
  runHubUsageReport,
  startHubUsageReporter,
};
