"use strict";

const api = require("./magaluApiClient");
const limiter = require("./magaluRateLimiter");
const repository = require("../repositories/financialAnalysisRepository");
const { normalizeReport } = require("./financialAnalysisNormalizer");

const SCOPE = "open:order-financial-report-seller:read";
const DAY_MS = 86_400_000;
function parseDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) throw Object.assign(new Error("Informe datas válidas para o período financeiro."), { status: 400 });
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) throw Object.assign(new Error("Informe datas válidas para o período financeiro."), { status: 400 });
  return ms;
}
function day(ms) { return new Date(ms).toISOString().slice(0, 10); }
function dateWindows(from, to) {
  const start = parseDay(from), end = parseDay(to);
  if (end < start) throw Object.assign(new Error("O período financeiro está invertido."), { status: 400 });
  if ((end - start) / DAY_MS > 89) throw Object.assign(new Error("Consulte no máximo 90 dias por vez."), { status: 400 });
  const windows = [];
  for (let cursor = start; cursor <= end; cursor += 15 * DAY_MS) windows.push([day(cursor), day(Math.min(end, cursor + 14 * DAY_MS))]);
  return windows;
}
function assertFinancialScope(account) {
  if (!Array.isArray(account?.scopes) || !account.scopes.includes(SCOPE)) {
    throw Object.assign(new Error(`Escopo financeiro ausente nesta conta: ${SCOPE}. Reconecte após sua liberação.`), { status: 409, code: "MAGALU_FINANCIAL_SCOPE_MISSING" });
  }
}
function pagePath(from, to, offset = 0) {
  const params = new URLSearchParams({
    purchased_at__gte: `${from}T00:00:00Z`, purchased_at__lte: `${to}T23:59:59.999999Z`,
    _limit: "100", _offset: String(offset),
  });
  return `/seller/v1/financial-analysis/orders?${params}`;
}
async function syncRange(account, { from, to }) {
  assertFinancialScope(account);
  const windows = dateWindows(from, to);
  let fetched = 0, pages = 0;
  const reports = new Map();
  for (const [start, end] of windows) {
    let offset = 0;
    for (;;) {
      await limiter.waitFor(account.id, "order-read");
      const response = await api.request(pagePath(start, end, offset), { accountId: account.id, dachTenantId: account.dach_tenant_id, attempts: 3, timeoutMs: 15_000 });
      const results = response.data?.results;
      if (!Array.isArray(results)) throw Object.assign(new Error("A API financeira retornou uma página inválida."), { status: 502 });
      if (!results.length && response.data?.meta?.links?.next) throw Object.assign(new Error("A API financeira retornou página financeira vazia com continuação."), { status: 502 });
      for (const report of results) {
        const normalized = normalizeReport(report);
        const existing = reports.get(normalized.orderCode);
        if (!existing || String(normalized.remoteUpdatedAt || "") >= String(existing.remoteUpdatedAt || "")) reports.set(normalized.orderCode, normalized);
        fetched += 1;
      }
      pages += 1;
      offset += results.length;
      if (!response.data?.meta?.links?.next) break;
      if (pages >= 200) throw Object.assign(new Error("Limite de páginas financeiras atingido; reduza o período."), { status: 422 });
    }
  }
  await repository.upsertBatch(account.id, [...reports.values()]);
  return { fetched, persisted: reports.size, pages, windows: windows.length };
}

module.exports = { SCOPE, dateWindows, assertFinancialScope, pagePath, syncRange };
