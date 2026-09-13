import { dbQuery } from '../lib/db';

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_INITIAL_DELAY_MS = 75 * 1000;
let started = false;

type UsageReport = { tenant_id: string; module: string; usage_date: string; metrics: Record<string, number> };
const normalizeConfigValue = (value: unknown) => String(value || '').trim().replace(/^["']|["']$/g, '');
const isDisabled = (value: unknown) => ['0', 'false', 'off', 'disabled', 'no'].includes(normalizeConfigValue(value).toLowerCase());
const positiveInt = (value: unknown, fallback: number) => { const parsed = Number.parseInt(String(value || ''), 10); return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback; };
const getHubConfig = () => ({ baseUrl: normalizeConfigValue(process.env.HUB_BASE_URL).replace(/\/+$/, ''), token: normalizeConfigValue(process.env.HUB_INTERNAL_TOKEN) });
const buildReport = (row: any, metricKey: string, value: unknown): UsageReport | null => {
  const tenantId = String(row?.tenant_id || '').trim();
  const usageDate = String(row?.usage_date || '').slice(0, 10);
  const amount = Number(value || 0);
  if (!tenantId || !usageDate || !Number.isFinite(amount) || amount < 0) return null;
  return { tenant_id: tenantId, module: 'tracking', usage_date: usageDate, metrics: { [metricKey]: amount } };
};
async function postUsageReports(reports: UsageReport[]) {
  const { baseUrl, token } = getHubConfig();
  if (!baseUrl || !token || reports.length === 0) return;
  const response = await fetch(`${baseUrl}/v1/internal/usage/report`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ reports }) });
  if (!response.ok) throw new Error(`Hub usage HTTP ${response.status}: ${(await response.text().catch(() => '')).slice(0, 180)}`);
}
export async function collectHubUsageReports(): Promise<UsageReport[]> {
  const ordersResult = await dbQuery<any>(`
    select coalesce(nullif(trim(c."tenantGlobalId"), ''), 'tracking_company_' || c."id"::text) as tenant_id,
           o."createdAt"::date::text as usage_date,
           count(*)::int as orders
      from "Company" c
      join "Order" o on o."companyId" = c."id"
     where o."createdAt" >= current_date - interval '30 days'
       and o."createdAt" < current_date + interval '1 day'
       and coalesce(nullif(trim(c."tenantGlobalId"), ''), '') <> ''
     group by tenant_id, usage_date
     order by usage_date asc`);
  const eventsResult = await dbQuery<any>(`
    select coalesce(nullif(trim(c."tenantGlobalId"), ''), 'tracking_company_' || c."id"::text) as tenant_id,
           te."createdAt"::date::text as usage_date,
           count(*)::int as tracking_events
      from "Company" c
      join "Order" o on o."companyId" = c."id"
      join "TrackingEvent" te on te."orderId" = o."id"
     where te."createdAt" >= current_date - interval '30 days'
       and te."createdAt" < current_date + interval '1 day'
       and coalesce(nullif(trim(c."tenantGlobalId"), ''), '') <> ''
     group by tenant_id, usage_date
     order by usage_date asc`);
  const reports = [
    ...(ordersResult.rows || []).map((row) => buildReport(row, 'orders', row.orders)),
    ...(eventsResult.rows || []).map((row) => buildReport(row, 'tracking_events', row.tracking_events)),
  ].filter(Boolean) as UsageReport[];
  const reportsByKey = new Map<string, UsageReport>();
  reports.forEach((report) => {
    const key = `${report.tenant_id}:${report.usage_date}`;
    const current = reportsByKey.get(key) || { ...report, metrics: {} };
    current.metrics = { ...current.metrics, ...report.metrics };
    reportsByKey.set(key, current);
  });
  return Array.from(reportsByKey.values()).map((report) => ({
    ...report,
    metrics: {
      ...report.metrics,
      activity_units: Number(report.metrics.orders || 0) + Number(report.metrics.tracking_events || 0),
    },
  }));
}
export async function runHubUsageReport() { try { const reports = await collectHubUsageReports(); await postUsageReports(reports); if (reports.length) console.log(`[tracking.usage] ${reports.length} reporte(s) enviados ao Hub.`); } catch (error: any) { console.warn('[tracking.usage] Falha ao reportar consumo ao Hub:', error?.message || error); } }
export function startHubUsageReporter() { if (started || isDisabled(process.env.HUB_USAGE_REPORTING)) return; const { baseUrl, token } = getHubConfig(); if (!baseUrl || !token) return; started = true; const firstTimer = setTimeout(() => void runHubUsageReport(), positiveInt(process.env.HUB_USAGE_REPORT_INITIAL_DELAY_MS, DEFAULT_INITIAL_DELAY_MS)); firstTimer.unref?.(); const interval = setInterval(() => void runHubUsageReport(), positiveInt(process.env.HUB_USAGE_REPORT_INTERVAL_MS, DEFAULT_INTERVAL_MS)); interval.unref?.(); }
