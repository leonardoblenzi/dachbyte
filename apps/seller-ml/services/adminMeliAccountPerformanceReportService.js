"use strict";

const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const db = require("../db/db");
const TokenService = require("./tokenService");
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

async function createReport({ meliContaId, userId, email, periodDays = 90 }) {
  await ensureSchema();
  await cleanupExpiredReports();
  const range = getPeriodRange(periodDays);
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

async function fetchPaidOrders({ account, accessToken, periodFrom, periodTo, reportId }) {
  const orders = [];
  const warnings = [];
  let offset = 0;
  const limit = 50;
  let total = null;
  while (orders.length < MAX_ORDERS_PER_REPORT) {
    const url = new URL("https://api.mercadolibre.com/orders/search");
    url.searchParams.set("seller", String(account.meliUserId));
    url.searchParams.set("order.status", "paid");
    url.searchParams.set("order.date_created.from", isoDateTime(periodFrom));
    url.searchParams.set("order.date_created.to", isoDateTime(periodTo));
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    const data = await mlGetJson(url.toString(), accessToken);
    const page = Array.isArray(data?.results) ? data.results : [];
    total = Number(data?.paging?.total || total || page.length || 0);
    orders.push(...page);
    if (reportId && orders.length && orders.length % 250 === 0) {
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

function buildProductMetrics(orders, periodFrom, periodTo) {
  const fromTime = new Date(periodFrom).getTime();
  const toTime = new Date(periodTo).getTime();
  const midTime = fromTime + (toTime - fromTime) / 2;
  const map = new Map();
  for (const order of orders) {
    const soldAt = orderDate(order);
    const soldTime = soldAt ? new Date(soldAt).getTime() : toTime;
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
          currentQuantity: 0,
          currentRevenueCents: 0,
        });
      }
      const row = map.get(key);
      const qty = toNumber(item?.quantity, 0);
      const revenue = moneyToCents(item?.unit_price) * qty;
      row.quantity += qty;
      row.revenueCents += revenue;
      if (Number.isFinite(soldTime) && soldTime < midTime) {
        row.previousQuantity += qty;
        row.previousRevenueCents += revenue;
      } else {
        row.currentQuantity += qty;
        row.currentRevenueCents += revenue;
      }
    }
  }
  return Array.from(map.values()).map((row) => ({
    ...row,
    averageTicketCents: row.quantity > 0 ? Math.round(row.revenueCents / row.quantity) : 0,
    quantityDelta: row.currentQuantity - row.previousQuantity,
    revenueDeltaCents: row.currentRevenueCents - row.previousRevenueCents,
    trend:
      row.currentRevenueCents > row.previousRevenueCents ? "crescimento" :
      row.currentRevenueCents < row.previousRevenueCents ? "queda" :
      "estavel",
  }));
}

function classifyAbc(cumulativePct) {
  if (cumulativePct <= 80) return "A";
  if (cumulativePct <= 95) return "B";
  return "C";
}

function applyAbc(rows, metric) {
  const total = rows.reduce((sum, row) => sum + toNumber(row[metric], 0), 0);
  let cumulative = 0;
  return rows.map((row, index) => {
    const value = toNumber(row[metric], 0);
    cumulative += value;
    const cumulativePct = total > 0 ? (cumulative / total) * 100 : 100;
    return {
      ...row,
      rank: index + 1,
      [`${metric}SharePct`]: total > 0 ? (value / total) * 100 : 0,
      [`${metric}CumulativePct`]: cumulativePct,
      [`${metric}Abc`]: classifyAbc(cumulativePct),
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

function buildInsights(analysis) {
  const topRevenue = analysis.rankRevenue.slice(0, 3);
  const curveA = analysis.curveRevenue.find((entry) => entry.curve === "A");
  const fallingA = analysis.rankRevenue.filter((row) => row.revenueCentsAbc === "A" && row.trend === "queda");
  const insights = [];
  insights.push(`A conta faturou ${formatBRL(analysis.kpis.revenueCents)} em ${analysis.kpis.ordersCount} pedido(s), com ticket medio de ${formatBRL(analysis.kpis.averageTicketCents)}.`);
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
      "Revisar anuncios em queda antes de aumentar investimento em publicidade.",
      "Usar os candidatos em crescimento para campanhas controladas e validacao de margem.",
      "Conectar cache de Ads/margem para enriquecer a proxima versao do relatorio.",
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

function buildAnalysis({ account, orders, totalAvailable, warnings, periodFrom, periodTo, sellerProfile }) {
  const products = buildProductMetrics(orders, periodFrom, periodTo);
  const revenueTotal = orders.reduce((sum, order) => sum + orderRevenueCents(order), 0);
  const rankRevenue = applyAbc([...products].sort((a, b) => b.revenueCents - a.revenueCents), "revenueCents");
  const rankQuantity = applyAbc([...products].sort((a, b) => b.quantity - a.quantity), "quantity");
  const revenueAbcById = new Map(rankRevenue.map((row) => [row.itemId || row.title, row.revenueCentsAbc]));
  const quantityAbcById = new Map(rankQuantity.map((row) => [row.itemId || row.title, row.quantityAbc]));
  for (const row of rankRevenue) row.quantityAbc = quantityAbcById.get(row.itemId || row.title) || "C";
  for (const row of rankQuantity) row.revenueCentsAbc = revenueAbcById.get(row.itemId || row.title) || "C";
  const validationWarnings = [...warnings];
  if (!orders.length) validationWarnings.push("Nao ha pedidos pagos no periodo analisado.");
  if (!products.length) validationWarnings.push("Nao ha itens de pedido para montar ranking de anuncios.");
  validationWarnings.push("Ads, margem e estoque nao foram consolidados nesta primeira versao do relatorio ML.");
  const reputation = normalizeReputation(sellerProfile);
  if (reputation.warning) validationWarnings.push(reputation.warning);
  const analysis = {
    generatedAt: nowIso(),
    account,
    period: {
      from: periodFrom,
      to: periodTo,
      days: Math.max(1, Math.round((new Date(periodTo).getTime() - new Date(periodFrom).getTime()) / 86400000)),
    },
    kpis: {
      revenueCents: revenueTotal,
      ordersCount: orders.length,
      ordersAvailable: Number(totalAvailable || orders.length),
      averageTicketCents: orders.length > 0 ? Math.round(revenueTotal / orders.length) : 0,
      soldProductsCount: products.length,
    },
    rankRevenue,
    rankQuantity,
    curveRevenue: summarizeCurve(rankRevenue, "revenueCents", "revenueCentsAbc"),
    curveQuantity: summarizeCurve(rankQuantity, "quantity", "quantityAbc"),
    daily: buildDailySeries(orders),
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
    moneyCell(row.currentRevenueCents),
    moneyCell(row.revenueDeltaCents),
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
    ["Gerado em", formatDateTime(analysis.generatedAt)],
    ["Retencao", RETENTION_NOTICE],
  ], [38, 110]);
  aoaSheet(wb, "Resumo Executivo", [
    ["Indicador", "Valor"],
    ["Faturamento total", moneyCell(analysis.kpis.revenueCents)],
    ["Pedidos pagos carregados", analysis.kpis.ordersCount],
    ["Pedidos disponiveis na API", analysis.kpis.ordersAvailable],
    ["Ticket medio", moneyCell(analysis.kpis.averageTicketCents)],
    ["Anuncios com venda", analysis.kpis.soldProductsCount],
    ["Resumo", analysis.insights.executiveSummary],
    ["Alertas", analysis.insights.alerts.join(" | ")],
    ["Oportunidades", analysis.insights.opportunities.join(" | ")],
  ], [34, 120]);
  const header = ["Posicao", "ID Anuncio", "SKU", "Titulo", "Qtd", "Faturamento", "Ticket medio", "Participacao %", "ABC", "Tendencia", "Fat. anterior", "Fat. atual", "Delta"];
  aoaSheet(wb, "Ranking Faturamento", [header, ...productRows(analysis.rankRevenue, "revenue")], [10, 18, 18, 70, 10, 16, 16, 16, 10, 16, 16, 16, 16]);
  aoaSheet(wb, "Ranking Quantidade", [header, ...productRows(analysis.rankQuantity, "quantity")], [10, 18, 18, 70, 10, 16, 16, 16, 10, 16, 16, 16, 16]);
  aoaSheet(wb, "Curva ABC Faturamento", [
    ["Curva", "Produtos", "Faturamento", "Participacao %", "Qtd", "Top produtos"],
    ...analysis.curveRevenue.map((row) => [row.curve, row.products, moneyCell(row.revenueCents), Number(row.sharePct.toFixed(2)), row.quantity, row.topProducts.map((p) => p.title).join(" | ")]),
  ], [10, 12, 18, 16, 12, 110]);
  aoaSheet(wb, "Vendas por Dia", [
    ["Data", "Faturamento", "Pedidos", "Ticket medio"],
    ...analysis.daily.map((row) => [row.date, moneyCell(row.revenueCents), row.orders, moneyCell(row.averageTicketCents)]),
  ], [16, 18, 12, 18]);
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
  pdf.beginPage();
  pdf.text("Relatorio de Performance Mercado Livre", 54, 720, 23, { bold: true });
  pdf.text(analysis.account.label, 54, 684, 15, { bold: true });
  pdf.text(`ML User: ${analysis.account.meliUserId || "-"}`, 54, 660, 10);
  pdf.text(`Periodo: ${formatDate(analysis.period.from)} ate ${formatDate(analysis.period.to)}`, 54, 642, 10);
  pdf.text("Arquivos disponiveis por 24h apos a geracao.", 54, 612, 10, { bold: true, color: "0.75 0.24 0.05" });
  pdf.endPage();
  pdf.beginPage();
  pdf.h1("Resumo executivo");
  pdf.table(["Indicador", "Valor"], [
    ["Faturamento", formatBRL(analysis.kpis.revenueCents)],
    ["Pedidos pagos", analysis.kpis.ordersCount],
    ["Ticket medio", formatBRL(analysis.kpis.averageTicketCents)],
    ["Anuncios vendidos", analysis.kpis.soldProductsCount],
    ["Reputacao", analysis.reputation.levelId || "-"],
  ], [210, 280]);
  pdf.p(analysis.insights.executiveSummary);
  analysis.insights.alerts.slice(0, 5).forEach((text) => pdf.p(`Alerta: ${text}`, 9));
  pdf.h1("Ranking por faturamento");
  pdf.table(["#", "ID", "Anuncio", "Qtd", "Faturamento", "ABC"], analysis.rankRevenue.slice(0, 15).map((p) => [
    p.rank,
    p.itemId || "-",
    p.title,
    p.quantity,
    formatBRL(p.revenueCents),
    p.revenueCentsAbc,
  ]), [26, 70, 245, 44, 92, 38]);
  pdf.h1("Curva ABC");
  pdf.table(["Curva", "Anuncios", "Faturamento", "Part.%", "Qtd"], analysis.curveRevenue.map((c) => [
    c.curve,
    c.products,
    formatBRL(c.revenueCents),
    formatPercent(c.sharePct),
    c.quantity,
  ]), [60, 80, 130, 90, 80]);
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
    await appendLog(reportId, "Buscando perfil e reputacao do seller...", 16);
    const sellerProfile = await fetchSellerProfile({ account, accessToken });
    await appendLog(reportId, "Buscando pedidos pagos no periodo...", 24);
    const orderData = await fetchPaidOrders({
      account,
      accessToken,
      periodFrom: report.periodFrom,
      periodTo: report.periodTo,
      reportId,
    });
    await appendLog(reportId, "Calculando rankings, Curva ABC e serie diaria...", 56);
    const analysis = buildAnalysis({
      account,
      orders: orderData.orders,
      totalAvailable: orderData.totalAvailable,
      warnings: orderData.warnings,
      periodFrom: report.periodFrom,
      periodTo: report.periodTo,
      sellerProfile,
    });
    ensureGeneratedDir();
    const baseName = `${String(reportId).padStart(6, "0")}-${sanitizeFilePart(account.label)}-${new Date().toISOString().slice(0, 10)}`;
    const xlsxPath = path.join(GENERATED_DIR, `${baseName}.xlsx`);
    const pdfPath = path.join(GENERATED_DIR, `${baseName}.pdf`);
    await appendLog(reportId, "Montando XLSX executivo...", 74);
    buildXlsx(analysis, xlsxPath);
    await appendLog(reportId, "Montando PDF executivo...", 88);
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
  cleanupExpiredReports,
  createReport,
  getDownloadInfo,
  getReportById,
  listAccounts,
  listReports,
  REPORT_STATUSES,
  startReportRetentionCleanup,
};
