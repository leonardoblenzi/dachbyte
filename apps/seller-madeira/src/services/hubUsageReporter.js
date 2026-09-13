"use strict";

const { queryRows } = require("./databaseService");
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_INITIAL_DELAY_MS = 75 * 1000;
let started = false;
function normalizeConfigValue(value) { return String(value || "").trim().replace(/^["']|["']$/g, ""); }
function isDisabled(value) { return ["0", "false", "off", "disabled", "no"].includes(normalizeConfigValue(value).toLowerCase()); }
function positiveInt(value, fallback) { const parsed = Number.parseInt(String(value || ""), 10); return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback; }
function getHubConfig() { return { baseUrl: normalizeConfigValue(process.env.HUB_BASE_URL).replace(/\/+$/, ""), token: normalizeConfigValue(process.env.HUB_INTERNAL_TOKEN) }; }
function buildReport(row, metricKey, value) { const tenantId = String(row.tenant_id || "").trim(); const usageDate = String(row.usage_date || "").slice(0, 10); const amount = Number(value || 0); if (!tenantId || !usageDate || !Number.isFinite(amount) || amount < 0) return null; return { tenant_id: tenantId, module: "madeira", usage_date: usageDate, metrics: { [metricKey]: amount } }; }
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
  const rows = await queryRows(`
    select coalesce(nullif(trim(w."tenantGlobalId"), ''), 'madeira_workspace_' || w."id"::text) as tenant_id,
           coalesce(o."approvedAt", o."importedAt", o."createdAt")::date::text as usage_date,
           count(*)::int as orders
      from "MadWorkspace" w
      join "MadOrder" o on o."workspaceId" = w."id"
     where coalesce(o."approvedAt", o."importedAt", o."createdAt") >= current_date - interval '30 days'
       and coalesce(o."approvedAt", o."importedAt", o."createdAt") < current_date + interval '1 day'
       and coalesce(lower(o."status"::text), '') <> all($1::text[])
       and coalesce(nullif(trim(w."tenantGlobalId"), ''), '') <> ''
     group by tenant_id, usage_date
     order by usage_date asc`, [["cancelled", "returned", "refunded"]]);
  for (const row of rows || []) mergeMetric(row, "orders", row.orders);
  const products = await queryRows(`
    select coalesce(nullif(trim(w."tenantGlobalId"), ''), 'madeira_workspace_' || w."id"::text) as tenant_id,
           current_date::text as usage_date,
           count(p."id")::int as products
      from "MadWorkspace" w
      join "MadProduct" p on p."workspaceId" = w."id"
     where coalesce(nullif(trim(w."tenantGlobalId"), ''), '') <> ''
     group by w."id", w."tenantGlobalId"`);
  for (const row of products || []) mergeMetric(row, "products", row.products);
  return Array.from(reportsByKey.values()).map((report) => ({
    ...report,
    metrics: {
      ...report.metrics,
      activity_units: Number(report.metrics.orders || 0) + Number(report.metrics.products || 0)
    }
  }));
}
async function postUsageReports(reports) { const { baseUrl, token } = getHubConfig(); if (!baseUrl || !token || !reports.length) return; const response = await fetch(`${baseUrl}/v1/internal/usage/report`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ reports }) }); if (!response.ok) throw new Error(`Hub usage HTTP ${response.status}: ${(await response.text().catch(() => "")).slice(0, 180)}`); }
async function runHubUsageReport() { try { const reports = await collectHubUsageReports(); await postUsageReports(reports); if (reports.length) console.log(`[madeira.usage] ${reports.length} reporte(s) enviados ao Hub.`); } catch (error) { console.warn("[madeira.usage] Falha ao reportar consumo ao Hub:", error?.message || error); } }
function startHubUsageReporter() { if (started || isDisabled(process.env.HUB_USAGE_REPORTING)) return; const { baseUrl, token } = getHubConfig(); if (!baseUrl || !token) return; started = true; const firstTimer = setTimeout(() => void runHubUsageReport(), positiveInt(process.env.HUB_USAGE_REPORT_INITIAL_DELAY_MS, DEFAULT_INITIAL_DELAY_MS)); firstTimer.unref?.(); const interval = setInterval(() => void runHubUsageReport(), positiveInt(process.env.HUB_USAGE_REPORT_INTERVAL_MS, DEFAULT_INTERVAL_MS)); interval.unref?.(); }
module.exports = { collectHubUsageReports, runHubUsageReport, startHubUsageReporter };
