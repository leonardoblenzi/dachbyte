"use strict";

const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
let ExcelJS = null;
try {
  ExcelJS = require("exceljs");
} catch (_error) {
  ExcelJS = null;
}
const { query, queryOne } = require("../config/postgres");
const OrderSyncService = require("./OrderSyncService");
const ShopeeAdsService = require("./ShopeeAdsService");
const { callAdsWithAutoRefresh } = require("./ShopeeAdsTokenService");

const REPORT_STATUSES = { QUEUED: "QUEUED", RUNNING: "RUNNING", SUCCESS: "SUCCESS", FAILED: "FAILED" };
const EXCLUDED_ORDER_STATUSES = ["CANCELLED", "UNPAID", "TO_RETURN", "IN_CANCEL"];
const GENERATED_DIR = path.join(__dirname, "..", "..", "generated", "account-performance-reports");
const TZ = process.env.SALES_SUMMARY_TZ || "America/Sao_Paulo";
const REPORT_RETENTION_HOURS = 24;
const REPORT_RETENTION_MS = REPORT_RETENTION_HOURS * 60 * 60 * 1000;
const REPORT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const REPORT_RETENTION_NOTICE =
  "Atencao: este relatorio fica salvo no banco e disponivel para download por apenas 24h apos a geracao. Salve os arquivos localmente antes do prazo; depois disso o registro e os arquivos sao removidos automaticamente para nao ocupar espaco.";
let schemaReadyPromise = null;
let cleanupTimer = null;

function nowIso() { return new Date().toISOString(); }
function clampInt(value, min, max, fallback) { const n = Number(value); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback; }
function toNumber(value, fallback = 0) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function cents(value) { return Math.round(toNumber(value, 0)); }
function formatBRL(value) { return (cents(value) / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }
function formatPercent(value) { return `${toNumber(value, 0).toFixed(2)}%`; }
function moneyToCents(value) {
  if (value == null || value === "") return 0;
  const normalized =
    typeof value === "string" && value.includes(",")
      ? value.replace(/\./g, "").replace(",", ".")
      : value;
  const amount = Number(normalized);
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
}
function safeDate(value) { return value ? new Date(value) : null; }
function formatDateTime(value) { try { return value ? new Date(value).toLocaleString("pt-BR", { timeZone: TZ }) : "-"; } catch { return String(value || "-"); } }
function formatDate(value) { try { return value ? new Date(value).toLocaleDateString("pt-BR", { timeZone: TZ }) : "-"; } catch { return String(value || "-"); } }
function sanitizeFilePart(value) { return String(value || "conta").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 70) || "conta"; }
function ensureGeneratedDir() { fs.mkdirSync(GENERATED_DIR, { recursive: true }); }
function getPeriodRange(periodDays = 90) { const days = clampInt(periodDays, 7, 180, 90); const to = new Date(); const from = new Date(to.getTime() - days * 86400000); return { days, from, to }; }
function pad2(value) { return String(value).padStart(2, "0"); }
function daysInMonth(year, month) { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }
function parseMonthValue(value) {
  const match = String(value || "").trim().match(/^(\d{4})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || year < 2000 || month < 1 || month > 12) return null;
  return { year, month };
}
function buildMonthRange(year, month) {
  const lastDay = daysInMonth(year, month);
  return {
    from: new Date(`${year}-${pad2(month)}-01T00:00:00.000-03:00`),
    to: new Date(`${year}-${pad2(month)}-${pad2(lastDay)}T23:59:59.999-03:00`),
  };
}
function getMonthlyPeriodRange(periodMonth) {
  const selected = parseMonthValue(periodMonth);
  if (!selected) {
    const error = new Error("Informe um mes valido para o relatorio mensal.");
    error.statusCode = 400;
    throw error;
  }
  const previousMonth = selected.month === 1 ? 12 : selected.month - 1;
  const previousYear = selected.month === 1 ? selected.year - 1 : selected.year;
  const current = buildMonthRange(selected.year, selected.month);
  const previous = buildMonthRange(previousYear, previousMonth);
  return {
    days: daysInMonth(selected.year, selected.month),
    from: current.from,
    to: current.to,
    compareFrom: previous.from,
    compareTo: previous.to,
    selectedMonth: `${selected.year}-${pad2(selected.month)}`,
  };
}
function getReportPeriodRange({ periodDays = 90, periodPreset = "rolling_days", periodMonth = null } = {}) {
  if (String(periodPreset || "").trim() === "monthly") return getMonthlyPeriodRange(periodMonth);
  return { ...getPeriodRange(periodDays), compareFrom: null, compareTo: null, selectedMonth: null };
}
function getReportExpiryDate(row) { const base = safeDate(row?.completedAt || row?.completedat || row?.createdAt || row?.createdat); return base && Number.isFinite(base.getTime()) ? new Date(base.getTime() + REPORT_RETENTION_MS).toISOString() : null; }

async function ensureSchema() {
  if (!schemaReadyPromise) {
    schemaReadyPromise = (async () => {
      await query(`CREATE TABLE IF NOT EXISTS "AdminAccountPerformanceReport" (
        id SERIAL NOT NULL, "accountId" INTEGER NOT NULL, "accountName" TEXT,
        "generatedByUserId" INTEGER, "generatedByEmail" TEXT,
        "periodFrom" TIMESTAMPTZ NOT NULL, "periodTo" TIMESTAMPTZ NOT NULL,
        "compareFrom" TIMESTAMPTZ, "compareTo" TIMESTAMPTZ, "periodPreset" TEXT NOT NULL DEFAULT 'rolling_days', "selectedMonth" TEXT,
        "periodDays" INTEGER NOT NULL DEFAULT 90, status TEXT NOT NULL DEFAULT 'QUEUED',
        progress INTEGER NOT NULL DEFAULT 0, "currentStep" TEXT, "xlsxPath" TEXT, "pdfPath" TEXT,
        logs JSONB NOT NULL DEFAULT '[]'::jsonb, summary JSONB, error TEXT,
        "startedAt" TIMESTAMPTZ, "completedAt" TIMESTAMPTZ,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT "AdminAccountPerformanceReport_pkey" PRIMARY KEY (id))`);
      await query(`ALTER TABLE "AdminAccountPerformanceReport" ADD COLUMN IF NOT EXISTS "compareFrom" TIMESTAMPTZ`);
      await query(`ALTER TABLE "AdminAccountPerformanceReport" ADD COLUMN IF NOT EXISTS "compareTo" TIMESTAMPTZ`);
      await query(`ALTER TABLE "AdminAccountPerformanceReport" ADD COLUMN IF NOT EXISTS "periodPreset" TEXT NOT NULL DEFAULT 'rolling_days'`);
      await query(`ALTER TABLE "AdminAccountPerformanceReport" ADD COLUMN IF NOT EXISTS "selectedMonth" TEXT`);
      await query(`CREATE INDEX IF NOT EXISTS "AdminAccountPerformanceReport_account_created_idx" ON "AdminAccountPerformanceReport"("accountId", "createdAt" DESC)`);
      await query(`CREATE INDEX IF NOT EXISTS "AdminAccountPerformanceReport_status_idx" ON "AdminAccountPerformanceReport"(status)`);
    })().catch((error) => { schemaReadyPromise = null; throw error; });
  }
  return schemaReadyPromise;
}

function mapReportRow(row) {
  if (!row) return null;
  const mapped = {
    id: Number(row.id), accountId: Number(row.accountId ?? row.accountid ?? row.account_id),
    accountName: row.accountName || row.accountname || row.account_name || null,
    generatedByUserId: row.generatedByUserId || row.generatedbyuserid || null,
    generatedByEmail: row.generatedByEmail || row.generatedbyemail || null,
    periodFrom: row.periodFrom || row.periodfrom || null, periodTo: row.periodTo || row.periodto || null,
    compareFrom: row.compareFrom || row.comparefrom || null, compareTo: row.compareTo || row.compareto || null,
    periodPreset: row.periodPreset || row.periodpreset || "rolling_days",
    selectedMonth: row.selectedMonth || row.selectedmonth || null,
    periodDays: Number(row.periodDays || row.perioddays || 90), status: row.status || REPORT_STATUSES.QUEUED,
    progress: Number(row.progress || 0), currentStep: row.currentStep || row.currentstep || null,
    xlsxPath: row.xlsxPath || row.xlsxpath || null, pdfPath: row.pdfPath || row.pdfpath || null,
    logs: Array.isArray(row.logs) ? row.logs : [], summary: row.summary || null, error: row.error || null,
    startedAt: row.startedAt || row.startedat || null, completedAt: row.completedAt || row.completedat || null,
    createdAt: row.createdAt || row.createdat || null, updatedAt: row.updatedAt || row.updatedat || null,
  };
  mapped.expiresAt = getReportExpiryDate(mapped);
  mapped.retentionHours = REPORT_RETENTION_HOURS;
  mapped.retentionNotice = REPORT_RETENTION_NOTICE;
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
    console.warn("[AdminAccountPerformanceReport] Falha ao excluir arquivo expirado", resolved, error?.message || error);
  }
}

async function cleanupExpiredReports() {
  await ensureSchema();
  const result = await query(
    `SELECT id, "xlsxPath" AS xlsx_path, "pdfPath" AS pdf_path
       FROM "AdminAccountPerformanceReport"
      WHERE COALESCE("completedAt", "createdAt") < NOW() - ($1::text)::interval
      LIMIT 500`,
    [`${REPORT_RETENTION_HOURS} hours`],
  );
  const ids = [];
  for (const row of result.rows || []) {
    ids.push(Number(row.id));
    deleteReportFileIfSafe(row.xlsx_path);
    deleteReportFileIfSafe(row.pdf_path);
  }
  if (ids.length) {
    await query(`DELETE FROM "AdminAccountPerformanceReport" WHERE id = ANY($1::int[])`, [ids]);
  }
  return ids.length;
}

function startReportRetentionCleanup() {
  if (cleanupTimer) return () => {};

  const run = async () => {
    try {
      const removed = await cleanupExpiredReports();
      if (removed > 0) {
        console.log(`[AdminAccountPerformanceReport] ${removed} relatorio(s) expirado(s) removido(s).`);
      }
    } catch (error) {
      console.warn("[AdminAccountPerformanceReport] Falha na limpeza de relatorios expirados:", error?.message || error);
    }
  };

  void run();
  cleanupTimer = setInterval(() => void run(), REPORT_CLEANUP_INTERVAL_MS);
  cleanupTimer.unref?.();

  return () => {
    if (cleanupTimer) clearInterval(cleanupTimer);
    cleanupTimer = null;
  };
}

async function appendLog(reportId, message, progress = null, status = null) {
  const entry = { at: nowIso(), message: String(message || "") };
  const sets = [`logs = COALESCE(logs, '[]'::jsonb) || $2::jsonb`, `"currentStep" = $3`, `"updatedAt" = NOW()`];
  const params = [Number(reportId), JSON.stringify([entry]), entry.message];
  if (progress != null) { params.push(clampInt(progress, 0, 100, 0)); sets.push(`progress = $${params.length}`); }
  if (status) { params.push(status); sets.push(`status = $${params.length}`); }
  await query(`UPDATE "AdminAccountPerformanceReport" SET ${sets.join(", ")} WHERE id = $1`, params);
}

async function listAccounts() {
  await ensureSchema();
  const result = await query(`SELECT a.id, a.name, a."documentType" AS document_type, a."documentNumber" AS document_number,
    a."companyPhotoUrl" AS company_photo_url, a."responsibleName" AS responsible_name, a."responsibleContact" AS responsible_contact,
    a."currentMonthGoalCents" AS current_month_goal_cents, a."quarterGoalCents" AS quarter_goal_cents,
    a."semesterGoalCents" AS semester_goal_cents, a."annualGoalCents" AS annual_goal_cents,
    COUNT(DISTINCT s.id)::int AS shops_count, COUNT(DISTINCT o.id)::int AS orders_count,
    MAX(o."updatedAt") AS latest_order_sync_at, MAX(o."shopeeCreateTime") AS latest_order_created_at
    FROM "Account" a LEFT JOIN "Shop" s ON s."accountId" = a.id LEFT JOIN "Order" o ON o."shopId" = s.id
    GROUP BY a.id ORDER BY a.name ASC NULLS LAST, a.id ASC`);
  return result.rows.map((row) => ({ id: Number(row.id), name: row.name || `Conta ${row.id}`, documentType: row.document_type || null,
    documentNumber: row.document_number || null, companyPhotoUrl: row.company_photo_url || null,
    responsibleName: row.responsible_name || null, responsibleContact: row.responsible_contact || null,
    currentMonthGoalCents: row.current_month_goal_cents == null ? null : Number(row.current_month_goal_cents),
    quarterGoalCents: row.quarter_goal_cents == null ? null : Number(row.quarter_goal_cents),
    semesterGoalCents: row.semester_goal_cents == null ? null : Number(row.semester_goal_cents),
    annualGoalCents: row.annual_goal_cents == null ? null : Number(row.annual_goal_cents),
    shopsCount: Number(row.shops_count || 0), ordersCount: Number(row.orders_count || 0),
    latestOrderSyncAt: row.latest_order_sync_at || null, latestOrderCreatedAt: row.latest_order_created_at || null }));
}

async function listReports({ accountId = null, limit = 50 } = {}) {
  await ensureSchema();
  await cleanupExpiredReports();
  const params = []; let where = "";
  if (accountId != null && Number.isFinite(Number(accountId))) { params.push(Number(accountId)); where = `WHERE "accountId" = $${params.length}`; }
  params.push(clampInt(limit, 1, 200, 50));
  const result = await query(`SELECT * FROM "AdminAccountPerformanceReport" ${where} ORDER BY "createdAt" DESC, id DESC LIMIT $${params.length}`, params);
  return result.rows.map(mapReportRow);
}

async function getReportById(reportId) {
  await ensureSchema();
  await cleanupExpiredReports();
  return mapReportRow(await queryOne(`SELECT * FROM "AdminAccountPerformanceReport" WHERE id = $1 LIMIT 1`, [Number(reportId)]));
}

async function loadAccount(accountId) {
  const row = await queryOne(`SELECT id, name, "documentType" AS document_type, "documentNumber" AS document_number,
    "companyPhotoUrl" AS company_photo_url, "responsibleName" AS responsible_name, "responsibleContact" AS responsible_contact,
    "currentMonthGoalCents" AS current_month_goal_cents, "quarterGoalCents" AS quarter_goal_cents,
    "semesterGoalCents" AS semester_goal_cents, "annualGoalCents" AS annual_goal_cents,
    "tenantGlobalId" AS tenant_global_id FROM "Account" WHERE id = $1 LIMIT 1`, [Number(accountId)]);
  return row ? { id: Number(row.id), name: row.name || `Conta ${row.id}`, documentType: row.document_type || null,
    documentNumber: row.document_number || null, companyPhotoUrl: row.company_photo_url || null,
    responsibleName: row.responsible_name || null, responsibleContact: row.responsible_contact || null,
    currentMonthGoalCents: row.current_month_goal_cents == null ? null : Number(row.current_month_goal_cents),
    quarterGoalCents: row.quarter_goal_cents == null ? null : Number(row.quarter_goal_cents),
    semesterGoalCents: row.semester_goal_cents == null ? null : Number(row.semester_goal_cents),
    annualGoalCents: row.annual_goal_cents == null ? null : Number(row.annual_goal_cents),
    tenantGlobalId: row.tenant_global_id || null } : null;
}

async function loadShops(accountId) {
  const result = await query(`SELECT id, "shopId" AS shop_id, region, status FROM "Shop" WHERE "accountId" = $1 ORDER BY id ASC`, [Number(accountId)]);
  return result.rows.map((row) => ({ id: Number(row.id), shopId: row.shop_id == null ? null : String(row.shop_id), region: row.region || null, status: row.status || null }));
}

async function getLatestOrderSync(accountId) {
  const row = await queryOne(`SELECT MAX(o."updatedAt") AS latest_sync_at, COUNT(o.id)::int AS orders_count FROM "Order" o INNER JOIN "Shop" s ON s.id = o."shopId" WHERE s."accountId" = $1`, [Number(accountId)]);
  return { latestSyncAt: row?.latest_sync_at || null, ordersCount: Number(row?.orders_count || 0) };
}

function allocateItemsToOrderRevenue(orders = [], rawItems = []) {
  const itemsByOrderId = new Map();
  for (const item of rawItems) {
    const orderId = Number(item.orderId || 0);
    if (!orderId) continue;
    if (!itemsByOrderId.has(orderId)) itemsByOrderId.set(orderId, []);
    itemsByOrderId.get(orderId).push(item);
  }

  const allocatedItems = [];
  for (const order of orders) {
    const orderId = Number(order.id || 0);
    const orderItems = itemsByOrderId.get(orderId) || [];
    const orderRevenueCents = cents(order.gmvCents);
    if (!orderItems.length) {
      if (orderRevenueCents > 0) {
        allocatedItems.push({
          orderId,
          productId: null,
          itemId: "pedidos-sem-itens-sincronizados",
          modelId: null,
          sku: null,
          title: "Pedidos sem itens sincronizados",
          quantity: 1,
          revenueCents: orderRevenueCents,
          soldAt: order.createdAt,
          status: null,
          stock: null,
          costCents: 0,
          allocationNote: "Faturamento do pedido sem itens vinculados no banco.",
        });
      }
      continue;
    }

    const rawTotal = orderItems.reduce((sum, item) => sum + Math.max(0, cents(item.rawRevenueCents)), 0);
    const qtyTotal = orderItems.reduce((sum, item) => sum + Math.max(0, toNumber(item.quantity, 0)), 0);
    let remaining = orderRevenueCents;
    orderItems.forEach((item, index) => {
      const isLast = index === orderItems.length - 1;
      const weight = rawTotal > 0
        ? Math.max(0, cents(item.rawRevenueCents))
        : Math.max(0, toNumber(item.quantity, 0));
      const totalWeight = rawTotal > 0 ? rawTotal : qtyTotal;
      const allocated = isLast
        ? remaining
        : totalWeight > 0
          ? Math.round((orderRevenueCents * weight) / totalWeight)
          : 0;
      remaining -= allocated;
      allocatedItems.push({
        ...item,
        revenueCents: allocated,
        rawRevenueCents: undefined,
        allocationNote: rawTotal === orderRevenueCents ? null : "Faturamento rateado pelo GMV real do pedido.",
      });
    });
  }
  return allocatedItems;
}

async function createReport({ accountId, userId, email, periodDays = 90, periodPreset = "rolling_days", periodMonth = null }) {
  await ensureSchema();
  await cleanupExpiredReports();
  const preset = String(periodPreset || "").trim() === "monthly" ? "monthly" : "rolling_days";
  const range = getReportPeriodRange({ periodDays, periodPreset: preset, periodMonth });
  const account = await loadAccount(accountId);
  if (!account) { const error = new Error("Empresa/conta nao encontrada."); error.statusCode = 404; throw error; }
  const row = await queryOne(`INSERT INTO "AdminAccountPerformanceReport" ("accountId", "accountName", "generatedByUserId", "generatedByEmail", "periodFrom", "periodTo", "compareFrom", "compareTo", "periodPreset", "selectedMonth", "periodDays", status, progress, "currentStep", logs)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'QUEUED', 0, 'Aguardando processamento', '[]'::jsonb) RETURNING *`,
    [Number(account.id), account.name, userId == null ? null : Number(userId), email || null, range.from, range.to, range.compareFrom, range.compareTo, preset, range.selectedMonth, range.days]);
  const report = mapReportRow(row);
  setImmediate(() => runReport(report.id).catch((error) => console.error("[AdminAccountPerformanceReport]", error)));
  return report;
}

async function maybeSyncOrders({ reportId, account, shops, periodDays, periodFrom = null, compareFrom = null }) {
  await appendLog(reportId, "Verificando ultima sincronizacao de pedidos...", 8);
  const latest = await getLatestOrderSync(account.id);
  const latestTime = latest.latestSyncAt ? new Date(latest.latestSyncAt).getTime() : 0;
  const needsSync = !latestTime || Date.now() - latestTime > 5 * 86400000;
  await appendLog(reportId, `Sincronizacao necessaria: ${needsSync ? "sim" : "nao"}. Ultima sincronizacao: ${formatDateTime(latest.latestSyncAt)}.`, 12);
  if (!needsSync) return { attempted: false, latestSyncAt: latest.latestSyncAt };
  await appendLog(reportId, "Iniciando sincronizacao de pedidos antes do relatorio...", 14);
  const earliest = safeDate(compareFrom || periodFrom);
  const daysFromEarliest = earliest && Number.isFinite(earliest.getTime())
    ? Math.ceil((Date.now() - earliest.getTime()) / 86400000) + 2
    : Number(periodDays || 90);
  const rangeDays = Math.min(180, Math.max(30, daysFromEarliest));
  const results = [];
  for (const shop of shops) {
    if (!shop.shopId) continue;
    try {
      await appendLog(reportId, `Buscando pedidos da loja ${shop.shopId} (${rangeDays} dias)...`, 16);
      const result = await OrderSyncService.syncOrdersForShop({ shopeeShopId: String(shop.shopId), rangeDays });
      results.push({ shopId: shop.shopId, ok: true, summary: result?.summary || null });
      await appendLog(reportId, `Loja ${shop.shopId}: sincronizacao finalizada.`, 22);
    } catch (error) {
      results.push({ shopId: shop.shopId, ok: false, error: String(error?.message || error) });
      await appendLog(reportId, `Loja ${shop.shopId}: sincronizacao falhou, usando base atual. Motivo: ${String(error?.message || error)}`, 22);
    }
  }
  await appendLog(reportId, "Validando dados apos sincronizacao...", 24);
  return { attempted: true, latestSyncAt: latest.latestSyncAt, results };
}

async function loadAnalysisData({ accountId, periodFrom, periodTo }) {
  const params = [Number(accountId), periodFrom, periodTo, EXCLUDED_ORDER_STATUSES];
  const ordersResult = await query(`SELECT o.id, o."orderSn" AS order_sn, o."gmvCents" AS gmv_cents, o."orderStatus" AS order_status,
    COALESCE(o."shopeeCreateTime", o."createdAt") AS created_at, o."updatedAt" AS updated_at, o."shopId" AS shop_id
    FROM "Order" o INNER JOIN "Shop" s ON s.id = o."shopId" WHERE s."accountId" = $1
    AND COALESCE(o."orderStatus", '') <> ALL($4::text[])
    AND ((o."shopeeCreateTime" >= $2 AND o."shopeeCreateTime" <= $3) OR (o."shopeeCreateTime" IS NULL AND o."createdAt" >= $2 AND o."createdAt" <= $3))
    ORDER BY COALESCE(o."shopeeCreateTime", o."createdAt") ASC`, params);
  const itemResult = await query(`SELECT oi."orderId" AS order_id, oi."productId" AS product_id, oi."itemId" AS item_id,
    oi."modelId" AS model_id, oi."itemSku" AS item_sku, COALESCE(NULLIF(oi."itemName", ''), p.title, 'Produto sem titulo') AS title,
    COALESCE(oi.quantity, 0)::numeric AS quantity, COALESCE(oi."orderPrice", 0)::numeric AS order_price_cents,
    COALESCE(o."shopeeCreateTime", o."createdAt") AS sold_at, p.status AS product_status, p.stock AS stock,
    p."itemSku" AS product_sku, p."costCents" AS cost_cents
    FROM "OrderItem" oi INNER JOIN "Order" o ON o.id = oi."orderId" INNER JOIN "Shop" s ON s.id = o."shopId"
    LEFT JOIN "Product" p ON p.id = oi."productId" WHERE s."accountId" = $1 AND COALESCE(o."orderStatus", '') <> ALL($4::text[])
    AND ((o."shopeeCreateTime" >= $2 AND o."shopeeCreateTime" <= $3) OR (o."shopeeCreateTime" IS NULL AND o."createdAt" >= $2 AND o."createdAt" <= $3))`, params);
  const productCountRow = await queryOne(`SELECT COUNT(*)::int AS total FROM "Product" p INNER JOIN "Shop" s ON s.id = p."shopId" WHERE s."accountId" = $1 AND UPPER(TRIM(COALESCE(p.status, ''))) <> 'DELETED'`, [Number(accountId)]);
  const orders = ordersResult.rows.map((row) => ({ id: Number(row.id), orderSn: row.order_sn, gmvCents: cents(row.gmv_cents), status: row.order_status || null, createdAt: row.created_at, updatedAt: row.updated_at, shopId: Number(row.shop_id) }));
  const rawItems = itemResult.rows.map((row) => ({ orderId: Number(row.order_id), productId: row.product_id == null ? null : Number(row.product_id), itemId: row.item_id == null ? null : String(row.item_id), modelId: row.model_id == null ? null : String(row.model_id), sku: row.item_sku || row.product_sku || null, title: row.title || "Produto sem titulo", quantity: toNumber(row.quantity, 0), rawRevenueCents: cents(row.order_price_cents), soldAt: row.sold_at, status: row.product_status || null, stock: row.stock == null ? null : Number(row.stock), costCents: cents(row.cost_cents) }));
  return {
    orders,
    items: allocateItemsToOrderRevenue(orders, rawItems),
    productCount: Number(productCountRow?.total || 0),
  };
}

function classifyAbc(cumulativePct) { if (cumulativePct <= 80) return "A"; if (cumulativePct <= 95) return "B"; return "C"; }
function applyAbc(rows, metric) { const total = rows.reduce((sum, row) => sum + toNumber(row[metric], 0), 0); let cumulative = 0; return rows.map((row, index) => { const value = toNumber(row[metric], 0); cumulative += value; const cumulativePct = total > 0 ? (cumulative / total) * 100 : 100; return { ...row, rank: index + 1, [`${metric}SharePct`]: total > 0 ? (value / total) * 100 : 0, [`${metric}CumulativePct`]: cumulativePct, [`${metric}Abc`]: classifyAbc(cumulativePct) }; }); }
function summarizeCurve(rows, metric, abcField) { const totalMetric = rows.reduce((sum, row) => sum + toNumber(row[metric], 0), 0); return ["A", "B", "C"].map((curve) => { const list = rows.filter((row) => (row[abcField] || "C") === curve); const metricTotal = list.reduce((sum, row) => sum + toNumber(row[metric], 0), 0); return { curve, products: list.filter((row) => !isUnlinkedOrderItem(row)).length, metricTotal, revenueCents: list.reduce((sum, row) => sum + cents(row.revenueCents), 0), quantity: list.reduce((sum, row) => sum + toNumber(row.quantity, 0), 0), sharePct: totalMetric > 0 ? (metricTotal / totalMetric) * 100 : 0, topProducts: list.slice(0, 5) }; }); }
function isUnlinkedOrderItem(item) { return String(item?.itemId || "") === "pedidos-sem-itens-sincronizados"; }

function buildProductMetrics(items, periodFrom, periodTo, previousItems = null) {
  const map = new Map(); const fromTime = safeDate(periodFrom).getTime(); const toTime = safeDate(periodTo).getTime(); const midTime = fromTime + (toTime - fromTime) / 2;
  const ensureEntry = (item) => {
    const key = item.itemId || `produto-${item.productId || item.title}`;
    if (!map.has(key)) map.set(key, { itemId: item.itemId || null, productId: item.productId || null, sku: item.sku || null, title: item.title || "Produto sem titulo", quantity: 0, revenueCents: 0, orders: new Set(), currentRevenueCents: 0, previousRevenueCents: 0, currentQuantity: 0, previousQuantity: 0, lastSaleAt: null, stock: item.stock, status: item.status });
    return map.get(key);
  };
  for (const item of items) {
    const entry = ensureEntry(item); entry.quantity += toNumber(item.quantity, 0); entry.revenueCents += cents(item.revenueCents); entry.orders.add(item.orderId);
    const soldTime = item.soldAt ? new Date(item.soldAt).getTime() : 0;
    if (Array.isArray(previousItems)) { entry.currentRevenueCents += cents(item.revenueCents); entry.currentQuantity += toNumber(item.quantity, 0); }
    else if (soldTime >= midTime) { entry.currentRevenueCents += cents(item.revenueCents); entry.currentQuantity += toNumber(item.quantity, 0); } else { entry.previousRevenueCents += cents(item.revenueCents); entry.previousQuantity += toNumber(item.quantity, 0); }
    if (!entry.lastSaleAt || (item.soldAt && new Date(item.soldAt) > new Date(entry.lastSaleAt))) entry.lastSaleAt = item.soldAt || entry.lastSaleAt;
    if (entry.stock == null && item.stock != null) entry.stock = item.stock; if (!entry.status && item.status) entry.status = item.status;
  }
  if (Array.isArray(previousItems)) {
    for (const item of previousItems) {
      const entry = ensureEntry(item);
      entry.previousRevenueCents += cents(item.revenueCents);
      entry.previousQuantity += toNumber(item.quantity, 0);
      if (entry.stock == null && item.stock != null) entry.stock = item.stock;
      if (!entry.status && item.status) entry.status = item.status;
    }
  }
  return Array.from(map.values()).map((entry) => { const revenueDelta = entry.currentRevenueCents - entry.previousRevenueCents; const threshold = Math.max(5000, entry.previousRevenueCents * 0.1); const trend = revenueDelta > threshold ? "crescimento" : revenueDelta < -threshold ? "queda" : "estabilidade"; return { ...entry, ordersCount: entry.orders.size, orders: undefined, averageTicketCents: entry.quantity > 0 ? Math.round(entry.revenueCents / entry.quantity) : 0, revenueDeltaCents: revenueDelta, quantityDelta: entry.currentQuantity - entry.previousQuantity, trend }; });
}

function rankKey(row) { return row?.itemId || row?.productId || row?.title || ""; }
function rankedMetricRows(rows, metric) { return rows.filter((row) => toNumber(row[metric], 0) > 0).sort((a, b) => toNumber(b[metric], 0) - toNumber(a[metric], 0)).map((row, index) => ({ row, rank: index + 1, value: toNumber(row[metric], 0), key: rankKey(row) })); }
function rankMovement(currentRows, previousRows, metric, topN) {
  const currentRanked = rankedMetricRows(currentRows, metric);
  const previousRanked = rankedMetricRows(previousRows, metric);
  const currentTop = currentRanked.slice(0, topN);
  const previousTop = previousRanked.slice(0, topN);
  const currentMap = new Map(currentRanked.map((entry) => [entry.key, entry]));
  const previousMap = new Map(previousRanked.map((entry) => [entry.key, entry]));
  const topRows = currentTop.map((entry) => {
    const previous = previousMap.get(entry.key) || null;
    const movement = previous ? previous.rank - entry.rank : null;
    const movementLabel = !previous
      ? "Novo no periodo atual"
      : previous.rank > topN
        ? `Entrou no Top ${topN}`
        : movement > 0
          ? `Subiu ${movement} pos.`
          : movement < 0
            ? `Caiu ${Math.abs(movement)} pos.`
            : "Manteve posicao";
    const explanation = !previous
      ? "Produto sem venda/ranking no periodo anterior equivalente."
      : previous.rank > topN
        ? `Antes estava fora do Top ${topN}, na posicao #${previous.rank}.`
        : "Produto estava presente nos dois recortes comparados.";
    return { ...entry.row, currentRank: entry.rank, previousRank: previous?.rank || null, currentValue: entry.value, previousValue: previous?.value || 0, movement, movementLabel, explanation };
  });
  const exitedRows = previousTop
    .filter((entry) => !currentTop.some((current) => current.key === entry.key))
    .map((entry) => {
      const current = currentMap.get(entry.key) || null;
      return {
        ...entry.row,
        currentRank: current?.rank || null,
        previousRank: entry.rank,
        currentValue: current?.value || 0,
        previousValue: entry.value,
        movement: current ? entry.rank - current.rank : null,
        movementLabel: current ? `Saiu do Top ${topN}` : "Saiu: sem venda atual",
        explanation: current ? `Agora esta fora do Top ${topN}, na posicao #${current.rank}.` : "Produto nao teve venda/ranking no periodo atual equivalente.",
      };
    });
  return {
    topN,
    rows: [...topRows, ...exitedRows],
    entered: topRows.filter((row) => !row.previousRank || row.previousRank > topN),
    exited: exitedRows,
    stayed: topRows.filter((row) => row.previousRank && row.previousRank <= topN),
  };
}
function buildDailySeries(orders) { const map = new Map(); for (const order of orders) { const key = order.createdAt ? new Date(order.createdAt).toISOString().slice(0, 10) : "sem-data"; if (!map.has(key)) map.set(key, { date: key, revenueCents: 0, orders: 0 }); const entry = map.get(key); entry.revenueCents += cents(order.gmvCents); entry.orders += 1; } return Array.from(map.values()).sort((a, b) => String(a.date).localeCompare(String(b.date))).map((entry) => ({ ...entry, averageTicketCents: entry.orders > 0 ? Math.round(entry.revenueCents / entry.orders) : 0 })); }
function validateData({ orders, items, productCount }) { const warnings = []; if (!orders.length) warnings.push("Nao ha pedidos no periodo analisado."); if (orders.length > 0 && orders.length < 10) warnings.push("A amostra de pedidos e pequena; analise pode oscilar."); if (!items.length) warnings.push("Nao ha itens de pedido vinculados aos pedidos do periodo."); const invalidItems = items.filter((item) => !item.itemId || item.quantity <= 0 || item.revenueCents < 0).length; if (invalidItems > 0) warnings.push(`${invalidItems} item(ns) possuem ID, quantidade ou valor inconsistente.`); const unlinkedRevenue = items.filter((item) => item.itemId === "pedidos-sem-itens-sincronizados").reduce((sum, item) => sum + cents(item.revenueCents), 0); if (unlinkedRevenue > 0) warnings.push(`${formatBRL(unlinkedRevenue)} do faturamento esta em pedidos sem itens sincronizados; o ranking agrupa esse valor para nao perder total do periodo.`); if (productCount === 0) warnings.push("Nao ha produtos cadastrados para a conta."); return warnings; }
function selectAccountGoal(account, elapsedDays) {
  const goals = [
    { key: "currentMonthGoalCents", label: "mês atual", maxDays: 45, projectionDays: 30 },
    { key: "quarterGoalCents", label: "trimestre", maxDays: 110, projectionDays: 90 },
    { key: "semesterGoalCents", label: "6 meses", maxDays: 200, projectionDays: 180 },
    { key: "annualGoalCents", label: "anual", maxDays: Infinity, projectionDays: 365 },
  ];
  const preferred = goals.find((goal) => elapsedDays <= goal.maxDays) || goals[goals.length - 1];
  const target = Number(account?.[preferred.key] || 0);
  if (target > 0) return { ...preferred, targetCents: target };
  const fallback = goals.find((goal) => Number(account?.[goal.key] || 0) > 0);
  if (fallback) return { ...fallback, targetCents: Number(account[fallback.key] || 0), fallbackFrom: preferred.label };
  const envTarget = Number(process.env.ACCOUNT_REPORT_DEFAULT_MONTHLY_TARGET_CENTS || 0);
  return { key: "env", label: "padrão mensal", maxDays: 45, projectionDays: 30, targetCents: Number.isFinite(envTarget) ? envTarget : 0, fromEnv: true };
}
function buildGoalsSection(revenueCents, periodFrom, periodTo, account = null) { const elapsedDays = Math.max(1, Math.ceil((new Date(periodTo).getTime() - new Date(periodFrom).getTime()) / 86400000)); const selectedGoal = selectAccountGoal(account, elapsedDays); const target = Number(selectedGoal.targetCents || 0); const projection = Math.round((revenueCents / elapsedDays) * Number(selectedGoal.projectionDays || 30)); const note = target > 0 ? selectedGoal.fromEnv ? "Meta padrao configurada por variavel de ambiente." : selectedGoal.fallbackFrom ? `Meta de ${selectedGoal.label} usada como fallback porque a meta de ${selectedGoal.fallbackFrom} nao esta preenchida.` : `Meta de ${selectedGoal.label} cadastrada na empresa.` : "Sem meta cadastrada para esta empresa."; return { targetCents: target, targetLabel: selectedGoal.label, projectionDays: selectedGoal.projectionDays || 30, realizedCents: revenueCents, achievedPct: target > 0 ? (revenueCents / target) * 100 : null, missingCents: target > 0 ? Math.max(0, target - revenueCents) : null, projectionCents: projection, status: target > 0 ? (projection >= target ? "ritmo_ok" : "risco") : "sem_meta_cadastrada", note }; }

function buildInsights(analysis) {
  const topRevenue = analysis.rankRevenue.slice(0, 3);
  const curveA = analysis.curveRevenue.find((entry) => entry.curve === "A");
  const fallingA = analysis.rankRevenue.filter((row) => row.revenueCentsAbc === "A" && row.trend === "queda");
  const growth = [...analysis.rankRevenue].sort((a, b) => b.revenueDeltaCents - a.revenueDeltaCents).slice(0, 5);
  const falling = [...analysis.rankRevenue].sort((a, b) => a.revenueDeltaCents - b.revenueDeltaCents).slice(0, 5);
  const insights = [];
  insights.push(`A conta faturou ${formatBRL(analysis.kpis.revenueCents)} em ${analysis.kpis.ordersCount} pedido(s), com ticket medio de ${formatBRL(analysis.kpis.averageTicketCents)}.`);
  if (topRevenue.length) insights.push(`Os 3 principais anuncios concentram ${formatPercent(topRevenue.reduce((sum, item) => sum + item.revenueCentsSharePct, 0))} do faturamento analisado.`);
  if (curveA) insights.push(`Curva A: ${curveA.products} produto(s) representam ${formatPercent(curveA.sharePct)} do faturamento. Proteja estoque, preco e campanhas destes itens.`);
  if (fallingA.length) insights.push(`${fallingA.length} produto(s) da Curva A estao em queda e devem receber revisao imediata.`);
  if (growth.length && growth[0].revenueDeltaCents > 0) insights.push(`Maior aceleracao: ${growth[0].title} cresceu ${formatBRL(growth[0].revenueDeltaCents)} versus periodo anterior equivalente.`);
  if (falling.length && falling[0].revenueDeltaCents < 0) insights.push(`Maior queda: ${falling[0].title} caiu ${formatBRL(Math.abs(falling[0].revenueDeltaCents))}; investigar ruptura, preco, visitas e conversao.`);
  if (analysis.validationWarnings.length) insights.push(`Limitacoes da analise: ${analysis.validationWarnings.join(" ")}`);
  return { executiveSummary: insights[0], alerts: insights.slice(1, 4), opportunities: insights.slice(4), nextSteps: ["Blindar Curva A com monitoramento diario de estoque e competitividade.", "Escalar produtos em crescimento com campanhas e revisao de margem.", "Reativar produtos que venderam no periodo anterior e pararam no periodo atual.", "Revisar anuncios da Curva C com baixa tracao ou baixa margem operacional."], raw: insights };
}

async function maybeEnhanceInsightsWithOllama(analysis, reportId) {
  const ollamaUrl = String(process.env.OLLAMA_BASE_URL || "").replace(/\/+$/, "");
  const model = process.env.OLLAMA_ACCOUNT_REPORT_MODEL || "qwen2.5:7b";
  if (!ollamaUrl || typeof fetch !== "function") return analysis.insights;
  try {
    await appendLog(reportId, `Gerando insights com IA local (${model})...`, 63);
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 30000);
    const response = await fetch(`${ollamaUrl}/api/generate`, { method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal, body: JSON.stringify({ model, stream: false, prompt: `Analise somente dados reais. Nao invente numeros, campanhas, pedidos, ROAS ou custos ausentes. Se faltar dado, cite a limitacao. Responda JSON com executiveSummary, alerts, opportunities, nextSteps.\n${JSON.stringify({ kpis: analysis.kpis, topRevenue: analysis.rankRevenue.slice(0, 10), topQuantity: analysis.rankQuantity.slice(0, 10), curveRevenue: analysis.curveRevenue, ads: analysis.ads ? { kpis: analysis.ads.kpis, rankings: { revenue: analysis.ads.rankings.revenue.slice(0, 10), spend: analysis.ads.rankings.spend.slice(0, 10), efficiency: analysis.ads.rankings.efficiency.slice(0, 10), waste: analysis.ads.rankings.waste.slice(0, 10) }, recommendations: analysis.ads.recommendations.slice(0, 10), dataGaps: analysis.ads.dataGaps } : null, warnings: analysis.validationWarnings }).slice(0, 22000)}` }) });
    clearTimeout(timeout); if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
    const data = await response.json(); const text = String(data?.response || ""); const start = text.indexOf("{"); const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) { const parsed = JSON.parse(text.slice(start, end + 1)); return { executiveSummary: String(parsed.executiveSummary || analysis.insights.executiveSummary || ""), alerts: Array.isArray(parsed.alerts) ? parsed.alerts.map(String).slice(0, 8) : analysis.insights.alerts, opportunities: Array.isArray(parsed.opportunities) ? parsed.opportunities.map(String).slice(0, 8) : analysis.insights.opportunities, nextSteps: Array.isArray(parsed.nextSteps) ? parsed.nextSteps.map(String).slice(0, 8) : analysis.insights.nextSteps, raw: [...analysis.insights.raw, "Insights IA local aplicados."] }; }
  } catch (error) { await appendLog(reportId, `IA local indisponivel; mantendo insights deterministicos. Motivo: ${String(error?.message || error)}`, 64); }
  return analysis.insights;
}

function buildAnalysis({ account, shops, orders, items, productCount, periodFrom, periodTo, syncInfo, previousOrders = null, previousItems = null, compareFrom = null, compareTo = null, periodPreset = "rolling_days", selectedMonth = null }) {
  const hasExplicitComparison = Array.isArray(previousItems);
  const products = buildProductMetrics(items, periodFrom, periodTo, hasExplicitComparison ? previousItems : null); const revenueTotal = orders.reduce((sum, order) => sum + cents(order.gmvCents), 0); const soldProductIds = new Set(products.filter((item) => !isUnlinkedOrderItem(item) && (toNumber(item.currentRevenueCents, 0) > 0 || toNumber(item.currentQuantity, 0) > 0 || !hasExplicitComparison)).map((item) => item.itemId || item.productId).filter(Boolean));
  const rankSourceProducts = hasExplicitComparison ? products.filter((item) => toNumber(item.currentRevenueCents, 0) > 0 || toNumber(item.currentQuantity, 0) > 0) : products;
  const rankRevenue = applyAbc([...rankSourceProducts].sort((a, b) => b.revenueCents - a.revenueCents), "revenueCents"); const rankQuantity = applyAbc([...rankSourceProducts].sort((a, b) => b.quantity - a.quantity), "quantity");
  const revenueAbcById = new Map(rankRevenue.map((row) => [row.itemId || row.productId || row.title, row.revenueCentsAbc])); const quantityAbcById = new Map(rankQuantity.map((row) => [row.itemId || row.productId || row.title, row.quantityAbc]));
  for (const row of rankRevenue) row.quantityAbc = quantityAbcById.get(row.itemId || row.productId || row.title) || "C"; for (const row of rankQuantity) row.revenueCentsAbc = revenueAbcById.get(row.itemId || row.productId || row.title) || "C";
  const fromTime = new Date(periodFrom).getTime(); const toTime = new Date(periodTo).getTime(); const mid = hasExplicitComparison ? safeDate(periodFrom) : new Date(fromTime + (toTime - fromTime) / 2); const previousProducts = products.map((p) => ({ ...p, revenueCents: p.previousRevenueCents, quantity: p.previousQuantity })); const currentProducts = products.map((p) => ({ ...p, revenueCents: p.currentRevenueCents, quantity: p.currentQuantity }));
  const validationWarnings = validateData({ orders, items, productCount }); const curveRevenue = summarizeCurve(rankRevenue, "revenueCents", "revenueCentsAbc"); const curveQuantity = summarizeCurve(rankQuantity, "quantity", "quantityAbc");
  const analysis = { generatedAt: nowIso(), account, shops, period: { from: periodFrom, to: periodTo, currentStart: mid, compareFrom, compareTo, periodPreset, selectedMonth, days: Math.round((toTime - fromTime) / 86400000) }, syncInfo, kpis: { revenueCents: revenueTotal, ordersCount: orders.length, previousOrdersCount: Array.isArray(previousOrders) ? previousOrders.length : null, averageTicketCents: orders.length > 0 ? Math.round(revenueTotal / orders.length) : 0, soldProductsCount: soldProductIds.size, productsWithoutSalesCount: Math.max(0, Number(productCount || 0) - soldProductIds.size), productsTotal: Number(productCount || 0), shopsCount: shops.length }, rankRevenue, rankQuantity, curveRevenue, curveQuantity, curveASecurity: { concentrationTop5Pct: rankRevenue.slice(0, 5).reduce((sum, row) => sum + row.revenueCentsSharePct, 0), fallingA: rankRevenue.filter((row) => row.revenueCentsAbc === "A" && row.trend === "queda"), lowStockA: rankRevenue.filter((row) => row.revenueCentsAbc === "A" && row.stock != null && Number(row.stock) <= 3), recommendations: ["Monitorar estoque e ruptura da Curva A todos os dias.", "Criar plano de defesa comercial para Top 5 por faturamento.", "Revisar anuncios da Curva A em queda com prioridade maxima.", "Distribuir dependencia criando escala em produtos da Curva B."] }, growth: [...rankRevenue].sort((a, b) => b.revenueDeltaCents - a.revenueDeltaCents).slice(0, 20), decline: [...rankRevenue].sort((a, b) => a.revenueDeltaCents - b.revenueDeltaCents).slice(0, 20), movements: { revenue: [5, 10, 20].map((n) => rankMovement(currentProducts, previousProducts, "revenueCents", n)), quantity: [5, 10, 20].map((n) => rankMovement(currentProducts, previousProducts, "quantity", n)) }, daily: buildDailySeries(orders), goals: buildGoalsSection(revenueTotal, periodFrom, periodTo, account), validationWarnings };
  analysis.insights = buildInsights(analysis); return analysis;
}

function aoaSheet(workbook, name, rows, widths = []) { const sheet = XLSX.utils.aoa_to_sheet(rows); sheet["!cols"] = widths.map((wch) => ({ wch })); if (rows.length > 1 && rows[0]?.length) sheet["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length - 1, c: rows[0].length - 1 } }) }; XLSX.utils.book_append_sheet(workbook, sheet, name.slice(0, 31)); }
function moneyCell(value) { return Number((cents(value) / 100).toFixed(2)); }
function productRows(rows, metricType = "revenue") { return rows.map((row) => [row.rank, row.itemId || "-", row.sku || "-", row.title, Number(row.quantity || 0), moneyCell(row.revenueCents), moneyCell(row.averageTicketCents), Number((metricType === "quantity" ? row.quantitySharePct : row.revenueCentsSharePct || 0).toFixed(2)), metricType === "quantity" ? row.quantityAbc : row.revenueCentsAbc, row.trend, moneyCell(row.revenueDeltaCents)]); }
function rankCell(value, fallback = "Sem ranking") { const n = Number(value); return Number.isFinite(n) && n > 0 ? `#${n}` : fallback; }
function movementMetricCell(value, metricLabel) { return String(metricLabel || "").toLowerCase().includes("faturamento") ? moneyCell(value) : Number(toNumber(value, 0).toFixed(2)); }
function movementRows(movement, metricLabel) {
  if (!movement) return [];
  const rows = Array.isArray(movement.rows) ? movement.rows : [];
  if (rows.length) {
    return rows.map((p) => [
      metricLabel,
      p.movementLabel || "Sem movimento calculado",
      p.itemId || "-",
      p.title || "Produto sem titulo",
      rankCell(p.currentRank, "Sem venda atual"),
      rankCell(p.previousRank, "Sem venda anterior"),
      movementMetricCell(p.currentValue, metricLabel),
      movementMetricCell(p.previousValue, metricLabel),
      p.explanation || "",
    ]);
  }
  return [
    ...movement.entered.map((p) => [metricLabel, "Entrou", p.itemId || "-", p.title, "Top atual", "Sem venda anterior", movementMetricCell(p.currentValue, metricLabel), 0, "Produto entrou no recorte atual."]),
    ...movement.exited.map((p) => [metricLabel, "Saiu", p.itemId || "-", p.title, "Sem venda atual", rankCell(p.previousRank), 0, movementMetricCell(p.previousValue, metricLabel), "Produto saiu do recorte atual."]),
    ...movement.stayed.map((p) => [metricLabel, p.movement > 0 ? "Subiu" : p.movement < 0 ? "Caiu" : "Manteve", p.itemId || "-", p.title, rankCell(p.currentRank), rankCell(p.previousRank), movementMetricCell(p.currentValue, metricLabel), movementMetricCell(p.previousValue, metricLabel), "Produto estava presente nos dois recortes."]),
  ];
}

function isoDateOnly(value) { const date = value ? new Date(value) : new Date(); return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10); }
function addDaysIso(value, days) { const date = value ? new Date(value) : new Date(); date.setUTCDate(date.getUTCDate() + Number(days || 0)); return isoDateOnly(date); }
function toShopeeDate(iso) { const [y, m, d] = String(iso || "").split("-"); return y && m && d ? `${d}-${m}-${y}` : null; }
function ratio(value, divisor) { const v = toNumber(value, 0); const d = toNumber(divisor, 0); return d > 0 ? v / d : null; }
function ratioPct(value, divisor) { const r = ratio(value, divisor); return r == null ? null : Number((r * 100).toFixed(2)); }
function formatMetricNumber(value, digits = 2) { return value == null || !Number.isFinite(Number(value)) ? "-" : Number(value).toFixed(digits); }
function adsMetricRow(row) { return [row.rank, row.itemId || "-", row.title || "-", moneyCell(row.revenueCents), moneyCell(row.spendCents), formatMetricNumber(row.roas), formatMetricNumber(row.acosPct), row.impressions, row.clicks, formatMetricNumber(row.ctrPct), row.attributedItemsSold, moneyCell(row.costPerSaleCents), moneyCell(row.wasteScoreCents), row.actionHint || "-"]; }
function emptyAdsAnalysis(periodTo, reason = "Nao ha dados de Ads CPC cacheados para os ultimos 3 meses.") { const to = isoDateOnly(periodTo); const from = addDaysIso(to, -89); return { available: false, period: { from, to, days: 90 }, dataGaps: [reason], kpis: { spendCents: 0, revenueCents: 0, attributedOrders: 0, attributedItemsSold: 0, impressions: 0, clicks: 0, roas: null, acosPct: null, avgCpcCents: 0, ctrPct: null, conversionPct: null, costPerOrderCents: 0, adsTicketCents: 0 }, monthly: [], rankings: { revenue: [], spend: [], efficiency: [], waste: [] }, recommendations: [], insights: ["Sem dados reais de Ads suficientes para gerar conclusoes."], nextSteps: ["Conectar/sincronizar Ads e gerar novamente o relatorio.", "Nao tomar decisoes de investimento de Ads sem metricas reais disponiveis."] }; }

function summarizeOfficialAdsRows(rows = []) {
  return rows.reduce((acc, row) => {
    acc.spend += moneyToCents(row?.expense);
    acc.broad_gmv += moneyToCents(row?.broad_gmv);
    acc.direct_gmv += moneyToCents(row?.direct_gmv);
    acc.broad_sold += toNumber(row?.broad_order ?? row?.broad_item_sold ?? row?.broad_sold, 0);
    acc.direct_sold += toNumber(row?.direct_order ?? row?.direct_item_sold ?? row?.direct_sold, 0);
    acc.impressions += toNumber(row?.impression, 0);
    acc.clicks += toNumber(row?.click, 0);
    return acc;
  }, { spend: 0, broad_gmv: 0, direct_gmv: 0, broad_sold: 0, direct_sold: 0, impressions: 0, clicks: 0 });
}

function monthKeyFromAdsDate(value) {
  const raw = String(value || "").trim();
  const dmy = raw.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2]}`;
  const ymd = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (ymd) return `${ymd[1]}-${ymd[2]}`;
  const date = raw ? new Date(raw) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 7) : "sem-mes";
}

function chunkIsoDateRange(from, to, maxDays = 31) {
  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end) return [];
  const chunks = [];
  let cursor = start;
  while (cursor <= end) {
    const chunkStart = new Date(cursor);
    const chunkEnd = new Date(cursor);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + maxDays - 1);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());
    chunks.push({ from: chunkStart.toISOString().slice(0, 10), to: chunkEnd.toISOString().slice(0, 10) });
    cursor = new Date(chunkEnd);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return chunks;
}

function buildOfficialAdsMonthlyRows(rows = []) {
  const byMonth = new Map();
  for (const row of rows) {
    const month = monthKeyFromAdsDate(row?.date);
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push(row);
  }
  return Array.from(byMonth.entries())
    .sort(([a], [b]) => String(a).localeCompare(String(b)))
    .map(([month, monthRows]) => ({ month, ...summarizeOfficialAdsRows(monthRows) }));
}

async function loadConnectedAdsShopsForAccount(accountId) {
  const result = await query(`SELECT s.id, s."shopId" AS shop_id, s.region, s.status, s."accountId" AS account_id
    FROM "OAuthToken" t INNER JOIN "Shop" s ON s.id = t."shopId"
    WHERE s."accountId" = $1 AND t."adsAccessToken" IS NOT NULL
    ORDER BY s.id ASC`, [Number(accountId)]);
  return result.rows.map((row) => ({ id: Number(row.id), shopId: row.shop_id == null ? null : BigInt(row.shop_id), region: row.region || null, status: row.status || null, accountId: Number(row.account_id) }));
}

async function loadOfficialAdsDailyRows({ accountId, from, to }) {
  const ranges = chunkIsoDateRange(from, to);
  if (!ranges.length) return { available: false, rows: [], errors: ["Periodo oficial Ads invalido."] };
  const shops = await loadConnectedAdsShopsForAccount(accountId);
  if (!shops.length) return { available: false, rows: [], errors: ["Nenhuma loja da conta possui token Ads conectado."] };
  const rows = [];
  const errors = [];
  for (const shop of shops) {
    for (const range of ranges) {
      try {
        const raw = await callAdsWithAutoRefresh({
          shop,
          call: (accessToken) => ShopeeAdsService.get_all_cpc_ads_daily_performance({
            accessToken,
            shopId: shop.shopId,
            startDate: toShopeeDate(range.from),
            endDate: toShopeeDate(range.to),
          }),
        });
        const responseRows = Array.isArray(raw?.response) ? raw.response : [];
        responseRows.forEach((row) => rows.push({ ...row, shopDbId: shop.id, shopId: String(shop.shopId || "") }));
      } catch (error) {
        errors.push(`Loja ${String(shop.shopId || shop.id)} ${range.from}..${range.to}: ${error?.message || String(error)}`);
      }
    }
  }
  return { available: rows.length > 0, rows, errors, shopsCount: shops.length };
}

async function loadAdsAnalysisData({ accountId, periodTo }) {
  const to = isoDateOnly(periodTo);
  const from = addDaysIso(to, -89);
  const params = [Number(accountId), from, to, EXCLUDED_ORDER_STATUSES];
  try {
    const totalsRow = await queryOne(`SELECT COALESCE(SUM(ah.expense), 0)::bigint AS spend, COALESCE(SUM(ah."broadGmv"), 0)::bigint AS broad_gmv, COALESCE(SUM(ah."directGmv"), 0)::bigint AS direct_gmv, COALESCE(SUM(ah."broadSold"), 0)::bigint AS broad_sold, COALESCE(SUM(ah."directSold"), 0)::bigint AS direct_sold, COALESCE(SUM(ah.impression), 0)::bigint AS impressions, COALESCE(SUM(ah.click), 0)::bigint AS clicks FROM "AdsHourlyMetric" ah INNER JOIN "Shop" s ON s.id = ah."shopId" WHERE s."accountId" = $1 AND ah.type = 'CPC' AND ah.date >= $2::date AND ah.date <= $3::date`, params.slice(0, 3));
    const productResult = await query(`SELECT ah."shopId" AS shop_id, ah."itemId" AS item_id, COALESCE(MAX(NULLIF(p.title, '')), 'Anuncio ' || ah."itemId"::text) AS title, MAX(NULLIF(p."itemSku", '')) AS sku, MAX(p.status) AS status, MAX(p.stock) AS stock, COALESCE(SUM(ah.expense), 0)::bigint AS spend, COALESCE(SUM(ah."broadGmv"), 0)::bigint AS broad_gmv, COALESCE(SUM(ah."directGmv"), 0)::bigint AS direct_gmv, COALESCE(SUM(ah."broadSold"), 0)::bigint AS broad_sold, COALESCE(SUM(ah."directSold"), 0)::bigint AS direct_sold, COALESCE(SUM(ah.impression), 0)::bigint AS impressions, COALESCE(SUM(ah.click), 0)::bigint AS clicks FROM "AdsHourlyMetric" ah INNER JOIN "Shop" s ON s.id = ah."shopId" LEFT JOIN "Product" p ON p."shopId" = ah."shopId" AND p."itemId" = ah."itemId" WHERE s."accountId" = $1 AND ah.type = 'CPC' AND ah."itemId" IS NOT NULL AND ah.date >= $2::date AND ah.date <= $3::date GROUP BY ah."shopId", ah."itemId" ORDER BY spend DESC`, params.slice(0, 3));
    const monthlyResult = await query(`SELECT TO_CHAR(DATE_TRUNC('month', ah.date::timestamp), 'YYYY-MM') AS month, COALESCE(SUM(ah.expense), 0)::bigint AS spend, COALESCE(SUM(ah."broadGmv"), 0)::bigint AS broad_gmv, COALESCE(SUM(ah."directGmv"), 0)::bigint AS direct_gmv, COALESCE(SUM(ah."broadSold"), 0)::bigint AS broad_sold, COALESCE(SUM(ah."directSold"), 0)::bigint AS direct_sold, COALESCE(SUM(ah.impression), 0)::bigint AS impressions, COALESCE(SUM(ah.click), 0)::bigint AS clicks FROM "AdsHourlyMetric" ah INNER JOIN "Shop" s ON s.id = ah."shopId" WHERE s."accountId" = $1 AND ah.type = 'CPC' AND ah.date >= $2::date AND ah.date <= $3::date GROUP BY DATE_TRUNC('month', ah.date::timestamp) ORDER BY month ASC`, params.slice(0, 3));
    const official = await loadOfficialAdsDailyRows({ accountId, from, to }).catch((error) => ({ available: false, rows: [], errors: [error?.message || String(error)] }));
    const officialTotals = official.available ? summarizeOfficialAdsRows(official.rows) : null;
    let attribution = { orders: 0, revenueCents: 0 };
    try {
      const attrRow = await queryOne(`SELECT COUNT(DISTINCT o.id)::int AS orders, COALESCE(SUM(COALESCE(NULLIF(o."gmvCents"::text, '')::numeric, 0)), 0)::bigint AS revenue FROM "Order" o INNER JOIN "Shop" s ON s.id = o."shopId" INNER JOIN "OrderAdsAttribution" a ON a."orderId" = o.id WHERE s."accountId" = $1 AND a."adsType" = 'CPC' AND a."createdAt" >= $2::date AND a."createdAt" < ($3::date + INTERVAL '1 day') AND COALESCE(o."orderStatus", '') <> ALL($4::text[])`, params);
      attribution = { orders: Number(attrRow?.orders || 0), revenueCents: cents(attrRow?.revenue || 0) };
    } catch (_error) {
      attribution = { orders: 0, revenueCents: 0, unavailable: true };
    }
    return { from, to, totalsRow, productRows: productResult.rows, monthlyRows: monthlyResult.rows, attribution, official, officialTotals };
  } catch (error) {
    if (error?.code === "42P01") return { from, to, missing: true, error: "Tabela AdsHourlyMetric ou tabelas relacionadas ainda nao existem." };
    throw error;
  }
}

function normalizeAdsAggregate(row, attribution = null) {
  const spendCents = cents(row?.spend || 0);
  const broadGmv = cents(row?.broad_gmv || 0);
  const directGmv = cents(row?.direct_gmv || 0);
  const revenueCents = broadGmv > 0 ? broadGmv : directGmv;
  const effectiveRevenueCents = attribution?.revenueCents > 0 ? Math.max(revenueCents, attribution.revenueCents) : revenueCents;
  const attributedItemsSold = Math.max(toNumber(row?.broad_sold, 0), toNumber(row?.direct_sold, 0));
  const impressions = toNumber(row?.impressions, 0);
  const clicks = toNumber(row?.clicks, 0);
  const attributedOrders = attribution?.orders != null ? Number(attribution.orders || 0) : 0;
  return { spendCents, revenueCents: effectiveRevenueCents, attributedOrders, attributedItemsSold, impressions, clicks, roas: spendCents > 0 ? Number((effectiveRevenueCents / spendCents).toFixed(4)) : null, acosPct: effectiveRevenueCents > 0 ? Number(((spendCents / effectiveRevenueCents) * 100).toFixed(2)) : null, avgCpcCents: clicks > 0 ? Math.round(spendCents / clicks) : 0, ctrPct: ratioPct(clicks, impressions), conversionPct: ratioPct(attributedOrders || attributedItemsSold, clicks), costPerOrderCents: (attributedOrders || attributedItemsSold) > 0 ? Math.round(spendCents / (attributedOrders || attributedItemsSold)) : 0, adsTicketCents: (attributedOrders || attributedItemsSold) > 0 ? Math.round(effectiveRevenueCents / (attributedOrders || attributedItemsSold)) : 0 };
}

function normalizeAdsProduct(row) {
  const base = normalizeAdsAggregate(row);
  const roas = base.spendCents > 0 ? base.revenueCents / base.spendCents : null;
  const wasteScoreCents = base.revenueCents <= 0 ? base.spendCents : Math.max(0, Math.round(base.spendCents - base.revenueCents * 0.18));
  let actionHint = "Manter monitoramento.";
  if (base.spendCents > 0 && base.revenueCents <= 0) actionHint = "Pausar/revisar termos, criativo e competitividade antes de escalar.";
  else if (roas != null && roas < 2) actionHint = "Reduzir lance e revisar margem/conversao.";
  else if (roas != null && roas >= 5) actionHint = "Escalar com limite e proteger estoque.";
  return { ...base, shopId: Number(row?.shop_id || 0), itemId: row?.item_id == null ? null : String(row.item_id), sku: row?.sku || null, title: row?.title || "Anuncio sem titulo", status: row?.status || null, stock: row?.stock == null ? null : Number(row.stock), wasteScoreCents, actionHint };
}

function rankAdsRows(rows, metric, direction = "desc") {
  return [...rows].filter((row) => toNumber(row[metric], 0) > 0).sort((a, b) => direction === "asc" ? toNumber(a[metric], 0) - toNumber(b[metric], 0) : toNumber(b[metric], 0) - toNumber(a[metric], 0)).map((row, index) => ({ ...row, rank: index + 1 }));
}

function buildAdsRecommendations(analysis, adsRows) {
  const adsByItem = new Map(adsRows.map((row) => [String(row.itemId), row]));
  return analysis.rankRevenue.filter((row) => row.itemId && row.revenueCents > 0).filter((row) => {
    const ads = adsByItem.get(String(row.itemId));
    return !ads || ads.spendCents <= 0 || (ads.roas != null && ads.roas >= 5 && row.revenueCentsAbc === "A");
  }).slice(0, 20).map((row) => {
    const ads = adsByItem.get(String(row.itemId));
    const priority = row.revenueCentsAbc === "A" ? "ALTA" : row.revenueCentsAbc === "B" ? "MEDIA" : "TESTE";
    const strategy = ads?.spendCents > 0 ? "Campanha defensiva com lances controlados para proteger produto que ja performa." : "Adicionar em Ads CPC com teste de descoberta e limite diario baixo.";
    const budgetCents = Math.round(Math.min(Math.max(row.revenueCents * 0.02, 500), 5000));
    return { priority, itemId: row.itemId, sku: row.sku || "-", title: row.title, reason: `${row.revenueCentsAbc || "C"} por faturamento, ${formatBRL(row.revenueCents)} vendidos e tendencia ${row.trend}.`, strategy, initialBudgetSuggestion: `Sugestao calculada por regra interna: ate ${formatBRL(budgetCents)} para teste inicial, validar ROAS antes de escalar.`, objective: row.revenueCentsAbc === "A" ? "Defender faturamento e share do item." : "Validar potencial incremental com baixo risco.", risk: row.stock != null && Number(row.stock) <= 3 ? "Risco de estoque baixo antes de escalar." : "Monitorar ACOS e margem antes de aumentar investimento." };
  });
}

function buildAdsInsights(ads) {
  if (!ads.available) return ads.insights || [];
  const insights = [];
  insights.push(`Ads CPC nos ultimos 3 meses investiu ${formatBRL(ads.kpis.spendCents)} e atribuiu ${formatBRL(ads.kpis.revenueCents)} em receita, com ROAS ${formatMetricNumber(ads.kpis.roas)} e ACOS ${formatMetricNumber(ads.kpis.acosPct)}%.`);
  if (ads.rankings.efficiency[0]) insights.push(`Melhor eficiencia: ${ads.rankings.efficiency[0].title} com ROAS ${formatMetricNumber(ads.rankings.efficiency[0].roas)}.`);
  if (ads.rankings.waste[0]) insights.push(`Maior ponto de desperdicio: ${ads.rankings.waste[0].title}, com ${formatBRL(ads.rankings.waste[0].wasteScoreCents)} em gasto/risco sem retorno proporcional.`);
  if (ads.recommendations.length) insights.push(`${ads.recommendations.length} produto(s) aparecem como candidatos para Ads com base em vendas reais e baixa/nenhuma cobertura de Ads.`);
  if (ads.dataGaps.length) insights.push(`Limitacoes Ads: ${ads.dataGaps.join(" ")}`);
  return insights;
}

async function buildAdsAnalysis({ accountId, periodTo, commercialAnalysis }) {
  const raw = await loadAdsAnalysisData({ accountId, periodTo });
  if (raw.missing) return emptyAdsAnalysis(periodTo, raw.error);
  const hasOfficial = Boolean(raw.official?.available && raw.officialTotals);
  const kpis = normalizeAdsAggregate(hasOfficial ? raw.officialTotals : raw.totalsRow, raw.attribution);
  const rows = raw.productRows.map(normalizeAdsProduct);
  const monthly = hasOfficial
    ? buildOfficialAdsMonthlyRows(raw.official.rows).map((row) => ({ month: row.month, ...normalizeAdsAggregate(row) }))
    : raw.monthlyRows.map((row) => ({ month: row.month, ...normalizeAdsAggregate(row) }));
  const dataGaps = [];
  if (hasOfficial) dataGaps.push("KPIs e mes a mes de Ads usam a performance diaria oficial da Shopee; rankings por produto usam o cache local quando disponivel.");
  if (!hasOfficial && Array.isArray(raw.official?.errors) && raw.official.errors.length) dataGaps.push(`Performance diaria oficial indisponivel: ${raw.official.errors.slice(0, 3).join(" | ")}`);
  if (!rows.length && kpis.spendCents <= 0 && kpis.revenueCents <= 0) dataGaps.push("Nao ha metricas AdsHourlyMetric CPC no periodo analisado.");
  if (!rows.length && (kpis.spendCents > 0 || kpis.revenueCents > 0)) dataGaps.push("Nao ha cache local por produto no periodo; o relatorio trouxe os KPIs oficiais, mas os rankings por anuncio ficam vazios ate o snapshot local cobrir o periodo.");
  dataGaps.push("A base local de Ads nao possui nome de campanha; rankings de Ads foram gerados por produto/anuncio anunciado.");
  if (raw.attribution?.unavailable || !raw.attribution?.orders) dataGaps.push("Pedidos por Ads dependem da tabela OrderAdsAttribution; quando nao ha correspondencia local, o relatorio usa itens vendidos de Ads como apoio.");
  const rankings = { revenue: rankAdsRows(rows, "revenueCents"), spend: rankAdsRows(rows, "spendCents"), efficiency: rankAdsRows(rows.filter((row) => row.spendCents > 0 && row.revenueCents > 0), "roas"), waste: rankAdsRows(rows, "wasteScoreCents") };
  const ads = { available: rows.length > 0 || kpis.spendCents > 0 || kpis.revenueCents > 0, period: { from: raw.from, to: raw.to, days: 90 }, dataGaps, kpis, monthly, rankings, recommendations: buildAdsRecommendations(commercialAnalysis, rows), insights: [], nextSteps: [] };
  ads.insights = buildAdsInsights(ads);
  ads.nextSteps = ads.available ? ["Pausar ou revisar anuncios com gasto e receita zero antes de aumentar verba.", "Escalar gradualmente anuncios com ROAS alto e estoque seguro.", "Adicionar candidatos priorizados em campanhas CPC com limite baixo e revisao em 7 dias.", "Conferir dados de atribuicao antes de tomar decisao baseada apenas em pedidos Ads."] : ["Sincronizar Ads CPC e gerar novamente o relatorio.", "Conferir conexao do app de Ads nas lojas da conta.", "Nao criar recomendacoes de investimento sem dados reais de Ads."];
  return ads;
}

function mergeAdsIntoInsights(analysis) {
  if (!analysis.ads) return analysis.insights;
  return { ...analysis.insights, alerts: [...analysis.insights.alerts, ...(analysis.ads.available ? analysis.ads.insights.slice(1, 3) : analysis.ads.dataGaps).slice(0, 3)].slice(0, 8), opportunities: [...analysis.insights.opportunities, ...analysis.ads.recommendations.slice(0, 3).map((item) => `Ads: ${item.priority} - ${item.title}: ${item.strategy}`)].slice(0, 8), nextSteps: [...analysis.insights.nextSteps, ...analysis.ads.nextSteps].slice(0, 10), raw: [...analysis.insights.raw, ...analysis.ads.insights] };
}

function buildLegacyXlsx(analysis, filePath) { const wb = XLSX.utils.book_new();
  aoaSheet(wb, "Capa", [["Relatorio de Performance da Conta"], ["Empresa", analysis.account.name], ["CNPJ/Documento", `${analysis.account.documentType || "-"} ${analysis.account.documentNumber || ""}`.trim()], ["Periodo", `${formatDate(analysis.period.from)} ate ${formatDate(analysis.period.to)}`], ["Comparativo", excelPeriodComparedText(analysis)], ["Gerado em", formatDateTime(analysis.generatedAt)], ["Retencao", REPORT_RETENTION_NOTICE], ["Lojas analisadas", analysis.shops.length]], [42, 120]);
  aoaSheet(wb, "Resumo Executivo", [["Indicador", "Valor"], ["Faturamento total", moneyCell(analysis.kpis.revenueCents)], ["Pedidos", analysis.kpis.ordersCount], ["Ticket medio", moneyCell(analysis.kpis.averageTicketCents)], ["Anuncios com vendas", analysis.kpis.soldProductsCount], ["Anuncios sem vendas", analysis.kpis.productsWithoutSalesCount], ["Resumo inteligente", analysis.insights.executiveSummary], ["Alertas", analysis.insights.alerts.join(" | ")], ["Oportunidades", analysis.insights.opportunities.join(" | ")]], [32, 95]);
  const header = ["Posicao", "ID Anuncio", "SKU", "Titulo", "Qtd", "Faturamento", "Ticket medio", "Participacao %", "ABC", "Tendencia", "Delta faturamento"];
  aoaSheet(wb, "Ranking por Faturamento", [header, ...productRows(analysis.rankRevenue, "revenue")], [10, 18, 20, 58, 10, 16, 16, 16, 10, 16, 18]); aoaSheet(wb, "Ranking por Quantidade", [header, ...productRows(analysis.rankQuantity, "quantity")], [10, 18, 20, 58, 10, 16, 16, 16, 10, 16, 18]);
  aoaSheet(wb, "Curva ABC Faturamento", [["Curva", "Produtos", "Faturamento", "Participacao %", "Qtd vendida", "Top produtos"], ...analysis.curveRevenue.map((row) => [row.curve, row.products, moneyCell(row.revenueCents), Number(row.sharePct.toFixed(2)), row.quantity, row.topProducts.map((p) => p.title).join(" | ")])], [10, 12, 18, 16, 14, 100]);
  aoaSheet(wb, "Curva ABC Quantidade", [["Curva", "Produtos", "Qtd vendida", "Participacao %", "Faturamento", "Top produtos"], ...analysis.curveQuantity.map((row) => [row.curve, row.products, row.quantity, Number(row.sharePct.toFixed(2)), moneyCell(row.revenueCents), row.topProducts.map((p) => p.title).join(" | ")])], [10, 12, 14, 16, 18, 100]);
  aoaSheet(wb, "Seguranca Curva A", [["Tema", "Analise"], ["Concentracao Top 5", formatPercent(analysis.curveASecurity.concentrationTop5Pct)], ["Curva A em queda", analysis.curveASecurity.fallingA.map((p) => p.title).join(" | ") || "Sem alertas"], ["Curva A com estoque baixo", analysis.curveASecurity.lowStockA.map((p) => `${p.title} (${p.stock})`).join(" | ") || "Sem alertas"], ["Recomendacoes", analysis.curveASecurity.recommendations.join(" | ")]], [28, 110]);
  aoaSheet(wb, "Crescimento e Queda", [["Tipo", "ID", "Titulo", "Delta faturamento", "Delta qtd", "Tendencia"], ...analysis.growth.slice(0, 20).map((p) => ["Crescimento", p.itemId || "-", p.title, moneyCell(p.revenueDeltaCents), p.quantityDelta, p.trend]), ...analysis.decline.slice(0, 20).map((p) => ["Queda", p.itemId || "-", p.title, moneyCell(p.revenueDeltaCents), p.quantityDelta, p.trend])], [16, 18, 70, 18, 14, 16]);
  for (const top of [5, 10, 20]) { const rev = analysis.movements.revenue.find((m) => m.topN === top); const qty = analysis.movements.quantity.find((m) => m.topN === top); aoaSheet(wb, `Top ${top}`, [["Metrica", "Movimento", "ID", "Titulo", "Posicao atual", "Posicao anterior", "Valor atual", "Valor anterior", "Leitura"], ...movementRows(rev, "Faturamento"), ...movementRows(qty, "Quantidade")], [16, 26, 18, 70, 16, 18, 16, 16, 80]); }
  aoaSheet(wb, "Movimentacao Completa", [["Data", "Faturamento", "Pedidos", "Ticket medio"], ...analysis.daily.map((row) => [row.date, moneyCell(row.revenueCents), row.orders, moneyCell(row.averageTicketCents)])], [16, 18, 12, 18]);
  aoaSheet(wb, "Controle de Metas", [["Indicador", "Valor"], ["Meta utilizada", analysis.goals.targetLabel || "-"], ["Meta de faturamento", analysis.goals.targetCents ? moneyCell(analysis.goals.targetCents) : "Sem meta cadastrada"], ["Realizado", moneyCell(analysis.goals.realizedCents)], ["Percentual atingido", analysis.goals.achievedPct == null ? "-" : Number(analysis.goals.achievedPct.toFixed(2))], ["Diferenca para meta", analysis.goals.missingCents == null ? "-" : moneyCell(analysis.goals.missingCents)], ["Projecao", moneyCell(analysis.goals.projectionCents)], ["Dias projetados", analysis.goals.projectionDays || "-"], ["Status", analysis.goals.status], ["Observacao", analysis.goals.note]], [30, 70]);
  const ads = analysis.ads || emptyAdsAnalysis(analysis.period.to);
  aoaSheet(wb, "Ads Resumo 3 Meses", [["Indicador", "Valor"], ["Periodo Ads", `${ads.period.from} ate ${ads.period.to}`], ["Investimento Ads", moneyCell(ads.kpis.spendCents)], ["Receita atribuida Ads", moneyCell(ads.kpis.revenueCents)], ["Pedidos atribuidos Ads", ads.kpis.attributedOrders], ["Itens vendidos Ads", ads.kpis.attributedItemsSold], ["ROAS", ads.kpis.roas == null ? "-" : Number(ads.kpis.roas.toFixed(2))], ["ACOS %", ads.kpis.acosPct == null ? "-" : Number(ads.kpis.acosPct.toFixed(2))], ["CPC medio", moneyCell(ads.kpis.avgCpcCents)], ["CTR %", ads.kpis.ctrPct == null ? "-" : Number(ads.kpis.ctrPct.toFixed(2))], ["Conversao %", ads.kpis.conversionPct == null ? "-" : Number(ads.kpis.conversionPct.toFixed(2))], ["Custo por pedido/item", moneyCell(ads.kpis.costPerOrderCents)], ["Ticket Ads", moneyCell(ads.kpis.adsTicketCents)], ["Limitacoes", ads.dataGaps.join(" | ") || "-"]], [34, 120]);
  aoaSheet(wb, "Ads Mes a Mes", [["Mes", "Investimento", "Receita Ads", "ROAS", "ACOS %", "Pedidos", "Itens", "Impressoes", "Cliques", "CTR %", "CPC medio"], ...ads.monthly.map((row) => [row.month, moneyCell(row.spendCents), moneyCell(row.revenueCents), row.roas == null ? "-" : Number(row.roas.toFixed(2)), row.acosPct == null ? "-" : Number(row.acosPct.toFixed(2)), row.attributedOrders, row.attributedItemsSold, row.impressions, row.clicks, row.ctrPct == null ? "-" : Number(row.ctrPct.toFixed(2)), moneyCell(row.avgCpcCents)])], [14, 16, 16, 10, 10, 10, 10, 14, 12, 10, 14]);
  const adsHeader = ["Rank", "ID Anuncio", "Produto", "Receita Ads", "Investimento", "ROAS", "ACOS %", "Impressoes", "Cliques", "CTR %", "Itens", "Custo pedido/item", "Desperdicio estimado", "Acao sugerida"];
  aoaSheet(wb, "Ads Ranking Receita", [adsHeader, ...ads.rankings.revenue.slice(0, 100).map(adsMetricRow)], [8, 18, 70, 16, 16, 10, 10, 14, 12, 10, 10, 18, 18, 60]);
  aoaSheet(wb, "Ads Ranking Investimento", [adsHeader, ...ads.rankings.spend.slice(0, 100).map(adsMetricRow)], [8, 18, 70, 16, 16, 10, 10, 14, 12, 10, 10, 18, 18, 60]);
  aoaSheet(wb, "Ads Eficiencia", [adsHeader, ...ads.rankings.efficiency.slice(0, 100).map(adsMetricRow)], [8, 18, 70, 16, 16, 10, 10, 14, 12, 10, 10, 18, 18, 60]);
  aoaSheet(wb, "Ads Desperdicio", [adsHeader, ...ads.rankings.waste.slice(0, 100).map(adsMetricRow)], [8, 18, 70, 16, 16, 10, 10, 14, 12, 10, 10, 18, 18, 60]);
  aoaSheet(wb, "Ads Produtos Sugeridos", [["Prioridade", "ID", "SKU", "Produto", "Motivo", "Estrategia", "Orcamento inicial", "Objetivo", "Risco"], ...ads.recommendations.map((row) => [row.priority, row.itemId, row.sku, row.title, row.reason, row.strategy, row.initialBudgetSuggestion, row.objective, row.risk])], [14, 18, 18, 70, 80, 80, 55, 55, 55]);
  aoaSheet(wb, "Ads Proximos Passos", [["Tipo", "Recomendacao"], ...ads.insights.map((text) => ["Insight", text]), ...ads.nextSteps.map((text) => ["Proximo passo", text]), ...ads.dataGaps.map((text) => ["Limitacao", text])], [22, 120]);
  aoaSheet(wb, "Insights IA", [["Tipo", "Insight"], ["Resumo executivo", analysis.insights.executiveSummary], ...analysis.insights.alerts.map((text) => ["Alerta", text]), ...analysis.insights.opportunities.map((text) => ["Oportunidade", text]), ...analysis.insights.nextSteps.map((text) => ["Proximo passo", text]), ...analysis.validationWarnings.map((text) => ["Limitacao", text])], [22, 110]);
  aoaSheet(wb, "Dados Base", [["ID", "SKU", "Titulo", "Qtd", "Faturamento", "Ticket", "ABC Faturamento", "ABC Qtd", "Tendencia", "Estoque", "Status"], ...analysis.rankRevenue.map((p) => [p.itemId || "-", p.sku || "-", p.title, p.quantity, moneyCell(p.revenueCents), moneyCell(p.averageTicketCents), p.revenueCentsAbc, p.quantityAbc, p.trend, p.stock ?? "-", p.status || "-"])], [18, 20, 70, 12, 18, 16, 16, 12, 16, 12, 14]);
  XLSX.writeFile(wb, filePath, { bookType: "xlsx" });
}

function excelPeriodComparedText(analysis) {
  if (analysis?.period?.compareFrom && analysis?.period?.compareTo) {
    return `Período analisado: ${formatDate(analysis.period.from)} até ${formatDate(analysis.period.to)} | Comparativo: mês anterior ${formatDate(analysis.period.compareFrom)} até ${formatDate(analysis.period.compareTo)}`;
  }
  const currentFrom = formatDate(analysis.period.currentStart || analysis.period.from);
  const currentTo = formatDate(analysis.period.to);
  const previousFrom = formatDate(analysis.period.from);
  const previousTo = formatDate(analysis.period.currentStart || analysis.period.to);
  return `Período analisado: ${formatDate(analysis.period.from)} até ${formatDate(analysis.period.to)} | Comparativo: ${previousFrom} até ${previousTo} vs ${currentFrom} até ${currentTo}`;
}

function excelSafeSheetName(name) {
  return String(name || "Aba").replace(/[\\/?*\[\]:]/g, " ").slice(0, 31);
}

function excelColumnLetter(index) {
  let n = Number(index || 1);
  let out = "";
  while (n > 0) {
    const mod = (n - 1) % 26;
    out = String.fromCharCode(65 + mod) + out;
    n = Math.floor((n - mod) / 26);
  }
  return out;
}

function visualBar(value, max, size = 18) {
  const width = max > 0 ? Math.max(1, Math.round((Number(value || 0) / max) * size)) : 0;
  return `${"█".repeat(width)}${"░".repeat(Math.max(0, size - width))}`;
}

function productStyledRows(rows, metricType = "revenue") {
  return rows.map((row) => [
    row.rank,
    row.itemId || "-",
    row.sku || "-",
    row.title,
    Number(row.quantity || 0),
    moneyCell(row.revenueCents),
    moneyCell(row.previousRevenueCents),
    moneyCell(row.currentRevenueCents),
    moneyCell(row.revenueDeltaCents),
    moneyCell(row.averageTicketCents),
    Number((metricType === "quantity" ? row.quantitySharePct : row.revenueCentsSharePct || 0).toFixed(2)),
    metricType === "quantity" ? row.quantityAbc : row.revenueCentsAbc,
    row.trend,
    row.stock ?? "-",
    row.status || "-",
  ]);
}

function abcDetailRows(rows, metricType = "revenue") {
  return ["A", "B", "C"].flatMap((curve) =>
    rows
      .filter((row) => (metricType === "quantity" ? row.quantityAbc : row.revenueCentsAbc) === curve)
      .map((row) => [
        curve,
        row.rank,
        row.itemId || "-",
        row.sku || "-",
        row.title,
        Number(row.quantity || 0),
        moneyCell(row.revenueCents),
        metricType === "quantity" ? Number((row.quantitySharePct || 0).toFixed(2)) : Number((row.revenueCentsSharePct || 0).toFixed(2)),
        metricType === "quantity" ? Number((row.quantityCumulativePct || 0).toFixed(2)) : Number((row.revenueCentsCumulativePct || 0).toFixed(2)),
        moneyCell(row.previousRevenueCents),
        moneyCell(row.currentRevenueCents),
        moneyCell(row.revenueDeltaCents),
        row.trend,
      ]),
  );
}

function applyWorksheetShell(ws, analysis, title, columnCount, widths = []) {
  ws.properties.defaultRowHeight = 20;
  ws.views = [{ state: "frozen", ySplit: 4 }];
  ws.mergeCells(1, 1, 1, Math.max(6, columnCount));
  ws.mergeCells(2, 1, 2, Math.max(6, columnCount));
  ws.mergeCells(3, 1, 3, Math.max(6, columnCount));
  ws.getCell(1, 1).value = `DACHBYTE SELLER | ${analysis.account.name || "Empresa"}`;
  ws.getCell(2, 1).value = title;
  ws.getCell(3, 1).value = excelPeriodComparedText(analysis);
  [1, 2, 3].forEach((rowNumber) => {
    const row = ws.getRow(rowNumber);
    row.height = rowNumber === 1 ? 28 : 22;
    row.getCell(1).font = { bold: true, color: { argb: rowNumber === 1 ? "FFFFFFFF" : "FF172033" }, size: rowNumber === 1 ? 15 : 11 };
    row.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: rowNumber === 1 ? "FF0F172A" : rowNumber === 2 ? "FFEFF6FF" : "FFF8FAFC" } };
    row.getCell(1).alignment = { vertical: "middle", horizontal: "left" };
  });
  ws.columns = Array.from({ length: columnCount }, (_, index) => ({ width: widths[index] || 16 }));
}

function styleTableRange(ws, headerRowNumber, rowCount, columnCount) {
  const header = ws.getRow(headerRowNumber);
  header.height = 26;
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E3A8A" } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = { top: { style: "thin", color: { argb: "FFCBD5E1" } }, left: { style: "thin", color: { argb: "FFCBD5E1" } }, bottom: { style: "thin", color: { argb: "FFCBD5E1" } }, right: { style: "thin", color: { argb: "FFCBD5E1" } } };
  });
  for (let r = headerRowNumber + 1; r < headerRowNumber + rowCount; r += 1) {
    const row = ws.getRow(r);
    row.height = 24;
    row.eachCell((cell, colNumber) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: r % 2 === 0 ? "FFFFFFFF" : "FFF8FAFC" } };
      cell.border = { bottom: { style: "thin", color: { argb: "FFE2E8F0" } } };
      cell.alignment = { vertical: "middle", horizontal: colNumber <= 4 ? "left" : "center", wrapText: colNumber === 3 || colNumber === 4 || colNumber > 12 };
      const headerText = String(ws.getCell(headerRowNumber, colNumber).value || "").toLowerCase();
      if (headerText.includes("faturamento") || headerText.includes("ticket") || headerText.includes("receita") || headerText.includes("investimento") || headerText.includes("delta") || headerText.includes("custo") || headerText.includes("desperdício") || headerText.includes("orçamento")) {
        cell.numFmt = '"R$" #,##0.00;[Red]-"R$" #,##0.00';
      } else if (headerText.includes("%") || headerText.includes("participação") || headerText.includes("acos") || headerText.includes("ctr") || headerText.includes("conversão")) {
        cell.numFmt = '0.00';
      }
    });
  }
  if (rowCount > 1 && columnCount > 1) {
    ws.autoFilter = { from: { row: headerRowNumber, column: 1 }, to: { row: headerRowNumber + rowCount - 1, column: columnCount } };
  }
}

function addStyledSheet(wb, analysis, name, headers, rows, widths = [], options = {}) {
  const ws = wb.addWorksheet(excelSafeSheetName(name));
  const columnCount = Math.max(headers.length, widths.length, 6);
  applyWorksheetShell(ws, analysis, name, columnCount, widths);
  const headerRowNumber = 4;
  ws.getRow(headerRowNumber).values = headers;
  rows.forEach((row) => ws.addRow(row));
  styleTableRange(ws, headerRowNumber, rows.length + 1, headers.length);
  if (options.note) {
    const noteRow = ws.getRow(rows.length + 6);
    noteRow.getCell(1).value = options.note;
    noteRow.getCell(1).font = { italic: true, color: { argb: "FF475569" } };
  }
  if (options.comparisonRows?.length) addComparisonPanel(ws, headerRowNumber, headers.length + 2, options.comparisonTitle || "Comparativo com período anterior", options.comparisonRows);
  if (options.curveSummary?.length) addCurvePanel(ws, headerRowNumber, headers.length + 2, options.curveSummary);
  return ws;
}

function addComparisonPanel(ws, startRow, startCol, title, rows) {
  const max = Math.max(1, ...rows.map((row) => Math.max(Number(row.current || 0), Number(row.previous || 0))));
  ws.getCell(startRow, startCol).value = title;
  ws.getCell(startRow, startCol).font = { bold: true, color: { argb: "FF0F172A" }, size: 11 };
  [["Produto", "Anterior", "Atual", "Gráfico"]].forEach((row, index) => {
    const r = ws.getRow(startRow + 1 + index);
    row.forEach((value, offset) => {
      const cell = r.getCell(startCol + offset);
      cell.value = value;
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF334155" } };
    });
  });
  rows.slice(0, 10).forEach((item, index) => {
    const r = ws.getRow(startRow + 2 + index);
    r.getCell(startCol).value = item.label;
    r.getCell(startCol + 1).value = moneyCell(item.previous);
    r.getCell(startCol + 2).value = moneyCell(item.current);
    r.getCell(startCol + 3).value = `Ant ${visualBar(item.previous, max, 10)}  Atual ${visualBar(item.current, max, 10)}`;
    r.getCell(startCol + 1).numFmt = '"R$" #,##0.00';
    r.getCell(startCol + 2).numFmt = '"R$" #,##0.00';
    r.getCell(startCol + 3).font = { color: { argb: "FF2563EB" } };
  });
  [startCol, startCol + 1, startCol + 2, startCol + 3].forEach((col) => {
    ws.getColumn(col).width = col === startCol ? 28 : col === startCol + 3 ? 36 : 14;
  });
}

function addCurvePanel(ws, startRow, startCol, summary) {
  const max = Math.max(1, ...summary.map((row) => Number(row.sharePct || 0)));
  ws.getCell(startRow, startCol).value = "Gráfico geral de concentração por curva";
  ws.getCell(startRow, startCol).font = { bold: true, color: { argb: "FF0F172A" }, size: 11 };
  [["Curva", "Produtos", "Participação", "Concentração"]].forEach((row, index) => {
    const r = ws.getRow(startRow + 1 + index);
    row.forEach((value, offset) => {
      const cell = r.getCell(startCol + offset);
      cell.value = value;
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF334155" } };
    });
  });
  summary.forEach((item, index) => {
    const r = ws.getRow(startRow + 2 + index);
    r.getCell(startCol).value = item.curve;
    r.getCell(startCol + 1).value = item.products;
    r.getCell(startCol + 2).value = Number((item.sharePct || 0).toFixed(2));
    r.getCell(startCol + 3).value = visualBar(item.sharePct, max, 24);
    r.getCell(startCol + 3).font = { color: { argb: item.curve === "A" ? "FF2563EB" : item.curve === "B" ? "FF0F766E" : "FFF97316" } };
  });
  [startCol, startCol + 1, startCol + 2, startCol + 3].forEach((col) => {
    ws.getColumn(col).width = col === startCol + 3 ? 34 : 14;
  });
}

async function buildStyledXlsx(analysis, filePath) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "DACHBYTE Seller";
  wb.created = new Date();
  wb.modified = new Date();
  wb.properties.date1904 = false;
  const commonProductHeader = ["Posição", "ID Anúncio", "SKU", "Título", "Qtd", "Faturamento", "Faturamento período anterior", "Faturamento período atual", "Delta faturamento", "Ticket médio", "Participação %", "ABC", "Tendência", "Estoque", "Status"];
  const commonWidths = [10, 18, 18, 62, 10, 16, 20, 20, 18, 16, 16, 10, 14, 12, 14];
  addStyledSheet(wb, analysis, "Capa", ["Campo", "Informação"], [["Empresa", analysis.account.name], ["Documento", `${analysis.account.documentType || "-"} ${analysis.account.documentNumber || ""}`.trim()], ["Período", `${formatDate(analysis.period.from)} até ${formatDate(analysis.period.to)}`], ["Comparativo", excelPeriodComparedText(analysis)], ["Gerado em", formatDateTime(analysis.generatedAt)], ["Retenção", REPORT_RETENTION_NOTICE], ["Lojas analisadas", analysis.shops.length]], [28, 120]);
  addStyledSheet(wb, analysis, "Resumo Executivo", ["Indicador", "Valor"], [["Faturamento total", moneyCell(analysis.kpis.revenueCents)], ["Pedidos", analysis.kpis.ordersCount], ["Ticket médio", moneyCell(analysis.kpis.averageTicketCents)], ["Anúncios com vendas", analysis.kpis.soldProductsCount], ["Anúncios sem vendas", analysis.kpis.productsWithoutSalesCount], ["Resumo inteligente", analysis.insights.executiveSummary], ["Alertas", analysis.insights.alerts.join(" | ")], ["Oportunidades", analysis.insights.opportunities.join(" | ")]], [32, 120], { comparisonRows: analysis.rankRevenue.slice(0, 10).map((p) => ({ label: p.title, previous: p.previousRevenueCents, current: p.currentRevenueCents })) });
  addStyledSheet(wb, analysis, "Ranking por Faturamento", commonProductHeader, productStyledRows(analysis.rankRevenue, "revenue"), commonWidths, { comparisonRows: analysis.rankRevenue.slice(0, 10).map((p) => ({ label: p.title, previous: p.previousRevenueCents, current: p.currentRevenueCents })) });
  addStyledSheet(wb, analysis, "Ranking por Quantidade", commonProductHeader, productStyledRows(analysis.rankQuantity, "quantity"), commonWidths, { comparisonRows: analysis.rankQuantity.slice(0, 10).map((p) => ({ label: p.title, previous: p.previousRevenueCents, current: p.currentRevenueCents })) });
  const abcHeaders = ["Curva", "Posição", "ID Anúncio", "SKU", "Título", "Qtd", "Faturamento", "Participação %", "Acumulado %", "Faturamento anterior", "Faturamento atual", "Delta faturamento", "Tendência"];
  addStyledSheet(wb, analysis, "Curva ABC Faturamento", abcHeaders, abcDetailRows(analysis.rankRevenue, "revenue"), [10, 10, 18, 18, 62, 10, 16, 16, 16, 18, 18, 18, 14], { curveSummary: analysis.curveRevenue });
  addStyledSheet(wb, analysis, "Curva ABC Quantidade", abcHeaders, abcDetailRows(analysis.rankQuantity, "quantity"), [10, 10, 18, 18, 62, 10, 16, 16, 16, 18, 18, 18, 14], { curveSummary: analysis.curveQuantity });
  addStyledSheet(wb, analysis, "Segurança Curva A", ["Tema", "Análise"], [["Concentração Top 5", formatPercent(analysis.curveASecurity.concentrationTop5Pct)], ["Curva A em queda", analysis.curveASecurity.fallingA.map((p) => p.title).join(" | ") || "Sem alertas"], ["Curva A com estoque baixo", analysis.curveASecurity.lowStockA.map((p) => `${p.title} (${p.stock})`).join(" | ") || "Sem alertas"], ["Recomendações", analysis.curveASecurity.recommendations.join(" | ")]], [30, 140], { curveSummary: analysis.curveRevenue });
  addStyledSheet(wb, analysis, "Crescimento e Queda", ["Tipo", "ID", "Título", "Delta faturamento", "Delta qtd", "Tendência"], [...analysis.growth.slice(0, 20).map((p) => ["Crescimento", p.itemId || "-", p.title, moneyCell(p.revenueDeltaCents), p.quantityDelta, p.trend]), ...analysis.decline.slice(0, 20).map((p) => ["Queda", p.itemId || "-", p.title, moneyCell(p.revenueDeltaCents), p.quantityDelta, p.trend])], [16, 18, 70, 18, 14, 16], { comparisonRows: analysis.growth.slice(0, 10).map((p) => ({ label: p.title, previous: p.previousRevenueCents, current: p.currentRevenueCents })) });
  for (const top of [5, 10, 20]) {
    const rev = analysis.movements.revenue.find((m) => m.topN === top);
    const qty = analysis.movements.quantity.find((m) => m.topN === top);
    addStyledSheet(wb, analysis, `Top ${top}`, ["Métrica", "Movimento", "ID", "Título", "Posição atual", "Posição anterior", "Valor atual", "Valor anterior", "Leitura"], [...movementRows(rev, "Faturamento"), ...movementRows(qty, "Quantidade")], [16, 26, 18, 70, 16, 18, 16, 16, 80]);
  }
  addStyledSheet(wb, analysis, "Movimentação Completa", ["Data", "Faturamento", "Pedidos", "Ticket médio"], analysis.daily.map((row) => [row.date, moneyCell(row.revenueCents), row.orders, moneyCell(row.averageTicketCents)]), [16, 18, 12, 18]);
  addStyledSheet(wb, analysis, "Controle de Metas", ["Indicador", "Valor"], [["Meta utilizada", analysis.goals.targetLabel || "-"], ["Meta de faturamento", analysis.goals.targetCents ? moneyCell(analysis.goals.targetCents) : "Sem meta cadastrada"], ["Realizado", moneyCell(analysis.goals.realizedCents)], ["Percentual atingido", analysis.goals.achievedPct == null ? "-" : Number(analysis.goals.achievedPct.toFixed(2))], ["Diferença para meta", analysis.goals.missingCents == null ? "-" : moneyCell(analysis.goals.missingCents)], ["Projeção", moneyCell(analysis.goals.projectionCents)], ["Dias projetados", analysis.goals.projectionDays || "-"], ["Status", analysis.goals.status], ["Observação", analysis.goals.note]], [32, 90]);
  const ads = analysis.ads || emptyAdsAnalysis(analysis.period.to);
  addStyledSheet(wb, analysis, "Ads Resumo 3 Meses", ["Indicador", "Valor"], [["Período Ads", `${ads.period.from} até ${ads.period.to}`], ["Investimento Ads", moneyCell(ads.kpis.spendCents)], ["Receita atribuída Ads", moneyCell(ads.kpis.revenueCents)], ["Pedidos atribuídos Ads", ads.kpis.attributedOrders], ["Itens vendidos Ads", ads.kpis.attributedItemsSold], ["ROAS", ads.kpis.roas == null ? "-" : Number(ads.kpis.roas.toFixed(2))], ["ACOS %", ads.kpis.acosPct == null ? "-" : Number(ads.kpis.acosPct.toFixed(2))], ["CPC médio", moneyCell(ads.kpis.avgCpcCents)], ["CTR %", ads.kpis.ctrPct == null ? "-" : Number(ads.kpis.ctrPct.toFixed(2))], ["Conversão %", ads.kpis.conversionPct == null ? "-" : Number(ads.kpis.conversionPct.toFixed(2))], ["Custo por pedido/item", moneyCell(ads.kpis.costPerOrderCents)], ["Ticket Ads", moneyCell(ads.kpis.adsTicketCents)], ["Limitações", ads.dataGaps.join(" | ") || "-"]], [34, 120]);
  addStyledSheet(wb, analysis, "Ads Mês a Mês", ["Mês", "Investimento", "Receita Ads", "ROAS", "ACOS %", "Pedidos", "Itens", "Impressões", "Cliques", "CTR %", "CPC médio"], ads.monthly.map((row) => [row.month, moneyCell(row.spendCents), moneyCell(row.revenueCents), row.roas == null ? "-" : Number(row.roas.toFixed(2)), row.acosPct == null ? "-" : Number(row.acosPct.toFixed(2)), row.attributedOrders, row.attributedItemsSold, row.impressions, row.clicks, row.ctrPct == null ? "-" : Number(row.ctrPct.toFixed(2)), moneyCell(row.avgCpcCents)]), [14, 16, 16, 10, 10, 10, 10, 14, 12, 10, 14]);
  const adsHeader = ["Rank", "ID Anúncio", "Produto", "Receita Ads", "Investimento", "ROAS", "ACOS %", "Impressões", "Cliques", "CTR %", "Itens", "Custo pedido/item", "Desperdício estimado", "Ação sugerida"];
  addStyledSheet(wb, analysis, "Ads Ranking Receita", adsHeader, ads.rankings.revenue.slice(0, 100).map(adsMetricRow), [8, 18, 70, 16, 16, 10, 10, 14, 12, 10, 10, 18, 20, 60]);
  addStyledSheet(wb, analysis, "Ads Ranking Investimento", adsHeader, ads.rankings.spend.slice(0, 100).map(adsMetricRow), [8, 18, 70, 16, 16, 10, 10, 14, 12, 10, 10, 18, 20, 60]);
  addStyledSheet(wb, analysis, "Ads Eficiência", adsHeader, ads.rankings.efficiency.slice(0, 100).map(adsMetricRow), [8, 18, 70, 16, 16, 10, 10, 14, 12, 10, 10, 18, 20, 60]);
  addStyledSheet(wb, analysis, "Ads Desperdício", adsHeader, ads.rankings.waste.slice(0, 100).map(adsMetricRow), [8, 18, 70, 16, 16, 10, 10, 14, 12, 10, 10, 18, 20, 60]);
  addStyledSheet(wb, analysis, "Ads Produtos Sugeridos", ["Prioridade", "ID", "SKU", "Produto", "Motivo", "Estratégia", "Orçamento inicial", "Objetivo", "Risco"], ads.recommendations.map((row) => [row.priority, row.itemId, row.sku, row.title, row.reason, row.strategy, row.initialBudgetSuggestion, row.objective, row.risk]), [14, 18, 18, 70, 80, 80, 55, 55, 55]);
  addStyledSheet(wb, analysis, "Ads Próximos Passos", ["Tipo", "Recomendação"], [...ads.insights.map((text) => ["Insight", text]), ...ads.nextSteps.map((text) => ["Próximo passo", text]), ...ads.dataGaps.map((text) => ["Limitação", text])], [22, 120]);
  addStyledSheet(wb, analysis, "Insights IA", ["Tipo", "Insight"], [["Resumo executivo", analysis.insights.executiveSummary], ...analysis.insights.alerts.map((text) => ["Alerta", text]), ...analysis.insights.opportunities.map((text) => ["Oportunidade", text]), ...analysis.insights.nextSteps.map((text) => ["Próximo passo", text]), ...analysis.validationWarnings.map((text) => ["Limitação", text])], [22, 120]);
  addStyledSheet(wb, analysis, "Dados Base", ["ID", "SKU", "Título", "Qtd", "Faturamento", "Ticket", "ABC Faturamento", "ABC Qtd", "Tendência", "Estoque", "Status", "Faturamento anterior", "Faturamento atual", "Delta"], analysis.rankRevenue.map((p) => [p.itemId || "-", p.sku || "-", p.title, p.quantity, moneyCell(p.revenueCents), moneyCell(p.averageTicketCents), p.revenueCentsAbc, p.quantityAbc, p.trend, p.stock ?? "-", p.status || "-", moneyCell(p.previousRevenueCents), moneyCell(p.currentRevenueCents), moneyCell(p.revenueDeltaCents)]), [18, 20, 70, 12, 18, 16, 16, 12, 16, 12, 14, 18, 18, 18]);
  await wb.xlsx.writeFile(filePath);
}

async function buildXlsx(analysis, filePath) {
  if (!ExcelJS) {
    buildLegacyXlsx(analysis, filePath);
    return;
  }
  await buildStyledXlsx(analysis, filePath);
}

function escapePdfText(text) { return String(text == null ? "" : text).replace(/[\u2013\u2014]/g, "-").replace(/[\u2022]/g, "-").replace(/[^\x09\x0A\x0D\x20-\x7E\xC0-\xFF]/g, "").replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)"); }
function wrapText(text, length) { const words = String(text || "").split(/\s+/); const lines = []; let line = ""; for (const word of words) { if (`${line} ${word}`.trim().length > length) { if (line) lines.push(line); line = word; } else line = `${line} ${word}`.trim(); } if (line) lines.push(line); return lines.length ? lines : [""]; }
function metricValue(value) { return Math.abs(value) > 100000 ? formatBRL(value) : String(value); }

class SimplePdf {
  constructor() { this.objects = []; this.pages = []; this.width = 595; this.height = 842; this.current = []; this.y = 800; }
  addObject(body) { this.objects.push(body); return this.objects.length; }
  beginPage() { if (this.current.length) this.endPage(); this.current = []; this.y = 800; }
  endPage() { if (!this.current.length) return; const content = this.current.join("\n"); const contentId = this.addObject(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`); this.pages.push({ contentId }); this.current = []; }
  ensureSpace(height = 40) { if (this.y - height < 60) { this.endPage(); this.beginPage(); } }
  text(text, x, y, size = 10, opts = {}) { const font = opts.bold ? "/F2" : "/F1"; const color = opts.color || "0.05 0.08 0.16"; this.current.push(`${color} rg BT ${font} ${size} Tf ${x} ${y} Td (${escapePdfText(text)}) Tj ET`); }
  line(x1, y1, x2, y2) { this.current.push(`${x1} ${y1} m ${x2} ${y2} l S`); }
  rect(x, y, w, h, color = "0.96 0.97 1") { this.current.push(`${color} rg ${x} ${y} ${w} ${h} re f 0.05 0.08 0.16 rg 0 0 0 RG`); }
  h1(text) { this.ensureSpace(44); this.text(text, 42, this.y, 18, { bold: true }); this.y -= 26; this.line(42, this.y, 553, this.y); this.y -= 16; }
  p(text, size = 10) { for (const chunk of wrapText(text, 92)) { this.ensureSpace(16); this.text(chunk, 48, this.y, size); this.y -= 14; } this.y -= 4; }
  table(headers, rows, widths) { this.ensureSpace(28); let x = 42; this.rect(42, this.y - 4, 511, 20, "0.90 0.93 1"); headers.forEach((h, i) => { this.text(h, x + 4, this.y + 2, 8, { bold: true }); x += widths[i]; }); this.y -= 24; for (const row of rows) { this.ensureSpace(22); x = 42; row.forEach((cell, i) => { this.text(String(cell).slice(0, widths[i] > 90 ? 42 : 18), x + 4, this.y, 7); x += widths[i]; }); this.y -= 16; } this.y -= 8; }
  barChart(title, rows, labelGetter, valueGetter) { this.ensureSpace(160); this.text(title, 48, this.y, 11, { bold: true }); this.y -= 18; const max = Math.max(1, ...rows.map(valueGetter)); for (const row of rows.slice(0, 10)) { const value = valueGetter(row); const width = Math.max(2, Math.round((value / max) * 260)); this.text(String(labelGetter(row)).slice(0, 28), 48, this.y, 7); this.rect(220, this.y - 3, width, 8, "0.18 0.35 0.95"); this.text(metricValue(value), 490, this.y, 7); this.y -= 14; } this.y -= 8; }
  build() { this.endPage(); const font1 = this.addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"); const font2 = this.addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>"); const pageIds = []; const pagesId = this.objects.length + this.pages.length + 1; for (const page of this.pages) { pageIds.push(this.addObject(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${this.width} ${this.height}] /Resources << /Font << /F1 ${font1} 0 R /F2 ${font2} 0 R >> >> /Contents ${page.contentId} 0 R >>`)); } const finalPagesId = this.addObject(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`); const catalogId = this.addObject(`<< /Type /Catalog /Pages ${finalPagesId} 0 R >>`); const parts = ["%PDF-1.4\n"]; const offsets = [0]; this.objects.forEach((body, i) => { offsets.push(Buffer.byteLength(parts.join(""), "latin1")); parts.push(`${i + 1} 0 obj\n${body}\nendobj\n`); }); const xrefOffset = Buffer.byteLength(parts.join(""), "latin1"); parts.push(`xref\n0 ${this.objects.length + 1}\n0000000000 65535 f \n`); for (let i = 1; i <= this.objects.length; i += 1) parts.push(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`); parts.push(`trailer\n<< /Size ${this.objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`); return Buffer.from(parts.join(""), "latin1"); }
}

function buildPdf(analysis, filePath) {
  const pdf = new SimplePdf(); pdf.beginPage(); pdf.rect(0, 0, 595, 842, "0.97 0.98 1"); pdf.text("Relatorio de Performance da Conta", 54, 720, 26, { bold: true }); pdf.text(analysis.account.name, 54, 680, 18, { bold: true }); pdf.text(`Documento: ${analysis.account.documentType || "-"} ${analysis.account.documentNumber || ""}`.trim(), 54, 654, 11); pdf.text(`Periodo: ${formatDate(analysis.period.from)} ate ${formatDate(analysis.period.to)}`, 54, 636, 11); pdf.text(`Comparativo: ${excelPeriodComparedText(analysis)}`, 54, 618, 9); pdf.text(`Gerado em: ${formatDateTime(analysis.generatedAt)}`, 54, 600, 11); pdf.text("Atencao: arquivo e registro disponiveis por 24h apos a geracao.", 54, 574, 10, { bold: true, color: "0.75 0.24 0.05" }); pdf.text("Salve o PDF/XLSX antes do prazo; depois disso a limpeza automatica remove o relatorio.", 54, 558, 9, { color: "0.75 0.24 0.05" }); pdf.text("DACHBYTE Seller - Shopee Backoffice", 54, 90, 10);
  pdf.endPage(); pdf.beginPage();
  pdf.h1("Resumo executivo"); pdf.table(["Indicador", "Valor"], [["Faturamento", formatBRL(analysis.kpis.revenueCents)], ["Pedidos", analysis.kpis.ordersCount], ["Ticket medio", formatBRL(analysis.kpis.averageTicketCents)], ["Anuncios com venda", analysis.kpis.soldProductsCount], ["Anuncios sem venda", analysis.kpis.productsWithoutSalesCount]], [210, 280]); pdf.p(analysis.insights.executiveSummary); analysis.insights.alerts.slice(0, 5).forEach((text) => pdf.p(`Alerta: ${text}`, 9));
  pdf.h1("Ranking por faturamento"); pdf.table(["#", "ID", "Produto", "Qtd", "Faturamento", "ABC"], analysis.rankRevenue.slice(0, 15).map((p) => [p.rank, p.itemId || "-", p.title, p.quantity, formatBRL(p.revenueCents), p.revenueCentsAbc]), [26, 70, 240, 44, 92, 38]); pdf.barChart("Top 10 por faturamento", analysis.rankRevenue.slice(0, 10), (p) => p.title, (p) => p.revenueCents);
  pdf.h1("Ranking por quantidade"); pdf.table(["#", "ID", "Produto", "Qtd", "Faturamento", "ABC"], analysis.rankQuantity.slice(0, 15).map((p) => [p.rank, p.itemId || "-", p.title, p.quantity, formatBRL(p.revenueCents), p.quantityAbc]), [26, 70, 240, 44, 92, 38]); pdf.barChart("Top 10 por quantidade", analysis.rankQuantity.slice(0, 10), (p) => p.title, (p) => p.quantity);
  pdf.h1("Curva ABC e seguranca da Curva A"); pdf.table(["Curva", "Produtos", "Faturamento", "Part.%", "Qtd"], analysis.curveRevenue.map((c) => [c.curve, c.products, formatBRL(c.revenueCents), formatPercent(c.sharePct), c.quantity]), [60, 80, 130, 90, 80]); pdf.p(`Concentracao Top 5: ${formatPercent(analysis.curveASecurity.concentrationTop5Pct)}. Produtos da Curva A em queda: ${analysis.curveASecurity.fallingA.length}. Curva A com estoque baixo: ${analysis.curveASecurity.lowStockA.length}.`); analysis.curveASecurity.recommendations.forEach((text) => pdf.p(`Recomendacao: ${text}`, 9));
  pdf.table(["Curva", "ID", "Produto", "Fat.", "Atual", "Anterior"], abcDetailRows(analysis.rankRevenue, "revenue").slice(0, 24).map((row) => [row[0], row[2], row[4], formatBRL(row[6] * 100), formatBRL(row[10] * 100), formatBRL(row[9] * 100)]), [42, 64, 220, 70, 70, 70]);
  pdf.h1("Crescimento, queda e movimentacao"); pdf.table(["Tipo", "Produto", "Delta", "Tendencia"], [...analysis.growth.slice(0, 8).map((p) => ["Crescimento", p.title, formatBRL(p.revenueDeltaCents), p.trend]), ...analysis.decline.slice(0, 8).map((p) => ["Queda", p.title, formatBRL(p.revenueDeltaCents), p.trend])], [90, 270, 90, 70]);
  const ads = analysis.ads || emptyAdsAnalysis(analysis.period.to);
  pdf.h1("Analise de Ads dos ultimos 3 meses"); pdf.table(["Indicador", "Valor"], [["Investimento Ads", formatBRL(ads.kpis.spendCents)], ["Receita atribuida", formatBRL(ads.kpis.revenueCents)], ["Pedidos Ads", ads.kpis.attributedOrders], ["Itens Ads", ads.kpis.attributedItemsSold], ["ROAS", ads.kpis.roas == null ? "-" : formatMetricNumber(ads.kpis.roas)], ["ACOS", ads.kpis.acosPct == null ? "-" : `${formatMetricNumber(ads.kpis.acosPct)}%`], ["CPC medio", formatBRL(ads.kpis.avgCpcCents)], ["CTR", ads.kpis.ctrPct == null ? "-" : `${formatMetricNumber(ads.kpis.ctrPct)}%`]], [220, 270]); ads.insights.slice(0, 5).forEach((text) => pdf.p(`Ads: ${text}`, 9));
  if (ads.monthly.length) pdf.barChart("Ads mes a mes - investimento", ads.monthly, (row) => row.month, (row) => row.spendCents);
  if (ads.rankings.revenue.length) pdf.barChart("Top Ads por faturamento atribuido", ads.rankings.revenue.slice(0, 10), (row) => row.title, (row) => row.revenueCents);
  if (ads.rankings.waste.length) pdf.barChart("Top Ads por desperdicio/risco", ads.rankings.waste.slice(0, 10), (row) => row.title, (row) => row.wasteScoreCents);
  pdf.h1("Recomendacoes executivas de Ads"); pdf.table(["Prioridade", "Produto", "Estrategia"], ads.recommendations.slice(0, 10).map((row) => [row.priority, row.title, row.strategy]), [70, 220, 220]); ads.nextSteps.slice(0, 6).forEach((text) => pdf.p(`Proximo passo Ads: ${text}`, 9)); ads.dataGaps.slice(0, 4).forEach((text) => pdf.p(`Limitacao Ads: ${text}`, 8));
  pdf.h1("Controle de metas e proximos passos"); pdf.p(`Meta utilizada: ${analysis.goals.targetLabel || "-"}. Meta: ${analysis.goals.targetCents ? formatBRL(analysis.goals.targetCents) : "sem meta cadastrada"}. Realizado: ${formatBRL(analysis.goals.realizedCents)}. Projecao: ${formatBRL(analysis.goals.projectionCents)} em ${analysis.goals.projectionDays || 30} dias. Status: ${analysis.goals.status}.`); analysis.insights.nextSteps.forEach((text) => pdf.p(`Proximo passo: ${text}`, 9)); if (analysis.validationWarnings.length) { pdf.h1("Limitacoes da analise"); analysis.validationWarnings.forEach((text) => pdf.p(text, 9)); }
  fs.writeFileSync(filePath, pdf.build());
}

async function runReport(reportId) {
  await ensureSchema(); let report = await getReportById(reportId); if (!report) return;
  try {
    await query(`UPDATE "AdminAccountPerformanceReport" SET status = 'RUNNING', progress = 3, "startedAt" = NOW(), "updatedAt" = NOW() WHERE id = $1`, [Number(reportId)]);
    await appendLog(reportId, "Preparando analise da conta...", 5, REPORT_STATUSES.RUNNING); report = await getReportById(reportId);
    const account = await loadAccount(report.accountId); const shops = await loadShops(report.accountId); if (!shops.length) await appendLog(reportId, "Conta sem lojas Shopee vinculadas. O relatorio sera gerado com limitacoes.", 7);
    const syncInfo = await maybeSyncOrders({ reportId, account, shops, periodDays: report.periodDays, periodFrom: report.periodFrom, compareFrom: report.compareFrom }); await appendLog(reportId, "Buscando pedidos dos ultimos periodos...", 30);
    const data = await loadAnalysisData({ accountId: account.id, periodFrom: report.periodFrom, periodTo: report.periodTo });
    let previousData = null;
    if (report.compareFrom && report.compareTo) {
      await appendLog(reportId, "Buscando dados do mes anterior para comparacao mensal...", 36);
      previousData = await loadAnalysisData({ accountId: account.id, periodFrom: report.compareFrom, periodTo: report.compareTo });
    }
    await appendLog(reportId, "Calculando faturamento, vendas, rankings e Curva ABC...", 42);
    const analysis = buildAnalysis({ account, shops, ...data, periodFrom: report.periodFrom, periodTo: report.periodTo, syncInfo, previousOrders: previousData?.orders || null, previousItems: previousData?.items || null, compareFrom: report.compareFrom, compareTo: report.compareTo, periodPreset: report.periodPreset, selectedMonth: report.selectedMonth }); await appendLog(reportId, "Identificando crescimento, queda e entradas/saidas dos rankings...", 54);
    await appendLog(reportId, "Analisando Ads CPC dos ultimos 3 meses...", 60); analysis.ads = await buildAdsAnalysis({ accountId: account.id, periodTo: report.periodTo, commercialAnalysis: analysis }); analysis.insights = mergeAdsIntoInsights(analysis); analysis.insights = await maybeEnhanceInsightsWithOllama(analysis, reportId);
    ensureGeneratedDir(); const baseName = `${String(reportId).padStart(6, "0")}-${sanitizeFilePart(account.name)}-${new Date().toISOString().slice(0, 10)}`; const xlsxPath = path.join(GENERATED_DIR, `${baseName}.xlsx`); const pdfPath = path.join(GENERATED_DIR, `${baseName}.pdf`);
    await appendLog(reportId, "Montando XLSX executivo...", 72); await buildXlsx(analysis, xlsxPath); await appendLog(reportId, "Montando PDF premium...", 86); buildPdf(analysis, pdfPath); await appendLog(reportId, "Relatorio finalizado com sucesso.", 100, REPORT_STATUSES.SUCCESS);
    await query(`UPDATE "AdminAccountPerformanceReport" SET status = 'SUCCESS', progress = 100, "currentStep" = 'Relatorio finalizado', "xlsxPath" = $2, "pdfPath" = $3, summary = $4::jsonb, "completedAt" = NOW(), "updatedAt" = NOW() WHERE id = $1`, [Number(reportId), xlsxPath, pdfPath, JSON.stringify({ kpis: analysis.kpis, ads: { available: analysis.ads?.available, kpis: analysis.ads?.kpis, dataGaps: analysis.ads?.dataGaps }, warnings: analysis.validationWarnings, insights: analysis.insights, period: analysis.period })]);
  } catch (error) { const message = String(error?.message || error); await appendLog(reportId, `Falha ao gerar relatorio: ${message}`, 100, REPORT_STATUSES.FAILED).catch(() => {}); await query(`UPDATE "AdminAccountPerformanceReport" SET status = 'FAILED', error = $2, "completedAt" = NOW(), "updatedAt" = NOW() WHERE id = $1`, [Number(reportId), message]).catch(() => {}); }
}

function getDownloadInfo(report, format) { if (!report) return null; const normalized = String(format || "").toLowerCase(); const filePath = normalized === "pdf" ? report.pdfPath : normalized === "xlsx" ? report.xlsxPath : null; if (!filePath) return null; const resolved = path.resolve(filePath); const root = path.resolve(GENERATED_DIR); if (!resolved.startsWith(root) || !fs.existsSync(resolved)) return null; return { path: resolved, filename: path.basename(resolved), contentType: normalized === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }; }

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
