"use strict";

const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const db = require("../db/db");
const TokenService = require("./tokenService");
const ProductAdsService = require("./productAdsService");
const { decryptToken } = require("./tokenCrypto");

const REPORT_STATUSES = {
  QUEUED: "QUEUED",
  RUNNING: "RUNNING",
  SUCCESS: "SUCCESS",
  FAILED: "FAILED",
};

const TZ = process.env.ML_REPORT_TZ || "America/Sao_Paulo";
const GENERATED_DIR = path.join(__dirname, "..", "generated", "meli-account-performance-reports");
const RETENTION_HOURS = 24;
const RETENTION_MS = RETENTION_HOURS * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const MAX_ORDERS_PER_REPORT = Number(process.env.ML_ACCOUNT_REPORT_MAX_ORDERS || 5000);
const REPORT_UTC_OFFSET = process.env.ML_REPORT_UTC_OFFSET || "-03:00";
const RETENTION_NOTICE =
  "Este relatorio fica disponivel para download por 24h apos a geracao; depois disso o registro e os arquivos sao removidos automaticamente.";

let schemaReadyPromise = null;
let cleanupTimer = null;

function nowIso() {
  return new Date().toISOString();
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function moneyToCents(value) {
  return Math.round(toNumber(value, 0) * 100);
}

function cents(value) {
  return Math.round(toNumber(value, 0));
}

function moneyCell(value) {
  return Number((cents(value) / 100).toFixed(2));
}

function formatBRL(value) {
  return (cents(value) / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function formatPercent(value) {
  return `${toNumber(value, 0).toFixed(2)}%`;
}

function formatDate(value) {
  try {
    return value ? new Date(value).toLocaleDateString("pt-BR", { timeZone: TZ }) : "-";
  } catch {
    return String(value || "-");
  }
}

function formatDateTime(value) {
  try {
    return value ? new Date(value).toLocaleString("pt-BR", { timeZone: TZ }) : "-";
  } catch {
    return String(value || "-");
  }
}

function isoDateTime(value) {
  const d = value ? new Date(value) : new Date();
  return Number.isFinite(d.getTime()) ? d.toISOString() : new Date().toISOString();
}

function sanitizeFilePart(value) {
  return String(value || "conta-ml")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70) || "conta-ml";
}

function ensureGeneratedDir() {
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
}

function getPeriodRange(periodDays = 90) {
  const days = clampInt(periodDays, 7, 180, 90);
  const to = new Date();
  const from = new Date(to.getTime() - days * 86400000);
  return { days, from, to };
}

function parseDateOnly(value, label) {
  const normalized = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    const error = new Error(`Informe ${label} no formato AAAA-MM-DD.`);
    error.statusCode = 400;
    throw error;
  }
  const [year, month, day] = normalized.split("-").map(Number);
  const utcDate = new Date(Date.UTC(year, month - 1, day));
  if (
    utcDate.getUTCFullYear() !== year
    || utcDate.getUTCMonth() !== month - 1
    || utcDate.getUTCDate() !== day
  ) {
    const error = new Error(`Informe ${label} valida.`);
    error.statusCode = 400;
    throw error;
  }
  return { normalized, utcDate };
}

function getCustomPeriodRange(periodFrom, periodTo) {
  const fromDate = parseDateOnly(periodFrom, "uma data inicial");
  const toDate = parseDateOnly(periodTo, "uma data final");
  if (fromDate.utcDate > toDate.utcDate) {
    const error = new Error("A data inicial deve ser anterior ou igual a data final.");
    error.statusCode = 400;
    throw error;
  }
  const days = Math.floor((toDate.utcDate - fromDate.utcDate) / 86400000) + 1;
  if (days > 180) {
    const error = new Error("O periodo personalizado pode ter no maximo 180 dias.");
    error.statusCode = 400;
    throw error;
  }
  const today = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
  if (toDate.normalized > today) {
    const error = new Error("A data final nao pode estar no futuro.");
    error.statusCode = 400;
    throw error;
  }
  return {
    days,
    from: new Date(`${fromDate.normalized}T00:00:00.000${REPORT_UTC_OFFSET}`),
    to: new Date(`${toDate.normalized}T23:59:59.999${REPORT_UTC_OFFSET}`),
  };
}

function getPreviousPeriodRange(periodFrom, periodTo) {
  const from = new Date(periodFrom);
  const to = new Date(periodTo);
  const duration = Math.max(1, to.getTime() - from.getTime() + 1);
  const previousTo = new Date(from.getTime() - 1);
  const previousFrom = new Date(previousTo.getTime() - duration + 1);
  return { from: previousFrom, to: previousTo };
}

function dateOnlyInReportTimeZone(value) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function percentChange(current, previous) {
  const currentValue = toNumber(current, 0);
  const previousValue = toNumber(previous, 0);
  if (previousValue === 0) return currentValue === 0 ? 0 : null;
  return ((currentValue - previousValue) / Math.abs(previousValue)) * 100;
}

function getReportExpiryDate(row) {
  const raw = row?.completed_at || row?.completedAt || row?.created_at || row?.createdAt;
  const date = raw ? new Date(raw) : null;
  return date && Number.isFinite(date.getTime())
    ? new Date(date.getTime() + RETENTION_MS).toISOString()
    : null;
}

async function ensureSchema() {
  if (!schemaReadyPromise) {
    schemaReadyPromise = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS admin_meli_account_performance_reports (
          id BIGSERIAL PRIMARY KEY,
          meli_conta_id BIGINT NOT NULL REFERENCES meli_contas (id) ON DELETE CASCADE,
          empresa_id BIGINT REFERENCES empresas (id) ON DELETE SET NULL,
          account_label TEXT,
          empresa_nome TEXT,
          meli_user_id BIGINT,
          generated_by_user_id BIGINT,
          generated_by_email TEXT,
          period_from TIMESTAMPTZ NOT NULL,
          period_to TIMESTAMPTZ NOT NULL,
          period_days INTEGER NOT NULL DEFAULT 90,
          status TEXT NOT NULL DEFAULT 'QUEUED',
          progress INTEGER NOT NULL DEFAULT 0,
          current_step TEXT,
          xlsx_path TEXT,
          pdf_path TEXT,
          logs JSONB NOT NULL DEFAULT '[]'::jsonb,
          summary JSONB,
          error TEXT,
          started_at TIMESTAMPTZ,
          completed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await db.query(`
        CREATE INDEX IF NOT EXISTS ix_admin_meli_reports_account_created
          ON admin_meli_account_performance_reports (meli_conta_id, created_at DESC)
      `);
      await db.query(`
        CREATE INDEX IF NOT EXISTS ix_admin_meli_reports_status
          ON admin_meli_account_performance_reports (status)
      `);
    })().catch((error) => {
      schemaReadyPromise = null;
      throw error;
    });
  }
  return schemaReadyPromise;
}

function mapReportRow(row) {
  if (!row) return null;
  const mapped = {
    id: Number(row.id),
    meliContaId: row.meli_conta_id == null ? null : Number(row.meli_conta_id),
    empresaId: row.empresa_id == null ? null : Number(row.empresa_id),
    accountLabel: row.account_label || null,
    empresaNome: row.empresa_nome || null,
    meliUserId: row.meli_user_id == null ? null : String(row.meli_user_id),
    generatedByUserId: row.generated_by_user_id == null ? null : Number(row.generated_by_user_id),
    generatedByEmail: row.generated_by_email || null,
    periodFrom: row.period_from || null,
    periodTo: row.period_to || null,
    periodDays: Number(row.period_days || 90),
    status: row.status || REPORT_STATUSES.QUEUED,
    progress: Number(row.progress || 0),
    currentStep: row.current_step || null,
    xlsxPath: row.xlsx_path || null,
    pdfPath: row.pdf_path || null,
    logs: Array.isArray(row.logs) ? row.logs : [],
    summary: row.summary || null,
    error: row.error || null,
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
  mapped.expiresAt = getReportExpiryDate(row);
  mapped.retentionHours = RETENTION_HOURS;
  mapped.retentionNotice = RETENTION_NOTICE;
  return mapped;
}

function deleteReportFileIfSafe(filePath) {
  if (!filePath) return;
  const resolved = path.resolve(filePath);
  const root = path.resolve(GENERATED_DIR);
  if (!resolved.startsWith(root)) return;
  try {
    if (fs.existsSync(resolved)) fs.unlinkSync(resolved);
  } catch (error) {
    console.warn("[AdminMeliAccountReport] Falha ao excluir arquivo expirado", error?.message || error);
  }
}

async function cleanupExpiredReports() {
  await ensureSchema();
  const result = await db.query(
    `SELECT id, xlsx_path, pdf_path
       FROM admin_meli_account_performance_reports
      WHERE COALESCE(completed_at, created_at) < NOW() - ($1::text)::interval
      LIMIT 500`,
    [`${RETENTION_HOURS} hours`],
  );
  const ids = [];
  for (const row of result.rows || []) {
    ids.push(Number(row.id));
    deleteReportFileIfSafe(row.xlsx_path);
    deleteReportFileIfSafe(row.pdf_path);
  }
  if (ids.length) {
    await db.query(`DELETE FROM admin_meli_account_performance_reports WHERE id = ANY($1::bigint[])`, [ids]);
  }
  return ids.length;
}

function startReportRetentionCleanup() {
  if (cleanupTimer) return () => {};
  const run = async () => {
    try {
      const removed = await cleanupExpiredReports();
      if (removed > 0) {
        console.log(`[AdminMeliAccountReport] ${removed} relatorio(s) expirado(s) removido(s).`);
      }
    } catch (error) {
      console.warn("[AdminMeliAccountReport] Falha na limpeza:", error?.message || error);
    }
  };
  void run();
  cleanupTimer = setInterval(() => void run(), CLEANUP_INTERVAL_MS);
  cleanupTimer.unref?.();
  return () => {
    if (cleanupTimer) clearInterval(cleanupTimer);
    cleanupTimer = null;
  };
}

async function appendLog(reportId, message, progress = null, status = null) {
  const entry = { at: nowIso(), message: String(message || "") };
  const sets = [
    `logs = COALESCE(logs, '[]'::jsonb) || $2::jsonb`,
    `current_step = $3`,
    `updated_at = NOW()`,
  ];
  const params = [Number(reportId), JSON.stringify([entry]), entry.message];
  if (progress != null) {
    params.push(clampInt(progress, 0, 100, 0));
    sets.push(`progress = $${params.length}`);
  }
  if (status) {
    params.push(status);
    sets.push(`status = $${params.length}`);
  }
  await db.query(`UPDATE admin_meli_account_performance_reports SET ${sets.join(", ")} WHERE id = $1`, params);
}

async function listAccounts() {
  await ensureSchema();
  const result = await db.query(`
    SELECT mc.id,
           mc.empresa_id,
           e.nome AS empresa_nome,
           mc.meli_user_id,
           mc.apelido,
           mc.site_id,
           mc.status,
           mc.ultimo_uso_em,
           mt.meli_conta_id IS NOT NULL AS has_tokens,
           mt.access_expires_at,
           mt.ultimo_refresh_em
      FROM meli_contas mc
      JOIN empresas e ON e.id = mc.empresa_id
      LEFT JOIN meli_tokens mt ON mt.meli_conta_id = mc.id
     ORDER BY e.nome ASC, mc.apelido ASC, mc.id ASC
  `);
  return result.rows.map((row) => ({
    id: Number(row.id),
    empresaId: Number(row.empresa_id),
    empresaNome: row.empresa_nome || null,
    meliUserId: row.meli_user_id == null ? null : String(row.meli_user_id),
    apelido: row.apelido || null,
    siteId: row.site_id || "MLB",
    status: row.status || null,
    ultimoUsoEm: row.ultimo_uso_em || null,
    hasTokens: row.has_tokens === true,
    accessExpiresAt: row.access_expires_at || null,
    ultimoRefreshEm: row.ultimo_refresh_em || null,
  }));
}

async function listReports({ meliContaId = null, limit = 80 } = {}) {
  await ensureSchema();
  await cleanupExpiredReports();
  const params = [];
  let where = "";
  if (meliContaId != null && Number.isFinite(Number(meliContaId))) {
    params.push(Number(meliContaId));
    where = `WHERE meli_conta_id = $${params.length}`;
  }
  params.push(clampInt(limit, 1, 200, 80));
  const result = await db.query(
    `SELECT * FROM admin_meli_account_performance_reports ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length}`,
    params,
  );
  return result.rows.map(mapReportRow);
}

async function getReportById(reportId) {
  await ensureSchema();
  await cleanupExpiredReports();
  const result = await db.query(
    `SELECT * FROM admin_meli_account_performance_reports WHERE id = $1 LIMIT 1`,
    [Number(reportId)],
  );
  return mapReportRow(result.rows[0] || null);
}

async function loadAccount(meliContaId, { includeToken = false } = {}) {
  const result = await db.query(
    `SELECT mc.id,
            mc.empresa_id,
            e.nome AS empresa_nome,
            e.document_type,
            e.document_number,
            mc.meli_user_id,
            mc.apelido,
            mc.site_id,
            mc.status,
            mt.access_token,
            mt.access_expires_at,
            mt.refresh_token,
            mt.scope
       FROM meli_contas mc
       JOIN empresas e ON e.id = mc.empresa_id
       LEFT JOIN meli_tokens mt ON mt.meli_conta_id = mc.id
      WHERE mc.id = $1
      LIMIT 1`,
    [Number(meliContaId)],
  );
  const row = result.rows[0];
  if (!row) return null;
  const account = {
    id: Number(row.id),
    empresaId: Number(row.empresa_id),
    empresaNome: row.empresa_nome || null,
    documentType: row.document_type || null,
    documentNumber: row.document_number || null,
    meliUserId: row.meli_user_id == null ? null : String(row.meli_user_id),
    apelido: row.apelido || `Conta ${row.id}`,
    label: `${row.empresa_nome || "Empresa"} - ${row.apelido || row.meli_user_id || row.id}`,
    siteId: row.site_id || "MLB",
    status: row.status || null,
  };
  if (includeToken) {
    account.creds = {
      meli_conta_id: account.id,
      meli_user_id: account.meliUserId,
      account_key: String(account.id),
      access_token: row.access_token ? decryptToken(row.access_token) : null,
      access_expires_at: row.access_expires_at || null,
      refresh_token: row.refresh_token ? decryptToken(row.refresh_token) : null,
      scope: row.scope || null,
    };
  }
  return account;
}

async function createReport({ meliContaId, userId, email, periodDays = 90, periodFrom = null, periodTo = null }) {
  await ensureSchema();
  await cleanupExpiredReports();
  const hasCustomPeriod = periodFrom != null || periodTo != null;
  const range = hasCustomPeriod
    ? getCustomPeriodRange(periodFrom, periodTo)
    : getPeriodRange(periodDays);
  const account = await loadAccount(meliContaId);
  if (!account) {
    const error = new Error("Conta Mercado Livre nao encontrada.");
    error.statusCode = 404;
    throw error;
  }
  const result = await db.query(
    `INSERT INTO admin_meli_account_performance_reports
       (meli_conta_id, empresa_id, account_label, empresa_nome, meli_user_id,
        generated_by_user_id, generated_by_email, period_from, period_to, period_days,
        status, progress, current_step, logs)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'QUEUED', 0, 'Aguardando processamento', '[]'::jsonb)
     RETURNING *`,
    [
      account.id,
      account.empresaId,
      account.apelido,
      account.empresaNome,
      account.meliUserId,
      userId == null ? null : Number(userId),
      email || null,
      range.from,
      range.to,
      range.days,
    ],
  );
  const report = mapReportRow(result.rows[0]);
  setImmediate(() => runReport(report.id).catch((error) => console.error("[AdminMeliAccountReport]", error)));
  return report;
}

async function mlGetJson(url, accessToken) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = data?.message || data?.error || `Mercado Livre HTTP ${response.status}`;
    throw new Error(message);
  }
  return data;
}

async function fetchSellerProfile({ account, accessToken }) {
  try {
    const user = await mlGetJson(`https://api.mercadolibre.com/users/${encodeURIComponent(account.meliUserId)}`, accessToken);
    return {
      id: user?.id || account.meliUserId,
      nickname: user?.nickname || null,
      permalink: user?.permalink || null,
      reputation: user?.seller_reputation || null,
    };
  } catch (error) {
    return {
      id: account.meliUserId,
      nickname: null,
      permalink: null,
      reputation: null,
      warning: `Nao foi possivel carregar reputacao do vendedor: ${error?.message || error}`,
    };
  }
}

async function fetchOrders({ account, accessToken, periodFrom, periodTo, reportId = null, status = "paid" }) {
  const orders = [];
  const warnings = [];
  let offset = 0;
  const limit = 50;
  let total = null;
  while (orders.length < MAX_ORDERS_PER_REPORT) {
    const url = new URL("https://api.mercadolibre.com/orders/search");
    url.searchParams.set("seller", String(account.meliUserId));
    url.searchParams.set("order.status", String(status));
    url.searchParams.set("order.date_created.from", isoDateTime(periodFrom));
    url.searchParams.set("order.date_created.to", isoDateTime(periodTo));
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    const data = await mlGetJson(url.toString(), accessToken);
    const page = Array.isArray(data?.results) ? data.results : [];
    total = Number(data?.paging?.total || total || page.length || 0);
    orders.push(...page);
    if (reportId && status === "paid" && orders.length && orders.length % 250 === 0) {
      await appendLog(reportId, `Pedidos carregados: ${orders.length}/${total || "?"}.`, 32).catch(() => {});
    }
    if (!page.length || orders.length >= total) break;
    offset += limit;
  }
  if (total != null && orders.length < total) {
    warnings.push(`Foram carregados ${orders.length} de ${total} pedidos; limite operacional atual: ${MAX_ORDERS_PER_REPORT}.`);
  }
  return { orders, totalAvailable: total || orders.length, warnings };
}

async function fetchAccountVisits({ account, accessToken, periodFrom, periodTo }) {
  try {
    const url = new URL(`https://api.mercadolibre.com/users/${encodeURIComponent(account.meliUserId)}/items_visits`);
    url.searchParams.set("date_from", dateOnlyInReportTimeZone(periodFrom));
    url.searchParams.set("date_to", dateOnlyInReportTimeZone(periodTo));
    const data = await mlGetJson(url.toString(), accessToken);
    return { total: Math.max(0, toNumber(data?.total_visits, 0)), warning: null };
  } catch (error) {
    return {
      total: null,
      warning: `Visitas da conta indisponiveis: ${error?.message || error}`,
    };
  }
}

function orderRevenueCents(order) {
  const itemsRevenue = (Array.isArray(order?.order_items) ? order.order_items : []).reduce((sum, item) => {
    return sum + moneyToCents(item?.unit_price) * toNumber(item?.quantity, 0);
  }, 0);
  return itemsRevenue || moneyToCents(order?.total_amount || order?.paid_amount || 0);
}

function orderDate(order) {
  return order?.date_created || order?.date_closed || order?.date_last_updated || null;
}

function itemKey(item) {
  return String(item?.item?.id || item?.item_id || item?.id || item?.item?.title || "sem-id");
}

function itemSku(item) {
  return item?.item?.seller_sku || item?.seller_sku || item?.item?.seller_custom_field || item?.seller_custom_field || "";
}

function buildProductMetrics(orders, previousOrders = []) {
  const map = new Map();
  const collect = (sourceOrders, previous) => {
    for (const order of sourceOrders) {
    for (const item of Array.isArray(order?.order_items) ? order.order_items : []) {
      const key = itemKey(item);
      if (!map.has(key)) {
        map.set(key, {
          itemId: item?.item?.id || item?.item_id || null,
          sku: itemSku(item),
          title: item?.item?.title || item?.title || "Anuncio sem titulo",
          quantity: 0,
          revenueCents: 0,
          previousQuantity: 0,
          previousRevenueCents: 0,
        });
      }
      const row = map.get(key);
      const qty = toNumber(item?.quantity, 0);
      const revenue = moneyToCents(item?.unit_price) * qty;
      if (previous) {
        row.previousQuantity += qty;
        row.previousRevenueCents += revenue;
      } else {
        row.quantity += qty;
        row.revenueCents += revenue;
      }
    }
    }
  };
  collect(orders, false);
  collect(previousOrders, true);
  return Array.from(map.values()).map((row) => ({
    ...row,
    averageTicketCents: row.quantity > 0 ? Math.round(row.revenueCents / row.quantity) : 0,
    quantityDelta: row.quantity - row.previousQuantity,
    revenueDeltaCents: row.revenueCents - row.previousRevenueCents,
    revenueChangePct: percentChange(row.revenueCents, row.previousRevenueCents),
    trend:
      row.revenueCents > row.previousRevenueCents ? "crescimento" :
      row.revenueCents < row.previousRevenueCents ? "queda" :
      "estavel",
  }));
}

function classifyAbc(startPct) {
  if (startPct < 80) return "A";
  if (startPct < 95) return "B";
  return "C";
}

function applyAbc(rows, metric) {
  const total = rows.reduce((sum, row) => sum + toNumber(row[metric], 0), 0);
  let cumulative = 0;
  return rows.map((row, index) => {
    const value = toNumber(row[metric], 0);
    const startPct = total > 0 ? (cumulative / total) * 100 : 100;
    cumulative += value;
    const cumulativePct = total > 0 ? (cumulative / total) * 100 : 100;
    return {
      ...row,
      rank: index + 1,
      [`${metric}SharePct`]: total > 0 ? (value / total) * 100 : 0,
      [`${metric}CumulativePct`]: cumulativePct,
      [`${metric}Abc`]: classifyAbc(startPct),
    };
  });
}

function summarizeCurve(rows, metric, abcField) {
  const totalMetric = rows.reduce((sum, row) => sum + toNumber(row[metric], 0), 0);
  return ["A", "B", "C"].map((curve) => {
    const list = rows.filter((row) => (row[abcField] || "C") === curve);
    const metricTotal = list.reduce((sum, row) => sum + toNumber(row[metric], 0), 0);
    return {
      curve,
      products: list.length,
      revenueCents: list.reduce((sum, row) => sum + cents(row.revenueCents), 0),
      quantity: list.reduce((sum, row) => sum + toNumber(row.quantity, 0), 0),
      sharePct: totalMetric > 0 ? (metricTotal / totalMetric) * 100 : 0,
      topProducts: list.slice(0, 5),
    };
  });
}

function buildDailySeries(orders) {
  const map = new Map();
  for (const order of orders) {
    const key = orderDate(order) ? new Date(orderDate(order)).toISOString().slice(0, 10) : "sem-data";
    if (!map.has(key)) map.set(key, { date: key, revenueCents: 0, orders: 0 });
    const entry = map.get(key);
    entry.revenueCents += orderRevenueCents(order);
    entry.orders += 1;
  }
  return Array.from(map.values())
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .map((entry) => ({
      ...entry,
      averageTicketCents: entry.orders > 0 ? Math.round(entry.revenueCents / entry.orders) : 0,
    }));
}

function adsMetrics(raw = {}) {
  const metrics = raw && typeof raw === "object" ? raw : {};
  const directAmount = toNumber(metrics.direct_amount, 0);
  const indirectAmount = toNumber(metrics.indirect_amount, 0);
  const totalAmount = toNumber(metrics.total_amount, directAmount + indirectAmount);
  const cost = toNumber(metrics.cost, 0);
  const clicks = toNumber(metrics.clicks, 0);
  const prints = toNumber(metrics.prints, 0);
  const units = toNumber(metrics.units_quantity, 0);
  return {
    prints,
    clicks,
    cost,
    cpc: toNumber(metrics.cpc, clicks > 0 ? cost / clicks : 0),
    ctr: toNumber(metrics.ctr, prints > 0 ? (clicks / prints) * 100 : 0),
    cvr: toNumber(metrics.cvr ?? metrics.conversion_rate, clicks > 0 ? (units / clicks) * 100 : 0),
    acos: toNumber(metrics.acos, totalAmount > 0 ? (cost / totalAmount) * 100 : 0),
    roas: toNumber(metrics.roas, cost > 0 ? totalAmount / cost : 0),
    sov: toNumber(metrics.sov, 0),
    tacos: metrics.tacos == null ? null : toNumber(metrics.tacos, 0),
    unitsQuantity: units,
    totalAmount,
    directAmount,
    indirectAmount,
    organicAmount: toNumber(metrics.organic_units_amount, 0),
    directUnits: toNumber(metrics.direct_units_quantity, 0),
    indirectUnits: toNumber(metrics.indirect_units_quantity, 0),
    organicUnits: toNumber(metrics.organic_units_quantity, 0),
    advertisingItems: toNumber(metrics.advertising_items_quantity, 0),
    impressionShare: metrics.impression_share == null ? null : toNumber(metrics.impression_share, 0),
    topImpressionShare: metrics.top_impression_share == null ? null : toNumber(metrics.top_impression_share, 0),
    lostByRank: metrics.lost_impression_share_by_ad_rank == null ? null : toNumber(metrics.lost_impression_share_by_ad_rank, 0),
    acosBenchmark: metrics.acos_benchmark == null ? null : toNumber(metrics.acos_benchmark, 0),
  };
}

function summarizeAdsCampaigns(campaigns = []) {
  const summary = campaigns.reduce((acc, campaign) => {
    const metrics = campaign.metrics || {};
    acc.prints += metrics.prints;
    acc.clicks += metrics.clicks;
    acc.cost += metrics.cost;
    acc.unitsQuantity += metrics.unitsQuantity;
    acc.totalAmount += metrics.totalAmount;
    acc.directAmount += metrics.directAmount;
    acc.indirectAmount += metrics.indirectAmount;
    acc.organicAmount += metrics.organicAmount;
    return acc;
  }, {
    prints: 0,
    clicks: 0,
    cost: 0,
    unitsQuantity: 0,
    totalAmount: 0,
    directAmount: 0,
    indirectAmount: 0,
    organicAmount: 0,
  });
  summary.ctr = summary.prints > 0 ? (summary.clicks / summary.prints) * 100 : 0;
  summary.cpc = summary.clicks > 0 ? summary.cost / summary.clicks : 0;
  summary.cvr = summary.clicks > 0 ? (summary.unitsQuantity / summary.clicks) * 100 : 0;
  summary.roas = summary.cost > 0 ? summary.totalAmount / summary.cost : 0;
  summary.acos = summary.totalAmount > 0 ? (summary.cost / summary.totalAmount) * 100 : 0;
  return summary;
}

function weightedDailyMetric(series = [], field) {
  const rows = series.filter((row) => row?.[field] != null && Number.isFinite(Number(row[field])));
  if (!rows.length) return null;
  const totalWeight = rows.reduce((sum, row) => sum + Math.max(0, toNumber(row.prints, 0)), 0);
  if (totalWeight > 0) {
    return rows.reduce((sum, row) => sum + toNumber(row[field], 0) * Math.max(0, toNumber(row.prints, 0)), 0) / totalWeight;
  }
  return rows.reduce((sum, row) => sum + toNumber(row[field], 0), 0) / rows.length;
}

async function mapLimit(list, limit, mapper) {
  const results = new Array(list.length);
  let cursor = 0;
  const workers = new Array(Math.min(Math.max(1, limit), list.length)).fill(null).map(async () => {
    while (cursor < list.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(list[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function fetchAdsAnalysis({ account, periodFrom, periodTo, previousFrom, previousTo, reportId }) {
  const warnings = [];
  const options = { mlCreds: account.creds, accountKey: String(account.id) };
  const currentDates = {
    date_from: dateOnlyInReportTimeZone(periodFrom),
    date_to: dateOnlyInReportTimeZone(periodTo),
  };
  const previousDates = {
    date_from: dateOnlyInReportTimeZone(previousFrom),
    date_to: dateOnlyInReportTimeZone(previousTo),
  };
  const [currentResult, previousResult] = await Promise.all([
    ProductAdsService.listarCampanhas(currentDates, options),
    ProductAdsService.obterResumoCampanhas(previousDates, options),
  ]);
  if (!currentResult?.success) {
    warnings.push(`Publicidade nao consolidada: ${currentResult?.error || "falha ao consultar campanhas"}.`);
    return { available: false, campaigns: [], items: [], summary: {}, previousSummary: {}, warnings };
  }
  if (!previousResult?.success) {
    warnings.push(`Comparativo anterior de Ads indisponivel: ${previousResult?.error || "falha ao consultar campanhas"}.`);
  }
  const previousById = new Map((previousResult?.campaigns || []).map((campaign) => [String(campaign.id), campaign]));
  const campaigns = (currentResult.campaigns || []).map((campaign) => {
    const metrics = adsMetrics(campaign.metrics);
    const previousMetrics = adsMetrics(previousById.get(String(campaign.id))?.metrics || {});
    return {
      id: String(campaign.id),
      name: campaign.name || `Campanha ${campaign.id}`,
      status: campaign.status || "-",
      strategy: campaign.strategy || "-",
      roasTarget: campaign.roas_target == null ? null : toNumber(campaign.roas_target, 0),
      createdAt: campaign.created_at || null,
      lastUpdated: campaign.last_updated || null,
      adgroupsCount: campaign.adgroups_count == null ? null : Number(campaign.adgroups_count),
      metrics,
      previousMetrics,
      costChangePct: percentChange(metrics.cost, previousMetrics.cost),
      revenueChangePct: percentChange(metrics.totalAmount, previousMetrics.totalAmount),
      roasChangePct: percentChange(metrics.roas, previousMetrics.roas),
    };
  });
  await appendLog(reportId, `Campanhas Ads carregadas: ${campaigns.length}. Buscando anuncios patrocinados...`, 52).catch(() => {});
  const itemGroups = await mapLimit(campaigns, 3, async (campaign) => {
    const [result, dailyResult] = await Promise.all([
      ProductAdsService.listarItensCampanha(campaign.id, currentDates, options),
      ProductAdsService.metricasDiariasCampanha(campaign.id, currentDates, options),
    ]);
    if (dailyResult?.success) {
      campaign.daily = dailyResult.series || [];
      campaign.metrics.sov = weightedDailyMetric(campaign.daily, "sov") ?? campaign.metrics.sov;
      campaign.metrics.impressionShare = weightedDailyMetric(campaign.daily, "impression_share");
      campaign.metrics.topImpressionShare = weightedDailyMetric(campaign.daily, "top_impression_share");
      campaign.metrics.lostByRank = weightedDailyMetric(campaign.daily, "lost_impression_share_by_ad_rank");
      campaign.metrics.acosBenchmark = weightedDailyMetric(campaign.daily, "acos_benchmark");
    } else {
      campaign.daily = [];
      warnings.push(`Campanha ${campaign.name}: serie diaria indisponivel (${dailyResult?.error || "erro desconhecido"}).`);
    }
    if (!result?.success) {
      warnings.push(`Campanha ${campaign.name}: anuncios nao carregados (${result?.error || "erro desconhecido"}).`);
      return [];
    }
    return (result.items || []).map((item) => ({
      campaignId: campaign.id,
      campaignName: campaign.name,
      itemId: item.item_id || null,
      adGroupId: item.ad_group_id || null,
      sku: item.sku || null,
      title: item.title || item.item_id || "Anuncio patrocinado",
      status: item.status || "-",
      quality: item.publication_quality == null ? null : Number(item.publication_quality),
      metrics: adsMetrics(item.metrics),
    }));
  });
  const items = itemGroups.flat();
  const summary = summarizeAdsCampaigns(campaigns);
  const previousCampaigns = (previousResult?.campaigns || []).map((campaign) => ({ metrics: adsMetrics(campaign.metrics) }));
  const previousSummary = summarizeAdsCampaigns(previousCampaigns);
  return { available: true, campaigns, items, summary, previousSummary, warnings, currentDates, previousDates };
}

function buildInsights(analysis) {
  const topRevenue = analysis.rankRevenue.slice(0, 3);
  const curveA = analysis.curveRevenue.find((entry) => entry.curve === "A");
  const fallingA = analysis.rankRevenue.filter((row) => row.revenueCentsAbc === "A" && row.trend === "queda");
  const insights = [];
  const revenueDelta = analysis.comparison.revenueChangePct;
  insights.push(`A conta faturou ${formatBRL(analysis.kpis.revenueCents)} em ${analysis.kpis.ordersCount} pedido(s), com ticket medio de ${formatBRL(analysis.kpis.averageTicketCents)}${revenueDelta == null ? "" : ` e variacao de ${formatPercent(revenueDelta)} versus o periodo anterior`}.`);
  if (analysis.ads.available) {
    insights.push(`Ads gerou ${formatBRL(moneyToCents(analysis.ads.summary.totalAmount))} com investimento de ${formatBRL(moneyToCents(analysis.ads.summary.cost))}, ROAS ${analysis.ads.summary.roas.toFixed(2)}x e ACOS ${formatPercent(analysis.ads.summary.acos)}.`);
  }
  if (analysis.kpis.visits != null && analysis.kpis.conversionRatePct != null) {
    insights.push(`A conta recebeu ${analysis.kpis.visits} visita(s), com conversao estimada de ${formatPercent(analysis.kpis.conversionRatePct)} por pedido pago.`);
  }
  if (topRevenue.length) {
    insights.push(`Os 3 principais anuncios concentraram ${formatPercent(topRevenue.reduce((sum, item) => sum + item.revenueCentsSharePct, 0))} do faturamento no periodo.`);
  }
  if (curveA) {
    insights.push(`Curva A: ${curveA.products} anuncio(s) representam ${formatPercent(curveA.sharePct)} do faturamento.`);
  }
  if (fallingA.length) {
    insights.push(`${fallingA.length} anuncio(s) da Curva A estao em queda e pedem revisao de preco, estoque e visitas.`);
  }
  if (analysis.reputation?.levelId) {
    insights.push(`Reputacao atual do seller: ${analysis.reputation.levelId}.`);
  }
  if (analysis.validationWarnings.length) {
    insights.push(`Limitacoes da analise: ${analysis.validationWarnings.join(" ")}`);
  }
  return {
    executiveSummary: insights[0],
    alerts: insights.slice(1, 4),
    opportunities: insights.slice(4),
    nextSteps: [
      "Proteger anuncios da Curva A com acompanhamento de estoque, preco e concorrencia.",
      "Revisar campanhas com investimento e ROAS abaixo da meta antes de ampliar publicidade.",
      "Escalar gradualmente campanhas e anuncios com ROAS acima da meta e conversao consistente.",
      "Revisar anuncios da Curva A em queda, priorizando qualidade, preco, estoque e competitividade.",
    ],
    raw: insights,
  };
}

function normalizeReputation(sellerProfile) {
  const rep = sellerProfile?.reputation || {};
  const tx = rep?.transactions || {};
  return {
    sellerId: sellerProfile?.id || null,
    nickname: sellerProfile?.nickname || null,
    permalink: sellerProfile?.permalink || null,
    levelId: rep?.level_id || null,
    powerSellerStatus: rep?.power_seller_status || null,
    transactionsTotal: Number(tx?.total || 0),
    transactionsCompleted: Number(tx?.completed || 0),
    canceledPct: tx?.canceled == null ? null : Number(tx.canceled) * 100,
    claimsRatePct: rep?.metrics?.claims?.rate == null ? null : Number(rep.metrics.claims.rate) * 100,
    delayedHandlingTimeRatePct: rep?.metrics?.delayed_handling_time?.rate == null ? null : Number(rep.metrics.delayed_handling_time.rate) * 100,
    salesCompletedPeriod: rep?.transactions?.period || null,
    warning: sellerProfile?.warning || null,
  };
}

function buildAnalysis({
  account,
  orders,
  previousOrders,
  cancelledOrders,
  previousCancelledOrders,
  visits,
  previousVisits,
  totalAvailable,
  previousTotalAvailable,
  warnings,
  periodFrom,
  periodTo,
  previousFrom,
  previousTo,
  sellerProfile,
  ads,
}) {
  const products = buildProductMetrics(orders, previousOrders);
  const adsByItem = new Map();
  for (const item of ads?.items || []) {
    const key = String(item.itemId || "");
    if (!key) continue;
    const current = adsByItem.get(key) || adsMetrics();
    const metrics = item.metrics || {};
    for (const field of ["prints", "clicks", "cost", "unitsQuantity", "totalAmount", "directAmount", "indirectAmount", "organicAmount"]) {
      current[field] = toNumber(current[field], 0) + toNumber(metrics[field], 0);
    }
    current.ctr = current.prints > 0 ? (current.clicks / current.prints) * 100 : 0;
    current.cpc = current.clicks > 0 ? current.cost / current.clicks : 0;
    current.cvr = current.clicks > 0 ? (current.unitsQuantity / current.clicks) * 100 : 0;
    current.roas = current.cost > 0 ? current.totalAmount / current.cost : 0;
    current.acos = current.totalAmount > 0 ? (current.cost / current.totalAmount) * 100 : 0;
    adsByItem.set(key, current);
  }
  for (const product of products) product.ads = adsByItem.get(String(product.itemId || "")) || null;
  const revenueTotal = orders.reduce((sum, order) => sum + orderRevenueCents(order), 0);
  const previousRevenueTotal = previousOrders.reduce((sum, order) => sum + orderRevenueCents(order), 0);
  const unitsSold = products.reduce((sum, product) => sum + toNumber(product.quantity, 0), 0);
  const previousUnitsSold = products.reduce((sum, product) => sum + toNumber(product.previousQuantity, 0), 0);
  const rankRevenue = applyAbc([...products].sort((a, b) => b.revenueCents - a.revenueCents), "revenueCents");
  const rankQuantity = applyAbc([...products].sort((a, b) => b.quantity - a.quantity), "quantity");
  const revenueAbcById = new Map(rankRevenue.map((row) => [row.itemId || row.title, row.revenueCentsAbc]));
  const quantityAbcById = new Map(rankQuantity.map((row) => [row.itemId || row.title, row.quantityAbc]));
  for (const row of rankRevenue) row.quantityAbc = quantityAbcById.get(row.itemId || row.title) || "C";
  for (const row of rankQuantity) row.revenueCentsAbc = revenueAbcById.get(row.itemId || row.title) || "C";
  const validationWarnings = [...warnings, ...(ads?.warnings || [])];
  if (!orders.length) validationWarnings.push("Nao ha pedidos pagos no periodo analisado.");
  if (!products.length) validationWarnings.push("Nao ha itens de pedido para montar ranking de anuncios.");
  if (!ads?.available) validationWarnings.push("Publicidade nao ficou disponivel para esta conta ou periodo.");
  validationWarnings.push("Margem, tarifas, impostos, frete e estoque nao fazem parte desta versao; faturamento nao representa lucro liquido.");
  const reputation = normalizeReputation(sellerProfile);
  if (reputation.warning) validationWarnings.push(reputation.warning);
  const analysis = {
    generatedAt: nowIso(),
    account,
    period: {
      from: periodFrom,
      to: periodTo,
      days: Math.max(1, Math.round((new Date(periodTo).getTime() - new Date(periodFrom).getTime()) / 86400000)),
      previousFrom,
      previousTo,
    },
    kpis: {
      revenueCents: revenueTotal,
      ordersCount: orders.length,
      ordersAvailable: Number(totalAvailable || orders.length),
      averageTicketCents: orders.length > 0 ? Math.round(revenueTotal / orders.length) : 0,
      unitsSold,
      averageUnitPriceCents: unitsSold > 0 ? Math.round(revenueTotal / unitsSold) : 0,
      cancelledOrdersCount: cancelledOrders.length,
      cancellationRatePct: orders.length + cancelledOrders.length > 0
        ? (cancelledOrders.length / (orders.length + cancelledOrders.length)) * 100
        : 0,
      visits: visits == null ? null : Number(visits),
      conversionRatePct: visits > 0 ? (orders.length / visits) * 100 : null,
      soldProductsCount: products.filter((product) => product.quantity > 0).length,
    },
    previousKpis: {
      revenueCents: previousRevenueTotal,
      ordersCount: previousOrders.length,
      ordersAvailable: Number(previousTotalAvailable || previousOrders.length),
      averageTicketCents: previousOrders.length > 0 ? Math.round(previousRevenueTotal / previousOrders.length) : 0,
      unitsSold: previousUnitsSold,
      averageUnitPriceCents: previousUnitsSold > 0 ? Math.round(previousRevenueTotal / previousUnitsSold) : 0,
      cancelledOrdersCount: previousCancelledOrders.length,
      visits: previousVisits == null ? null : Number(previousVisits),
      conversionRatePct: previousVisits > 0 ? (previousOrders.length / previousVisits) * 100 : null,
    },
    rankRevenue,
    rankQuantity,
    curveRevenue: summarizeCurve(rankRevenue, "revenueCents", "revenueCentsAbc"),
    curveQuantity: summarizeCurve(rankQuantity, "quantity", "quantityAbc"),
    daily: buildDailySeries(orders),
    comparison: {
      revenueChangePct: percentChange(revenueTotal, previousRevenueTotal),
      ordersChangePct: percentChange(orders.length, previousOrders.length),
      unitsChangePct: percentChange(unitsSold, previousUnitsSold),
      ticketChangePct: percentChange(
        orders.length > 0 ? revenueTotal / orders.length : 0,
        previousOrders.length > 0 ? previousRevenueTotal / previousOrders.length : 0,
      ),
      cancellationsChangePct: percentChange(cancelledOrders.length, previousCancelledOrders.length),
      visitsChangePct: visits == null || previousVisits == null ? null : percentChange(visits, previousVisits),
      conversionDeltaPp: visits > 0 && previousVisits > 0
        ? ((orders.length / visits) - (previousOrders.length / previousVisits)) * 100
        : null,
    },
    ads: ads || { available: false, campaigns: [], items: [], summary: {}, previousSummary: {}, warnings: [] },
    reputation,
    validationWarnings,
  };
  analysis.insights = buildInsights(analysis);
  return analysis;
}

function aoaSheet(workbook, name, rows, widths = []) {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet["!cols"] = widths.map((wch) => ({ wch }));
  if (rows.length > 1 && rows[0]?.length) {
    sheet["!autofilter"] = {
      ref: XLSX.utils.encode_range({
        s: { r: 0, c: 0 },
        e: { r: rows.length - 1, c: rows[0].length - 1 },
      }),
    };
  }
  XLSX.utils.book_append_sheet(workbook, sheet, name.slice(0, 31));
}

function productRows(rows, metricType = "revenue") {
  return rows.map((row) => [
    row.rank,
    row.itemId || "-",
    row.sku || "-",
    row.title,
    Number(row.quantity || 0),
    moneyCell(row.revenueCents),
    moneyCell(row.averageTicketCents),
    Number((metricType === "quantity" ? row.quantitySharePct : row.revenueCentsSharePct || 0).toFixed(2)),
    metricType === "quantity" ? row.quantityAbc : row.revenueCentsAbc,
    row.trend,
    moneyCell(row.previousRevenueCents),
    moneyCell(row.revenueCents),
    moneyCell(row.revenueDeltaCents),
    row.revenueChangePct == null ? "Novo" : Number(row.revenueChangePct.toFixed(2)),
    row.ads ? Number(row.ads.prints || 0) : 0,
    row.ads ? Number(row.ads.clicks || 0) : 0,
    row.ads ? Number((row.ads.ctr || 0).toFixed(2)) : 0,
    row.ads ? Number((row.ads.cpc || 0).toFixed(2)) : 0,
    row.ads ? Number((row.ads.cost || 0).toFixed(2)) : 0,
    row.ads ? Number((row.ads.totalAmount || 0).toFixed(2)) : 0,
    row.ads ? Number((row.ads.roas || 0).toFixed(2)) : 0,
    row.ads ? Number((row.ads.acos || 0).toFixed(2)) : 0,
  ]);
}

function buildXlsx(analysis, filePath) {
  const wb = XLSX.utils.book_new();
  aoaSheet(wb, "Capa", [
    ["Relatorio de Performance da Conta ML"],
    ["Empresa", analysis.account.empresaNome || "-"],
    ["Conta ML", analysis.account.apelido || "-"],
    ["ML User", analysis.account.meliUserId || "-"],
    ["Documento", `${analysis.account.documentType || "-"} ${analysis.account.documentNumber || ""}`.trim()],
    ["Periodo", `${formatDate(analysis.period.from)} ate ${formatDate(analysis.period.to)}`],
    ["Comparativo", `${formatDate(analysis.period.previousFrom)} ate ${formatDate(analysis.period.previousTo)}`],
    ["Gerado em", formatDateTime(analysis.generatedAt)],
    ["Retencao", RETENTION_NOTICE],
  ], [38, 110]);
  aoaSheet(wb, "Resumo Executivo", [
    ["Indicador", "Periodo atual", "Periodo anterior", "Variacao %"],
    ["Faturamento total", moneyCell(analysis.kpis.revenueCents), moneyCell(analysis.previousKpis.revenueCents), analysis.comparison.revenueChangePct],
    ["Pedidos pagos", analysis.kpis.ordersCount, analysis.previousKpis.ordersCount, analysis.comparison.ordersChangePct],
    ["Unidades vendidas", analysis.kpis.unitsSold, analysis.previousKpis.unitsSold, analysis.comparison.unitsChangePct],
    ["Ticket medio", moneyCell(analysis.kpis.averageTicketCents), moneyCell(analysis.previousKpis.averageTicketCents), analysis.comparison.ticketChangePct],
    ["Preco medio por unidade", moneyCell(analysis.kpis.averageUnitPriceCents), moneyCell(analysis.previousKpis.averageUnitPriceCents), null],
    ["Pedidos cancelados", analysis.kpis.cancelledOrdersCount, analysis.previousKpis.cancelledOrdersCount, analysis.comparison.cancellationsChangePct],
    ["Taxa de cancelamento %", Number(analysis.kpis.cancellationRatePct.toFixed(2)), "-", "-"],
    ["Visitas", analysis.kpis.visits ?? "Indisponivel", analysis.previousKpis.visits ?? "Indisponivel", analysis.comparison.visitsChangePct],
    ["Conversao %", analysis.kpis.conversionRatePct == null ? "Indisponivel" : Number(analysis.kpis.conversionRatePct.toFixed(2)), analysis.previousKpis.conversionRatePct == null ? "Indisponivel" : Number(analysis.previousKpis.conversionRatePct.toFixed(2)), analysis.comparison.conversionDeltaPp == null ? "-" : `${analysis.comparison.conversionDeltaPp.toFixed(2)} p.p.`],
    ["Anuncios com venda", analysis.kpis.soldProductsCount, "-", "-"],
    ["Resumo", analysis.insights.executiveSummary, "", ""],
    ["Alertas", analysis.insights.alerts.join(" | "), "", ""],
    ["Oportunidades", analysis.insights.opportunities.join(" | "), "", ""],
  ], [34, 45, 45, 18]);
  const header = ["Posicao", "ID Anuncio", "SKU", "Titulo", "Qtd", "Faturamento", "Ticket medio", "Participacao %", "ABC", "Tendencia", "Fat. anterior", "Fat. atual", "Delta", "Var. %", "Impressoes Ads", "Cliques Ads", "CTR %", "CPC", "Investimento", "Receita Ads", "ROAS", "ACOS %"];
  const rankingWidths = [10, 18, 18, 60, 10, 16, 16, 16, 10, 16, 16, 16, 16, 12, 16, 14, 12, 12, 16, 16, 12, 12];
  aoaSheet(wb, "Ranking Faturamento", [header, ...productRows(analysis.rankRevenue, "revenue")], rankingWidths);
  aoaSheet(wb, "Ranking Quantidade", [header, ...productRows(analysis.rankQuantity, "quantity")], rankingWidths);
  aoaSheet(wb, "Curva ABC Faturamento", [
    ["Curva", "Produtos", "Faturamento", "Participacao %", "Qtd", "Top produtos"],
    ...analysis.curveRevenue.map((row) => [row.curve, row.products, moneyCell(row.revenueCents), Number(row.sharePct.toFixed(2)), row.quantity, row.topProducts.map((p) => p.title).join(" | ")]),
  ], [10, 12, 18, 16, 12, 110]);
  aoaSheet(wb, "Vendas por Dia", [
    ["Data", "Faturamento", "Pedidos", "Ticket medio"],
    ...analysis.daily.map((row) => [row.date, moneyCell(row.revenueCents), row.orders, moneyCell(row.averageTicketCents)]),
  ], [16, 18, 12, 18]);
  aoaSheet(wb, "Resumo Ads", [
    ["Indicador", "Periodo atual", "Periodo anterior", "Variacao %"],
    ["Campanhas", analysis.ads.campaigns.length, "-", "-"],
    ["Impressoes", analysis.ads.summary.prints || 0, analysis.ads.previousSummary.prints || 0, percentChange(analysis.ads.summary.prints, analysis.ads.previousSummary.prints)],
    ["Cliques", analysis.ads.summary.clicks || 0, analysis.ads.previousSummary.clicks || 0, percentChange(analysis.ads.summary.clicks, analysis.ads.previousSummary.clicks)],
    ["CTR %", Number((analysis.ads.summary.ctr || 0).toFixed(2)), Number((analysis.ads.previousSummary.ctr || 0).toFixed(2)), percentChange(analysis.ads.summary.ctr, analysis.ads.previousSummary.ctr)],
    ["CPC", Number((analysis.ads.summary.cpc || 0).toFixed(2)), Number((analysis.ads.previousSummary.cpc || 0).toFixed(2)), percentChange(analysis.ads.summary.cpc, analysis.ads.previousSummary.cpc)],
    ["Investimento", Number((analysis.ads.summary.cost || 0).toFixed(2)), Number((analysis.ads.previousSummary.cost || 0).toFixed(2)), percentChange(analysis.ads.summary.cost, analysis.ads.previousSummary.cost)],
    ["Receita atribuida", Number((analysis.ads.summary.totalAmount || 0).toFixed(2)), Number((analysis.ads.previousSummary.totalAmount || 0).toFixed(2)), percentChange(analysis.ads.summary.totalAmount, analysis.ads.previousSummary.totalAmount)],
    ["Receita direta", Number((analysis.ads.summary.directAmount || 0).toFixed(2)), Number((analysis.ads.previousSummary.directAmount || 0).toFixed(2)), percentChange(analysis.ads.summary.directAmount, analysis.ads.previousSummary.directAmount)],
    ["Receita indireta", Number((analysis.ads.summary.indirectAmount || 0).toFixed(2)), Number((analysis.ads.previousSummary.indirectAmount || 0).toFixed(2)), percentChange(analysis.ads.summary.indirectAmount, analysis.ads.previousSummary.indirectAmount)],
    ["Unidades atribuidas", analysis.ads.summary.unitsQuantity || 0, analysis.ads.previousSummary.unitsQuantity || 0, percentChange(analysis.ads.summary.unitsQuantity, analysis.ads.previousSummary.unitsQuantity)],
    ["CVR %", Number((analysis.ads.summary.cvr || 0).toFixed(2)), Number((analysis.ads.previousSummary.cvr || 0).toFixed(2)), percentChange(analysis.ads.summary.cvr, analysis.ads.previousSummary.cvr)],
    ["ROAS", Number((analysis.ads.summary.roas || 0).toFixed(2)), Number((analysis.ads.previousSummary.roas || 0).toFixed(2)), percentChange(analysis.ads.summary.roas, analysis.ads.previousSummary.roas)],
    ["ACOS %", Number((analysis.ads.summary.acos || 0).toFixed(2)), Number((analysis.ads.previousSummary.acos || 0).toFixed(2)), percentChange(analysis.ads.summary.acos, analysis.ads.previousSummary.acos)],
    ["TACOS %", analysis.kpis.revenueCents > 0 ? Number(((analysis.ads.summary.cost / moneyCell(analysis.kpis.revenueCents)) * 100).toFixed(2)) : 0, "-", "-"],
    ["Participacao Ads %", analysis.kpis.revenueCents > 0 ? Number(((analysis.ads.summary.totalAmount / moneyCell(analysis.kpis.revenueCents)) * 100).toFixed(2)) : 0, "-", "-"],
  ], [34, 24, 24, 18]);
  aoaSheet(wb, "Campanhas Ads", [[
    "ID", "Campanha", "Status", "Estrategia", "ROAS objetivo", "Grupos", "Impressoes", "Cliques", "CTR %", "CPC", "Investimento", "Receita total", "Receita direta", "Receita indireta", "Unidades", "CVR %", "ROAS", "ACOS %", "SOV %", "Part. impressoes %", "Part. topo %", "Perda por ranking %", "Benchmark ACOS %", "Var. investimento %", "Var. receita %", "Var. ROAS %",
  ], ...analysis.ads.campaigns.map((campaign) => [
    campaign.id, campaign.name, campaign.status, campaign.strategy, campaign.roasTarget ?? "-", campaign.adgroupsCount ?? "-",
    campaign.metrics.prints, campaign.metrics.clicks, Number(campaign.metrics.ctr.toFixed(2)), Number(campaign.metrics.cpc.toFixed(2)), Number(campaign.metrics.cost.toFixed(2)), Number(campaign.metrics.totalAmount.toFixed(2)), Number(campaign.metrics.directAmount.toFixed(2)), Number(campaign.metrics.indirectAmount.toFixed(2)), campaign.metrics.unitsQuantity, Number(campaign.metrics.cvr.toFixed(2)), Number(campaign.metrics.roas.toFixed(2)), Number(campaign.metrics.acos.toFixed(2)), Number(campaign.metrics.sov.toFixed(2)), campaign.metrics.impressionShare, campaign.metrics.topImpressionShare, campaign.metrics.lostByRank, campaign.metrics.acosBenchmark, campaign.costChangePct, campaign.revenueChangePct, campaign.roasChangePct,
  ])], [16, 38, 14, 18, 16, 10, 14, 12, 12, 12, 16, 16, 16, 16, 12, 12, 12, 12, 12, 18, 16, 20, 18, 18, 18, 16]);
  aoaSheet(wb, "Ads por Dia", [[
    "Data", "Campanha ID", "Campanha", "Impressoes", "Cliques", "CTR %", "CPC", "Investimento", "Receita", "Receita direta", "Receita indireta", "Unidades", "CVR %", "ROAS", "ACOS %", "SOV %", "Part. impressoes %", "Part. topo %", "Perda por ranking %", "Benchmark ACOS %",
  ], ...analysis.ads.campaigns.flatMap((campaign) => (campaign.daily || []).map((day) => [
    day.date, campaign.id, campaign.name, day.prints, day.clicks, Number(toNumber(day.ctr, 0).toFixed(2)), Number(toNumber(day.cpc, 0).toFixed(2)), Number(toNumber(day.cost, 0).toFixed(2)), Number(toNumber(day.total_amount, 0).toFixed(2)), Number(toNumber(day.direct_amount, 0).toFixed(2)), Number(toNumber(day.indirect_amount, 0).toFixed(2)), day.units_quantity, Number(toNumber(day.cvr, 0).toFixed(2)), Number(toNumber(day.roas, 0).toFixed(2)), Number(toNumber(day.acos, 0).toFixed(2)), day.sov, day.impression_share, day.top_impression_share, day.lost_impression_share_by_ad_rank, day.acos_benchmark,
  ]))], [14, 16, 38, 14, 12, 12, 12, 16, 16, 16, 16, 12, 12, 12, 12, 12, 18, 16, 20, 18]);
  aoaSheet(wb, "Anuncios Ads", [[
    "Campanha ID", "Campanha", "Item", "SKU", "Titulo", "Status", "Qualidade %", "Impressoes", "Cliques", "CTR %", "CPC", "Investimento", "Receita total", "Receita direta", "Receita indireta", "Unidades", "CVR %", "ROAS", "ACOS %",
  ], ...analysis.ads.items.map((item) => [
    item.campaignId, item.campaignName, item.itemId || "-", item.sku || "-", item.title, item.status, item.quality ?? "-", item.metrics.prints, item.metrics.clicks, Number(item.metrics.ctr.toFixed(2)), Number(item.metrics.cpc.toFixed(2)), Number(item.metrics.cost.toFixed(2)), Number(item.metrics.totalAmount.toFixed(2)), Number(item.metrics.directAmount.toFixed(2)), Number(item.metrics.indirectAmount.toFixed(2)), item.metrics.unitsQuantity, Number(item.metrics.cvr.toFixed(2)), Number(item.metrics.roas.toFixed(2)), Number(item.metrics.acos.toFixed(2)),
  ])], [16, 36, 18, 18, 60, 14, 14, 14, 12, 12, 12, 16, 16, 16, 16, 12, 12, 12, 12]);
  aoaSheet(wb, "Reputacao", [
    ["Indicador", "Valor"],
    ["Seller ID", analysis.reputation.sellerId || "-"],
    ["Nickname", analysis.reputation.nickname || "-"],
    ["Nivel", analysis.reputation.levelId || "-"],
    ["MercadoLider", analysis.reputation.powerSellerStatus || "-"],
    ["Transacoes totais", analysis.reputation.transactionsTotal],
    ["Transacoes concluidas", analysis.reputation.transactionsCompleted],
    ["Cancelamento %", analysis.reputation.canceledPct == null ? "-" : Number(analysis.reputation.canceledPct.toFixed(2))],
    ["Reclamacoes %", analysis.reputation.claimsRatePct == null ? "-" : Number(analysis.reputation.claimsRatePct.toFixed(2))],
    ["Atraso despacho %", analysis.reputation.delayedHandlingTimeRatePct == null ? "-" : Number(analysis.reputation.delayedHandlingTimeRatePct.toFixed(2))],
    ["Link", analysis.reputation.permalink || "-"],
  ], [30, 90]);
  aoaSheet(wb, "Insights", [
    ["Tipo", "Texto"],
    ["Resumo", analysis.insights.executiveSummary],
    ...analysis.insights.alerts.map((text) => ["Alerta", text]),
    ...analysis.insights.opportunities.map((text) => ["Oportunidade", text]),
    ...analysis.insights.nextSteps.map((text) => ["Proximo passo", text]),
    ...analysis.validationWarnings.map((text) => ["Limitacao", text]),
  ], [22, 130]);
  aoaSheet(wb, "Qualidade dos Dados", [
    ["Tipo", "Detalhe"],
    ["Pedidos carregados", `${analysis.kpis.ordersCount} de ${analysis.kpis.ordersAvailable}`],
    ["Pedidos anteriores", `${analysis.previousKpis.ordersCount} de ${analysis.previousKpis.ordersAvailable}`],
    ["Ads disponivel", analysis.ads.available ? "Sim" : "Nao"],
    ...analysis.validationWarnings.map((warning) => ["Aviso", warning]),
  ], [28, 130]);
  XLSX.writeFile(wb, filePath);
}

function escapePdfText(text) {
  return String(text == null ? "" : text)
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xC0-\xFF]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function wrapText(text, length) {
  const words = String(text || "").split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    if (`${line} ${word}`.trim().length > length) {
      if (line) lines.push(line);
      line = word;
    } else {
      line = `${line} ${word}`.trim();
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

class SimplePdf {
  constructor() {
    this.objects = [];
    this.pages = [];
    this.width = 595;
    this.height = 842;
    this.current = [];
    this.y = 800;
  }
  addObject(body) {
    this.objects.push(body);
    return this.objects.length;
  }
  beginPage() {
    if (this.current.length) this.endPage();
    this.current = [];
    this.y = 800;
  }
  endPage() {
    if (!this.current.length) return;
    const content = this.current.join("\n");
    const contentId = this.addObject(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`);
    this.pages.push({ contentId });
    this.current = [];
  }
  ensureSpace(height = 40) {
    if (this.y - height < 60) {
      this.endPage();
      this.beginPage();
    }
  }
  text(text, x, y, size = 10, opts = {}) {
    const font = opts.bold ? "/F2" : "/F1";
    const color = opts.color || "0.05 0.08 0.16";
    this.current.push(`${color} rg BT ${font} ${size} Tf ${x} ${y} Td (${escapePdfText(text)}) Tj ET`);
  }
  h1(text) {
    this.ensureSpace(44);
    this.text(text, 42, this.y, 18, { bold: true });
    this.y -= 28;
  }
  p(text, size = 10) {
    for (const chunk of wrapText(text, 92)) {
      this.ensureSpace(16);
      this.text(chunk, 48, this.y, size);
      this.y -= 14;
    }
    this.y -= 4;
  }
  table(headers, rows, widths) {
    this.ensureSpace(30);
    let x = 42;
    headers.forEach((h, i) => {
      this.text(h, x + 4, this.y, 8, { bold: true });
      x += widths[i];
    });
    this.y -= 20;
    for (const row of rows) {
      this.ensureSpace(22);
      x = 42;
      row.forEach((cell, i) => {
        this.text(String(cell).slice(0, widths[i] > 100 ? 42 : 18), x + 4, this.y, 7);
        x += widths[i];
      });
      this.y -= 16;
    }
    this.y -= 8;
  }
  build() {
    this.endPage();
    const font1 = this.addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
    const font2 = this.addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
    const pageIds = [];
    const pagesId = this.objects.length + this.pages.length + 1;
    for (const page of this.pages) {
      pageIds.push(this.addObject(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${this.width} ${this.height}] /Resources << /Font << /F1 ${font1} 0 R /F2 ${font2} 0 R >> >> /Contents ${page.contentId} 0 R >>`));
    }
    const finalPagesId = this.addObject(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`);
    const catalogId = this.addObject(`<< /Type /Catalog /Pages ${finalPagesId} 0 R >>`);
    const parts = ["%PDF-1.4\n"];
    const offsets = [0];
    this.objects.forEach((body, i) => {
      offsets.push(Buffer.byteLength(parts.join(""), "latin1"));
      parts.push(`${i + 1} 0 obj\n${body}\nendobj\n`);
    });
    const xrefOffset = Buffer.byteLength(parts.join(""), "latin1");
    parts.push(`xref\n0 ${this.objects.length + 1}\n0000000000 65535 f \n`);
    for (let i = 1; i <= this.objects.length; i += 1) {
      parts.push(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
    }
    parts.push(`trailer\n<< /Size ${this.objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);
    return Buffer.from(parts.join(""), "latin1");
  }
}

function buildPdf(analysis, filePath) {
  const pdf = new SimplePdf();
  const adsSummary = analysis.ads.summary || {};
  const topAdsItems = [...(analysis.ads.items || [])]
    .sort((a, b) => toNumber(b.metrics?.totalAmount, 0) - toNumber(a.metrics?.totalAmount, 0))
    .slice(0, 15);
  pdf.beginPage();
  pdf.text("Relatorio de Performance Mercado Livre", 54, 720, 23, { bold: true });
  pdf.text(analysis.account.label, 54, 684, 15, { bold: true });
  pdf.text(`ML User: ${analysis.account.meliUserId || "-"}`, 54, 660, 10);
  pdf.text(`Periodo: ${formatDate(analysis.period.from)} ate ${formatDate(analysis.period.to)}`, 54, 642, 10);
  pdf.text(`Comparativo: ${formatDate(analysis.period.previousFrom)} ate ${formatDate(analysis.period.previousTo)}`, 54, 624, 10);
  pdf.text("Arquivos disponiveis por 24h apos a geracao.", 54, 590, 10, { bold: true, color: "0.75 0.24 0.05" });
  pdf.endPage();

  pdf.beginPage();
  pdf.h1("Resumo executivo");
  pdf.table(["Indicador", "Atual", "Anterior", "Var.%"], [
    ["Faturamento", formatBRL(analysis.kpis.revenueCents), formatBRL(analysis.previousKpis.revenueCents), analysis.comparison.revenueChangePct == null ? "Novo" : formatPercent(analysis.comparison.revenueChangePct)],
    ["Pedidos pagos", analysis.kpis.ordersCount, analysis.previousKpis.ordersCount, analysis.comparison.ordersChangePct == null ? "Novo" : formatPercent(analysis.comparison.ordersChangePct)],
    ["Unidades", analysis.kpis.unitsSold, analysis.previousKpis.unitsSold, analysis.comparison.unitsChangePct == null ? "Novo" : formatPercent(analysis.comparison.unitsChangePct)],
    ["Ticket medio", formatBRL(analysis.kpis.averageTicketCents), formatBRL(analysis.previousKpis.averageTicketCents), analysis.comparison.ticketChangePct == null ? "Novo" : formatPercent(analysis.comparison.ticketChangePct)],
    ["Cancelados", analysis.kpis.cancelledOrdersCount, analysis.previousKpis.cancelledOrdersCount, analysis.comparison.cancellationsChangePct == null ? "-" : formatPercent(analysis.comparison.cancellationsChangePct)],
    ["Visitas", analysis.kpis.visits ?? "-", analysis.previousKpis.visits ?? "-", analysis.comparison.visitsChangePct == null ? "-" : formatPercent(analysis.comparison.visitsChangePct)],
    ["Conversao", analysis.kpis.conversionRatePct == null ? "-" : formatPercent(analysis.kpis.conversionRatePct), analysis.previousKpis.conversionRatePct == null ? "-" : formatPercent(analysis.previousKpis.conversionRatePct), analysis.comparison.conversionDeltaPp == null ? "-" : `${analysis.comparison.conversionDeltaPp.toFixed(2)} p.p.`],
  ], [170, 110, 110, 90]);
  pdf.p(analysis.insights.executiveSummary);
  analysis.insights.alerts.slice(0, 5).forEach((text) => pdf.p(`Alerta: ${text}`, 9));
  pdf.h1("Leitura da conta");
  pdf.p(`Foram vendidos ${analysis.kpis.unitsSold} itens em ${analysis.kpis.ordersCount} pedidos. O preco medio por unidade foi ${formatBRL(analysis.kpis.averageUnitPriceCents)} e a taxa de cancelamento observada foi ${formatPercent(analysis.kpis.cancellationRatePct)}.`);
  pdf.endPage();

  pdf.beginPage();
  pdf.h1("Publicidade - visao consolidada");
  if (analysis.ads.available) {
    pdf.table(["Indicador", "Atual", "Anterior"], [
      ["Campanhas", analysis.ads.campaigns.length, "-"],
      ["Investimento", formatBRL(moneyToCents(adsSummary.cost)), formatBRL(moneyToCents(analysis.ads.previousSummary.cost || 0))],
      ["Receita Ads", formatBRL(moneyToCents(adsSummary.totalAmount)), formatBRL(moneyToCents(analysis.ads.previousSummary.totalAmount || 0))],
      ["ROAS", `${toNumber(adsSummary.roas, 0).toFixed(2)}x`, `${toNumber(analysis.ads.previousSummary.roas, 0).toFixed(2)}x`],
      ["ACOS", formatPercent(adsSummary.acos), formatPercent(analysis.ads.previousSummary.acos)],
      ["Impressoes", adsSummary.prints || 0, analysis.ads.previousSummary.prints || 0],
      ["Cliques", adsSummary.clicks || 0, analysis.ads.previousSummary.clicks || 0],
      ["CTR", formatPercent(adsSummary.ctr), formatPercent(analysis.ads.previousSummary.ctr)],
      ["CPC", formatBRL(moneyToCents(adsSummary.cpc)), formatBRL(moneyToCents(analysis.ads.previousSummary.cpc || 0))],
      ["CVR", formatPercent(adsSummary.cvr), formatPercent(analysis.ads.previousSummary.cvr)],
      ["TACOS", analysis.kpis.revenueCents > 0 ? formatPercent((adsSummary.cost / moneyCell(analysis.kpis.revenueCents)) * 100) : "0,00%", "-"],
    ], [180, 150, 150]);
    pdf.p(`A publicidade respondeu por ${analysis.kpis.revenueCents > 0 ? formatPercent((adsSummary.totalAmount / moneyCell(analysis.kpis.revenueCents)) * 100) : "0,00%"} do faturamento bruto observado.`);
  } else {
    pdf.p("Nao foi possivel consolidar Product Ads para esta conta ou periodo.");
  }
  pdf.endPage();

  pdf.beginPage();
  pdf.h1("Desempenho por campanha");
  pdf.table(["Campanha", "Status", "Invest.", "Receita", "ROAS", "ACOS", "CTR", "CVR"], analysis.ads.campaigns.slice(0, 25).map((campaign) => [
    campaign.name,
    campaign.status,
    formatBRL(moneyToCents(campaign.metrics.cost)),
    formatBRL(moneyToCents(campaign.metrics.totalAmount)),
    `${campaign.metrics.roas.toFixed(2)}x`,
    formatPercent(campaign.metrics.acos),
    formatPercent(campaign.metrics.ctr),
    formatPercent(campaign.metrics.cvr),
  ]), [135, 55, 68, 68, 48, 48, 44, 44]);
  pdf.endPage();

  pdf.beginPage();
  pdf.h1("Top anuncios patrocinados");
  pdf.table(["Item", "Anuncio", "Campanha", "Invest.", "Receita", "ROAS", "ACOS"], topAdsItems.map((item) => [
    item.itemId || "-",
    item.title,
    item.campaignName,
    formatBRL(moneyToCents(item.metrics.cost)),
    formatBRL(moneyToCents(item.metrics.totalAmount)),
    `${item.metrics.roas.toFixed(2)}x`,
    formatPercent(item.metrics.acos),
  ]), [68, 155, 110, 58, 62, 42, 42]);
  pdf.endPage();

  pdf.beginPage();
  pdf.h1("Ranking por faturamento");
  pdf.table(["#", "ID", "Anuncio", "Qtd", "Faturamento", "Var.%", "ABC"], analysis.rankRevenue.slice(0, 15).map((p) => [
    p.rank,
    p.itemId || "-",
    p.title,
    p.quantity,
    formatBRL(p.revenueCents),
    p.revenueChangePct == null ? "Novo" : formatPercent(p.revenueChangePct),
    p.revenueCentsAbc,
  ]), [26, 68, 205, 42, 78, 58, 34]);
  pdf.h1("Curva ABC");
  pdf.table(["Curva", "Anuncios", "Faturamento", "Part.%", "Qtd"], analysis.curveRevenue.map((c) => [
    c.curve,
    c.products,
    formatBRL(c.revenueCents),
    formatPercent(c.sharePct),
    c.quantity,
  ]), [60, 80, 130, 90, 80]);
  pdf.endPage();

  pdf.beginPage();
  pdf.h1("Reputacao e operacao");
  pdf.table(["Indicador", "Valor"], [
    ["Nivel", analysis.reputation.levelId || "-"],
    ["MercadoLider", analysis.reputation.powerSellerStatus || "-"],
    ["Transacoes concluidas", analysis.reputation.transactionsCompleted],
    ["Cancelamento reputacao", analysis.reputation.canceledPct == null ? "-" : formatPercent(analysis.reputation.canceledPct)],
    ["Reclamacoes", analysis.reputation.claimsRatePct == null ? "-" : formatPercent(analysis.reputation.claimsRatePct)],
    ["Atraso despacho", analysis.reputation.delayedHandlingTimeRatePct == null ? "-" : formatPercent(analysis.reputation.delayedHandlingTimeRatePct)],
  ], [230, 250]);
  pdf.h1("Proximos passos");
  analysis.insights.nextSteps.forEach((text) => pdf.p(text, 9));
  if (analysis.validationWarnings.length) {
    pdf.h1("Limitacoes");
    analysis.validationWarnings.forEach((text) => pdf.p(text, 8));
  }
  fs.writeFileSync(filePath, pdf.build());
}

async function runReport(reportId) {
  await ensureSchema();
  let report = await getReportById(reportId);
  if (!report) return;
  try {
    await db.query(
      `UPDATE admin_meli_account_performance_reports
          SET status = 'RUNNING', progress = 3, started_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [Number(reportId)],
    );
    await appendLog(reportId, "Preparando conta e token Mercado Livre...", 8, REPORT_STATUSES.RUNNING);
    report = await getReportById(reportId);
    const account = await loadAccount(report.meliContaId, { includeToken: true });
    if (!account) throw new Error("Conta ML nao encontrada.");
    if (!account.creds?.refresh_token && !account.creds?.access_token) {
      throw new Error("Conta ML sem token OAuth disponivel.");
    }
    const accessToken = await TokenService.renovarTokenSeNecessario(account.creds);
    if (!accessToken) throw new Error("Nao foi possivel obter token de acesso ML.");
    const previousRange = getPreviousPeriodRange(report.periodFrom, report.periodTo);
    await appendLog(reportId, "Buscando vendas, cancelamentos e comparativo anterior...", 16);
    const [sellerProfile, orderData, previousOrderData, cancelledData, previousCancelledData, visitsData, previousVisitsData] = await Promise.all([
      fetchSellerProfile({ account, accessToken }),
      fetchOrders({ account, accessToken, periodFrom: report.periodFrom, periodTo: report.periodTo, reportId, status: "paid" }),
      fetchOrders({ account, accessToken, periodFrom: previousRange.from, periodTo: previousRange.to, status: "paid" }),
      fetchOrders({ account, accessToken, periodFrom: report.periodFrom, periodTo: report.periodTo, status: "cancelled" }),
      fetchOrders({ account, accessToken, periodFrom: previousRange.from, periodTo: previousRange.to, status: "cancelled" }),
      fetchAccountVisits({ account, accessToken, periodFrom: report.periodFrom, periodTo: report.periodTo }),
      fetchAccountVisits({ account, accessToken, periodFrom: previousRange.from, periodTo: previousRange.to }),
    ]);
    await appendLog(reportId, "Buscando campanhas e anuncios de Product Ads...", 38);
    const ads = await fetchAdsAnalysis({
      account,
      periodFrom: report.periodFrom,
      periodTo: report.periodTo,
      previousFrom: previousRange.from,
      previousTo: previousRange.to,
      reportId,
    });
    await appendLog(reportId, "Calculando rankings, comparativos, Curva ABC e eficiencia de Ads...", 64);
    const analysis = buildAnalysis({
      account,
      orders: orderData.orders,
      previousOrders: previousOrderData.orders,
      cancelledOrders: cancelledData.orders,
      previousCancelledOrders: previousCancelledData.orders,
      visits: visitsData.total,
      previousVisits: previousVisitsData.total,
      totalAvailable: orderData.totalAvailable,
      previousTotalAvailable: previousOrderData.totalAvailable,
      warnings: [
        ...orderData.warnings,
        ...previousOrderData.warnings,
        ...cancelledData.warnings,
        ...previousCancelledData.warnings,
        ...(visitsData.warning ? [visitsData.warning] : []),
        ...(previousVisitsData.warning ? [previousVisitsData.warning] : []),
      ],
      periodFrom: report.periodFrom,
      periodTo: report.periodTo,
      previousFrom: previousRange.from,
      previousTo: previousRange.to,
      sellerProfile,
      ads,
    });
    ensureGeneratedDir();
    const baseName = `${String(reportId).padStart(6, "0")}-${sanitizeFilePart(account.label)}-${new Date().toISOString().slice(0, 10)}`;
    const xlsxPath = path.join(GENERATED_DIR, `${baseName}.xlsx`);
    const pdfPath = path.join(GENERATED_DIR, `${baseName}.pdf`);
    await appendLog(reportId, "Montando XLSX executivo e detalhado...", 76);
    buildXlsx(analysis, xlsxPath);
    await appendLog(reportId, "Montando PDF executivo completo...", 90);
    buildPdf(analysis, pdfPath);
    await appendLog(reportId, "Relatorio finalizado com sucesso.", 100, REPORT_STATUSES.SUCCESS);
    await db.query(
      `UPDATE admin_meli_account_performance_reports
          SET status = 'SUCCESS',
              progress = 100,
              current_step = 'Relatorio finalizado',
              xlsx_path = $2,
              pdf_path = $3,
              summary = $4::jsonb,
              completed_at = NOW(),
              updated_at = NOW()
        WHERE id = $1`,
      [
        Number(reportId),
        xlsxPath,
        pdfPath,
        JSON.stringify({
          kpis: analysis.kpis,
          previousKpis: analysis.previousKpis,
          comparison: analysis.comparison,
          ads: {
            available: analysis.ads.available,
            campaigns: analysis.ads.campaigns.length,
            items: analysis.ads.items.length,
            summary: analysis.ads.summary,
            previousSummary: analysis.ads.previousSummary,
          },
          reputation: analysis.reputation,
          warnings: analysis.validationWarnings,
          insights: analysis.insights,
          period: analysis.period,
        }),
      ],
    );
  } catch (error) {
    const message = String(error?.message || error);
    await appendLog(reportId, `Falha ao gerar relatorio: ${message}`, 100, REPORT_STATUSES.FAILED).catch(() => {});
    await db.query(
      `UPDATE admin_meli_account_performance_reports
          SET status = 'FAILED', error = $2, completed_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [Number(reportId), message],
    ).catch(() => {});
  }
}

function getDownloadInfo(report, format) {
  if (!report) return null;
  const normalized = String(format || "").toLowerCase();
  const filePath = normalized === "pdf" ? report.pdfPath : normalized === "xlsx" ? report.xlsxPath : null;
  if (!filePath) return null;
  const resolved = path.resolve(filePath);
  const root = path.resolve(GENERATED_DIR);
  if (!resolved.startsWith(root) || !fs.existsSync(resolved)) return null;
  return {
    path: resolved,
    filename: path.basename(resolved),
    contentType: normalized === "pdf"
      ? "application/pdf"
      : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
}

module.exports = {
  adsMetrics,
  buildAnalysis,
  buildPdf,
  buildXlsx,
  cleanupExpiredReports,
  createReport,
  getCustomPeriodRange,
  getDownloadInfo,
  getPreviousPeriodRange,
  getReportById,
  listAccounts,
  listReports,
  REPORT_STATUSES,
  startReportRetentionCleanup,
};
