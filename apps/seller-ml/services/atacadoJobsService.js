"use strict";

const Bull = require("bull");
const crypto = require("crypto");
const ExcelJS = require("exceljs");
const AtacadoService = require("./atacadoService");
const { makeBullClient, getSharedRedis } = require("../lib/redisClient");
const { attachJobContract, backendJobIdFromUid } = require("./jobContract");
const { recordAuthEvent } = require("./authAuditService");
const { quoteCredits, reserveCredits, settleCredits } = require("./hubCreditsService");
const { waitForHeavyOperationLease } = require("./mlHeavyOperationGovernor");

const QUEUE_NAME = "ml-atacado";
const RESULT_TTL_SECONDS = Math.max(
  3600,
  Number(process.env.ATACADO_RESULT_TTL_SECONDS || 3 * 24 * 60 * 60),
);
const WORKER_CONCURRENCY = Math.max(
  1,
  Math.min(8, Number(process.env.ATACADO_WORKER_CONCURRENCY || 2)),
);
const META_UPDATE_EVERY = Math.max(
  1,
  Number(process.env.ATACADO_META_UPDATE_EVERY || 10),
);
const RESULT_FLUSH_EVERY = Math.max(
  10,
  Number(process.env.ATACADO_RESULT_FLUSH_EVERY || 100),
);

let queueInstance = null;
let workerStarted = false;
let redisInstance = null;

class AtacadoJobCancelledError extends Error {
  constructor(message = "Job de atacado cancelado pelo usuario.") {
    super(message);
    this.name = "AtacadoJobCancelledError";
  }
}

function nowISO() {
  return new Date().toISOString();
}

function getQueue() {
  if (!queueInstance) {
    queueInstance = new Bull(QUEUE_NAME, {
      createClient: (type) => makeBullClient(type, QUEUE_NAME),
    });
  }
  return queueInstance;
}

function getRedis() {
  if (!redisInstance) redisInstance = getSharedRedis("atacado:jobs");
  return redisInstance;
}

function resolveJobId(value) {
  return backendJobIdFromUid("atacado", value);
}

function normalizeAccountKey(value) {
  const text = String(value || "").trim();
  if (!text || text.toLowerCase() === "default") return null;
  return text;
}

function metaKey(jobId) {
  return `ml:atacado:${jobId}:meta`;
}

function resultsKey(jobId) {
  return `ml:atacado:${jobId}:results`;
}

async function readMeta(jobId) {
  try {
    const raw = await getRedis().get(metaKey(jobId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function writeMeta(jobId, patch = {}) {
  const previous = (await readMeta(jobId)) || {};
  const merged = {
    ...previous,
    ...patch,
    updated_at: patch.updated_at || nowISO(),
  };
  await getRedis()
    .set(metaKey(jobId), JSON.stringify(merged), "EX", RESULT_TTL_SECONDS)
    .catch(() => {});
  return merged;
}

async function appendResults(jobId, rows = []) {
  const normalized = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!normalized.length) return;
  const redis = getRedis();
  const payload = normalized.map((row) => JSON.stringify(row));
  await redis.rpush(resultsKey(jobId), ...payload);
  await redis.expire(resultsKey(jobId), RESULT_TTL_SECONDS);
}

async function readResults(jobId) {
  try {
    const rows = await getRedis().lrange(resultsKey(jobId), 0, -1);
    return rows
      .map((row) => {
        try {
          return JSON.parse(row);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function resultCount(jobId) {
  try {
    return Math.max(0, Number(await getRedis().llen(resultsKey(jobId))) || 0);
  } catch {
    return 0;
  }
}

function round2(value) {
  const num = Number(value || 0);
  return Math.round((num + Number.EPSILON) * 100) / 100;
}

function safeText(value, max = 500) {
  const text = value == null ? "" : String(value);
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function tierSummaryFromConfigs(tierConfigs = []) {
  const tiers = Array.isArray(tierConfigs)
    ? tierConfigs
        .map((tier) => ({
          min_purchase_unit: Number(tier?.min_purchase_unit || 0) || null,
          discount_percent: Number(tier?.discount_percent || 0) || null,
        }))
        .filter((tier) => tier.min_purchase_unit != null || tier.discount_percent != null)
    : [];
  const discounts = tiers
    .map((tier) => Number(tier.discount_percent))
    .filter((value) => Number.isFinite(value));
  return {
    tiers,
    tier_count: tiers.length,
    min_discount_percent: discounts.length ? Math.min(...discounts) : null,
    max_discount_percent: discounts.length ? Math.max(...discounts) : null,
  };
}

function tierSummaryFromResult(result = {}) {
  const baseAmount = Number(result?.row?.sale_price || 0) || null;
  const prices = Array.isArray(result?.payload?.price_per_quantity)
    ? result.payload.price_per_quantity
    : Array.isArray(result?.payload?.prices) ? result.payload.prices : [];
  const tiers = prices.map((price) => {
    const absoluteAmount = Number(price?.amount);
    const discount = price?.percentage != null
      ? Number(price.percentage)
      : baseAmount && absoluteAmount > 0
        ? round2(100 * (1 - absoluteAmount / baseAmount))
        : null;
    return {
      min_purchase_unit: Number(price?.conditions?.min_purchase_unit || 0) || null,
      amount: absoluteAmount > 0 ? absoluteAmount : baseAmount && Number.isFinite(discount)
        ? round2(baseAmount * (1 - discount / 100))
        : null,
      discount_percent: discount != null && Number.isFinite(discount) ? discount : null,
      currency_id: result?.row?.currency_id || "BRL",
    };
  });
  const discounts = tiers
    .map((tier) => Number(tier.discount_percent))
    .filter((value) => Number.isFinite(value));
  return {
    tiers,
    tier_count: tiers.length,
    min_discount_percent: discounts.length ? Math.min(...discounts) : null,
    max_discount_percent: discounts.length ? Math.max(...discounts) : null,
    base_price: baseAmount,
  };
}

function atacadoResultAction({ id, kind, status, resultTotal }) {
  if (kind === "atacado-load-active" || !["concluido", "cancelado", "erro"].includes(status) || resultTotal <= 0) {
    return null;
  }
  return {
    type: "download_xlsx",
    label: "Baixar XLSX",
    url: `/api/atacado/jobs/${encodeURIComponent(String(id))}/download.xlsx`,
    download: true,
  };
}

async function buildAtacadoResultsWorkbook(rows = [], context = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "DACHBYTE Seller";
  workbook.created = new Date();
  const summary = workbook.addWorksheet("Resumo do job");
  summary.columns = [{ header: "Campo", key: "field", width: 27 }, { header: "Valor", key: "value", width: 55 }];
  [
    ["Job", String(context.jobId || "")],
    ["Operação", String(context.operationId || "")],
    ["Conta", String(context.accountLabel || "")],
    ["Status", String(context.status || "")],
    ["Tipo", "Aplicação"],
    ["Total", Number(context.total || 0)],
    ["Processados", Number(context.processed || 0)],
    ["Aplicados", Number(context.applied || 0)],
    ["Ignorados", Number(context.skipped || 0)],
    ["Erros", Number(context.errors || 0)],
    ["Iniciado em", String(context.startedAt || "")],
    ["Finalizado em", String(context.finishedAt || "")],
  ].forEach(([field, value]) => summary.addRow({ field, value }));

  const results = workbook.addWorksheet("Resultados");
  results.columns = [
    { header: "MLB", key: "mlb", width: 20 },
    { header: "Status", key: "status", width: 16 },
    { header: "Motivo", key: "reason", width: 65 },
    { header: "Título", key: "title", width: 55 },
    { header: "SKU", key: "sku", width: 24 },
    { header: "Preço do anúncio", key: "itemPrice", width: 21 },
    { header: "Preço vigente", key: "salePrice", width: 21 },
    { header: "Promoção ativa", key: "promoActive", width: 17 },
    { header: "Desconto promoção", key: "promoPercent", width: 21 },
    { header: "Faixas solicitadas", key: "tierCount", width: 20 },
  ];
  const tiers = workbook.addWorksheet("Faixas");
  tiers.columns = [
    { header: "MLB", key: "mlb", width: 20 },
    { header: "Quantidade mínima", key: "quantity", width: 22 },
    { header: "Desconto solicitado", key: "discount", width: 23 },
    { header: "Preço vigente", key: "salePrice", width: 21 },
    { header: "Preço estimado por unidade", key: "unitPrice", width: 29 },
    { header: "Status do item", key: "status", width: 19 },
  ];
  const optionalNumber = (value) => value == null || value === "" || !Number.isFinite(Number(value))
    ? null : Number(value);
  for (const result of rows) {
    const row = result?.row || {};
    const basePrice = optionalNumber(row.sale_price);
    const storedPrices = Array.isArray(result?.payload?.price_per_quantity)
      ? result.payload.price_per_quantity
      : Array.isArray(result?.payload?.prices) ? result.payload.prices : null;
    const priceTiers = storedPrices
      ? storedPrices.map((price) => ({
          quantity: optionalNumber(price?.conditions?.min_purchase_unit),
          discount: price?.percentage != null
            ? optionalNumber(price.percentage)
            : basePrice && optionalNumber(price?.amount) != null
              ? round2(100 * (1 - Number(price.amount) / basePrice))
              : null,
        }))
      : (Array.isArray(context.tierConfigs) ? context.tierConfigs : []).map((tier) => ({
          quantity: optionalNumber(tier?.min_purchase_unit),
          discount: optionalNumber(tier?.discount_percent),
        }));
    results.addRow({
      mlb: String(result?.id || ""), status: String(result?.status || ""),
      reason: String(result?.reason || result?.message || ""),
      title: String(row.title || ""), sku: String(row.seller_custom_field || ""),
      itemPrice: optionalNumber(row.item_price), salePrice: basePrice,
      promoActive: row.promo_active == null ? "" : row.promo_active ? "Sim" : "Não",
      promoPercent: optionalNumber(row.promo_percent) == null ? null : Number(row.promo_percent) / 100,
      tierCount: priceTiers.length,
    });
    for (const tier of priceTiers) {
      tiers.addRow({
        mlb: String(result?.id || ""), quantity: tier.quantity,
        discount: tier.discount == null ? null : tier.discount / 100,
        salePrice: basePrice,
        unitPrice: basePrice == null || tier.discount == null
          ? null : round2(basePrice * (1 - tier.discount / 100)),
        status: String(result?.status || ""),
      });
    }
  }
  for (const sheet of [summary, results, tiers]) {
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    sheet.getRow(1).eachCell((cell) => {
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF183153" } };
      cell.alignment = { vertical: "middle" };
    });
    sheet.getRow(1).height = 25;
  }
  for (const column of ["F", "G"]) results.getColumn(column).numFmt = '"R$" #,##0.00';
  results.getColumn("I").numFmt = "0.00%";
  tiers.getColumn("C").numFmt = "0.00%";
  for (const column of ["D", "E"]) tiers.getColumn(column).numFmt = '"R$" #,##0.00';
  results.autoFilter = { from: "A1", to: "J1" };
  tiers.autoFilter = { from: "A1", to: "F1" };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function auditBase(data = {}, jobId = null) {
  const context = data.auditContext || {};
  return {
    userId: Number(context.userId) || null,
    email: context.email || null,
    ip: context.ip || null,
    userAgent: context.userAgent || null,
    accountKey: context.accountKey || data.accountKey || null,
    accountLabel: context.accountLabel || data.accountLabel || data.accountKey || null,
    meli_conta_id: context.meli_conta_id || null,
    route: context.route || null,
    method: context.method || null,
    job_id: jobId == null ? null : String(jobId),
    operation_id: data.operationId || null,
  };
}

async function auditAtacadoEvent(data, jobId, evento, status, metadata = {}) {
  const base = auditBase(data, jobId);
  return recordAuthEvent({
    userId: base.userId,
    email: base.email,
    evento,
    status,
    ip: base.ip,
    userAgent: base.userAgent,
    metadata: {
      accountKey: base.accountKey,
      accountLabel: base.accountLabel,
      meli_conta_id: base.meli_conta_id,
      route: base.route,
      method: base.method,
      job_id: base.job_id,
      operation_id: base.operation_id,
      action: "apply_wholesale_price",
      ...metadata,
    },
  }).catch((err) => {
    console.error("[AtacadoJobsService] audit erro:", err?.message || err);
  });
}

function accountFromData(data = {}) {
  const key = normalizeAccountKey(data.accountKey);
  const label = String(data.accountLabel || key || "").trim() || null;
  return key || label ? { key, label: label || key } : null;
}

function canAccessJob(job, accountKey) {
  const wanted = normalizeAccountKey(accountKey);
  const current = normalizeAccountKey(job?.data?.accountKey);
  return Boolean(wanted && current && wanted === current);
}

function isActiveLoadJob(data = {}) {
  return String(data?.kind || "").trim() === "atacado-load-active";
}

function rejectWholesaleSimulation(dryRun) {
  if (dryRun === true) throw new Error("Simulação de atacado não está disponível.");
}

function wholesaleBillingOperationKey() {
  return "wholesale.apply";
}

function wholesaleBillingIdempotencyKey(operationId) {
  const id = String(operationId || "").trim();
  if (!id) throw new Error("wholesale_operation_id_required");
  return `wholesale:${id}`;
}

function wholesaleBillableUnits(_data = {}, meta = {}) {
  return Math.max(0, Number(meta.applied || 0));
}

function wholesaleSettlementSummary(reservation = {}, settled = null) {
  const reserved = Math.max(0, Number(reservation?.reserved_credits || 0));
  const pending = {
    status: "pending",
    reserved_credits: reserved,
    spent_credits: null,
    released_credits: null,
  };
  if (!settled || !["consumed", "released"].includes(String(settled.status || ""))) return pending;
  if (settled.reserved_credits == null || settled.consumed_credits == null) return pending;
  const scale = Math.max(1, Number(settled.credit_unit_scale || reservation.credit_unit_scale || 1));
  const reservedUnits = Number(settled.reserved_credits);
  const consumedUnits = Number(settled.consumed_credits);
  if (!Number.isFinite(reservedUnits) || !Number.isFinite(consumedUnits)) return pending;
  const spentUnits = settled.status === "released" ? 0 : consumedUnits;
  if (spentUnits < 0 || spentUnits > reservedUnits) return pending;
  return {
    status: "confirmed",
    reserved_credits: reservedUnits / scale,
    spent_credits: spentUnits / scale,
    released_credits: (reservedUnits - spentUnits) / scale,
  };
}

async function settleAtacadoJob(job, meta, { release = false, settle = settleCredits, write = writeMeta } = {}) {
  const reservation = job?.data?.creditReservation;
  if (!reservation || reservation.bypass || reservation.shadow === true) return;
  const billableUnits = wholesaleBillableUnits(job.data, meta);
  const settled = await settle(reservation, {
    release: release || billableUnits <= 0,
    consumedUnits: release || billableUnits <= 0 ? null : billableUnits,
  });
  const summary = wholesaleSettlementSummary(reservation, settled);
  await write(job.id, {
    credit_settlement: summary.status === "confirmed"
      ? summary
      : { ...summary, status: "unconfirmed" },
  });
}

function explicitAtacadoLifecycleStatus(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (normalized === "erro") return "failed";
  if (normalized === "cancelado") return "canceled";
  return null;
}

function attachAtacadoJobContract(job) {
  const lifecycleStatus = explicitAtacadoLifecycleStatus(job?.status);
  return attachJobContract(job, {
    module: "atacado",
    ...(lifecycleStatus ? { lifecycleStatus } : {}),
  });
}

function telemetryFrom(job, meta = {}) {
  const reservation = job?.data?.creditReservation || {};
  const billableUnits = wholesaleBillableUnits(job?.data || {}, meta);
  return {
    billing_mode:
      reservation?.shadow === true
        ? "shadow"
        : reservation?.bypass === true
          ? "bypass"
          : "enforce",
    operation_key:
      job?.data?.billingOperationKey ||
      reservation?.quote?.operation_key ||
      reservation?.operation_key ||
      null,
    operation_id: job?.data?.operationId || null,
    selected: Number(meta.total || job?.data?.itemIds?.length || 0),
    processed: Number(meta.processed || 0),
    applied: Number(meta.applied || 0),
    validated: 0,
    skipped: Number(meta.skipped || 0),
    errors: Number(meta.errors || 0),
    billable_units: billableUnits,
    estimated_credits:
      reservation?.quote?.estimated_credits ??
      reservation?.reserved_credits ??
      null,
    duration_ms:
      meta.started_at && meta.finished_at
        ? Math.max(0, new Date(meta.finished_at).getTime() - new Date(meta.started_at).getTime())
        : null,
  };
}

async function shapeJob(job, { includeResults = false } = {}) {
  if (!job) return null;
  const meta = (await readMeta(job.id)) || {};
  const bullState = await job.getState().catch(() => "unknown");
  const activeLoad = isActiveLoadJob(job.data);
  const total = Math.max(0, Number(meta.total || (activeLoad ? 0 : job.data?.itemIds?.length) || 0));
  const processed = Math.max(0, Number(meta.processed || 0));
  const applied = Math.max(0, Number(meta.applied || 0));
  const skipped = Math.max(0, Number(meta.skipped || 0));
  const errors = Math.max(0, Number(meta.errors || 0));
  const loaded = Math.max(0, Number(meta.loaded || 0));
  const progress = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  const status = String(
    meta.status ||
      (bullState === "completed"
        ? "concluido"
        : bullState === "failed"
          ? "erro"
          : bullState === "waiting" || bullState === "delayed"
            ? "aguardando"
            : "processando")
  );
  const terminal = ["concluido", "cancelado", "erro"].includes(status);
  const resultTotal = await resultCount(job.id);
  const publicJob = {
    id: String(job.id),
    kind: job.data?.kind || "atacado",
    title:
      job.data?.title ||
      (activeLoad
        ? "Carregar ativos do Atacado"
        : `Aplicar Atacado - ${total} item(ns)`),
    state:
      status === "concluido"
        ? activeLoad
          ? `concluido: ${loaded || resultTotal} anuncio(s) carregado(s)${errors ? `, ${errors} detalhe(s) ausente(s)` : ""}`
          : `concluido: ${applied} ok, ${errors} erros, ${skipped} ignorados`
        : status === "processando"
          ? activeLoad
            ? `carregando ${processed}/${total || "?"}`
            : `processando ${processed}/${total}`
          : status,
    status,
    progress: terminal ? 100 : progress,
    processed,
    total,
    success: activeLoad ? loaded || resultTotal : applied,
    loaded: activeLoad ? (loaded || resultTotal) : undefined,
    applied,
    skipped,
    errors,
    created_at: new Date(job.timestamp).toISOString(),
    updated_at: meta.updated_at || new Date(job.processedOn || job.timestamp).toISOString(),
    completed: terminal,
    account: accountFromData(job.data),
    result_total: resultTotal,
    billing_telemetry: activeLoad ? null : telemetryFrom(job, meta),
    credit_settlement: activeLoad ? null : meta.credit_settlement || null,
    error: meta.error || null,
    queue_reason: meta.queueReason || null,
    heavy_operation_holder: meta.heavyOperationHolder || null,
    ...(includeResults ? { results: await readResults(job.id) } : {}),
  };
  const action = atacadoResultAction({
    id: job.id,
    kind: publicJob.kind,
    status,
    resultTotal,
  });
  const contracted = attachAtacadoJobContract(action
    ? { ...publicJob, review_action: action }
    : publicJob);
  if (action) contracted.job_contract.actions = { download_xlsx: action };
  return contracted;
}

async function scanActiveLoadPages({
  loadPage,
  onPage = null,
  shouldCancel = null,
} = {}) {
  if (typeof loadPage !== "function") {
    throw new Error("active_load_page_loader_required");
  }

  const seenCursors = new Set();
  let cursor = null;
  let total = 0;
  let processed = 0;
  let loaded = 0;
  let errors = 0;
  let pages = 0;

  for (;;) {
    if (typeof shouldCancel === "function" && await shouldCancel()) {
      throw new AtacadoJobCancelledError();
    }

    const page = await loadPage({ cursor });
    const rows = Array.isArray(page?.items) ? page.items : [];
    const paging = page?.paging || {};
    const scanned = Math.max(0, Number(paging.scanned ?? rows.length) || 0);
    const pageTotal = Number(paging.total);
    if (Number.isFinite(pageTotal) && pageTotal >= 0) total = pageTotal;

    processed += scanned;
    loaded += rows.length;
    errors += Math.max(0, scanned - rows.length);
    pages += 1;

    const snapshot = {
      cursor,
      next_cursor: paging.next_cursor || null,
      has_more: paging.has_more === true,
      rows,
      scanned,
      total: total || processed,
      processed,
      loaded,
      errors,
      pages,
    };
    if (typeof onPage === "function") await onPage(snapshot);

    const nextCursor = String(paging.next_cursor || "").trim();
    let stopReason = null;
    if (paging.has_more !== true) stopReason = "complete";
    else if (!nextCursor) stopReason = "missing_cursor";
    else if (scanned <= 0) stopReason = "empty_page";
    else if (seenCursors.has(nextCursor)) stopReason = "repeated_cursor";

    if (stopReason) {
      const finalTotal = total || processed;
      if (processed > 0 && loaded === 0) stopReason = "all_details_missing";
      return {
        total: finalTotal,
        processed,
        loaded,
        errors,
        pages,
        stop_reason: stopReason,
        complete: stopReason !== "all_details_missing" && (
          stopReason === "complete" || (finalTotal > 0 && processed >= finalTotal)
        ),
      };
    }

    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}

async function runActiveLoadJob(job) {
  const data = job.data || {};
  const initialMeta = (await readMeta(job.id)) || {};
  if (initialMeta.cancelRequested === true || initialMeta.status === "cancelado") {
    throw new AtacadoJobCancelledError();
  }

  const startedAt = nowISO();
  await writeMeta(job.id, {
    status: "processando",
    total: 0,
    processed: 0,
    loaded: 0,
    applied: 0,
    skipped: 0,
    errors: 0,
    cancelRequested: false,
    queueReason: null,
    heavyOperationHolder: null,
    started_at: startedAt,
  });
  await job.progress(0);

  await auditAtacadoEvent(data, job.id, "wholesale_active_load_started", "success", {
    action: "load_active_wholesale_items",
  });

  const serviceState = await AtacadoService.prepareState(data.mlCreds || {});
  const scan = await scanActiveLoadPages({
    shouldCancel: async () => {
      const latestMeta = (await readMeta(job.id)) || {};
      return latestMeta.cancelRequested === true || latestMeta.status === "cancelado";
    },
    loadPage: ({ cursor }) =>
      AtacadoService.listActiveItemsPage(serviceState, {
        cursor,
        limit: 50,
        extra_discount_percent: data.extraDiscountPercent,
      }),
    onPage: async (snapshot) => {
      if (snapshot.rows.length) await appendResults(job.id, snapshot.rows);
      const progress = snapshot.total > 0
        ? Math.min(99, Math.round((snapshot.processed / snapshot.total) * 100))
        : 0;
      await writeMeta(job.id, {
        status: "processando",
        total: snapshot.total,
        processed: snapshot.processed,
        loaded: snapshot.loaded,
        applied: 0,
        skipped: 0,
        errors: snapshot.errors,
        pages: snapshot.pages,
        cursor: snapshot.next_cursor,
      });
      await job.progress(progress);
    },
  });

  const {
    total: finalTotal,
    processed,
    loaded,
    errors,
    pages,
  } = scan;

  if (scan.complete !== true) {
    throw new Error(
      `Carga de ativos interrompida antes de cobrir todos os anuncios (${scan.stop_reason || "scan_incomplete"}): ${processed}/${finalTotal || "?"} processados.`,
    );
  }

  const finishedAt = nowISO();
  await writeMeta(job.id, {
    status: "concluido",
    total: finalTotal,
    processed,
    loaded,
    applied: 0,
    skipped: 0,
    errors,
    pages,
    finished_at: finishedAt,
    cancelRequested: false,
  });
  await job.progress(100);

  await auditAtacadoEvent(
    data,
    job.id,
    "wholesale_active_load_completed",
    errors > 0 ? "warn" : "success",
    {
      action: "load_active_wholesale_items",
      total_items: finalTotal,
      processed,
      loaded,
      errors,
      pages,
      duration_ms: Math.max(0, new Date(finishedAt).getTime() - new Date(startedAt).getTime()),
    },
  );

  return {
    ok: true,
    kind: "atacado-load-active",
    total: finalTotal,
    processed,
    loaded,
    errors,
    pages,
  };
}

async function runJob(job) {
  const data = job.data || {};
  rejectWholesaleSimulation(data.dryRun);
  const initialMeta = (await readMeta(job.id)) || {};
  if (initialMeta.cancelRequested === true || initialMeta.status === "cancelado") {
    throw new AtacadoJobCancelledError();
  }
  const ids = Array.from(
    new Set(
      (Array.isArray(data.itemIds) ? data.itemIds : [])
        .map((value) => String(value || "").trim().toUpperCase())
        .filter(Boolean),
    ),
  );
  if (!ids.length) throw new Error("Nenhum anuncio informado para o job de atacado.");

  const applyOptions = {
    extra_discount_percent: data.extraDiscountPercent,
    min_purchase_unit: data.minPurchaseUnit,
    tier_configs: data.tierConfigs,
    promo_only: data.promoOnly !== false,
  };
  const requestedTierSummary = tierSummaryFromConfigs(
    Array.isArray(data.tierConfigs) && data.tierConfigs.length
      ? data.tierConfigs
      : [{
          min_purchase_unit: data.minPurchaseUnit,
          discount_percent: data.extraDiscountPercent,
        }],
  );

  const startedAt = nowISO();
  await writeMeta(job.id, {
    status: "processando",
    total: ids.length,
    processed: 0,
    applied: 0,
    skipped: 0,
    errors: 0,
    cancelRequested: false,
    queueReason: null,
    heavyOperationHolder: null,
    started_at: startedAt,
  });
  await job.progress(0);

  await auditAtacadoEvent(data, job.id, "wholesale_price_job_started", "success", {
    total_items: ids.length,
    sample_ids: ids.slice(0, 20),
    promo_only: data.promoOnly !== false,
    extra_discount_percent: Number(data.extraDiscountPercent),
    min_purchase_unit: Number(data.minPurchaseUnit),
    wholesale_tier_count: requestedTierSummary.tier_count,
    wholesale_tiers: requestedTierSummary.tiers,
    wholesale_min_discount_percent: requestedTierSummary.min_discount_percent,
    wholesale_max_discount_percent: requestedTierSummary.max_discount_percent,
    billing_telemetry: telemetryFrom(job, {
      total: ids.length,
      processed: 0,
      applied: 0,
      skipped: 0,
      errors: 0,
      started_at: startedAt,
    }),
  });

  const state = await AtacadoService.prepareState(data.mlCreds || {});
  let processed = 0;
  let applied = 0;
  let skipped = 0;
  let errors = 0;
  let resultBuffer = [];

  for (const itemId of ids) {
    if (processed === 0 || processed % META_UPDATE_EVERY === 0) {
      const latestMeta = (await readMeta(job.id)) || {};
      if (latestMeta.cancelRequested === true || latestMeta.status === "cancelado") {
        throw new AtacadoJobCancelledError();
      }
    }

    let result;
    try {
      result = await AtacadoService.applyWholesaleForItem(state, itemId, applyOptions);
    } catch (error) {
      result = {
        id: itemId,
        status: "error",
        reason: error?.message || "Erro inesperado na execucao do job.",
      };
    }

    resultBuffer.push(result);
    processed += 1;
    const appliedTierSummary = tierSummaryFromResult(result);

    await auditAtacadoEvent(
      data,
      job.id,
      "wholesale_price_item_processed",
      result.status === "applied"
        ? "success"
        : result.status === "skipped"
          ? "warn"
          : "error",
      {
        mlb_id: itemId,
        item_id: itemId,
        item_index: processed,
        total_items: ids.length,
        item_status: result.status,
        message: safeText(result.reason || result.message || ""),
        promo_only: data.promoOnly !== false,
        promo_active: result?.row?.promo_active ?? null,
        promo_percent: result?.row?.promo_percent ?? null,
        item_price: result?.row?.item_price ?? null,
        sale_price: result?.row?.sale_price ?? null,
        wholesale_base_price: appliedTierSummary.base_price,
        wholesale_tier_count: appliedTierSummary.tier_count,
        wholesale_tiers: appliedTierSummary.tiers,
        wholesale_min_discount_percent: appliedTierSummary.min_discount_percent,
        wholesale_max_discount_percent: appliedTierSummary.max_discount_percent,
        requested_tiers: requestedTierSummary.tiers,
      },
    );

    if (result.status === "applied") applied += 1;
    else if (result.status === "skipped") skipped += 1;
    else errors += 1;

    if (resultBuffer.length >= RESULT_FLUSH_EVERY) {
      await appendResults(job.id, resultBuffer);
      resultBuffer = [];
    }

    if (processed === 1 || processed === ids.length || processed % META_UPDATE_EVERY === 0) {
      await writeMeta(job.id, {
        status: "processando",
        total: ids.length,
        processed,
        applied,
        skipped,
        errors,
      });
      await job.progress(Math.min(100, Math.round((processed / ids.length) * 100)));
    }
  }

  if (resultBuffer.length) await appendResults(job.id, resultBuffer);

  const finishedAt = nowISO();
  await writeMeta(job.id, {
    status: "concluido",
    total: ids.length,
    processed,
    applied,
    skipped,
    errors,
    finished_at: finishedAt,
    cancelRequested: false,
  });
  await job.progress(100);

  await auditAtacadoEvent(
    data,
    job.id,
    "wholesale_price_job_completed",
    errors > 0 ? "warn" : "success",
    {
      total_items: ids.length,
      processed,
      applied,
      skipped,
      errors,
      promo_only: data.promoOnly !== false,
      wholesale_tier_count: requestedTierSummary.tier_count,
      wholesale_tiers: requestedTierSummary.tiers,
      billing_telemetry: telemetryFrom(job, {
        total: ids.length,
        processed,
        applied,
        skipped,
        errors,
        started_at: startedAt,
        finished_at: finishedAt,
      }),
    },
  );

  return { ok: true, total: ids.length, processed, applied, skipped, errors };
}

class AtacadoJobsService {
  static initWorker() {
    const queue = getQueue();
    if (workerStarted) return queue;

    workerStarted = true;
    queue.process(WORKER_CONCURRENCY, async (job) => {
      let heavyLease = null;
      let refreshTimer = null;
      const activeLoad = isActiveLoadJob(job.data);
      try {
        heavyLease = await waitForHeavyOperationLease({
          accountKey: job.data?.accountKey,
          kind: activeLoad ? "wholesale-active-load" : "wholesale",
          ownerId: `${activeLoad ? "wholesale-load" : "wholesale"}:${job.id}`,
          metadata: {
            job_id: String(job.id),
            active_load: activeLoad,
          },
          lane: activeLoad ? "read" : "write",
          onWait: async (holder) => {
            await writeMeta(job.id, {
              status: "aguardando",
              queueReason: "heavy_operation_busy",
              heavyOperationHolder: holder || null,
            });
          },
          shouldCancel: async () => {
            const meta = (await readMeta(job.id)) || {};
            return meta.cancelRequested === true || meta.status === "cancelado";
          },
        });

        refreshTimer = setInterval(() => {
          heavyLease?.refresh?.().catch(() => {});
        }, 60_000);
        refreshTimer.unref?.();

        return activeLoad ? await runActiveLoadJob(job) : await runJob(job);
      } catch (rawError) {
        const error =
          rawError?.code === "HEAVY_OPERATION_WAIT_CANCELLED"
            ? new AtacadoJobCancelledError()
            : rawError;
        const meta = (await readMeta(job.id)) || {};
        if (error instanceof AtacadoJobCancelledError) {
          const finishedAt = nowISO();
          await writeMeta(job.id, {
            status: "cancelado",
            finished_at: finishedAt,
            cancelRequested: false,
          });
          await job.progress(100);
          await auditAtacadoEvent(
            job.data || {},
            job.id,
            activeLoad ? "wholesale_active_load_canceled" : "wholesale_price_job_canceled",
            "warn",
            {
              action: activeLoad ? "load_active_wholesale_items" : "apply_wholesale_price",
              total_items: Number(meta.total || job.data?.itemIds?.length || 0),
              processed: Number(meta.processed || 0),
              loaded: activeLoad ? Number(meta.loaded || 0) : undefined,
              applied: Number(meta.applied || 0),
              skipped: Number(meta.skipped || 0),
              errors: Number(meta.errors || 0),
              billing_telemetry: activeLoad
                ? null
                : telemetryFrom(job, {
                    ...meta,
                    finished_at: finishedAt,
                  }),
            },
          );
          return {
            ok: false,
            cancelled: true,
            total: Number(meta.total || job.data?.itemIds?.length || 0),
            processed: Number(meta.processed || 0),
            applied: Number(meta.applied || 0),
            skipped: Number(meta.skipped || 0),
            errors: Number(meta.errors || 0),
          };
        }

        await writeMeta(job.id, {
          status: "erro",
          finished_at: nowISO(),
          error: safeText(error?.message || String(error)),
        });
        await auditAtacadoEvent(
          job.data || {},
          job.id,
          activeLoad ? "wholesale_active_load_failed" : "wholesale_price_job_failed",
          "error",
          {
            action: activeLoad ? "load_active_wholesale_items" : "apply_wholesale_price",
            total_items: Number(meta.total || job.data?.itemIds?.length || 0),
            processed: Number(meta.processed || 0),
            loaded: activeLoad ? Number(meta.loaded || 0) : undefined,
            applied: Number(meta.applied || 0),
            skipped: Number(meta.skipped || 0),
            errors: Number(meta.errors || 0),
            billing_telemetry: activeLoad
              ? null
              : telemetryFrom(job, {
                  ...meta,
                  finished_at: nowISO(),
                }),
            error: safeText(error?.message || String(error)),
          },
        );
        throw error;
      } finally {
        if (refreshTimer) clearInterval(refreshTimer);
        await heavyLease?.release?.().catch(() => {});
      }
    });

    queue.on("completed", async (job) => {
      if (isActiveLoadJob(job?.data)) return;
      const meta = (await readMeta(job.id)) || {};
      await settleAtacadoJob(job, meta);
    });

    queue.on("failed", async (job, error) => {
      console.error("[AtacadoJobsService] job failed:", job?.id, error?.message || error);
      if (isActiveLoadJob(job?.data)) return;
      const meta = (await readMeta(job.id)) || {};
      await settleAtacadoJob(job, meta);
    });

    console.log(
      `[AtacadoJobsService] worker Bull inicializado (concurrency=${WORKER_CONCURRENCY})`,
    );
    return queue;
  }

  static async previewCredits({
    itemIds = [],
    dryRun = false,
    mlCreds = {},
    account = null,
  } = {}) {
    rejectWholesaleSimulation(dryRun);
    const ids = Array.from(
      new Set(
        (itemIds || [])
          .map((value) => String(value || "").trim().toUpperCase())
          .filter(Boolean),
      ),
    );
    if (!ids.length) throw new Error("Nenhum anuncio informado para calcular o custo do atacado.");
    const operationKey = wholesaleBillingOperationKey();
    const quote = await quoteCredits({
      mlCreds,
      account,
      operationKey,
      units: ids.length,
    });
    return {
      operation_key: operationKey,
      quantity: ids.length,
      estimated_credits: Number(quote?.estimated_credits || 0),
      available_credits:
        quote?.available_credits == null ? null : Number(quote.available_credits),
      sufficient: quote?.sufficient !== false,
      unlimited: quote?.unlimited === true,
      quote,
    };
  }

  static async enqueueActiveLoad({
    extraDiscountPercent = 1,
    mlCreds = {},
    accountKey = null,
    accountLabel = null,
    auditContext = null,
  } = {}) {
    const normalizedAccount = normalizeAccountKey(accountKey);
    if (!normalizedAccount) throw new Error("Conta obrigatoria para carregar anuncios ativos.");

    const operationId = `WHOLESALE-LOAD-${crypto.randomUUID()}`;
    const job = await getQueue().add(
      {
        kind: "atacado-load-active",
        operationId,
        title: "Carregar ativos do Atacado",
        extraDiscountPercent: Number(extraDiscountPercent) || 1,
        mlCreds,
        accountKey: normalizedAccount,
        accountLabel: accountLabel || normalizedAccount,
        auditContext: auditContext && typeof auditContext === "object" ? auditContext : null,
        createdAt: Date.now(),
      },
      {
        jobId: `job_atacado_${operationId}`,
        attempts: 1,
        removeOnComplete: 50,
        removeOnFail: false,
      },
    );

    await writeMeta(job.id, {
      status: "aguardando",
      total: 0,
      processed: 0,
      loaded: 0,
      applied: 0,
      skipped: 0,
      errors: 0,
      cancelRequested: false,
      created_at: nowISO(),
    });

    return shapeJob(job);
  }

  static async enqueue({
    itemIds = [],
    extraDiscountPercent = 1,
    minPurchaseUnit = 2,
    tierConfigs = null,
    promoOnly = true,
    dryRun = false,
    mlCreds = {},
    accountKey = null,
    accountLabel = null,
    auditContext = null,
  }) {
    rejectWholesaleSimulation(dryRun);
    const ids = Array.from(
      new Set(
        (itemIds || [])
          .map((value) => String(value || "").trim().toUpperCase())
          .filter(Boolean),
      ),
    );
    const normalizedAccount = normalizeAccountKey(accountKey);
    if (!ids.length) throw new Error("Nenhum anuncio informado para o job de atacado.");
    if (!normalizedAccount) throw new Error("Conta obrigatoria para iniciar job de atacado.");

    const operationId = `WHOLESALE-${crypto.randomUUID()}`;
    const billingOperationKey = wholesaleBillingOperationKey();
    const creditReservation = await reserveCredits({
      mlCreds,
      operationKey: billingOperationKey,
      units: ids.length,
      idempotencyKey: wholesaleBillingIdempotencyKey(operationId),
    });

    const queue = getQueue();
    let job;
    try {
      job = await queue.add(
        {
          kind: "atacado",
          operationId,
          billingOperationKey,
          title: `Aplicar Atacado - ${ids.length} item(ns)`,
          itemIds: ids,
          extraDiscountPercent: Number(extraDiscountPercent),
          minPurchaseUnit: Number(minPurchaseUnit),
          tierConfigs: Array.isArray(tierConfigs) ? tierConfigs : null,
          promoOnly: promoOnly !== false,
          mlCreds,
          accountKey: normalizedAccount,
          accountLabel: accountLabel || normalizedAccount,
          auditContext: auditContext && typeof auditContext === "object" ? auditContext : null,
          creditReservation,
          createdAt: Date.now(),
        },
        {
          jobId: `job_atacado_${operationId}`,
          attempts: 1,
          removeOnComplete: 200,
          removeOnFail: false,
        },
      );

      await writeMeta(job.id, {
        status: "aguardando",
        total: ids.length,
        processed: 0,
        applied: 0,
        skipped: 0,
        errors: 0,
        credit_settlement:
          creditReservation?.bypass || creditReservation?.shadow
            ? null
            : wholesaleSettlementSummary(creditReservation),
        cancelRequested: false,
        created_at: nowISO(),
      });
    } catch (error) {
      await settleCredits(creditReservation, { release: true }).catch(() => {});
      throw error;
    }

    return shapeJob(job);
  }

  static async listRecent(limit = 20, { accountKey = null } = {}) {
    const queue = getQueue();
    const jobs = await queue.getJobs(
      ["active", "waiting", "delayed", "failed", "completed"],
      0,
      Math.max(0, Number(limit || 20) - 1),
      false,
    );
    const scoped = jobs.filter((job) => canAccessJob(job, accountKey));
    const mapped = await Promise.all(scoped.map((job) => shapeJob(job)));
    return mapped.filter(Boolean);
  }

  static async jobDetail(id, { accountKey = null, includeResults = true } = {}) {
    const job = await getQueue().getJob(resolveJobId(id));
    if (!job || !canAccessJob(job, accountKey)) return null;
    return shapeJob(job, { includeResults: includeResults !== false });
  }

  static async cancelJob(id, { accountKey = null } = {}) {
    const job = await getQueue().getJob(resolveJobId(id));
    if (!job || !canAccessJob(job, accountKey)) return null;
    const state = await job.getState().catch(() => "unknown");
    const meta = (await readMeta(job.id)) || {};

    if (["completed", "failed"].includes(state) || ["concluido", "cancelado", "erro"].includes(meta.status)) {
      return { ok: false, status: meta.status || state, error: "Job ja finalizado." };
    }

    const cancelBeforeProcessing =
      ["waiting", "delayed"].includes(state) && Number(meta.processed || 0) <= 0;
    await writeMeta(job.id, {
      status: cancelBeforeProcessing ? "cancelado" : "cancelando",
      cancelRequested: true,
      cancel_requested: true,
    });
    if (cancelBeforeProcessing) {
      await settleAtacadoJob(job, meta, { release: true });
    }

    return {
      ok: true,
      status: cancelBeforeProcessing ? "cancelado" : "cancelando",
    };
  }

  static async getJobXlsx(id, { accountKey = null } = {}) {
    const job = await getQueue().getJob(resolveJobId(id));
    if (!job || !canAccessJob(job, accountKey) || isActiveLoadJob(job.data)) return null;
    const meta = (await readMeta(job.id)) || {};
    const bullState = await job.getState().catch(() => "unknown");
    const status = String(meta.status || (bullState === "completed" ? "concluido" : bullState === "failed" ? "erro" : "processando"));
    if (!["concluido", "cancelado", "erro"].includes(status)) return null;
    const rows = await readResults(job.id);
    if (!rows.length) return null;
    return {
      filename: `atacado_${job.id}.xlsx`,
      buffer: await buildAtacadoResultsWorkbook(rows, {
        jobId: job.id,
        operationId: job.data?.operationId,
        accountLabel: job.data?.accountLabel || job.data?.accountKey,
        status,
        total: meta.total || job.data?.itemIds?.length,
        processed: meta.processed,
        applied: meta.applied,
        skipped: meta.skipped,
        errors: meta.errors,
        startedAt: meta.started_at,
        finishedAt: meta.finished_at,
        tierConfigs: job.data?.tierConfigs,
      }),
    };
  }
}

AtacadoJobsService._test = {
  isActiveLoadJob,
  explicitAtacadoLifecycleStatus,
  attachAtacadoJobContract,
  scanActiveLoadPages,
  wholesaleBillingOperationKey,
  rejectWholesaleSimulation,
  wholesaleBillingIdempotencyKey,
  wholesaleBillableUnits,
  wholesaleSettlementSummary,
  settleAtacadoJob,
  telemetryFrom,
  atacadoResultAction,
  buildAtacadoResultsWorkbook,
};

module.exports = AtacadoJobsService;
