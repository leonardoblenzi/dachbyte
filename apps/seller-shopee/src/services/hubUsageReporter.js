"use strict";

const { query } = require("../config/postgres");
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_INITIAL_DELAY_MS = 75 * 1000;
const EXCLUDED_STATUSES = ["CANCELLED", "UNPAID", "TO_RETURN", "IN_CANCEL"];
const EXCLUDED_CARRIERS = ["retirada normal na agencia", "retirada normal na agência"];
let started = false;
function normalizeConfigValue(value) { return String(value || "").trim().replace(/^["']|["']$/g, ""); }
function isDisabled(value) { return ["0", "false", "off", "disabled", "no"].includes(normalizeConfigValue(value).toLowerCase()); }
function positiveInt(value, fallback) { const parsed = Number.parseInt(String(value || ""), 10); return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback; }
function getHubConfig() { return { baseUrl: normalizeConfigValue(process.env.HUB_BASE_URL).replace(/\/+$/, ""), token: normalizeConfigValue(process.env.HUB_INTERNAL_TOKEN) }; }
function buildReport(row, metricKey, value) { const tenantId = String(row.tenant_id || "").trim(); const usageDate = String(row.usage_date || "").slice(0, 10); const amount = Number(value || 0); if (!tenantId || !usageDate || !Number.isFinite(amount) || amount < 0) return null; return { tenant_id: tenantId, module: "shopee", usage_date: usageDate, metrics: { [metricKey]: amount } }; }
async function tableExists(tableName) { const result = await query("select to_regclass($1) as table_name", [tableName]); return Boolean(result.rows?.[0]?.table_name); }
async function collectHubUsageReports() {
  const reportsByKey = new Map();
  const mergeMetric = (row, metricKey, value) => {
    const report = buildReport(row, metricKey, value);
    if (!report) return;
    const key = `${report.tenant_id}:${report.usage_date}`;
    const current = reportsByKey.get(key) || { ...report, metrics: {} };
    current.metrics[metricKey] = report.metrics[metricKey];
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
  const ordersResult = await query(`
    select coalesce(nullif(trim(a."tenantGlobalId"), ''), 'shopee_account_' || a.id::text) as tenant_id,
           coalesce(o."shopeeCreateTime", o."createdAt")::date::text as usage_date,
           count(*)::int as orders
      from "Account" a
      join "Shop" s on s."accountId" = a.id
      join "Order" o on o."shopId" = s.id
     where coalesce(o."shopeeCreateTime", o."createdAt") >= current_date - interval '30 days'
       and coalesce(o."shopeeCreateTime", o."createdAt") < current_date + interval '1 day'
       and o."orderStatus" is not null
       and o."orderStatus" <> all($1::text[])
       and lower(coalesce(o."shippingCarrier", '')) <> all($2::text[])
       and coalesce(nullif(trim(a."tenantGlobalId"), ''), '') <> ''
     group by tenant_id, usage_date
     order by usage_date asc`, [EXCLUDED_STATUSES, EXCLUDED_CARRIERS]);
  for (const row of ordersResult.rows || []) mergeMetric(row, "orders", row.orders);
  const productsResult = await query(`
    select coalesce(nullif(trim(a."tenantGlobalId"), ''), 'shopee_account_' || a.id::text) as tenant_id,
           current_date::text as usage_date,
           count(p.id)::int as products
      from "Account" a
      join "Shop" s on s."accountId" = a.id
      join "Product" p on p."shopId" = s.id
     where coalesce(nullif(trim(a."tenantGlobalId"), ''), '') <> ''
     group by a.id, a."tenantGlobalId"`);
  for (const row of productsResult.rows || []) mergeMetric(row, "products", row.products);
  for (const row of productsResult.rows || []) addMetric(row, "stored_records", row.products);
  const footprintSources = [
    { table: '"ProductModel"', joins: 'join "Product" p on p."shopId" = s.id join "ProductModel" t on t."productId" = p.id' },
    { table: '"ProductImage"', joins: 'join "Product" p on p."shopId" = s.id join "ProductImage" t on t."productId" = p.id' },
    { table: '"Order"', joins: 'join "Order" t on t."shopId" = s.id' },
    { table: '"OrderItem"', joins: 'join "OrderItem" t on t."shopId" = s.id' },
    { table: '"AdsHourlyMetric"', joins: 'join "AdsHourlyMetric" t on t."shopId" = s.id' },
    { table: '"OrderAdsAttribution"', joins: 'join "OrderAdsAttribution" t on t."shopId" = s.id' },
    { table: '"ProductTrafficDaily"', joins: 'join "ProductTrafficDaily" t on t."shopId" = s.id' },
    { table: '"DiscountCampaign"', joins: 'join "DiscountCampaign" t on t."shopId" = s.id' },
    { table: '"DiscountItem"', joins: 'join "DiscountCampaign" c on c."shopId" = s.id join "DiscountItem" t on t."campaignId" = c.id' },
    { table: '"ListingCloneDraft"', joins: 'join "ListingCloneDraft" t on t."shopId" = s.id' },
    { table: '"ProductBoostBatch"', joins: 'join "ProductBoostBatch" t on t."shopId" = s.id' },
    { table: '"ProductBoostBatchItem"', joins: 'join "ProductBoostBatchItem" t on t."shopId" = s.id' },
    { table: '"StockAlertMonitor"', joins: 'join "StockAlertMonitor" t on t."shopId" = s.id' },
    { table: '"ProductPriceUpdateEvent"', joins: 'join "ProductPriceUpdateEvent" t on t."shopId" = s.id' }
  ];
  for (const source of footprintSources) {
    if (!(await tableExists(source.table))) continue;
    const result = await query(`
      select a."tenantGlobalId" as tenant_id,
             current_date::text as usage_date,
             count(t.*)::int as stored_records
        from "Account" a
        join "Shop" s on s."accountId" = a.id
        ${source.joins}
       where coalesce(nullif(trim(a."tenantGlobalId"), ''), '') <> ''
       group by a."tenantGlobalId"`);
    for (const row of result.rows || []) addMetric(row, "stored_records", row.stored_records);
  }
  if (await tableExists('"ProcessExecutionLog"')) {
    const result = await query(`
      select a."tenantGlobalId" as tenant_id,
             p."requestedAt"::date::text as usage_date,
             count(p.*)::int as processed_items
        from "Account" a
        join "ProcessExecutionLog" p on p."accountId" = a.id
       where p."requestedAt" >= current_date - interval '30 days'
         and coalesce(nullif(trim(a."tenantGlobalId"), ''), '') <> ''
       group by a."tenantGlobalId", p."requestedAt"::date`);
    for (const row of result.rows || []) addMetric(row, "processed_items", row.processed_items);
  }
  if (await tableExists('"ProductTrafficDaily"')) {
    const result = await query(`
      select a."tenantGlobalId" as tenant_id,
             t."trafficDate"::text as usage_date,
             count(t.*)::int as processed_items
        from "Account" a
        join "Shop" s on s."accountId" = a.id
        join "ProductTrafficDaily" t on t."shopId" = s.id
       where t."trafficDate" >= current_date - interval '30 days'
         and coalesce(nullif(trim(a."tenantGlobalId"), ''), '') <> ''
       group by a."tenantGlobalId", t."trafficDate"`);
    for (const row of result.rows || []) addMetric(row, "processed_items", row.processed_items);
  }
  if (await tableExists('"ProductBoostBatchItem"')) {
    const result = await query(`
      select a."tenantGlobalId" as tenant_id,
             t."createdAt"::date::text as usage_date,
             count(t.*)::int as processed_items
        from "Account" a
        join "Shop" s on s."accountId" = a.id
        join "ProductBoostBatchItem" t on t."shopId" = s.id
       where t."createdAt" >= current_date - interval '30 days'
         and coalesce(nullif(trim(a."tenantGlobalId"), ''), '') <> ''
       group by a."tenantGlobalId", t."createdAt"::date`);
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
async function postUsageReports(reports) { const { baseUrl, token } = getHubConfig(); if (!baseUrl || !token || !reports.length) return; const response = await fetch(`${baseUrl}/v1/internal/usage/report`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ reports }) }); if (!response.ok) throw new Error(`Hub usage HTTP ${response.status}: ${(await response.text().catch(() => "")).slice(0, 180)}`); }
async function runHubUsageReport() { try { const reports = await collectHubUsageReports(); await postUsageReports(reports); if (reports.length) console.log(`[shopee.usage] ${reports.length} reporte(s) enviados ao Hub.`); } catch (error) { console.warn("[shopee.usage] Falha ao reportar consumo ao Hub:", error?.message || error); } }
function startHubUsageReporter() { if (started || isDisabled(process.env.HUB_USAGE_REPORTING)) return; const { baseUrl, token } = getHubConfig(); if (!baseUrl || !token) return; started = true; const firstTimer = setTimeout(() => void runHubUsageReport(), positiveInt(process.env.HUB_USAGE_REPORT_INITIAL_DELAY_MS, DEFAULT_INITIAL_DELAY_MS)); firstTimer.unref?.(); const interval = setInterval(() => void runHubUsageReport(), positiveInt(process.env.HUB_USAGE_REPORT_INTERVAL_MS, DEFAULT_INTERVAL_MS)); interval.unref?.(); }
module.exports = { collectHubUsageReports, runHubUsageReport, startHubUsageReporter };
