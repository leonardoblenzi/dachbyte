"use strict";

const { querySku } = require("./db");
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_INITIAL_DELAY_MS = 75 * 1000;
let started = false;
function normalizeConfigValue(value) { return String(value || "").trim().replace(/^["']|["']$/g, ""); }
function isDisabled(value) { return ["0", "false", "off", "disabled", "no"].includes(normalizeConfigValue(value).toLowerCase()); }
function positiveInt(value, fallback) { const parsed = Number.parseInt(String(value || ""), 10); return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback; }
function getHubConfig() { return { baseUrl: normalizeConfigValue(process.env.HUB_BASE_URL).replace(/\/+$/, ""), token: normalizeConfigValue(process.env.HUB_INTERNAL_TOKEN) }; }
function buildReport(row, metricKey, value) { const tenantId = String(row.tenant_id || "").trim(); const usageDate = String(row.usage_date || "").slice(0, 10); const amount = Number(value || 0); if (!tenantId || !usageDate || !Number.isFinite(amount) || amount < 0) return null; return { tenant_id: tenantId, module: "skuleader", usage_date: usageDate, metrics: { [metricKey]: amount } }; }
async function collectHubUsageReports() {
  const result = await querySku(`
    select tenant_global_id as tenant_id,
           current_date::text as usage_date,
           count(*)::int as skus
      from skuleader.sku_links
     where coalesce(nullif(trim(tenant_global_id), ''), '') <> ''
     group by tenant_global_id`);
  return (result.rows || []).map((row) => {
    const report = buildReport(row, "skus", row.skus);
    if (!report) return null;
    report.metrics.activity_units = Number(row.skus || 0);
    return report;
  }).filter(Boolean);
}
async function postUsageReports(reports) { const { baseUrl, token } = getHubConfig(); if (!baseUrl || !token || !reports.length) return; const response = await fetch(`${baseUrl}/v1/internal/usage/report`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ reports }) }); if (!response.ok) throw new Error(`Hub usage HTTP ${response.status}: ${(await response.text().catch(() => "")).slice(0, 180)}`); }
async function runHubUsageReport() { try { const reports = await collectHubUsageReports(); await postUsageReports(reports); if (reports.length) console.log(`[skuleader.usage] ${reports.length} reporte(s) enviados ao Hub.`); } catch (error) { console.warn("[skuleader.usage] Falha ao reportar consumo ao Hub:", error?.message || error); } }
function startHubUsageReporter() { if (started || isDisabled(process.env.HUB_USAGE_REPORTING)) return; const { baseUrl, token } = getHubConfig(); if (!baseUrl || !token) return; started = true; const firstTimer = setTimeout(() => void runHubUsageReport(), positiveInt(process.env.HUB_USAGE_REPORT_INITIAL_DELAY_MS, DEFAULT_INITIAL_DELAY_MS)); firstTimer.unref?.(); const interval = setInterval(() => void runHubUsageReport(), positiveInt(process.env.HUB_USAGE_REPORT_INTERVAL_MS, DEFAULT_INTERVAL_MS)); interval.unref?.(); }
module.exports = { collectHubUsageReports, runHubUsageReport, startHubUsageReporter };
