// routes/promocoesRoutes.js
const express = require("express");
const crypto = require("crypto");
const fetch = require("node-fetch");
const TokenService = require("../services/tokenService");
const { getSharedRedis } = require("../lib/redisClient");
const multer = require("multer");
const { createAuditAction } = require("../middleware/auditAction");
const {
  getRequestIp,
  getRequestUserAgent,
} = require("../services/authAuditService");
const {
  attachJobContract,
  backendJobIdFromUid,
} = require("../services/jobContract");
let XLSX = null;
try {
  XLSX = require("xlsx");
} catch {
  XLSX = null;
}
let ExcelJS = null;
try {
  ExcelJS = require("exceljs");
} catch {
  ExcelJS = null;
}

// Serviços opcionais (se existirem)
let PromoJobsService = null;
try {
  PromoJobsService = require("../services/promoJobsService");
} catch {
  PromoJobsService = null;
}

let PromoSmartOptimizerService = null;
try {
  PromoSmartOptimizerService = require("../services/promoSmartOptimizerService");
} catch {
  PromoSmartOptimizerService = null;
}

// Adapter para remoção em massa (reutiliza seu services/promocaoService.js)
let PromoBulkRemove = null;
try {
  PromoBulkRemove = require("../services/promoBulkRemoveAdapter");
} catch {
  PromoBulkRemove = null;
}
let promoBulkRemoveWorkerBooted = false;

function ensurePromoBulkRemoveWorker() {
  if (promoBulkRemoveWorkerBooted || !PromoBulkRemove?.initWorker) return;
  try {
    PromoBulkRemove.initWorker();
    promoBulkRemoveWorkerBooted = true;
  } catch (error) {
    console.error("[promocoesRoutes] erro ao iniciar worker de remocao:", error?.message || error);
  }
}

// Store de seleção (fase 2)
let PromoSelectionStore = null;
try {
  PromoSelectionStore = require("../services/promoSelectionStore");
} catch {
  PromoSelectionStore = null;
}

let PromoOfferRefsService = null;
try {
  PromoOfferRefsService = require("../services/promoOfferRefsService");
} catch {
  PromoOfferRefsService = null;
}

const PROMO_JOB_SOURCE_BULL = "promo";
const PROMO_JOB_SOURCE_REMOVE = "remove";
const PROMO_JOB_SOURCE_SMART = "smart";
const SELECTION_PREPARE_CACHE_TTL_MS = 10 * 60 * 1000;
const SELECTION_PREPARE_SYNC_WAIT_MS = 8 * 1000;
const SELECTION_PREPARE_RETRY_MS = 2 * 1000;
const MANUAL_PROMO_MAX_PERCENT = 60;
const MANUAL_PROMO_PERCENT_TOLERANCE = Math.max(
  0,
  Number(process.env.PROMO_MANUAL_PERCENT_TOLERANCE || 1),
);
const MANUAL_PROMO_PERCENT_LOWER_ROUNDING_TOLERANCE = Math.max(
  0,
  Number(process.env.PROMO_MANUAL_PERCENT_LOWER_ROUNDING_TOLERANCE || 0.05),
);
const selectionPrepareCache = new Map();
const selectionPrepareInFlight = new Map();
const selectionPrepareStateLocal = new Map();
const SELECTION_PREPARE_STATE_TTL_MS = Math.max(
  SELECTION_PREPARE_CACHE_TTL_MS,
  Number(process.env.PROMO_SELECTION_PREPARE_STATE_TTL_MS || 15 * 60 * 1000),
);

function selectionPrepareRedis() {
  try { return getSharedRedis("promo-selection-prepare"); } catch { return null; }
}

function selectionPreparationId(cacheKey) {
  return crypto.createHash("sha1").update(String(cacheKey || "")).digest("hex").slice(0, 24);
}

function selectionPreparationStateKey(id) {
  return `promo:selection-prepare:state:${String(id || "")}`;
}

function selectionPreparationLockKey(id) {
  return `promo:selection-prepare:lock:${String(id || "")}`;
}

function getLocalSelectionPreparationState(id) {
  const key = String(id || "");
  if (!key) return null;
  const entry = selectionPrepareStateLocal.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    selectionPrepareStateLocal.delete(key);
    return null;
  }
  return entry.state || null;
}

async function getSelectionPreparationState(id) {
  const key = String(id || "");
  if (!key) return null;
  const redis = selectionPrepareRedis();
  if (redis) {
    try {
      const raw = await redis.get(selectionPreparationStateKey(key));
      if (raw) {
        const parsed = JSON.parse(raw);
        selectionPrepareStateLocal.set(key, {
          expiresAt: Date.now() + SELECTION_PREPARE_STATE_TTL_MS,
          state: parsed,
        });
        return parsed;
      }
    } catch {}
  }
  return getLocalSelectionPreparationState(key);
}

async function setSelectionPreparationState(id, state) {
  const key = String(id || "");
  if (!key) return;
  const safeState = state || {};
  selectionPrepareStateLocal.set(key, {
    expiresAt: Date.now() + SELECTION_PREPARE_STATE_TTL_MS,
    state: safeState,
  });
  const redis = selectionPrepareRedis();
  if (!redis) return;
  try {
    await redis.set(
      selectionPreparationStateKey(key),
      JSON.stringify(safeState),
      "PX",
      SELECTION_PREPARE_STATE_TTL_MS,
    );
  } catch {}
}

async function acquireSelectionPreparationLock(id) {
  const redis = selectionPrepareRedis();
  if (!redis || !id) return { acquired: true, release: async () => {} };
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  try {
    const ok = await redis.set(
      selectionPreparationLockKey(id),
      token,
      "PX",
      SELECTION_PREPARE_STATE_TTL_MS,
      "NX",
    );
    return {
      acquired: ok === "OK",
      release: async () => {
        try {
          const current = await redis.get(selectionPreparationLockKey(id));
          if (current === token) await redis.del(selectionPreparationLockKey(id));
        } catch {}
      },
    };
  } catch {
    return { acquired: true, release: async () => {} };
  }
}

function encodePromotionJobId(source, id) {
  const rawId = String(id || "").trim();
  if (!rawId) return rawId;
  const rawSource = String(source || "").trim().toLowerCase();
  if (!rawSource || rawId.includes(":")) return rawId;
  return `${rawSource}:${rawId}`;
}

function normalizePromoEnqueueResult(value) {
  if (value && typeof value === "object" && value.id != null) {
    return {
      id: String(value.id),
      reused: value.reused === true,
      reusedReason: value.reusedReason || value.reused_reason || null,
      lifecycleStatus: value.lifecycle_status || null,
    };
  }
  return {
    id: String(value || ""),
    reused: false,
    reusedReason: null,
    lifecycleStatus: null,
  };
}

function decodePromotionJobId(value) {
  let decoded = String(value || "").trim();
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Mantem o valor original se vier com encoding invalido.
  }
  const raw = backendJobIdFromUid("promocoes", decoded);
  const idx = raw.indexOf(":");
  if (idx <= 0) return { source: null, rawId: raw };
  return {
    source: raw.slice(0, idx).toLowerCase(),
    rawId: raw.slice(idx + 1),
  };
}

function resolveAccountKeyFromLocals(res) {
  const fromLocals = res?.locals?.accountKey;
  const fromCreds = res?.locals?.mlCreds?.account_key;
  const raw = String(fromLocals || fromCreds || "").trim();
  if (!raw) return null;
  if (raw.toLowerCase() === "default") return null;
  return raw;
}

function buildAuditContext(req, res, accountKey = null, accountLabel = null) {
  return {
    userId: Number(req.user?.uid || req.user?.id) || null,
    email: req.user?.email || null,
    ip: getRequestIp(req),
    userAgent: getRequestUserAgent(req),
    route: req.originalUrl || req.url || null,
    method: req.method,
    accountKey: accountKey || resolveAccountKeyFromLocals(res),
    accountLabel: accountLabel || res.locals?.accountLabel || accountKey || null,
    meli_conta_id: res.locals?.mlCreds?.meli_conta_id || null,
  };
}

function cleanupSelectionPrepareCache() {
  const now = Date.now();
  for (const [key, value] of selectionPrepareCache.entries()) {
    if (!value || value.expiresAt <= now) selectionPrepareCache.delete(key);
  }
}

function normalizeMlbId(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) return "";
  if (/^\d+$/.test(raw)) return `MLB${raw}`;
  const match = raw.match(/MLB\s*-?\s*(\d+)/i);
  if (match) return `MLB${match[1]}`;
  return /^MLB\d+$/i.test(raw) ? raw : "";
}

function normalizeMlbList(value) {
  const source = Array.isArray(value)
    ? value
    : String(value || "")
        .split(/[\s,;|]+/)
        .filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const entry of source) {
    const id = normalizeMlbId(entry);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function buildSelectionPrepareCacheKey({
  accountKey,
  promotionId,
  promotionType,
  status,
  mlb,
  mlbs,
  percentMax,
  stockMin,
  stockMax,
  lightningStock,
}) {
  return JSON.stringify({
    accountKey: String(accountKey || ""),
    promotionId: String(promotionId || ""),
    promotionType: String(promotionType || "").toUpperCase(),
    status: status || null,
    mlb: mlb || null,
    mlbs: Array.isArray(mlbs) && mlbs.length ? [...mlbs].sort() : null,
    percentMax: percentMax == null ? null : Number(percentMax),
    stockMin: stockMin == null ? null : Number(stockMin),
    stockMax: stockMax == null ? null : Number(stockMax),
    lightningStock: lightningStock == null ? null : Number(lightningStock),
  });
}

function getSelectionPrepareCacheEntry(key) {
  cleanupSelectionPrepareCache();
  const hit = selectionPrepareCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    selectionPrepareCache.delete(key);
    return null;
  }
  return hit.value || null;
}

function setSelectionPrepareCacheEntry(key, value) {
  cleanupSelectionPrepareCache();
  selectionPrepareCache.set(key, {
    expiresAt: Date.now() + SELECTION_PREPARE_CACHE_TTL_MS,
    value,
  });
}

function getSelectionPrepareInFlight(key) {
  const entry = selectionPrepareInFlight.get(key);
  if (!entry) return null;
  return entry;
}

function setSelectionPrepareInFlight(key, promise) {
  selectionPrepareInFlight.set(key, promise);
  promise.finally(() => {
    if (selectionPrepareInFlight.get(key) === promise) {
      selectionPrepareInFlight.delete(key);
    }
  });
  return promise;
}

function buildSelectionPrepareSuccessPayload({
  accountKey,
  promotionId,
  promotionType,
  status,
  mlb,
  mlbs = null,
  percentMaxNum,
  stockMinNum = null,
  stockMaxNum = null,
  lightningStockNum = null,
  ids,
  token = null,
  meta = null,
  cached = false,
  cachedAt = null,
}) {
  return {
    ok: true,
    token,
    total: Array.isArray(ids) ? ids.length : 0,
    meta: meta || {
      accountKey,
      promotionId,
      promotionType,
      filters: {
        status: status || null,
        mlb: mlb || null,
        mlbs: Array.isArray(mlbs) && mlbs.length ? mlbs : null,
        percent_max: percentMaxNum,
        stock_min: stockMinNum,
        stock_max: stockMaxNum,
        lightning_stock: lightningStockNum,
      },
      ...(cached ? { cached: true, cached_at: cachedAt } : {}),
    },
    ids,
  };
}

function buildUserPromotionDedupeKey(entry) {
  const type = String(entry?.type || entry?.promotion_type || "").toUpperCase();
  const id = String(entry?.id || entry?.promotion_id || entry?.code || "").trim();
  if (!id) return null;
  if (type !== "LIGHTNING") return id;

  const start = String(entry?.start_date || entry?.valid_from || "").trim();
  const finish = String(entry?.finish_date || entry?.valid_to || "").trim();
  const name = String(entry?.name || entry?.title || entry?.promotion_name || "").trim();
  if (!start && !finish) return [id, type].join("|");
  return [id, type, start, finish, name].join("|");
}

const core = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

/** Fetch com Authorization + 1 tentativa de renovação em 401 */
async function authFetch(req, url, init = {}, creds = {}) {
  let token = req?.access_token || null;
  if (!token) token = await TokenService.renovarTokenSeNecessario(creds);

  const call = async (tkn) => {
    const headers = {
      Accept: "application/json",
      ...(init.headers || {}),
      Authorization: `Bearer ${tkn}`,
    };
    return fetch(url, { ...init, headers });
  };

  let resp = await call(token);
  if (resp.status !== 401) return resp;

  const renewed = await TokenService.renovarToken(creds);
  const newToken = renewed?.access_token;
  return call(newToken);
}

/** Helper: lotear array */
function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function stripSuggestedDiscountedPrice(entry) {
  if (!entry || typeof entry !== "object") return entry;
  return {
    ...entry,
    offers: Array.isArray(entry?.offers)
      ? entry.offers.map((offer) =>
          offer && typeof offer === "object"
            ? { ...offer, suggested_discounted_price: undefined }
            : offer
        )
      : entry.offers,
    suggested_discounted_price: undefined,
  };
}

function needsDealFallbackDetail(item, promotionType) {
  const typeUp = String(item?.type || promotionType || "").toUpperCase();
  if (!["DEAL", "LIGHTNING"].includes(typeUp)) return false;
  const status = normalizeStatusServer(item?.status);
  const hasRange =
    toNumSafe(item?.min_discounted_price) != null ||
    toNumSafe(item?.max_discounted_price) != null;
  return ["candidate", "pending", "scheduled"].includes(status) && !hasRange;
}

async function fetchItemPromotionSnapshot(req, creds, itemId, promotionId) {
  const url = `https://api.mercadolibre.com/seller-promotions/items/${encodeURIComponent(
    itemId
  )}?app_version=v2`;
  const r = await authFetch(req, url, {}, creds);
  if (!r.ok) return null;
  const payload = await r.json().catch(() => []);
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.results)
    ? payload.results
    : [];
  return (
    list.find((entry) => String(entry?.id || entry?.promotion_id) === String(promotionId)) ||
    null
  );
}

function resolveApplyMethodForItem(promotionType, snapshot) {
  const typeUp = String(promotionType || "").toUpperCase();
  const status = normalizeStatusServer(snapshot?.status);

  if (typeUp === "SELLER_CAMPAIGN" || typeUp === "DEAL") {
    if (status === "started" || status === "pending" || status === "scheduled") {
      return "PUT";
    }
  }

  return "POST";
}

function requiresDealManualPercent(type) {
  return ["DEAL", "PRICE_DISCOUNT", "DOD", "LIGHTNING"].includes(String(type || "").toUpperCase());
}

function isValidManualPromoPercent(value) {
  const pct = Number(value);
  return Number.isFinite(pct) && pct > 0 && pct <= MANUAL_PROMO_MAX_PERCENT;
}

function manualPromoPercentMessage(field) {
  return `${field} é obrigatório e deve estar entre 0,01 e ${MANUAL_PROMO_MAX_PERCENT}%.`;
}

function round2Server(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function computeDealPriceFromPercentServer(originalPrice, percent) {
  const original = toNumSafe(originalPrice);
  const pct = toNumSafe(percent);
  if (original == null || original <= 0) return null;
  if (pct == null || pct <= 0 || pct >= 100) return null;
  return round2Server(original * (1 - pct / 100));
}

function computePercentFromDealPriceServer(originalPrice, dealPrice) {
  const original = toNumSafe(originalPrice);
  const deal = toNumSafe(dealPrice);
  if (original == null || original <= 0 || deal == null || deal <= 0) return null;
  return round2Server(100 * (1 - deal / original));
}

function validateManualDealPricePercentServer({
  originalPrice,
  dealPrice,
  requestedPercent,
}) {
  const requested = toNumSafe(requestedPercent);
  if (!isValidManualPromoPercent(requested)) {
    return {
      ok: false,
      error: "Percentual manual invalido ou ausente.",
      requested_percent: requested,
      calculated_percent: null,
    };
  }
  const calculated = computePercentFromDealPriceServer(originalPrice, dealPrice);
  if (calculated == null) {
    return {
      ok: false,
      error: "Nao foi possivel confirmar a % efetiva antes de aplicar.",
      requested_percent: requested,
      calculated_percent: null,
    };
  }
  const minAllowed = round2Server(requested - MANUAL_PROMO_PERCENT_LOWER_ROUNDING_TOLERANCE);
  const maxAllowed = round2Server(
    Math.min(MANUAL_PROMO_MAX_PERCENT, requested + MANUAL_PROMO_PERCENT_TOLERANCE)
  );
  if (calculated < minAllowed || calculated > maxAllowed) {
    return {
      ok: false,
      error: `Aplicacao bloqueada: percentual calculado ${calculated}% fora do limite permitido para ${requested}% (maximo ${maxAllowed}%).`,
      requested_percent: round2Server(requested),
      calculated_percent: round2Server(calculated),
      min_allowed_percent: minAllowed,
      max_allowed_percent: maxAllowed,
    };
  }
  return {
    ok: true,
    requested_percent: round2Server(requested),
    calculated_percent: round2Server(calculated),
  };
}

async function resolveOriginalPriceForManualGuardServer(req, creds, itemId, source = {}) {
  const details = await fetchItemsDetailsMap(req, creds, [itemId]).catch(() => ({}));
  // /items.price representa o preco regular atual do anuncio. Nao usar sale_price
  // como base do percentual manual para evitar desconto em cascata.
  const current = toNumSafe(
    details?.[itemId]?.price ??
      details?.[String(itemId || "").toUpperCase()]?.price,
  );
  const candidates = [
    source?.original_price,
    source?.item_original_price,
    source?.regular_amount,
    source?.base_price,
    current,
    source?.price,
  ]
    .map(toNumSafe)
    .filter((value) => value != null && value > 0);

  if (!candidates.length) return null;
  return Math.max(...candidates);
}

function computeDealDiscountRangeServer(item) {
  const original = toNumSafe(item?.original_price ?? item?.price ?? null);
  const minPrice = toNumSafe(item?.min_discounted_price);
  let maxPrice = toNumSafe(item?.max_discounted_price);
  const typeUp = String(item?.promotion_type ?? item?.type ?? "").toUpperCase();
  const lightningPrice = toNumSafe(item?.price);

  if (
    typeUp === "LIGHTNING" &&
    maxPrice == null &&
    lightningPrice != null &&
    lightningPrice > 0 &&
    lightningPrice < original &&
    (minPrice == null || lightningPrice >= minPrice)
  ) {
    maxPrice = lightningPrice;
  }
  const toPct = (price) =>
    original != null && original > 0 && price != null
      ? round2Server(((original - price) / original) * 100)
      : null;

  return {
    minPrice,
    maxPrice,
    minPct: toPct(maxPrice),
    maxPct: toPct(minPrice),
  };
}

function isDealPercentWithinRangeServer(item, percent, tolerance = 0.01) {
  const pct = toNumSafe(percent);
  if (pct == null) return false;
  const range = computeDealDiscountRangeServer(item);
  const lo = range.minPct;
  const hi = range.maxPct;
  if (lo == null || hi == null) return false;
  return pct + tolerance >= lo && pct - tolerance <= hi;
}

function attachPromotionJobContract(job, options = {}) {
  const backendJobId =
    options.backendJobId ||
    job?.backend_job_id ||
    job?.id ||
    job?.job_id ||
    job?.process_id;
  return attachJobContract(job, {
    module: "promocoes",
    kind: options.kind || job?.source || job?.kind || "promo",
    backendJobId,
    ...options,
  });
}

function promotionJobIdentity(backendJobId, source = PROMO_JOB_SOURCE_BULL) {
  const contracted = attachPromotionJobContract({
    id: backendJobId,
    source,
    status: "queued",
    completed: false,
    progress: 0,
  }, { backendJobId, kind: source });
  return {
    job_uid: contracted.job_uid,
    backend_job_id: contracted.backend_job_id,
    lifecycle_status: contracted.lifecycle_status,
    job_contract: contracted.job_contract,
  };
}

function computeCurrentDealPercentServer(item) {
  const original = toNumSafe(item?.original_price);
  if (original == null || original <= 0) return null;

  const finalPrice = toNumSafe(
    item?.deal_price ?? item?.new_price ?? item?._resolved_final_price,
  );
  if (finalPrice != null && finalPrice > 0 && finalPrice < original) {
    return round2Server(((original - finalPrice) / original) * 100);
  }

  const explicitPercent = toNumSafe(
    item?.discount_percentage ?? item?.discountPercent,
  );
  return explicitPercent != null && explicitPercent > 0
    ? round2Server(explicitPercent)
    : null;
}

function isDealPercentApplicableServer(item, percent, tolerance = 0.01) {
  const targetPercent = toNumSafe(percent);
  if (targetPercent == null) return false;
  const status = normalizeStatusServer(item?.status);
  const range = computeDealDiscountRangeServer(item);
  const isExistingOffer = ["started", "pending", "scheduled"].includes(status);

  if (isExistingOffer) {
    const currentPercent = computeCurrentDealPercentServer(item);
    if (currentPercent == null || targetPercent <= currentPercent + tolerance) {
      return false;
    }
  }

  if (range.minPct != null && range.maxPct != null) {
    return isDealPercentWithinRangeServer(item, targetPercent, tolerance);
  }

  // O ML não retorna min/max para ofertas DEAL já criadas. Para participantes
  // e programados, só preparamos aumentos de desconto; o PUT do ML continua
  // sendo a validação final do novo preço.
  return isExistingOffer;
}

function isSellerPercentApplicableServer(item, percent, tolerance = 0.01) {
  return isDealPercentApplicableServer(
    { ...item, promotion_type: "SELLER_CAMPAIGN" },
    percent,
    tolerance,
  );
}

function mergeManualPromotionRowsServer(rows, promotionType) {
  const list = (Array.isArray(rows) ? rows : []).filter(
    (row) => row && typeof row === "object",
  );
  if (!list.length) return null;

  const existing =
    list.find((row) => normalizeStatusServer(row?.status) === "started") ||
    list.find((row) => normalizeStatusServer(row?.status) === "pending") ||
    list.find((row) => normalizeStatusServer(row?.status) === "scheduled") ||
    null;
  const candidate =
    list.find((row) => normalizeStatusServer(row?.status) === "candidate") || null;
  const rangeRow =
    list.find((row) => {
      const range = computeDealDiscountRangeServer({
        ...row,
        promotion_type: promotionType,
      });
      return range.minPct != null && range.maxPct != null;
    }) || null;
  const base = existing || candidate || list[0];
  const merged = {
    ...(candidate || {}),
    ...(rangeRow || {}),
    ...base,
    promotion_type: String(promotionType || "").toUpperCase(),
  };

  if (rangeRow) {
    merged.min_discounted_price = rangeRow.min_discounted_price ?? null;
    merged.max_discounted_price = rangeRow.max_discounted_price ?? null;
  }
  if (existing) {
    merged.status = existing.status;
    merged.original_price =
      existing.original_price ?? rangeRow?.original_price ?? candidate?.original_price ?? null;
    merged.price = existing.price ?? null;
    merged.deal_price = existing.deal_price ?? existing.new_price ?? null;
    merged.new_price = existing.new_price ?? null;
    merged.discount_percentage = existing.discount_percentage ?? null;
  }

  return merged;
}

function preferPromotionSnapshot(rawRow, snapshot, promotionType) {
  const raw = rawRow || {};
  const snap = snapshot || {};
  const typeUp = String(raw?.type || promotionType || snap?.type || "").toUpperCase();
  const status = normalizeStatusServer(raw?.status ?? snap?.status);

  if (
    !["DEAL", "LIGHTNING"].includes(typeUp) ||
    !["candidate", "pending", "scheduled"].includes(status)
  ) {
    return { ...snap, ...raw };
  }

  return {
    ...raw,
    ...snap,
    id: raw.id ?? snap.id,
    item_id: raw.item_id ?? snap.item_id,
    status: raw.status ?? snap.status,
    original_price: snap.original_price ?? raw.original_price,
    price: snap.price ?? raw.price,
    deal_price: snap.deal_price ?? snap.new_price ?? raw.deal_price ?? raw.new_price,
    min_discounted_price: snap.min_discounted_price ?? raw.min_discounted_price,
    max_discounted_price: snap.max_discounted_price ?? raw.max_discounted_price,
    discount_percentage: snap.discount_percentage ?? raw.discount_percentage,
    offers: snap.offers ?? raw.offers,
    ref_id: snap.ref_id ?? raw.ref_id,
  };
}

function detectPreferredSource(rawRow, snapshot, promotionType) {
  const raw = rawRow || {};
  const snap = snapshot || {};
  const typeUp = String(raw?.type || promotionType || snap?.type || "").toUpperCase();
  const status = normalizeStatusServer(raw?.status ?? snap?.status);

  if (
    ["DEAL", "LIGHTNING"].includes(typeUp) &&
    ["candidate", "pending", "scheduled"].includes(status)
  ) {
    const snapMin = toNumSafe(snap?.min_discounted_price);
    const rawMin = toNumSafe(raw?.min_discounted_price);
    const snapMax = toNumSafe(snap?.max_discounted_price);
    const rawMax = toNumSafe(raw?.max_discounted_price);
    if (snapMin != null && snapMin !== rawMin) return "item_snapshot";
    if (snapMax != null && snapMax !== rawMax) return "item_snapshot";
    if (snapMin != null || snapMax != null) return "item_snapshot";
  }

  if (Object.keys(snap).length > 0) return "promotion_items";
  return "none";
}

async function fetchPromotionItemFromListing(req, creds, promotionId, promotionType, itemId) {
  const normalizedItemId = String(itemId || "").trim().toUpperCase();
  if (!normalizedItemId) {
    return { found: false, page: 0, error: "item_id obrigatorio" };
  }

  const qs = new URLSearchParams();
  qs.set("promotion_type", String(promotionType || "DEAL").toUpperCase());
  qs.set("item_id", normalizedItemId);
  qs.set("app_version", "v2");

  const url = `https://api.mercadolibre.com/seller-promotions/promotions/${encodeURIComponent(
    promotionId
  )}/items?${qs.toString()}`;
  const response = await authFetch(req, url, {}, creds);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return {
      found: false,
      page: 1,
      error: `HTTP ${response.status}`,
      body,
    };
  }

  const json = await response.json().catch(() => ({}));
  const results = Array.isArray(json?.results) ? json.results : [];
  const match = results.find(
    (row) =>
      String(row?.id || row?.item_id || "").trim().toUpperCase() ===
      normalizedItemId,
  );

  return {
    found: !!match,
    page: 1,
    search_after: null,
    row: match || null,
  };
}

function buildPromotionDebugPayload({
  itemId,
  promotionId,
  promotionType,
  listingRow,
  itemPromotions,
  itemPromotionMatch,
  mergedRow,
  resolved,
  itemDetails,
  rangeSummary,
}) {
  return {
    item_id: itemId,
    promotion_id: promotionId,
    promotion_type: promotionType,
    item_details: itemDetails || null,
    sources: {
      promotion_items_row: listingRow || null,
      item_promotions_match: itemPromotionMatch || null,
      item_promotions_all: itemPromotions || [],
    },
    chosen_source: mergedRow?._source ?? "unknown",
    range_summary: rangeSummary || null,
    merged_preview: mergedRow || null,
    resolved_preview: resolved || null,
  };
}

function roundDebug(value, digits = 2) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const factor = 10 ** digits;
  return Math.round((num + Number.EPSILON) * factor) / factor;
}

function pctFromOriginal(original, targetPrice) {
  const orig = toNumSafe(original);
  const price = toNumSafe(targetPrice);
  if (orig == null || orig <= 0 || price == null) return null;
  return roundDebug(((orig - price) / orig) * 100, 2);
}

function buildDealRangeSummary(original, mergedRow) {
  const orig = toNumSafe(original);
  if (orig == null || orig <= 0) return null;

  const minPrice = toNumSafe(mergedRow?.min_discounted_price);
  const maxPrice = toNumSafe(mergedRow?.max_discounted_price);
  const resolvedPrice = toNumSafe(mergedRow?._resolved_final_price);

  return {
    valid_price_range: {
      min_price: minPrice,
      max_price: maxPrice,
    },
    valid_discount_range: {
      min_pct: pctFromOriginal(orig, maxPrice),
      max_pct: pctFromOriginal(orig, minPrice),
    },
    reference_prices: {
      panel_like_price: maxPrice,
      panel_like_pct: pctFromOriginal(orig, maxPrice),
      resolved_price: resolvedPrice,
      resolved_pct: pctFromOriginal(orig, resolvedPrice),
    },
  };
}

function sanitizeSheetCell(value) {
  if (value == null) return "";
  return String(value);
}

function sleepServer(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function authFetchWithRetryOn429(req, url, opts, creds, retryOptions = {}) {
  const retries = Number(retryOptions.retries ?? 4);
  const baseDelayMs = Number(retryOptions.baseDelayMs ?? 800);
  const retryServerErrors = retryOptions.retryServerErrors === true;

  let lastResponse = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    lastResponse = await authFetch(req, url, opts, creds);
    const shouldRetry =
      lastResponse.status === 429 ||
      (retryServerErrors && lastResponse.status >= 500 && lastResponse.status <= 599);
    if (!shouldRetry) return lastResponse;
    if (attempt >= retries) return lastResponse;
    await lastResponse.arrayBuffer().catch(() => null);
    await sleepServer(baseDelayMs * (attempt + 1));
  }
  return lastResponse;
}

function isSellerCampaignNoCandidatesError(body) {
  return String(body?.message || "").toLowerCase().includes("no candidates found");
}

async function parseJsonResponseSafe(response) {
  const text = await response.text().catch(() => "");
  try {
    return { text, json: text ? JSON.parse(text) : {} };
  } catch {
    return { text, json: { raw: text } };
  }
}

function buildExportFilename(name) {
  const base = String(name || "seller-campaign")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "_");
  return `${base || "seller-campaign"}-${stamp}.xlsx`;
}

async function fetchItemsDetailsMap(req, creds, itemIds) {
  const details = {};
  for (const group of chunk(itemIds, 20)) {
    const urlItems = `https://api.mercadolibre.com/items?ids=${encodeURIComponent(
      group.join(",")
    )}&attributes=${encodeURIComponent(
      "id,title,seller_custom_field,price"
    )}`;
    const ir = await authFetch(req, urlItems, {}, creds);
    if (!ir.ok) continue;
    const blob = await ir.json().catch(() => []);
    (Array.isArray(blob) ? blob : []).forEach((row) => {
      const body = row?.body || row || {};
      if (!body?.id) return;
      details[body.id] = {
        title: body.title || "",
        seller_custom_field: body.seller_custom_field || "",
        price: toNumSafe(body.price),
      };
    });
  }
  return details;
}

async function fetchItemsAvailableQuantityMap(req, creds, itemIds) {
  const quantities = {};
  for (const group of chunk(itemIds, 20)) {
    const urlItems = `https://api.mercadolibre.com/items?ids=${encodeURIComponent(
      group.join(",")
    )}&attributes=${encodeURIComponent("id,available_quantity")}`;
    const response = await authFetchWithRetryOn429(req, urlItems, {}, creds, {
      retries: 3,
      baseDelayMs: 500,
    });
    if (!response.ok) continue;
    const rows = await response.json().catch(() => []);
    (Array.isArray(rows) ? rows : []).forEach((row) => {
      const body = row?.body || row || {};
      const id = String(body?.id || "").trim().toUpperCase();
      const available = Number(body?.available_quantity);
      if (id && Number.isFinite(available)) quantities[id] = available;
    });
  }
  return quantities;
}

async function buildSellerCampaignExportRows(req, creds, options = {}) {
  const {
    promotion_id,
    promotion_type,
    item_ids = [],
    seller_manual_percent = null,
  } = options;

  const uniqueIds = [...new Set((Array.isArray(item_ids) ? item_ids : []).map((id) => String(id || "").trim()).filter(Boolean))];
  if (!uniqueIds.length) return [];

  const itemsDetails = await fetchItemsDetailsMap(req, creds, uniqueIds);
  const rows = [];

  for (const itemId of uniqueIds) {
    const snapshot = await fetchItemPromotionSnapshot(
      req,
      creds,
      itemId,
      promotion_id
    ).catch(() => null);
    const details = itemsDetails[itemId] || {};
    const originalPrice =
      toNumSafe(snapshot?.original_price) ??
      toNumSafe(details?.price) ??
      toNumSafe(snapshot?.price) ??
      null;
    const computedPct =
      toNumSafe(seller_manual_percent) ??
      computeDescPctServer(snapshot || {}, promotion_type, null);
    const finalPrice =
      computeDealPriceFromPercentServer(originalPrice, computedPct) ??
      resolveDealFinalAndPct({
        original_price: originalPrice,
        status: snapshot?.status,
        deal_price: snapshot?.deal_price ?? snapshot?.new_price,
        min_discounted_price: snapshot?.min_discounted_price,
        max_discounted_price: snapshot?.max_discounted_price,
        price: snapshot?.price,
        discount_percentage: snapshot?.discount_percentage,
      }).final;

    rows.push({
      "Titulo do anuncio": sanitizeSheetCell(details.title || snapshot?.title || ""),
      "Numero do anuncio": itemId,
      SKU: sanitizeSheetCell(details.seller_custom_field || snapshot?.seller_custom_field || ""),
      "Preco original": originalPrice != null ? round2Server(originalPrice) : "",
      Porcentagem: computedPct != null ? round2Server(computedPct) : "",
      "Preco final": finalPrice != null ? round2Server(finalPrice) : "",
      "Status campanha": sanitizeSheetCell(normalizeStatusServer(snapshot?.status || "")),
    });
  }

  return rows;
}

/** Heurística única para resolver preço final e % em DEAL/SELLER
 * Lida com o caso em que "price" vem como DESCONTO EM R$ (e não preço final).
 * Permite ajustar limiares por env:
 * - ML_DEAL_MAX_GAP=0.70 (gap máximo aceitável entre original e final)
 */
// ===== Helper DEAL/SELLER: escolhe preço final e % com regras seguras
function resolveDealFinalAndPct(raw) {
  const orig = Number(
    raw.original_price || raw.originalPrice || raw.price || 0
  );
  const status = String(raw.status || "").toLowerCase();
  const typeUp = String(raw.promotion_type || raw.type || "").toUpperCase();
  const isSellerCampaign = typeUp === "SELLER_CAMPAIGN";
  const isDeal = typeUp === "DEAL" || typeUp === "LIGHTNING";

  const deal = Number(raw.deal_price || raw.new_price || 0);
  const minD = Number(raw.min_discounted_price || 0);
  const maxD = Number(raw.max_discounted_price || 0);
  const px = Number(raw.price || 0); // pode ser PREÇO FINAL ou DESCONTO em R$
  const mlPct = Number(raw.discount_percentage || raw.discountPercent || NaN);

  if (!orig || !isFinite(orig) || orig <= 0) return { final: null, pct: null };

  // Limites seguros (ajustáveis por env)
  const GAP = Number(process.env.ML_DEAL_MAX_GAP || 0.7); // 70% de gap para validar "preço final"
  const PCT_MIN = Number(process.env.ML_DEAL_PLAUSIBLE_PCT_MIN || 5); // 5%
  const PCT_MAX = Number(process.env.ML_DEAL_PLAUSIBLE_PCT_MAX || 40); // 40%
  const ALLOW_ML_PCT_FALLBACK =
    String(process.env.ML_DEAL_ALLOW_ML_PERCENT_FALLBACK || "true") === "true";

  const isPlausibleFinal = (v) =>
    isFinite(v) && v > 0 && v < orig && (orig - v) / orig < GAP;
  const isPlausiblePct = (p) => isFinite(p) && p >= PCT_MIN && p <= PCT_MAX;

  const isCandLike =
    status === "candidate" || status === "scheduled" || status === "pending";
  const noSuggestions =
    !(isFinite(minD) && minD > 0) &&
    !(isFinite(maxD) && maxD > 0);

  let final = null;

  // 1) started => confiar no deal/new_price
  if (status === "started" && isPlausibleFinal(deal)) final = deal;

  // 2) DEAL candidato/pendente: o painel do ML hoje reflete o teto (max_discounted_price)
  if (!final && isDeal && isCandLike && isPlausibleFinal(maxD)) final = maxD;

  // 3) demais promoções configuráveis: faixa min -> max
  if (!final) {
    if (!isDeal && isPlausibleFinal(minD)) final = minD;
    if (!final && !isDeal && isPlausibleFinal(maxD)) final = maxD;
  }

  // 3) CANDIDATE-like sem sugestões:
  // DEAL pode vir com "price" representando desconto em R$.
  // SELLER_CAMPAIGN não deve usar essa inferência.
  if (
    !final &&
    !isDeal &&
    !isSellerCampaign &&
    isCandLike &&
    noSuggestions &&
    isFinite(px) &&
    px > 0
  ) {
    const pctFromPrice = (px / orig) * 100;
    if (isPlausiblePct(pctFromPrice)) {
      const candidateFinal = orig - px;
      if (isPlausibleFinal(candidateFinal)) {
        final = candidateFinal; // usamos desconto em R$
      }
    }
  }

  // 5) fallback opcional com % do ML (quando não há sugestões e price==0)
  if (
    !final &&
    !isDeal &&
    isCandLike &&
    noSuggestions &&
    (!isFinite(px) || px === 0) &&
    ALLOW_ML_PCT_FALLBACK &&
    isPlausiblePct(mlPct)
  ) {
    const est = orig * (1 - mlPct / 100);
    if (isPlausibleFinal(est)) final = est;
  }

  // 6) fora de candidate-like, podemos ainda aceitar px como final plausível
  if (!final && !isCandLike && isFinite(px) && px > 0 && isPlausibleFinal(px))
    final = px;

  if (!final) return { final: null, pct: null };
  const pct = Math.max(0, Math.min(100, ((orig - final) / orig) * 100));
  return { final: Number(final.toFixed(2)), pct: Number(pct.toFixed(2)) };
}

/* ===========================================================
 * HELPERS COMPARTILHADOS COM selection/prepare
 * (espelham a lógica do front: computeDescPct)
 * =========================================================== */

function toNumSafe(x) {
  if (x === null || x === undefined || x === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function normalizePositiveIntSafe(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function resolveLightningApplyStock(raw) {
  let value;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    value = normalizePositiveIntSafe(
      raw.selected ?? raw.value ?? raw.quantity ?? raw.min ?? raw.max
    );
  } else {
    value = normalizePositiveIntSafe(raw);
  }
  return value != null && value >= 5 ? value : null;
}

function getLightningStockBoundsServer(item) {
  const stock = item?.stock && typeof item.stock === "object" ? item.stock : {};
  return {
    min: normalizePositiveIntSafe(
      stock.min ?? item?.stock_min ?? item?.min_stock ?? item?.minimum_stock ?? item?.min_quantity
    ),
    max: normalizePositiveIntSafe(
      stock.max ?? item?.stock_max ?? item?.max_stock ?? item?.maximum_stock ?? item?.max_quantity
    ),
  };
}

function normalizeStatusServer(s) {
  s = String(s || "").toLowerCase();
  if (s === "in_progress") return "pending";
  return s;
}

/** Lê rebate (MELI/Seller) de diversos formatos do payload + promotion_benefits */
function pickRebateServer(obj, promotionBenefits) {
  const b = obj?.benefits || {};
  const meli = toNumSafe(
    obj?.meli_percentage ??
      obj?.meli_percent ??
      b?.meli_percent ??
      promotionBenefits?.meli_percent
  );
  const seller = toNumSafe(
    obj?.seller_percentage ??
      obj?.seller_percent ??
      b?.seller_percent ??
      promotionBenefits?.seller_percent
  );
  const type =
    b?.type || promotionBenefits?.type || (meli != null ? "REBATE" : null);
  return { type, meli, seller };
}

/**
 * Calcula a % de desconto considerando o tipo de campanha,
 * o item bruto do ML e, opcionalmente, promotion_benefits do response.
 * Ã‰ o espelho da computeDescPct do front.
 */
function computeDescPctServer(it, promotionType, promotionBenefits) {
  const typeUp = String(promotionType || it.type || "").toUpperCase();
  const original = toNumSafe(it.original_price ?? it.price ?? null);
  const st = normalizeStatusServer(it.status);

  // PRE_NEGOTIATED: o teto usa o desconto base pre-acordado (preco original
  // versus price acordado). Rebate e boost nao alteram essa trava.
  if (typeUp === "PRE_NEGOTIATED") {
    const preOriginal = toNumSafe(
      it.original_price ?? it.item_original_price ?? it.regular_amount ?? it.base_price,
    );
    const prePrice = toNumSafe(
      it.deal_price ?? it.new_price ?? it._resolved_final_price ?? it.price,
    );
    if (
      preOriginal != null &&
      preOriginal > 0 &&
      prePrice != null &&
      prePrice > 0 &&
      prePrice <= preOriginal
    ) {
      return (1 - prePrice / preOriginal) * 100;
    }
    return toNumSafe(it.discount_percentage);
  }

  // SMART / PRICE_MATCHING: soma MELI + Seller quando faltar % do ML
  if (
    ["SMART", "PRICE_MATCHING", "PRICE_MATCHING_MELI_ALL"].includes(typeUp)
  ) {
    if (original != null) {
      const rb = pickRebateServer(it, promotionBenefits);
      const m =
        toNumSafe(it.meli_percentage) ??
        toNumSafe(it.rebate_meli_percent) ??
        toNumSafe(rb.meli);
      const s = toNumSafe(it.seller_percentage) ?? toNumSafe(rb.seller);
      const tot = toNumSafe((m || 0) + (s || 0));
      const mlDisc = toNumSafe(it.discount_percentage);
      if (mlDisc == null && (m != null || s != null)) return tot;
      return mlDisc;
    }
    return toNumSafe(it.discount_percentage);
  }

  // DEAL / SELLER_* : usa heurística de resolução baseada em min/max
  if (["DEAL", "SELLER_CAMPAIGN", "PRICE_DISCOUNT", "DOD", "LIGHTNING"].includes(typeUp)) {
    const { pct } = resolveDealFinalAndPct({
      original_price: original,
      status: st,
      promotion_type: typeUp,
      deal_price: it.deal_price ?? it.new_price,
      min_discounted_price: it.min_discounted_price,
      max_discounted_price: it.max_discounted_price,
      price: it.price,
      discount_percentage: it.discount_percentage,
    });

    const mlPct = toNumSafe(it.discount_percentage);
    const isCandLike =
      st === "candidate" || st === "scheduled" || st === "pending";

    if (isCandLike) return pct; // melhor null do que um valor claramente errado

    // Se o ML mandar um % muito maluco, preferimos o pct da heurística
    if (mlPct != null && mlPct > 70 && pct != null && Math.abs(mlPct - pct) > 5)
      return pct;

    return mlPct != null ? mlPct : pct;
  }

  // Fallback genérico
  const deal = toNumSafe(it.deal_price ?? it.new_price ?? it._resolved_final_price ?? null);
  if (original != null && deal != null && original > 0) {
    return (1 - deal / original) * 100;
  }
  return toNumSafe(it.discount_percentage);
}

function shouldFetchSnapshotForPreparePercentFilter(item, promotionType) {
  const typeUp = String(item?.type || promotionType || "").toUpperCase();
  if (typeUp === "SELLER_CAMPAIGN") {
    const pct = computeDescPctServer(item, typeUp, null);
    const original = toNumSafe(item?.original_price ?? item?.price ?? null);
    const hasPriceHints =
      toNumSafe(item?.deal_price ?? item?.new_price ?? null) != null ||
      toNumSafe(item?.min_discounted_price) != null ||
      toNumSafe(item?.max_discounted_price) != null ||
      toNumSafe(item?.discount_percentage) != null;

    return pct == null || (original == null && !hasPriceHints);
  }
  if (typeUp === "DEAL" || typeUp === "DOD" || typeUp === "LIGHTNING") return needsDealFallbackDetail(item, typeUp);
  return false;
}

function isOfferBasedPromotionType(promotionType) {
  const typeUp = String(promotionType || "").toUpperCase();
  return (
    typeUp === "SMART" ||
    typeUp === "PRE_NEGOTIATED" ||
    typeUp === "UNHEALTHY_STOCK" ||
    typeUp === "PRICE_MATCHING" ||
    typeUp.startsWith("PRICE_MATCHING")
  );
}

function isSmartLikePromotionType(promotionType) {
  const typeUp = String(promotionType || "").toUpperCase();
  return (
    typeUp === "SMART" ||
    typeUp === "PRE_NEGOTIATED" ||
    typeUp.startsWith("PRICE_MATCHING")
  );
}

function directOfferRefForPercentVariant(item, promotionType) {
  const strict = isStrictPreparedSelectionPromotionType(promotionType);
  const refs = [
    item?._variant_offer_id,
    item?.offer_id,
    item?.candidate_id,
    item?.offer_candidate_id,
    item?.candidate?.id,
    item?.ref_id,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  return strict
    ? refs.find((value) => !isCandidateLikeId(value)) || null
    : refs[0] || null;
}

function selectOfferWithinPercentCap(item, promotionType, promotionBenefits, percentCap) {
  const base = item && typeof item === "object" ? item : {};
  const itemId = String(base.id || base.item_id || "").trim().toUpperCase();
  const cap = toNumSafe(percentCap);
  if (!itemId || cap == null) return null;

  const variants = [{ ...base }];
  if (Array.isArray(base.offers)) {
    for (const offer of base.offers) {
      if (!offer || typeof offer !== "object") continue;
      const hasOfferPercentHints =
        toNumSafe(offer.discount_percentage) != null ||
        toNumSafe(offer.meli_percentage) != null ||
        toNumSafe(offer.seller_percentage) != null ||
        toNumSafe(offer.rebate_meli_percent) != null ||
        toNumSafe(offer?.benefits?.meli_percent) != null ||
        toNumSafe(offer?.benefits?.seller_percent) != null;
      variants.push({
        ...base,
        ...offer,
        id: itemId,
        item_id: itemId,
        _variant_offer_id:
          offer.offer_id ?? offer.id ?? offer.candidate_id ?? null,
        original_price: offer.original_price ?? base.original_price ?? null,
        discount_percentage: hasOfferPercentHints
          ? offer.discount_percentage ?? null
          : base.discount_percentage ?? null,
        meli_percentage: offer.meli_percentage ?? base.meli_percentage ?? null,
        seller_percentage: offer.seller_percentage ?? base.seller_percentage ?? null,
        rebate_meli_percent:
          offer.rebate_meli_percent ?? base.rebate_meli_percent ?? null,
        benefits: offer.benefits ?? base.benefits ?? null,
      });
    }
  }

  const eligible = variants
    .map((variant) => {
      const offerId = directOfferRefForPercentVariant(variant, promotionType);
      const percent = computeDescPctServer(
        variant,
        promotionType,
        promotionBenefits,
      );
      return {
        variant,
        offerId,
        percent: toNumSafe(percent),
      };
    })
    .filter(
      (entry) =>
        entry.offerId &&
        entry.percent != null &&
        entry.percent <= cap + 0.0001,
    )
    .sort((a, b) => b.percent - a.percent);

  const selected = eligible[0];
  if (!selected) return null;

  return {
    ...selected.variant,
    id: itemId,
    item_id: itemId,
    offer_id: selected.offerId,
    discount_percentage: round2Server(selected.percent),
    _selected_offer_id: selected.offerId,
    _selected_discount_percentage: round2Server(selected.percent),
    _offer_locked: true,
  };
}

async function fetchOfferWithinPercentCapForItem(
  req,
  creds,
  promotionId,
  promotionType,
  itemId,
  percentCap,
) {
  const params = new URLSearchParams();
  params.set("promotion_type", String(promotionType || "").toUpperCase());
  params.set("item_id", String(itemId || "").toUpperCase());
  params.set("limit", "50");
  params.set("app_version", "v2");

  const url = `https://api.mercadolibre.com/seller-promotions/promotions/${encodeURIComponent(
    promotionId,
  )}/items?${params.toString()}`;
  const response = await authFetch(req, url, {}, creds);
  if (!response.ok) return null;

  const json = await response.json().catch(() => ({}));
  const benefits = json?.promotion_benefits || null;
  const matches = (Array.isArray(json?.results) ? json.results : [])
    .filter(
      (row) =>
        String(row?.id || row?.item_id || "").toUpperCase() ===
        String(itemId || "").toUpperCase(),
    )
    .map((row) =>
      selectOfferWithinPercentCap(
        row,
        promotionType,
        benefits,
        percentCap,
      ),
    )
    .filter(Boolean)
    .sort(
      (a, b) =>
        Number(b?._selected_discount_percentage || 0) -
        Number(a?._selected_discount_percentage || 0),
    );

  return matches[0] || null;
}

function compactPreparedOfferSelectionItem(item) {
  if (!item || typeof item !== "object") {
    return { id: normalizeMlbId(item) };
  }
  return {
    id: String(item.id || item.item_id || "").trim().toUpperCase(),
    item_id: String(item.item_id || item.id || "").trim().toUpperCase(),
    status: item.status ?? null,
    type: item.type ?? item.promotion_type ?? null,
    original_price: item.original_price ?? null,
    price: item.price ?? null,
    deal_price: item.deal_price ?? item.new_price ?? null,
    discount_percentage: item.discount_percentage ?? null,
    meli_percentage: item.meli_percentage ?? null,
    seller_percentage: item.seller_percentage ?? null,
    rebate_meli_percent: item.rebate_meli_percent ?? null,
    offer_id: item.offer_id ?? item._selected_offer_id ?? null,
    candidate_id: item.candidate_id ?? null,
    ref_id: item.ref_id ?? null,
    _selected_offer_id: item._selected_offer_id ?? item.offer_id ?? null,
    _selected_discount_percentage:
      item._selected_discount_percentage ?? item.discount_percentage ?? null,
    _offer_locked: item._offer_locked === true,
  };
}

function isStrictPreparedSelectionPromotionType(promotionType) {
  const typeUp = String(promotionType || "").toUpperCase();
  return typeUp === "PRE_NEGOTIATED" || typeUp === "UNHEALTHY_STOCK";
}

function isCandidateLikeId(value) {
  return /^CANDIDATE-[A-Z0-9-]+$/i.test(String(value || ""));
}

function isCandidateNotFoundMlError(body) {
  const message = String(body?.message || body?.error || "").toUpperCase();
  if (message.includes("CANDIDATE_NOT_FOUND")) return true;
  const causes = Array.isArray(body?.cause) ? body.cause : [];
  return causes.some((cause) =>
    String(cause?.error_code || cause?.code || "").toUpperCase() === "CANDIDATE_NOT_FOUND"
  );
}

function collectOfferLikeIdsFromItem(item) {
  const out = new Set();
  const add = (value) => {
    const text = String(value || "").trim();
    if (text) out.add(text);
  };

  add(item?.offer_id);
  add(item?.candidate_id);
  add(item?.offer_candidate_id);
  add(item?.candidate?.id);
  add(item?.ref_id);

  if (Array.isArray(item?.offers)) {
    for (const offer of item.offers) {
      add(offer?.offer_id);
      add(offer?.id);
      add(offer?.candidate_id);
    }
  }

  return [...out];
}

function collectApplyOfferRefsFromPromotionItem(item, promotionType) {
  const refs = [];
  const add = (value) => {
    const text = String(value || "").trim();
    if (!text || refs.includes(text)) return;
    refs.push(text);
  };

  const strictType = isStrictPreparedSelectionPromotionType(promotionType);

  add(item?.offer_id);
  if (strictType) add(item?.ref_id);

  if (Array.isArray(item?.offers)) {
    for (const offer of item.offers) add(offer?.offer_id);
    for (const offer of item.offers) add(offer?.id);
    for (const offer of item.offers) add(offer?.candidate_id);
  }

  if (!strictType) add(item?.ref_id);
  add(item?.candidate_id);
  add(item?.offer_candidate_id);
  add(item?.candidate?.id);

  if (!refs.length && isOfferBasedPromotionType(promotionType)) {
    for (const value of collectOfferLikeIdsFromItem(item)) add(value);
  }

  return refs;
}

function pickCandidateIdFromItem(item) {
  const ids = collectOfferLikeIdsFromItem(item);
  return ids.find((value) => isCandidateLikeId(value)) || null;
}

async function fetchOfferIdsForItem(req, creds, itemId, promotionId, promotionType, candidateId) {
  const cachedRows =
    PromoOfferRefsService?.findOfferRefs && creds?.meli_conta_id
      ? await PromoOfferRefsService.findOfferRefs({
          meliContaId: creds.meli_conta_id,
          itemId,
          promotionId,
          promotionType,
          candidateId,
        }).catch(() => [])
      : [];
  const cachedIds = [
    ...new Set(
      (Array.isArray(cachedRows) ? cachedRows : [])
        .flatMap((row) => [row?.offer_id, row?.candidate_id])
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  ];
  if (cachedIds.length) return cachedIds;

  const url = `https://api.mercadolibre.com/seller-promotions/items/${encodeURIComponent(
    itemId
  )}?app_version=v2`;
  const response = await authFetch(req, url, {}, creds);
  if (!response.ok) return [];

  const payload = await response.json().catch(() => []);
  const promotions = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.results)
    ? payload.results
    : [];
  const ids = new Set();

  for (const promotion of promotions) {
    if (
      promotionId &&
      String(promotion?.id || promotion?.promotion_id || "") !== String(promotionId)
    ) {
      continue;
    }
    const offerLike = collectOfferLikeIdsFromItem(promotion);
    for (const value of offerLike) ids.add(value);
  }

  return [...ids];
}

async function enrichPreparedSelectionItem(
  req,
  creds,
  item,
  promotionId,
  promotionType,
  promotionBenefits
) {
  const base = item && typeof item === "object" ? { ...item } : {};
  const itemId = String(base.id || base.item_id || "").trim().toUpperCase();
  if (!itemId) return null;

  const typeUp = String(promotionType || "").toUpperCase();
  const candidateId = pickCandidateIdFromItem(base);
  const selectedOfferId = String(
    base._selected_offer_id || base.offer_id || "",
  ).trim() || null;
  let offerIds = collectOfferLikeIdsFromItem(base);

  if (isOfferBasedPromotionType(typeUp) && !offerIds.length) {
    offerIds = await fetchOfferIdsForItem(
      req,
      creds,
      itemId,
      promotionId,
      typeUp,
      candidateId
    ).catch(() => []);
  }

  const concreteOfferId =
    selectedOfferId ||
    offerIds.find((value) => !isCandidateLikeId(value)) ||
    (isSmartLikePromotionType(typeUp)
      ? offerIds.find((value) => isCandidateLikeId(value))
      : null) ||
    null;
  const resolvedCandidateId =
    candidateId || offerIds.find((value) => isCandidateLikeId(value)) || null;

  return {
    id: itemId,
    item_id: itemId,
    status: base.status || null,
    type: base.type || typeUp,
    original_price: base.original_price ?? null,
    price: base.price ?? null,
    available_quantity: base.available_quantity ?? null,
    stock: base.stock ?? null,
    deal_price: base.deal_price ?? base.new_price ?? null,
    new_price: base.new_price ?? null,
    min_discounted_price: base.min_discounted_price ?? null,
    max_discounted_price: base.max_discounted_price ?? null,
    discount_percentage:
      base._selected_discount_percentage ??
      base.discount_percentage ??
      computeDescPctServer(base, typeUp, promotionBenefits) ??
      null,
    meli_percentage: base.meli_percentage ?? null,
    seller_percentage: base.seller_percentage ?? null,
    rebate_meli_percent: base.rebate_meli_percent ?? null,
    promotion_id: promotionId,
    promotion_type: typeUp,
    offer_id: concreteOfferId,
    candidate_id: resolvedCandidateId,
    ref_id: base.ref_id || null,
    _selected_offer_id: selectedOfferId || concreteOfferId,
    _selected_discount_percentage:
      base._selected_discount_percentage ?? base.discount_percentage ?? null,
    _offer_locked: base._offer_locked === true || !!selectedOfferId,
    offers: Array.isArray(base.offers)
      ? base.offers.slice(0, 5).map((offer) => ({
          offer_id: offer?.offer_id ?? null,
          id: offer?.id ?? null,
          candidate_id: offer?.candidate_id ?? null,
        }))
      : [],
  };
}

/**
 * CRIAR CAMPANHA DO VENDEDOR
 * POST /api/promocoes/promotions
 */
core.post(
  "/api/promocoes/promotions",
  createAuditAction({
    evento: "promotion_created",
    metadata: (req) => ({
      promotion_type: req.body?.promotion_type || null,
      name: req.body?.name || null,
      start_date: req.body?.start_date || null,
      finish_date: req.body?.finish_date || null,
    }),
  }),
  async (req, res) => {
  try {
    const creds = res.locals.mlCreds || {};
    const {
      promotion_type,
      name,
      sub_type = "FLEXIBLE_PERCENTAGE",
      start_date,
      finish_date,
    } = req.body || {};

    if (String(promotion_type || "").toUpperCase() !== "SELLER_CAMPAIGN") {
      return res.status(400).json({
        ok: false,
        error: "Este endpoint cria apenas SELLER_CAMPAIGN.",
      });
    }
    if (!name || !start_date || !finish_date) {
      return res.status(400).json({
        ok: false,
        error: "name, start_date e finish_date são obrigatórios.",
      });
    }

    const start = new Date(String(start_date));
    const finish = new Date(String(finish_date));
    if (Number.isNaN(start.getTime()) || Number.isNaN(finish.getTime())) {
      return res.status(400).json({
        ok: false,
        error: "start_date e finish_date devem ser datas válidas.",
      });
    }
    if (finish < start) {
      return res.status(400).json({
        ok: false,
        error: "finish_date não pode ser menor que start_date.",
      });
    }

    const diffDays = Math.floor((finish - start) / 86400000) + 1;
    if (diffDays > 31) {
      return res.status(400).json({
        ok: false,
        error: "A seller campaign permite no máximo 31 dias.",
      });
    }

    const upstream = await authFetch(
      req,
      "https://api.mercadolibre.com/seller-promotions/promotions?app_version=v2",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          promotion_type: "SELLER_CAMPAIGN",
          name: String(name).trim(),
          sub_type: String(sub_type || "FLEXIBLE_PERCENTAGE"),
          start_date,
          finish_date,
        }),
      },
      creds
    );

    const text = await upstream.text().catch(() => "");
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        ok: false,
        error: json?.message || json?.error || "Falha ao criar seller campaign.",
        detail: json,
      });
    }

    return res.status(201).json({ ok: true, campaign: json });
  } catch (e) {
    console.error("[/api/promocoes/promotions] erro:", e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
  },
);

/**
 * EDITAR CAMPANHA DO VENDEDOR
 * PUT /api/promocoes/promotions/:promotionId
 */
core.put(
  "/api/promocoes/promotions/:promotionId",
  createAuditAction({
    evento: "promotion_updated",
    metadata: (req) => ({
      promotion_id: req.params?.promotionId || null,
      promotion_type: req.body?.promotion_type || null,
      promotion_status: req.body?.promotion_status || null,
      name: req.body?.name || null,
      start_date: req.body?.start_date || null,
      finish_date: req.body?.finish_date || null,
    }),
  }),
  async (req, res) => {
  try {
    const creds = res.locals.mlCreds || {};
    const { promotionId } = req.params;
    const {
      promotion_type,
      promotion_status,
      name,
      sub_type = "FLEXIBLE_PERCENTAGE",
      start_date,
      finish_date,
    } = req.body || {};

    if (String(promotion_type || "").toUpperCase() !== "SELLER_CAMPAIGN") {
      return res.status(400).json({
        ok: false,
        error: "Este endpoint edita apenas SELLER_CAMPAIGN.",
      });
    }
    if (!promotionId) {
      return res.status(400).json({
        ok: false,
        error: "promotionId é obrigatório.",
      });
    }
    if (!name || !start_date || !finish_date) {
      return res.status(400).json({
        ok: false,
        error: "name, start_date e finish_date são obrigatórios.",
      });
    }

    const start = new Date(String(start_date));
    const finish = new Date(String(finish_date));
    if (Number.isNaN(start.getTime()) || Number.isNaN(finish.getTime())) {
      return res.status(400).json({
        ok: false,
        error: "start_date e finish_date devem ser datas válidas.",
      });
    }
    if (finish < start) {
      return res.status(400).json({
        ok: false,
        error: "finish_date não pode ser menor que start_date.",
      });
    }

    const diffDays = Math.floor((finish - start) / 86400000) + 1;
    if (diffDays > 31) {
      return res.status(400).json({
        ok: false,
        error: "A seller campaign permite no máximo 31 dias.",
      });
    }

    const normalizedStatus = String(promotion_status || "").toLowerCase();
    const payload = {
      promotion_type: "SELLER_CAMPAIGN",
      name: String(name).trim(),
      finish_date,
    };

    if (normalizedStatus !== "started" && start_date) {
      payload.start_date = start_date;
    }

    if (sub_type) {
      payload.sub_type = String(sub_type || "FLEXIBLE_PERCENTAGE");
    }

    const upstream = await authFetch(
      req,
      `https://api.mercadolibre.com/seller-promotions/promotions/${encodeURIComponent(
        promotionId
      )}?app_version=v2`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      creds
    );

    const text = await upstream.text().catch(() => "");
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        ok: false,
        error: json?.message || json?.error || "Falha ao editar seller campaign.",
        detail: json,
      });
    }

    return res.json({ ok: true, campaign: json });
  } catch (e) {
    console.error("[/api/promocoes/promotions/:promotionId] put erro:", e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
  },
);

/**
 * EXCLUIR CAMPANHA DO VENDEDOR
 * DELETE /api/promocoes/promotions/:promotionId
 */
core.delete(
  "/api/promocoes/promotions/:promotionId",
  createAuditAction({
    evento: "promotion_deleted",
    metadata: (req) => ({
      promotion_id: req.params?.promotionId || null,
      promotion_type: req.query?.promotion_type || req.body?.promotion_type || null,
    }),
  }),
  async (req, res) => {
  try {
    const creds = res.locals.mlCreds || {};
    const { promotionId } = req.params;
    const promotionType = String(
      req.body?.promotion_type || req.query?.promotion_type || "SELLER_CAMPAIGN"
    ).toUpperCase();

    if (!promotionId) {
      return res.status(400).json({
        ok: false,
        error: "promotionId é obrigatório.",
      });
    }

    if (promotionType !== "SELLER_CAMPAIGN") {
      return res.status(400).json({
        ok: false,
        error: `promotion_type inválido para exclusão de campanha: ${promotionType}`,
      });
    }

    const params = new URLSearchParams();
    params.set("promotion_type", promotionType);
    params.set("app_version", "v2");

    const upstream = await authFetch(
      req,
      `https://api.mercadolibre.com/seller-promotions/promotions/${encodeURIComponent(
        promotionId
      )}?${params.toString()}`,
      { method: "DELETE" },
      creds
    );

    const text = await upstream.text().catch(() => "");
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = text ? { raw: text } : {};
    }

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        ok: false,
        error:
          json?.message ||
          json?.error ||
          "Falha ao excluir seller campaign no Mercado Livre.",
        detail: json,
      });
    }

    return res.json({
      ok: true,
      removed: true,
      promotion_id: promotionId,
      promotion_type: promotionType,
    });
  } catch (e) {
    console.error("[/api/promocoes/promotions/:promotionId] delete erro:", e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
  },
);

/** Lista promoções disponíveis para o vendedor atual */
/** Lista promoções disponíveis para o vendedor atual
 * GET /api/promocoes/users?limit=50&offset=0&status=started|scheduled|pending|all
 */
core.get("/api/promocoes/users", async (req, res) => {
  try {
    const creds = res.locals.mlCreds || {};

    // 1) users/me
    const meResp = await authFetch(
      req,
      "https://api.mercadolibre.com/users/me",
      {},
      creds
    );
    if (!meResp.ok) {
      const t = await meResp.text();
      return res
        .status(meResp.status)
        .json({ ok: false, step: "users/me", body: t });
    }
    const me = await meResp.json();
    const userId = me.id;

    // 2) paginação (do SEU backend)
    const limit = Math.min(50, Math.max(1, Number(req.query.limit || 50)));
    const offset = Math.max(0, Number(req.query.offset || 0));

    // 3) status vindo do front
    const statusIn = String(req.query.status || "")
      .trim()
      .toLowerCase();

    // helper: chama o ML e devolve JSON tolerante + status http
    async function callML(statusParam, useAppVersion = true) {
      const qs = new URLSearchParams();
      if (useAppVersion) qs.set("app_version", "v2");
      qs.set("limit", "50"); // ML pagina aqui; vamos puxar páginas internas e depois paginar no backend
      qs.set("offset", "0"); // começamos do zero e buscamos tudo (ou até um teto)
      if (statusParam) qs.set("status", String(statusParam));

      const url = `https://api.mercadolibre.com/seller-promotions/users/${userId}?${qs.toString()}`;

      const pr = await authFetch(req, url, {}, creds);
      const txt = await pr.text().catch(() => "");
      let json;
      try {
        json = txt ? JSON.parse(txt) : {};
      } catch {
        json = { raw: txt };
      }

      // fallback: se ML reclamar de app_version
      if (
        !pr.ok &&
        useAppVersion &&
        /invalid[\s_]*app_version/i.test(txt || "")
      ) {
        return callML(statusParam, false);
      }

      return { ok: pr.ok, status: pr.status, url, json, raw: txt };
    }

    // helper: extrai lista de promoções
    function extractResults(obj) {
      if (Array.isArray(obj)) return obj;
      if (Array.isArray(obj?.results)) return obj.results;
      if (Array.isArray(obj?.data?.results)) return obj.data.results;
      return [];
    }

    // helper: tenta descobrir total do ML
    function extractTotal(obj) {
      const p = obj?.paging || obj?.data?.paging || null;
      const t = Number(p?.total);
      return Number.isFinite(t) ? t : null;
    }

    // helper: busca TODAS as páginas do ML para um status (com teto)
    async function fetchAllForStatus(statusParam) {
      const merged = [];
      let pageOffset = 0;
      const ML_LIMIT = 50;
      const MAX_PAGES = 200; // trava de segurança

      // primeira chamada (pra pegar também se app_version dá erro)
      // depois seguimos usando o mesmo esquema
      for (let i = 0; i < MAX_PAGES; i++) {
        const qs = new URLSearchParams();
        qs.set("app_version", "v2");
        qs.set("limit", String(ML_LIMIT));
        qs.set("offset", String(pageOffset));
        if (statusParam) qs.set("status", String(statusParam));

        let url = `https://api.mercadolibre.com/seller-promotions/users/${userId}?${qs.toString()}`;

        let pr = await authFetch(req, url, {}, creds);
        let txt = await pr.text().catch(() => "");
        let json;
        try {
          json = txt ? JSON.parse(txt) : {};
        } catch {
          json = { raw: txt };
        }

        // fallback app_version
        if (!pr.ok && /invalid[\s_]*app_version/i.test(txt || "")) {
          const qs2 = new URLSearchParams();
          qs2.set("limit", String(ML_LIMIT));
          qs2.set("offset", String(pageOffset));
          if (statusParam) qs2.set("status", String(statusParam));
          url = `https://api.mercadolibre.com/seller-promotions/users/${userId}?${qs2.toString()}`;

          pr = await authFetch(req, url, {}, creds);
          txt = await pr.text().catch(() => "");
          try {
            json = txt ? JSON.parse(txt) : {};
          } catch {
            json = { raw: txt };
          }
        }

        if (!pr.ok) {
          // se falhou, retorna o erro do ML
          return { ok: false, status: pr.status, url, json };
        }

        const pageItems = extractResults(json).map((item) =>
          statusParam && item && typeof item === "object" && !item.status
            ? { ...item, status: statusParam }
            : item
        );
        if (!pageItems.length) break;

        merged.push(...pageItems);

        // Se veio menos que ML_LIMIT, acabou
        if (pageItems.length < ML_LIMIT) break;

        // Se o ML tem paging.total, para quando bater
        const total = extractTotal(json);
        pageOffset += ML_LIMIT;
        if (total != null && pageOffset >= total) break;
      }

      return { ok: true, status: 200, items: merged };
    }

    async function fetchAllForStatusMarketplace(statusParam) {
      const merged = [];
      let pageOffset = 0;
      const ML_LIMIT = 50;
      const MAX_PAGES = 200;

      for (let i = 0; i < MAX_PAGES; i++) {
        const qs = new URLSearchParams();
        qs.set("limit", String(ML_LIMIT));
        qs.set("offset", String(pageOffset));
        if (statusParam) qs.set("status", String(statusParam));

        const url = `https://api.mercadolibre.com/marketplace/seller-promotions/users/${userId}?${qs.toString()}`;

        const pr = await authFetch(
          req,
          url,
          { headers: { version: "v2" } },
          creds
        );
        const txt = await pr.text().catch(() => "");
        let json;
        try {
          json = txt ? JSON.parse(txt) : {};
        } catch {
          json = { raw: txt };
        }

        if (!pr.ok) {
          return { ok: false, status: pr.status, url, json };
        }

        const pageItems = extractResults(json);
        if (!pageItems.length) break;

        merged.push(...pageItems);

        if (pageItems.length < ML_LIMIT) break;

        const total = extractTotal(json);
        pageOffset += ML_LIMIT;
        if (total != null && pageOffset >= total) break;
      }

      return { ok: true, status: 200, items: merged };
    }

    async function fetchPromotionDetailCompat(promotionId, promotionType) {
      const pid = String(promotionId || "").trim();
      const pType = String(promotionType || "").trim().toUpperCase();
      if (!pid || !pType) return null;

      const directUrl = `https://api.mercadolibre.com/seller-promotions/promotions/${encodeURIComponent(
        pid
      )}?promotion_type=${encodeURIComponent(pType)}&app_version=v2`;
      const direct = await authFetch(req, directUrl, {}, creds);
      if (direct.ok) {
        const json = await direct.json().catch(() => null);
        if (json && typeof json === "object") return json;
      }

      const marketplaceUrl = `https://api.mercadolibre.com/marketplace/seller-promotions/promotions/${encodeURIComponent(
        pid
      )}?promotion_type=${encodeURIComponent(pType)}&user_id=${encodeURIComponent(
        userId
      )}`;
      const market = await authFetch(
        req,
        marketplaceUrl,
        { headers: { version: "v2" } },
        creds
      );
      if (!market.ok) return null;
      const marketJson = await market.json().catch(() => null);
      return marketJson && typeof marketJson === "object" ? marketJson : null;
    }

    // ==========================================================
    // CASO 1: status != all â†’ repassa status direto pro ML
    // ==========================================================
    if (statusIn && statusIn !== "all") {
      // Aqui a gente mantém seu comportamento original:
      // pega só uma página do ML baseada em limit/offset do front
      const qs = new URLSearchParams();
      qs.set("app_version", "v2");
      qs.set("limit", String(limit));
      qs.set("offset", String(offset));
      qs.set("status", String(statusIn));

      let url = `https://api.mercadolibre.com/seller-promotions/users/${userId}?${qs.toString()}`;

      let pr = await authFetch(req, url, {}, creds);
      let txt = await pr.text().catch(() => "");
      let json;
      try {
        json = txt ? JSON.parse(txt) : {};
      } catch {
        json = { raw: txt };
      }

      if (!pr.ok && /invalid[\s_]*app_version/i.test(txt || "")) {
        const qs2 = new URLSearchParams();
        qs2.set("limit", String(limit));
        qs2.set("offset", String(offset));
        qs2.set("status", String(statusIn));
        url = `https://api.mercadolibre.com/seller-promotions/users/${userId}?${qs2.toString()}`;

        pr = await authFetch(req, url, {}, creds);
        txt = await pr.text().catch(() => "");
        try {
          json = txt ? JSON.parse(txt) : {};
        } catch {
          json = { raw: txt };
        }
      }

      return res.status(pr.status).json({
        ok: pr.ok,
        user_id: userId,
        request: { limit, offset, status: statusIn },
        data: json,
      });
    }

    // ==========================================================
    // CASO 2: status=all (ou vazio) â†’ MERGE started/scheduled/pending/candidate
    // ==========================================================
    const lists = [];
    const listWarnings = [];
    const allNoFilter = await fetchAllForStatus(null);
    if (allNoFilter.ok && Array.isArray(allNoFilter.items) && allNoFilter.items.length) {
      lists.push(...allNoFilter.items);
    } else {
      listWarnings.push({
        source: "all",
        status: allNoFilter.status || 0,
        url: allNoFilter.url || null,
      });
    }

    const statusesToMerge = [
      "started",
      "scheduled",
      "programmed",
      "pending",
      "candidate",
    ];
    for (const st of statusesToMerge) {
      const got = await fetchAllForStatus(st);
      if (!got.ok) {
        listWarnings.push({
          source: "status",
          failed_status: st,
          status: got.status,
          url: got.url,
          data: got.json || null,
        });
        continue;
      }
      lists.push(...got.items);
    }

    if (!lists.length && listWarnings.length) {
      const first = listWarnings[0];
      return res.status(first.status || 502).json({
        ok: false,
        user_id: userId,
        step: "merge_status",
        request: { limit, offset, status: "all" },
        warnings: listWarnings,
      });
    }

    const marketplaceAll = await fetchAllForStatusMarketplace(null).catch(() => null);
    if (marketplaceAll?.ok && Array.isArray(marketplaceAll.items) && marketplaceAll.items.length) {
      lists.push(...marketplaceAll.items);
    }
    for (const st of statusesToMerge) {
      const got = await fetchAllForStatusMarketplace(st).catch(() => null);
      if (got?.ok && Array.isArray(got.items) && got.items.length) {
        lists.push(...got.items);
      }
    }

    // dedupe (LIGHTNING mantém slots distintos por período, mas evita repetir LGH geral)
    const seen = new Set();
    const merged = [];
    for (const p of lists) {
      const dedupeKey = buildUserPromotionDedupeKey(p);
      if (!dedupeKey) continue;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      merged.push(p);
    }

    const mergedEnriched = await Promise.all(
      merged.map(async (entry) => {
        const type = String(entry?.type || entry?.promotion_type || "").toUpperCase();
        const withMetrics = {
          ...entry,
          eligible_items:
            entry?.eligible_items ??
            entry?.eligible_items_count ??
            entry?.candidate_items ??
            entry?.candidate_items_count ??
            entry?.candidate_count ??
            entry?.candidates_count ??
            null,
          participating_items:
            entry?.participating_items ??
            entry?.participating_items_count ??
            entry?.started_items ??
            entry?.started_items_count ??
            entry?.started_count ??
            entry?.participants_count ??
            null,
          pending_items:
            entry?.pending_items ??
            entry?.scheduled_items ??
            null,
          promotion_items_total:
            entry?.promotion_items_total ?? entry?.items_count ?? null,
        };

        if (type !== "LIGHTNING") return withMetrics;

        const hasName = !!String(
          entry?.name || entry?.title || entry?.promotion_name || ""
        ).trim();
        const hasDates =
          !!String(entry?.start_date || entry?.valid_from || "").trim() ||
          !!String(entry?.finish_date || entry?.valid_to || "").trim();

        if (hasName && hasDates) return withMetrics;

        const detail = await fetchPromotionDetailCompat(entry?.id, type).catch(() => null);
        if (!detail) return withMetrics;

        return {
          ...detail,
          ...withMetrics,
          name:
            entry?.name ||
            detail?.name ||
            detail?.title ||
            detail?.promotion_name ||
            null,
          start_date:
            entry?.start_date || detail?.start_date || detail?.valid_from || null,
          finish_date:
            entry?.finish_date || detail?.finish_date || detail?.valid_to || null,
          deadline_date:
            entry?.deadline_date || detail?.deadline_date || null,
        };
      })
    );

    // paginação do SEU backend em cima do merged
    const paged = mergedEnriched.slice(offset, offset + limit);

    return res.json({
      ok: true,
      user_id: userId,
      request: { limit, offset, status: "all" },
      data: {
        results: paged,
        paging: {
          total: mergedEnriched.length,
          limit,
          offset,
        },
        meta: {
          counts_by_type: mergedEnriched.reduce((acc, cur) => {
            const type = String(cur?.type || cur?.promotion_type || "UNKNOWN")
              .toUpperCase();
            acc[type] = (acc[type] || 0) + 1;
            return acc;
          }, {}),
          warnings: listWarnings,
        },
      },
    });
  } catch (e) {
    console.error("[/api/promocoes/users] erro:", e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

core.get("/api/promocoes/debug/promotion-sources", async (req, res) => {
  try {
    const creds = res.locals.mlCreds || {};
    const meResp = await authFetch(
      req,
      "https://api.mercadolibre.com/users/me",
      {},
      creds
    );
    const me = await meResp.json().catch(() => ({}));
    const userId = me?.id;
    if (!userId) {
      return res.status(401).json({ ok: false, error: "user_id_not_found" });
    }

    const limit = Math.min(50, Math.max(1, Number(req.query?.limit || 20)));
    const statuses = ["", "started", "scheduled", "programmed", "pending", "candidate"];
    const promotionTypes = [
      "DOD",
      "LIGHTNING",
      "DEAL",
      "MARKETPLACE_CAMPAIGN",
      "PRICE_DISCOUNT",
      "VOLUME",
      "PRE_NEGOTIATED",
      "SELLER_CAMPAIGN",
      "SMART",
      "PRICE_MATCHING",
      "UNHEALTHY_STOCK",
      "SELLER_COUPON_CAMPAIGN",
      "SELLER_LIGHTNING_CAMPAIGN",
    ];
    const probes = [];
    const wwwProbes = [];
    const optionalProbes = [];
    const debugItemId = String(req.query?.item_id || "").trim();
    const debugPromotionIds = String(
      req.query?.promotion_ids || req.query?.promotion_id || ""
    )
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const debugPromotionTypes = String(req.query?.promotion_type || "")
      .split(",")
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean);
    const inferredPromotionTypes =
      debugPromotionTypes.length > 0
        ? debugPromotionTypes
        : debugPromotionIds.some((id) => /^C-MLB/i.test(id))
        ? ["LIGHTNING"]
        : [];
    const debugCandidateId = String(req.query?.candidate_id || "").trim();
    const debugOfferId = String(req.query?.offer_id || "").trim();

    const officialEndpointCatalog = [
      {
        key: "seller_promotions_by_user",
        method: "GET",
        path: "/seller-promotions/users/{user_id}?app_version=v2",
        purpose: "Lista convites/campanhas do vendedor.",
        needs: ["user_id"],
      },
      {
        key: "promotion_items",
        method: "GET",
        path:
          "/seller-promotions/promotions/{promotion_id}/items?promotion_type={type}&status={candidate|started|pending}&app_version=v2",
        purpose:
          "Lista itens por promocao e status; serve para contar elegiveis e participando com paginacao search_after.",
        needs: ["promotion_id", "promotion_type"],
      },
      {
        key: "promotion_items_lightning_seller_page_probe",
        method: "GET",
        path:
          "/seller-promotions/promotions/{C-MLB...}/items?promotion_type=LIGHTNING&item_id={item_id}&status_item={active|paused}&app_version=v2",
        purpose:
          "Testa se uma relampago criada pelo vendedor (C-MLB/MY_PAGE vista no painel) responde pelo contrato publico LIGHTNING.",
        needs: ["promotion_id", "item_id"],
      },
      {
        key: "item_promotions",
        method: "GET",
        path: "/seller-promotions/items/{item_id}?app_version=v2",
        purpose:
          "Lista promocoes associadas a um item; aqui aparecem PRICE_DISCOUNT e detalhes por item.",
        needs: ["item_id"],
      },
      {
        key: "item_promotion_lightning_probe",
        method: "GET",
        path:
          "/seller-promotions/items/{item_id}?promotion_type=LIGHTNING&promotion_id={C-MLB...}&app_version=v2",
        purpose:
          "Testa se um item elegivel retorna a relampago especifica quando passamos promotion_id + LIGHTNING.",
        needs: ["item_id", "promotion_id"],
      },
      {
        key: "candidate_detail",
        method: "GET",
        path: "/seller-promotions/candidates/{candidate_id}?app_version=v2",
        purpose: "Detalha um candidato recebido por notificacao public candidate.",
        needs: ["candidate_id"],
      },
      {
        key: "offer_detail",
        method: "GET",
        path: "/seller-promotions/offers/{offer_id}?app_version=v2",
        purpose: "Detalha uma oferta recebida por notificacao public offers.",
        needs: ["offer_id"],
      },
      {
        key: "apply_or_remove_item_offer",
        method: "POST/DELETE",
        path: "/seller-promotions/items/{item_id}?app_version=v2",
        purpose:
          "Aplica/remove ofertas em nivel de item, incluindo PRICE_DISCOUNT.",
        needs: ["item_id", "payload or promotion_type"],
      },
    ];

    for (const status of statuses) {
      const qs = new URLSearchParams({ limit: String(limit), offset: "0" });
      if (status) qs.set("status", status);
      probes.push({
        name: `seller-users${status ? `:${status}` : ":all"}`,
        url: `https://api.mercadolibre.com/seller-promotions/users/${userId}?${qs.toString()}`,
      });
      probes.push({
        name: `seller-users-v2${status ? `:${status}` : ":all"}`,
        url: `https://api.mercadolibre.com/seller-promotions/users/${userId}?app_version=v2&${qs.toString()}`,
      });
      probes.push({
        name: `marketplace-users${status ? `:${status}` : ":all"}`,
        url: `https://api.mercadolibre.com/marketplace/seller-promotions/users/${userId}?${qs.toString()}`,
        headers: { version: "v2" },
      });
    }

    for (const type of promotionTypes) {
      const qs = new URLSearchParams({
        promotion_type: type,
        limit: String(limit),
        offset: "0",
      });
      probes.push({
        name: `seller-promotions:${type}`,
        url: `https://api.mercadolibre.com/seller-promotions/promotions?${qs.toString()}`,
      });
      probes.push({
        name: `seller-promotions-v2:${type}`,
        url: `https://api.mercadolibre.com/seller-promotions/promotions?app_version=v2&${qs.toString()}`,
      });
      probes.push({
        name: `seller-promotions-user:${type}`,
        url: `https://api.mercadolibre.com/seller-promotions/promotions?user_id=${encodeURIComponent(
          String(userId)
        )}&${qs.toString()}`,
      });
      probes.push({
        name: `marketplace-promotions:${type}`,
        url: `https://api.mercadolibre.com/marketplace/seller-promotions/promotions?user_id=${encodeURIComponent(
          String(userId)
        )}&${qs.toString()}`,
        headers: { version: "v2" },
      });
    }

    const wwwBase =
      "https://www.mercadolivre.com.br/anuncios/lista/promos/api/items";
    const addWwwProbe = (name, filters) => {
      const qs = new URLSearchParams({
        viewId: "promos",
        filters: filters || "",
        search: "",
        sort: "",
        page: "1",
      });
      wwwProbes.push({ name, url: `${wwwBase}?${qs.toString()}` });
    };
    addWwwProbe("www-promos:all", "");
    addWwwProbe("www-promos:sellers-aggregator", "SELLERS_AGGREGATOR");
    addWwwProbe(
      "www-promos:seller-lightning-known-shape",
      "SELLER_LIGHTNING_CAMPAIGN_OFFER|SELLERS_AGGREGATOR"
    );

    const addOptionalProbe = (name, url) => {
      optionalProbes.push({ name, url });
    };

    if (debugItemId) {
      addOptionalProbe(
        "item-promotions-v2",
        `https://api.mercadolibre.com/seller-promotions/items/${encodeURIComponent(
          debugItemId
        )}?app_version=v2`
      );
      for (const type of ["LIGHTNING", "DOD", "PRICE_DISCOUNT"]) {
        const qs = new URLSearchParams({
          promotion_type: type,
          app_version: "v2",
        });
        addOptionalProbe(
          `item-promotions-v2:${type}`,
          `https://api.mercadolibre.com/seller-promotions/items/${encodeURIComponent(
            debugItemId
          )}?${qs.toString()}`
        );
      }
    }
    for (const promotionId of debugPromotionIds) {
      for (const type of inferredPromotionTypes) {
        const baseQs = new URLSearchParams({
          promotion_type: type,
          app_version: "v2",
          limit: "50",
        });
        if (debugItemId) baseQs.set("item_id", debugItemId);

        addOptionalProbe(
          `promotion-items:${type}:all:${promotionId}`,
          `https://api.mercadolibre.com/seller-promotions/promotions/${encodeURIComponent(
            promotionId
          )}/items?${baseQs.toString()}`
        );

        for (const status of ["candidate", "started", "pending", "finished"]) {
          const qs = new URLSearchParams(baseQs);
          qs.set("status", status);
          addOptionalProbe(
            `promotion-items:${type}:status:${status}:${promotionId}`,
            `https://api.mercadolibre.com/seller-promotions/promotions/${encodeURIComponent(
              promotionId
            )}/items?${qs.toString()}`
          );
        }

        for (const statusItem of ["active", "paused"]) {
          const qs = new URLSearchParams(baseQs);
          qs.set("status_item", statusItem);
          addOptionalProbe(
            `promotion-items:${type}:status-item:${statusItem}:${promotionId}`,
            `https://api.mercadolibre.com/seller-promotions/promotions/${encodeURIComponent(
              promotionId
            )}/items?${qs.toString()}`
          );
        }

        if (debugItemId) {
          const qs = new URLSearchParams({
            promotion_type: type,
            promotion_id: promotionId,
            app_version: "v2",
          });
          addOptionalProbe(
            `item-promotion:${type}:${promotionId}`,
            `https://api.mercadolibre.com/seller-promotions/items/${encodeURIComponent(
              debugItemId
            )}?${qs.toString()}`
          );
        }
      }
    }
    if (debugCandidateId) {
      optionalProbes.push({
        name: "candidate-detail-v2",
        url: `https://api.mercadolibre.com/seller-promotions/candidates/${encodeURIComponent(
          debugCandidateId
        )}?app_version=v2`,
      });
    }
    if (debugOfferId) {
      optionalProbes.push({
        name: "offer-detail-v2",
        url: `https://api.mercadolibre.com/seller-promotions/offers/${encodeURIComponent(
          debugOfferId
        )}?app_version=v2`,
      });
    }

    function extractRows(payload) {
      if (Array.isArray(payload)) return payload;
      if (Array.isArray(payload?.results)) return payload.results;
      if (Array.isArray(payload?.data?.results)) return payload.data.results;
      if (Array.isArray(payload?.promotions)) return payload.promotions;
      if (Array.isArray(payload?.data)) return payload.data;
      if (Array.isArray(payload?.items)) return payload.items;
      return [];
    }

    function summarizeRow(row) {
      return {
        id: row?.id || row?.promotion_id || row?.code || null,
        type: row?.type || row?.promotion_type || null,
        sub_type: row?.sub_type || row?.subtype || null,
        name: row?.name || row?.title || row?.promotion_name || null,
        status: row?.status || null,
        start_date: row?.start_date || row?.valid_from || null,
        finish_date: row?.finish_date || row?.valid_to || null,
      };
    }

    function getTextValue(value) {
      if (!value) return "";
      if (typeof value === "string") return value;
      if (typeof value?.title === "string") return value.title;
      if (typeof value?.text === "string") return value.text;
      return "";
    }

    function summarizeFloxCard(card) {
      const tracks = Array.isArray(card?.data?.tracks)
        ? card.data.tracks
        : [];
      const eventData =
        tracks.find((track) => track?.data?.event_data)?.data?.event_data ||
        {};
      const subtitle = Array.isArray(card?.subtitle)
        ? card.subtitle.map(getTextValue).filter(Boolean)
        : [];
      const description = Array.isArray(card?.description)
        ? card.description.map(getTextValue).filter(Boolean)
        : [];
      const topLabel = Array.isArray(card?.topLabel)
        ? card.topLabel.map(getTextValue).filter(Boolean)
        : [getTextValue(card?.topLabel)].filter(Boolean);
      const actions = Array.isArray(card?.actionable)
        ? card.actionable.map((action) => action?.label).filter(Boolean)
        : [];

      return {
        id: card?.id || card?.data?.id || eventData?.promo_id || null,
        title: card?.title || card?.customData?.cardTitle || null,
        filter: card?.data?.action?.filters || null,
        type: eventData?.type || null,
        promo_id: eventData?.promo_id || card?.data?.id || card?.id || null,
        eligible_count:
          typeof eventData?.total_eligible_items === "number"
            ? eventData.total_eligible_items
            : null,
        participating_count:
          typeof eventData?.total_actives_items === "number"
            ? eventData.total_actives_items
            : null,
        eligible_items_sample: Array.isArray(eventData?.eligible_items)
          ? eventData.eligible_items.slice(0, 5)
          : [],
        participating_items_sample: Array.isArray(eventData?.actives_items)
          ? eventData.actives_items.slice(0, 5)
          : [],
        description,
        subtitle,
        top_label: topLabel,
        actions,
        delete_callback:
          card?.actionable?.[0]?.data?.modal?.data?.urlCallback || null,
      };
    }

    function extractFloxPromotionGroups(payload) {
      const groups =
        payload?.data?.floxEvent?.data?.brick?.bricks?.[0]?.bricks?.[1]
          ?.bricks?.[1]?.data?.groups || [];
      if (!Array.isArray(groups)) return [];
      return groups.map((group) => {
        const cards = Array.isArray(group?.cards)
          ? group.cards.map(summarizeFloxCard)
          : [];
        const countsByType = cards.reduce((acc, card) => {
          const type = String(card?.type || card?.filter || "UNKNOWN")
            .split("-")[0]
            .toUpperCase();
          acc[type] = (acc[type] || 0) + 1;
          return acc;
        }, {});
        return {
          title: group?.title || null,
          cards_count: cards.length,
          close_label: group?.collapsibleButton?.closeLabel || null,
          counts_by_type: countsByType,
          cards,
        };
      });
    }

    const results = [];
    for (const probe of probes) {
      const started = Date.now();
      try {
        const response = await authFetch(
          req,
          probe.url,
          { headers: probe.headers || {} },
          creds
        );
        const text = await response.text().catch(() => "");
        let json;
        try {
          json = text ? JSON.parse(text) : {};
        } catch {
          json = { raw: text.slice(0, 500) };
        }
        const rows = extractRows(json);
        const countsByType = rows.reduce((acc, row) => {
          const type = String(row?.type || row?.promotion_type || "UNKNOWN").toUpperCase();
          acc[type] = (acc[type] || 0) + 1;
          return acc;
        }, {});
        results.push({
          name: probe.name,
          status: response.status,
          ok: response.ok,
          elapsed_ms: Date.now() - started,
          count: rows.length,
          counts_by_type: countsByType,
          paging: json?.paging || json?.data?.paging || null,
          keys: json && typeof json === "object" ? Object.keys(json).slice(0, 20) : [],
          sample: rows.slice(0, 5).map(summarizeRow),
          error:
            response.ok
              ? null
              : json?.message || json?.error || json?.raw || text.slice(0, 300) || null,
        });
      } catch (err) {
        results.push({
          name: probe.name,
          status: 0,
          ok: false,
          elapsed_ms: Date.now() - started,
          count: 0,
          counts_by_type: {},
          sample: [],
          error: err?.message || String(err),
        });
      }
    }

    const wwwResults = [];
    for (const probe of wwwProbes) {
      const started = Date.now();
      try {
        const response = await authFetch(req, probe.url, {}, creds);
        const contentType = response.headers.get("content-type") || "";
        const text = await response.text().catch(() => "");
        let json;
        try {
          json = text ? JSON.parse(text) : {};
        } catch {
          json = { raw: text.slice(0, 500) };
        }
        const groups = extractFloxPromotionGroups(json);
        const createdBySeller =
          groups.find((group) =>
            /criadas\s+por\s+voc/i.test(String(group?.title || ""))
          ) || null;
        const sellerCards = (createdBySeller?.cards || []).filter((card) =>
          /^SELLER_/i.test(String(card?.filter || card?.type || ""))
        );
        wwwResults.push({
          name: probe.name,
          status: response.status,
          ok: response.ok,
          elapsed_ms: Date.now() - started,
          content_type: contentType,
          groups_count: groups.length,
          groups: groups.map((group) => ({
            title: group.title,
            cards_count: group.cards_count,
            close_label: group.close_label,
            counts_by_type: group.counts_by_type,
            sample: group.cards.slice(0, 8),
          })),
          created_by_seller: createdBySeller
            ? {
                cards_count: createdBySeller.cards_count,
                close_label: createdBySeller.close_label,
                counts_by_type: createdBySeller.counts_by_type,
                seller_cards_count: sellerCards.length,
                seller_cards: sellerCards.slice(0, 60),
              }
            : null,
          error:
            response.ok
              ? null
              : json?.message || json?.error || json?.raw || text.slice(0, 300) || null,
        });
      } catch (err) {
        wwwResults.push({
          name: probe.name,
          status: 0,
          ok: false,
          elapsed_ms: Date.now() - started,
          groups_count: 0,
          groups: [],
          created_by_seller: null,
          error: err?.message || String(err),
        });
      }
    }

    const optionalResults = [];
    for (const probe of optionalProbes) {
      const started = Date.now();
      if (probe.skip) {
        optionalResults.push({
          name: probe.name,
          skipped: true,
          reason: probe.skip,
          url: probe.url,
        });
        continue;
      }
      try {
        const response = await authFetch(req, probe.url, {}, creds);
        const text = await response.text().catch(() => "");
        let json;
        try {
          json = text ? JSON.parse(text) : {};
        } catch {
          json = { raw: text.slice(0, 500) };
        }
        const rows = extractRows(json);
        optionalResults.push({
          name: probe.name,
          url: probe.url,
          status: response.status,
          ok: response.ok,
          elapsed_ms: Date.now() - started,
          count: rows.length,
          keys: json && typeof json === "object" ? Object.keys(json).slice(0, 20) : [],
          sample: rows.length ? rows.slice(0, 20).map(summarizeRow) : json,
          error:
            response.ok
              ? null
              : json?.message || json?.error || json?.raw || text.slice(0, 300) || null,
        });
      } catch (err) {
        optionalResults.push({
          name: probe.name,
          url: probe.url,
          status: 0,
          ok: false,
          elapsed_ms: Date.now() - started,
          error: err?.message || String(err),
        });
      }
    }

    return res.json({
      ok: true,
      user_id: userId,
      generated_at: new Date().toISOString(),
      query: {
        item_id: debugItemId || null,
        promotion_ids: debugPromotionIds,
        promotion_types: inferredPromotionTypes,
        candidate_id: debugCandidateId || null,
        offer_id: debugOfferId || null,
      },
      official_endpoint_catalog: officialEndpointCatalog,
      results,
      www_results: wwwResults,
      optional_results: optionalResults,
    });
  } catch (e) {
    console.error("[/api/promocoes/debug/promotion-sources] erro:", e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

/**
 * CONSULTA AS PROMOÇÃ•ES DE UM ITEM (array bruto do ML)
 * GET /api/promocoes/items/:itemId
 * -> Proxy para https://api.mercadolibre.com/seller-promotions/items/:ITEM_ID?app_version=v2
 */
core.get("/api/promocoes/items/:itemId", async (req, res) => {
  try {
    const creds = res.locals.mlCreds || {};
    const { itemId } = req.params;
    const url = `https://api.mercadolibre.com/seller-promotions/items/${encodeURIComponent(
      itemId
    )}?app_version=v2`;

    const r = await authFetch(req, url, {}, creds);
    const text = await r.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }

    // Normalizamos uma resposta vazia para []
    const promotions = Array.isArray(json)
      ? json
      : Array.isArray(json.results)
      ? json.results
      : [];
    return res
      .status(r.status)
      .json(promotions.map((entry) => stripSuggestedDiscountedPrice(entry)));
  } catch (e) {
    console.error("[/api/promocoes/items/:itemId] erro:", e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

core.get("/api/promocoes/debug/items/:itemId", async (req, res) => {
  try {
    const creds = res.locals.mlCreds || {};
    const { itemId } = req.params;
    const promotionId = String(req.query?.promotion_id || "").trim();
    const promotionType = String(req.query?.promotion_type || "DEAL").trim().toUpperCase();

    if (!itemId) {
      return res.status(400).json({ ok: false, error: "itemId é obrigatório." });
    }
    if (!promotionId) {
      return res.status(400).json({ ok: false, error: "promotion_id é obrigatório." });
    }

    const itemPromotionsUrl = `https://api.mercadolibre.com/seller-promotions/items/${encodeURIComponent(
      itemId
    )}?app_version=v2`;
    const itemPromotionsResp = await authFetch(req, itemPromotionsUrl, {}, creds);
    const itemPromotionsText = await itemPromotionsResp.text().catch(() => "");
    let itemPromotionsJson;
    try {
      itemPromotionsJson = itemPromotionsText ? JSON.parse(itemPromotionsText) : [];
    } catch {
      itemPromotionsJson = [];
    }
    const itemPromotions = (
      Array.isArray(itemPromotionsJson)
        ? itemPromotionsJson
        : Array.isArray(itemPromotionsJson?.results)
        ? itemPromotionsJson.results
        : []
    ).map((entry) => stripSuggestedDiscountedPrice(entry));

    const itemPromotionMatch =
      itemPromotions.find(
        (entry) => String(entry?.id || entry?.promotion_id || "") === promotionId
      ) || null;

    const listingProbe = await fetchPromotionItemFromListing(
      req,
      creds,
      promotionId,
      promotionType,
      itemId
    );
    const listingRow = stripSuggestedDiscountedPrice(listingProbe?.row || null);
    const sourceChosen = detectPreferredSource(
      listingRow || {},
      itemPromotionMatch || {},
      promotionType
    );
    const mergedBase = preferPromotionSnapshot(
      listingRow || {},
      itemPromotionMatch || {},
      promotionType
    );

    const itemDetailsUrl = `https://api.mercadolibre.com/items?ids=${encodeURIComponent(
      itemId
    )}&attributes=${encodeURIComponent("id,title,available_quantity,seller_custom_field,price")}`;
    const itemDetailsResp = await authFetch(req, itemDetailsUrl, {}, creds);
    const itemDetailsText = await itemDetailsResp.text().catch(() => "");
    let itemDetailsJson;
    try {
      itemDetailsJson = itemDetailsText ? JSON.parse(itemDetailsText) : [];
    } catch {
      itemDetailsJson = [];
    }
    const itemDetailsBody = Array.isArray(itemDetailsJson)
      ? itemDetailsJson?.[0]?.body || itemDetailsJson?.[0] || null
      : null;

    const original =
      mergedBase?.original_price != null
        ? Number(mergedBase.original_price)
        : itemDetailsBody?.price != null
        ? Number(itemDetailsBody.price)
        : null;

    const resolved = resolveDealFinalAndPct({
      original_price: original,
      status: mergedBase?.status,
      promotion_type: promotionType,
      deal_price: mergedBase?.deal_price ?? mergedBase?.new_price,
      min_discounted_price: mergedBase?.min_discounted_price,
      max_discounted_price: mergedBase?.max_discounted_price,
      price: mergedBase?.price,
      discount_percentage: mergedBase?.discount_percentage,
    });

    const mergedRow = {
      id: itemId,
      promotion_type: promotionType,
      original_price: original,
      deal_price: mergedBase?.deal_price ?? mergedBase?.new_price ?? null,
      min_discounted_price: mergedBase?.min_discounted_price ?? null,
      max_discounted_price: mergedBase?.max_discounted_price ?? null,
      discount_percentage: mergedBase?.discount_percentage ?? null,
      status: normalizeStatusServer(mergedBase?.status),
      _source: sourceChosen,
      _resolved_final_price: resolved?.final ?? null,
    };
    const rangeSummary = buildDealRangeSummary(original, mergedRow);

    return res.json({
      ok: true,
      probe: {
        promotion_items_listing: listingProbe,
        item_promotions_status: itemPromotionsResp.status,
        item_promotions_count: itemPromotions.length,
        item_details_status: itemDetailsResp.status,
        source_chosen: sourceChosen,
      },
      debug: buildPromotionDebugPayload({
        itemId,
        promotionId,
        promotionType,
        listingRow,
        itemPromotions,
        itemPromotionMatch,
        mergedRow,
        resolved,
        itemDetails: itemDetailsBody,
        rangeSummary,
      }),
    });
  } catch (e) {
    console.error("[/api/promocoes/debug/items/:itemId] erro:", e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

/**
 * RESOLVE OFFER IDS PARA UM ITEM (MLB)
 * GET /api/promocoes/items/:itemId/offer-ids
 * -> { ok:true, offer_ids:["OFFER-..."] } | { ok:false, error:"offer_id_not_found" }
 */
core.get("/api/promocoes/items/:itemId/offer-ids", async (req, res) => {
  try {
    const creds = res.locals.mlCreds || {};
    const { itemId } = req.params;
    const promotionId = String(req.query?.promotion_id || "").trim() || null;
    const promotionType = String(req.query?.promotion_type || "").trim() || null;
    const candidateId = String(req.query?.candidate_id || "").trim() || null;
    const typeUp = String(promotionType || "").trim().toUpperCase();

    if (promotionId && isStrictPreparedSelectionPromotionType(typeUp)) {
      const listingProbe = await fetchPromotionItemFromListing(
        req,
        creds,
        promotionId,
        typeUp,
        itemId
      ).catch(() => null);
      const listingRow = listingProbe?.found ? listingProbe.row : null;
      const listingRefs = collectApplyOfferRefsFromPromotionItem(listingRow, typeUp).filter(
        Boolean
      );
      if (listingRefs.length) {
        return res.json({
          ok: true,
          offer_ids: listingRefs,
          source: "promotion_items_listing",
        });
      }
    }

    const cachedRows =
      PromoOfferRefsService?.findOfferRefs && creds?.meli_conta_id
        ? await PromoOfferRefsService.findOfferRefs({
            meliContaId: creds.meli_conta_id,
            itemId,
            promotionId,
            promotionType,
            candidateId,
          }).catch(() => [])
        : [];
    const cachedIds = [
      ...new Set(
        (Array.isArray(cachedRows) ? cachedRows : [])
          .flatMap((row) => [row?.offer_id, row?.candidate_id])
          .map((value) => String(value || "").trim())
          .filter(Boolean),
      ),
    ];
    if (cachedIds.length) {
      return res.json({
        ok: true,
        offer_ids: cachedIds,
        source: "promo_offer_refs_cache",
      });
    }

    const url = `https://api.mercadolibre.com/seller-promotions/items/${encodeURIComponent(
      itemId
    )}?app_version=v2`;
    const r = await authFetch(req, url, {}, creds);
    const text = await r.text().catch(() => "");
    let arr;
    try {
      arr = JSON.parse(text);
    } catch {
      arr = [];
    }

    const promos = Array.isArray(arr)
      ? arr
      : Array.isArray(arr?.results)
      ? arr.results
      : [];
    const set = new Set();

    for (const p of promos) {
      if (Array.isArray(p?.offers)) {
        for (const o of p.offers) {
          const oid = o?.offer_id || o?.id;
          if (oid) set.add(String(oid));
        }
      }
      if (p?.offer_id) set.add(String(p.offer_id));
      if (/^OFFER-/i.test(String(p?.ref_id || ""))) {
        set.add(String(p.ref_id));
      }
    }

    const out = [...set];
    if (!out.length)
      return res.status(404).json({ ok: false, error: "offer_id_not_found" });

    return res.json({ ok: true, offer_ids: out });
  } catch (e) {
    console.error("[/api/promocoes/items/:itemId/offer-ids] erro:", e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

/**
 * Contagem leve de itens por promoção.
 * Usa paging.total do Mercado Livre com limit=1 para evitar carregar a lista.
 * GET /api/promocoes/promotions/:promotionId/counts?promotion_type=DEAL
 */
core.get("/api/promocoes/promotions/:promotionId/counts", async (req, res) => {
  try {
    const creds = res.locals.mlCreds || {};
    const { promotionId } = req.params;
    const promotionType = String(req.query.promotion_type || "").trim();

    if (!promotionId || !promotionType) {
      return res.status(400).json({
        ok: false,
        error: "promotion_id_and_type_required",
      });
    }

    const fetchCountJson = async (url, timeoutMs = 12000) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await authFetch(req, url, { signal: controller.signal }, creds);
        const json = await response.json().catch(() => ({}));
        if (!response.ok) {
          const err = new Error(`ML count failed`);
          err.status = response.status;
          err.data = json;
          throw err;
        }
        return json;
      } catch (err) {
        if (err?.name === "AbortError") {
          const timeoutErr = new Error("ML count timeout");
          timeoutErr.status = 504;
          throw timeoutErr;
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    };

    const buildItemsUrl = ({ status, limit, searchAfter = null }) => {
      const qs = new URLSearchParams();
      qs.set("promotion_type", promotionType);
      if (status) qs.set("status", status);
      qs.set("limit", String(limit));
      if (searchAfter) qs.set("search_after", String(searchAfter));
      qs.set("app_version", "v2");

      return `https://api.mercadolibre.com/seller-promotions/promotions/${encodeURIComponent(
        promotionId
      )}/items?${qs.toString()}`;
    };

    const readTotalForStatus = async (status) => {
      const first = await fetchCountJson(buildItemsUrl({ status, limit: 1 }));
      const total = Number(first?.paging?.total);
      if (Number.isFinite(total)) return total;

      let counted = Array.isArray(first?.results) ? first.results.length : 0;
      let token =
        first?.paging?.searchAfter ??
        first?.paging?.search_after ??
        first?.paging?.next_token ??
        first?.paging?.next ??
        null;
      const seenTokens = new Set(token ? [String(token)] : []);
      let pages = 0;
      const maxPages = 100;

      while (token && pages < maxPages) {
        pages += 1;
        const page = await fetchCountJson(
          buildItemsUrl({ status, limit: 50, searchAfter: token }),
        );
        const rows = Array.isArray(page?.results) ? page.results : [];
        counted += rows.length;
        const next =
          page?.paging?.searchAfter ??
          page?.paging?.search_after ??
          page?.paging?.next_token ??
          page?.paging?.next ??
          null;
        if (!next || seenTokens.has(String(next))) break;
        seenTokens.add(String(next));
        token = next;
      }

      return counted;
    };

    const readLightningUniqueParticipating = async () => {
      const wanted = new Set(["started", "pending", "scheduled", "programmed"]);
      const ids = new Set();
      const statusTotals = {};
      let token = null;
      const seenTokens = new Set();
      let pages = 0;
      const maxPages = 200;

      do {
        pages += 1;
        const page = await fetchCountJson(
          buildItemsUrl({ status: null, limit: 50, searchAfter: token }),
        );
        const rows = Array.isArray(page?.results) ? page.results : [];
        for (const row of rows) {
          const status = normalizeStatusServer(row?.status);
          statusTotals[status] = (statusTotals[status] || 0) + 1;
          if (!wanted.has(status)) continue;
          const id = String(row?.id || row?.item_id || "").trim().toUpperCase();
          if (id) ids.add(id);
        }

        const next =
          page?.paging?.searchAfter ??
          page?.paging?.search_after ??
          page?.paging?.next_token ??
          page?.paging?.next ??
          null;
        if (!next || seenTokens.has(String(next))) break;
        seenTokens.add(String(next));
        token = next;
      } while (token && pages < maxPages);

      return {
        total: ids.size,
        status_totals: statusTotals,
        pages,
      };
    };

    const useLightningUnique =
      String(promotionType || "").toUpperCase() === "LIGHTNING";

    const [eligibleResult, participatingResult] = await Promise.allSettled([
      readTotalForStatus("candidate"),
      useLightningUnique
        ? readLightningUniqueParticipating()
        : readTotalForStatus("started"),
    ]);
    const eligible =
      eligibleResult.status === "fulfilled"
      ? eligibleResult.value
      : 0;
    const participating = participatingResult.status === "fulfilled"
      ? useLightningUnique
        ? participatingResult.value.total
        : participatingResult.value
      : 0;
    const warnings = [
      eligibleResult.status === "rejected"
        ? { status: "candidate", error: eligibleResult.reason?.message || String(eligibleResult.reason) }
        : null,
      participatingResult.status === "rejected"
        ? { status: "started", error: participatingResult.reason?.message || String(participatingResult.reason) }
        : null,
    ].filter(Boolean);

    return res.json({
      ok: true,
      promotion_id: promotionId,
      promotion_type: promotionType,
      eligible_items: eligible,
      participating_items: participating,
      counts_source: useLightningUnique
        ? "promotion_items_unique_participating"
        : "promotion_items",
      participating_statuses:
        useLightningUnique && participatingResult.status === "fulfilled"
          ? participatingResult.value.status_totals
          : undefined,
      partial: warnings.length > 0,
      warnings,
    });
  } catch (e) {
    console.error("[/api/promocoes/promotions/:id/counts] erro:", e);
    return res.status(e.status || 500).json({
      ok: false,
      error: e.message || String(e),
      data: e.data || null,
    });
  }
});

/**
 * Itens de uma promoção (com enriquecimento de título/sku/price)
 * GET /api/promocoes/promotions/:promotionId/items
 *
 * Normaliza paginação para sempre expor paging.searchAfter
 * (aceita searchAfter | next_token | search_after do ML)
 *
 * 🔧 PATCH: DEAL/SELLER_CAMPAIGN
 * - Traz min_discounted_price / max_discounted_price
 * - Calcula discount_percentage quando não vier do ML:
 *    • se houver deal_price (started), usa deal_price/original_price
 *    • senão, usa a faixa do ML (min/max) para estimar o %
 */
core.get("/api/promocoes/promotions/:promotionId/items", async (req, res) => {
  try {
    const creds = res.locals.mlCreds || {};
    const { promotionId } = req.params;
    const {
      promotion_type = "DEAL",
      status,
      limit = 50,
      search_after,
    } = req.query;

    const qs = new URLSearchParams();
    qs.set("promotion_type", String(promotion_type));
    if (status) qs.set("status", String(status));
    if (limit) qs.set("limit", String(limit));
    if (search_after) qs.set("search_after", String(search_after));
    qs.set("app_version", "v2");

    const url = `https://api.mercadolibre.com/seller-promotions/promotions/${encodeURIComponent(
      promotionId
    )}/items?${qs.toString()}`;
    const pr = await authFetch(req, url, {}, creds);
    const promoJson = await pr.json().catch(() => ({}));

    const results = Array.isArray(promoJson.results) ? promoJson.results : [];
    const pagingIn = promoJson.paging || {};

    if (results.length === 0) {
      return res.json({
        ...promoJson,
        paging: {
          ...pagingIn,
          searchAfter:
            pagingIn.searchAfter ??
            pagingIn.next_token ??
            pagingIn.search_after ??
            null,
        },
      });
    }

    // Helpers
    const normStatus = (s) => {
      s = String(s || "").toLowerCase();
      if (s === "in_progress") return "pending";
      return s;
    };
    const isDealLike = (t) =>
      ["DEAL", "SELLER_CAMPAIGN", "PRICE_DISCOUNT", "DOD", "LIGHTNING"].includes(
        String(t || "").toUpperCase()
      );

    // Enriquecimento com /items (title/estoque/sku/price)
    const ids = results.map((r) => r.id || r.item_id).filter(Boolean);
    const pack = (arr, n) => {
      const out = [];
      for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
      return out;
    };
    const itemsDetails = {};
    const fallbackSnapshotsByItem = Object.create(null);

    for (const group of pack(ids, 20)) {
      const urlItems = `https://api.mercadolibre.com/items?ids=${encodeURIComponent(
        group.join(",")
      )}&attributes=${encodeURIComponent(
        "id,title,available_quantity,seller_custom_field,price"
      )}`;
      const ir = await authFetch(req, urlItems, {}, creds);
      if (!ir.ok) continue;
      const blob = await ir.json().catch(() => []);
      (Array.isArray(blob) ? blob : []).forEach((row) => {
        const b = row?.body || row || {};
        if (b?.id) {
          itemsDetails[b.id] = {
            title: b.title,
            available_quantity: b.available_quantity,
            seller_custom_field: b.seller_custom_field,
            price: b.price,
          };
        }
      });
    }

    const shouldRefreshSellerSnapshots =
      String(promotion_type || "").toUpperCase() === "SELLER_CAMPAIGN";
    const fallbackTargets = shouldRefreshSellerSnapshots
      ? results
      : results.filter((r) => needsDealFallbackDetail(r, promotion_type));
    for (const group of chunk(fallbackTargets, 10)) {
      const resolved = await Promise.all(
        group.map(async (row) => {
          const itemId = row?.id || row?.item_id;
          if (!itemId) return null;
          const snapshot = await fetchItemPromotionSnapshot(
            req,
            creds,
            itemId,
            promotionId
          ).catch(() => null);
          return snapshot ? { itemId, snapshot } : null;
        })
      );
      resolved.filter(Boolean).forEach(({ itemId, snapshot }) => {
        fallbackSnapshotsByItem[itemId] = snapshot;
      });
    }

    const merged = results.map((r) => {
      const id = r.id || r.item_id;
      const d = itemsDetails[id] || {};
      const fallback = fallbackSnapshotsByItem[id] || {};
      const typeUp = String(r.type || promotion_type || "").toUpperCase();
      const useSnapshotAsSource =
        typeUp === "SELLER_CAMPAIGN" && Object.keys(fallback).length > 0;
      const baseRow = useSnapshotAsSource
        ? { ...r, ...fallback }
        : preferPromotionSnapshot(r, fallback, typeUp);

      // original: da promoção, senão do item
      const original =
        baseRow.original_price != null
          ? Number(baseRow.original_price)
          : d.price != null
          ? Number(d.price)
          : null;

      const normalizedRange = computeDealDiscountRangeServer({
        ...baseRow,
        original_price: original,
        promotion_type: typeUp,
      });

      // Resolver final e % com a heurística única (corrige "price" como desconto em R$)
      const { final, pct } = resolveDealFinalAndPct({
        original_price: original,
        status: baseRow.status,
        promotion_type: typeUp,
        deal_price: baseRow.deal_price ?? baseRow.new_price,
        min_discounted_price: normalizedRange.minPrice,
        max_discounted_price: normalizedRange.maxPrice,
        price: baseRow.price,
        discount_percentage: baseRow.discount_percentage,
      });

      const st = normStatus(baseRow.status);

      return stripSuggestedDiscountedPrice({
        ...fallback,
        ...r,
        id,
        promotion_type: typeUp,
        title: d.title,
        available_quantity: d.available_quantity,
        seller_custom_field: d.seller_custom_field,

        original_price: original,
        // Só expõe deal_price quando started; em candidate mostramos candidatos
        deal_price: st === "started" ? final ?? null : null,

        // garantir números (ou null) p/ min/max
        min_discounted_price:
          normalizedRange.minPrice,
        max_discounted_price:
          normalizedRange.maxPrice,
        suggested_discounted_price: undefined,

        // % final coerente com a lógica do front
        discount_percentage: isDealLike(typeUp)
          ? pct != null
            ? pct
            : null
          : baseRow.discount_percentage != null
          ? Number(baseRow.discount_percentage)
          : original && final
          ? Number(((1 - final / original) * 100).toFixed(2))
          : null,

        status: st,

        // útil para debug/validação
        _resolved_final_price: final ?? null,
      });
    });

    const requestedStatus = normStatus(status);
    const mergedFiltered =
      shouldRefreshSellerSnapshots && requestedStatus
        ? merged.filter((row) => normStatus(row?.status) === requestedStatus)
        : merged;

    return res.json({
      ...promoJson,
      results: mergedFiltered,
      paging: {
        ...pagingIn,
        total:
          shouldRefreshSellerSnapshots && requestedStatus
            ? mergedFiltered.length
            : pagingIn.total,
        searchAfter:
          pagingIn.searchAfter ??
          pagingIn.next_token ??
          pagingIn.search_after ??
          null,
      },
    });
  } catch (e) {
    console.error("[/api/promocoes/promotions/:id/items] erro:", e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

/**
 * APLICAR ITENS A UMA PROMOÇÃO (lote)
 * POST /api/promocoes/apply
 * body: { promotion_id, promotion_type, items: [{ id, deal_price?, top_deal_price?, offer_id? }] }
 */
core.post(
  "/api/promocoes/apply",
  createAuditAction({
    evento: "promotion_apply_manual",
    metadata: (req) => ({
      promotion_id: req.body?.promotion_id || null,
      promotion_type: req.body?.promotion_type || null,
      promotion_name: req.body?.promotion_name || req.body?.campaign_name || null,
      total_items: Array.isArray(req.body?.items) ? req.body.items.length : 0,
      sample_ids: Array.isArray(req.body?.items) ? req.body.items.slice(0, 20) : [],
      legacy_endpoint: true,
    }),
  }),
  async (_req, res) =>
    res.status(410).json({
      ok: false,
      error: "legacy_manual_apply_removed",
      message:
        "Fluxo manual legado removido. Use os jobs de promocoes ou a aplicacao unitaria com percentual validado no servidor.",
    }),
);

// APLICAR UM ITEM EM UMA CAMPANHA
// POST /api/promocoes/items/:itemId/apply
core.post(
  "/api/promocoes/items/:itemId/apply",
  createAuditAction({
    evento: "promotion_apply_single_item",
    metadata: (req) => ({
      item_id: req.params?.itemId || null,
      promotion_id: req.body?.promotion_id || null,
      promotion_type: req.body?.promotion_type || null,
      promotion_name: req.body?.promotion_name || req.body?.campaign_name || null,
      manual_percent:
        req.body?.manual_percent ?? req.body?.requested_percent ?? null,
    }),
  }),
  async (req, res) => {
  try {
    const creds = res.locals.mlCreds || {};
    const { itemId } = req.params;

    const {
      promotion_id,
      promotion_type,
      offer_id,
      candidate_id,
      deal_price,
      top_deal_price,
      stock,
      max_discount_percent,
      manual_percent,
      requested_percent,
      original_price,
      item_original_price,
    } = req.body || {};

    if (!promotion_id || !promotion_type) {
      return res.status(400).json({
        ok: false,
        error: "promotion_id e promotion_type são obrigatórios.",
      });
    }

    const t = String(promotion_type).toUpperCase();
    if (["DEAL", "SELLER_CAMPAIGN", "SMART", "LIGHTNING", "PRE_NEGOTIATED"].includes(t)) {
      return res.status(410).json({
        ok: false,
        error: "legacy_single_apply_removed",
        message:
          "Aplicacao unitaria migrada para o motor seguro de jobs. Atualize a tela e tente novamente.",
      });
    }
    const payload = { promotion_id, promotion_type: t };
    let snapshot = null;
    const isStrictOfferType = isStrictPreparedSelectionPromotionType(t);
    const isSmartLikeType = isSmartLikePromotionType(t);
    const discountCap = toNumSafe(max_discount_percent);
    let offerLockedByCap = false;

    if (
      t === "SMART" ||
      t === "PRE_NEGOTIATED" ||
      t === "UNHEALTHY_STOCK" ||
      t.startsWith("PRICE_MATCHING")
    ) {
      if (discountCap == null) {
        return res.status(400).json({
          ok: false,
          error: "smart_discount_cap_required",
          message:
            "Aplicacao bloqueada: informe/verifique o teto de desconto antes de aplicar ofertas Smart.",
        });
      }
      const selectedOffer =
        await fetchOfferWithinPercentCapForItem(
              req,
              creds,
              promotion_id,
              t,
              itemId,
              discountCap,
            ).catch(() => null);
      if (!selectedOffer) {
        return res.status(412).json({
          ok: false,
          error: "offer_above_discount_cap",
          message: `Nenhuma oferta elegivel foi encontrada dentro do teto de ${discountCap}%.`,
        });
      }
      const fallbackOfferId = isSmartLikeType ? String(candidate_id || "").trim() : "";
      const resolvedOfferId =
        String(selectedOffer?._selected_offer_id || "").trim() ||
        String(offer_id || "").trim() ||
        fallbackOfferId;
      if (!resolvedOfferId) {
        return res.status(400).json({
          ok: false,
          error:
            t === "PRE_NEGOTIATED" || t === "UNHEALTHY_STOCK"
              ? "offer_id e obrigatorio para PRE_NEGOTIATED/UNHEALTHY_STOCK."
              : "offer_id e obrigatorio para SMART/PRICE_MATCHING.",
        });
      }
      payload.offer_id = resolvedOfferId;
      offerLockedByCap = !!selectedOffer;
      if (isStrictOfferType && !offerLockedByCap) {
        const listingProbe = await fetchPromotionItemFromListing(
          req,
          creds,
          promotion_id,
          t,
          itemId
        ).catch(() => null);
        const listingRow = listingProbe?.found ? listingProbe.row : null;
        const strictRefs = collectApplyOfferRefsFromPromotionItem(listingRow, t);
        if (strictRefs.length) payload.offer_id = strictRefs[0];
      }
    } else if (
      t === "SELLER_CAMPAIGN" ||
      t === "DEAL" ||
      t === "PRICE_DISCOUNT" ||
      t === "DOD" ||
      t === "LIGHTNING"
    ) {
      const needsManualPercentGuard =
        t === "SELLER_CAMPAIGN" ||
        t === "PRICE_DISCOUNT" ||
        t === "DEAL" ||
        t === "DOD" ||
        t === "LIGHTNING";
      const requestedManualPercent = manual_percent ?? requested_percent;
      let dealPriceNum = Number(deal_price);
      let originalForGuard = null;

      if (needsManualPercentGuard) {
        if (!isValidManualPromoPercent(requestedManualPercent)) {
          return res.status(400).json({
            ok: false,
            error: manualPromoPercentMessage("manual_percent"),
          });
        }
        let freshSnapshot = await fetchItemPromotionSnapshot(
          req,
          creds,
          itemId,
          promotion_id,
        ).catch(() => null);
        if (!freshSnapshot) {
          const listingProbe = await fetchPromotionItemFromListing(
            req,
            creds,
            promotion_id,
            t,
            itemId,
          ).catch(() => null);
          freshSnapshot = listingProbe?.found ? listingProbe.row : null;
        }
        if (!freshSnapshot) {
          return res.status(409).json({
            ok: false,
            error: "item_not_revalidated",
            message:
              "Aplicacao bloqueada: nao foi possivel revalidar o item dentro da campanha no Mercado Livre antes de calcular o percentual.",
            details: {
              item_id: itemId,
              promotion_id,
              promotion_type: t,
            },
          });
        }
        if (freshSnapshot) snapshot = freshSnapshot;
        if (
          t === "LIGHTNING" &&
          normalizeStatusServer(freshSnapshot?.status) !== "candidate"
        ) {
          return res.status(409).json({
            ok: false,
            error: "lightning_not_candidate",
            message:
              "A oferta relampago ja participa ou esta programada e nao pode ser editada diretamente. Remova a oferta atual antes de reaplicar.",
            details: {
              item_id: itemId,
              promotion_id,
              promotion_type: t,
              status: normalizeStatusServer(freshSnapshot?.status) || null,
            },
          });
        }
        originalForGuard = await resolveOriginalPriceForManualGuardServer(
          req,
          creds,
          itemId,
          {
            ...(freshSnapshot || {}),
            original_price,
            item_original_price,
          },
        );
        dealPriceNum = computeDealPriceFromPercentServer(
          originalForGuard,
          requestedManualPercent,
        );
      }

      if (!Number.isFinite(dealPriceNum) || dealPriceNum <= 0) {
        return res.status(400).json({
          ok: false,
          error: needsManualPercentGuard
            ? "Nao foi possivel calcular deal_price seguro a partir do percentual informado."
            : "deal_price deve ser um numero maior que zero.",
        });
      }
      if (needsManualPercentGuard) {
        const percentGuard = validateManualDealPricePercentServer({
          originalPrice: originalForGuard,
          dealPrice: dealPriceNum,
          requestedPercent: requestedManualPercent,
        });
        if (!percentGuard.ok) {
          return res.status(412).json({
            ok: false,
            error: "manual_percent_divergence",
            message: percentGuard.error,
            requested_percent: percentGuard.requested_percent,
            calculated_percent: percentGuard.calculated_percent,
            min_allowed_percent: percentGuard.min_allowed_percent,
            max_allowed_percent: percentGuard.max_allowed_percent,
            tolerance: MANUAL_PROMO_PERCENT_TOLERANCE,
          });
        }
      }
      payload.deal_price = dealPriceNum;
      if (top_deal_price != null) {
        const topDealPriceNum = Number(top_deal_price);
        if (!Number.isFinite(topDealPriceNum) || topDealPriceNum <= 0) {
          return res.status(400).json({
            ok: false,
            error: "top_deal_price deve ser um numero maior que zero.",
          });
        }
        payload.top_deal_price = topDealPriceNum;
      }
      if (t === "LIGHTNING") {
        const qty = resolveLightningApplyStock(stock);
        if (qty == null) {
          return res.status(400).json({
            ok: false,
            error: "stock é obrigatório para aplicar oferta relâmpago.",
          });
        }
        payload.stock = qty;
      }
    } else if (t === "MARKETPLACE_CAMPAIGN") {
      // sem campos adicionais
    }

    if (t === "SELLER_CAMPAIGN") {
      snapshot = await fetchItemPromotionSnapshot(
        req,
        creds,
        itemId,
        promotion_id
      ).catch(() => null);

      const snapshotStatus = normalizeStatusServer(snapshot?.status);
      if (!snapshot) {
        return res.status(409).json({
          ok: false,
          error: "item_not_in_campaign",
          message:
            "O item não aparece na seller campaign selecionada. O preço manual exibido na tela é apenas uma prévia e não cria candidatura no ML.",
          details: {
            item_id: itemId,
            promotion_id,
            promotion_type: t,
          },
        });
      }

      if (!["candidate", "pending", "scheduled", "started"].includes(snapshotStatus)) {
        return res.status(409).json({
          ok: false,
          error: "item_not_eligible",
          message: `O item está com status "${snapshotStatus || "unknown"}" nesta seller campaign e não pode ser aplicado manualmente agora.`,
          details: {
            item_id: itemId,
            promotion_id,
            promotion_type: t,
            status: snapshotStatus || null,
          },
        });
      }
    }

    const method = resolveApplyMethodForItem(t, snapshot);
    const fallbackMethod =
      t === "SELLER_CAMPAIGN" && method === "POST" ? "PUT" : null;

    const mlUrl = `https://api.mercadolibre.com/seller-promotions/items/${encodeURIComponent(
      itemId
    )}?app_version=v2`;
    let usedMethod = method;
    let strictRefsToTry = [payload.offer_id].filter(Boolean);
    if (isStrictOfferType && !offerLockedByCap) {
      const listingProbe = await fetchPromotionItemFromListing(
        req,
        creds,
        promotion_id,
        t,
        itemId
      ).catch(() => null);
      const listingRow = listingProbe?.found ? listingProbe.row : null;
      strictRefsToTry = [
        ...new Set([
          ...collectApplyOfferRefsFromPromotionItem(listingRow, t),
          ...strictRefsToTry,
        ]),
      ];
    }

    const runApplyAttempt = async (currentPayload, currentMethod) => {
      const response = await authFetch(
        req,
        mlUrl,
        {
          method: currentMethod,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(currentPayload),
        },
        creds
      );
      const parsed = await parseJsonResponseSafe(response);
      return { response, json: parsed.json };
    };

    let { response: r, json } = await runApplyAttempt(payload, usedMethod);

    if (
      fallbackMethod &&
      !r.ok &&
      isSellerCampaignNoCandidatesError(json)
    ) {
      usedMethod = fallbackMethod;
      ({ response: r, json } = await runApplyAttempt(payload, usedMethod));
    }

    if (
      !offerLockedByCap &&
      !r.ok &&
      isStrictOfferType &&
      isCandidateNotFoundMlError(json)
    ) {
      for (const ref of strictRefsToTry) {
        if (!ref || ref === payload.offer_id) continue;
        const retryPayload = { ...payload, offer_id: ref };
        ({ response: r, json } = await runApplyAttempt(retryPayload, usedMethod));
        if (r.ok || !isCandidateNotFoundMlError(json)) break;
      }
    }

    if (
      !r.ok &&
      t === "SELLER_CAMPAIGN" &&
      isSellerCampaignNoCandidatesError(json)
    ) {
      return res.status(409).json({
        ok: false,
        error: "item_not_candidate",
        message:
          "O Mercado Livre não encontrou o item como candidato aplicável nessa seller campaign neste momento.",
        details: {
          item_id: itemId,
          promotion_id,
          promotion_type: t,
          apply_method: usedMethod,
          attempted_methods:
            usedMethod === method ? [method] : [method, usedMethod],
          campaign_item_status: normalizeStatusServer(snapshot?.status) || null,
          requested_deal_price:
            payload.deal_price != null ? Number(payload.deal_price) : null,
          ml_body: json,
        },
      });
    }

    return res.status(r.status).send(json);
  } catch (e) {
    console.error("[/api/promocoes/items/:itemId/apply] erro:", e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
  },
);

core.post(
  "/api/promocoes/promotions/:promotionId/export-ml-excel",
  async (req, res) => {
    try {
      if (!XLSX) {
        return res.status(503).json({
          ok: false,
          error: "xlsx_unavailable",
          message: "Biblioteca XLSX indisponível no ambiente.",
        });
      }

      const creds = res.locals.mlCreds || {};
      const { promotionId } = req.params;
      const {
        promotion_type,
        item_ids = [],
        seller_manual_percent = null,
        campaign_name = null,
      } = req.body || {};

      const typeUp = String(promotion_type || "").toUpperCase();
      if (typeUp !== "SELLER_CAMPAIGN") {
        return res.status(400).json({
          ok: false,
          error: "invalid_promotion_type",
          message: "A exportação em planilha está disponível apenas para SELLER_CAMPAIGN.",
        });
      }

      const pct = toNumSafe(seller_manual_percent);
      if (!isValidManualPromoPercent(pct)) {
        return res.status(400).json({
          ok: false,
          error: "invalid_seller_manual_percent",
          message: manualPromoPercentMessage("seller_manual_percent"),
        });
      }

      if (!Array.isArray(item_ids) || !item_ids.length) {
        return res.status(400).json({
          ok: false,
          error: "item_ids_required",
          message: "Envie os item_ids filtrados para exportar a planilha.",
        });
      }

      const rows = await buildSellerCampaignExportRows(req, creds, {
        promotion_id: promotionId,
        promotion_type: typeUp,
        item_ids,
        seller_manual_percent: pct,
      });

      if (!rows.length) {
        return res.status(404).json({
          ok: false,
          error: "no_rows",
          message: "Nenhum item foi localizado para exportação.",
        });
      }

      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.json_to_sheet(rows);
      XLSX.utils.book_append_sheet(wb, ws, "Promocao");
      const buffer = XLSX.write(wb, {
        type: "buffer",
        bookType: "xlsx",
      });

      const filename = buildExportFilename(campaign_name || promotionId);
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`
      );
      return res.send(buffer);
    } catch (e) {
      console.error(
        "[/api/promocoes/promotions/:promotionId/export-ml-excel] erro:",
        e
      );
      return res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  }
);

core.post(
  "/api/promocoes/promotions/:promotionId/fill-ml-template",
  upload.single("template"),
  async (req, res) => {
    try {
      if (!ExcelJS) {
        return res.status(503).json({
          ok: false,
          error: "exceljs_unavailable",
          message: "Biblioteca ExcelJS indisponível no ambiente.",
        });
      }

      const creds = res.locals.mlCreds || {};
      const { promotionId } = req.params;
      const {
        promotion_type,
        seller_manual_percent,
        campaign_name = null,
      } = req.body || {};

      const itemIdsRaw = req.body?.item_ids;
      let itemIds = [];
      if (Array.isArray(itemIdsRaw)) {
        itemIds = itemIdsRaw;
      } else if (typeof itemIdsRaw === "string" && itemIdsRaw.trim()) {
        try {
          const parsed = JSON.parse(itemIdsRaw);
          if (Array.isArray(parsed)) itemIds = parsed;
        } catch {
          itemIds = itemIdsRaw.split(",").map((v) => v.trim());
        }
      }

      const typeUp = String(promotion_type || "").toUpperCase();
      if (typeUp !== "SELLER_CAMPAIGN") {
        return res.status(400).json({
          ok: false,
          error: "invalid_promotion_type",
          message: "O preenchimento do template está disponível apenas para SELLER_CAMPAIGN.",
        });
      }

      const pct = toNumSafe(seller_manual_percent);
      if (!isValidManualPromoPercent(pct)) {
        return res.status(400).json({
          ok: false,
          error: "invalid_seller_manual_percent",
          message: manualPromoPercentMessage("seller_manual_percent"),
        });
      }

      if (Math.round(pct) !== pct) {
        return res.status(400).json({
          ok: false,
          error: "seller_manual_percent_must_be_integer",
          message: "O template do Mercado Livre exige porcentagem inteira. Use valores sem casas decimais.",
        });
      }

      if (!Array.isArray(itemIds) || !itemIds.length) {
        return res.status(400).json({
          ok: false,
          error: "item_ids_required",
          message: "Envie os item_ids filtrados para preencher o template.",
        });
      }

      if (!req.file?.buffer) {
        return res.status(400).json({
          ok: false,
          error: "template_required",
          message: "Envie o template original baixado do Mercado Livre.",
        });
      }

      const rows = await buildSellerCampaignExportRows(req, creds, {
        promotion_id: promotionId,
        promotion_type: typeUp,
        item_ids: itemIds,
        seller_manual_percent: pct,
      });

      if (!rows.length) {
        return res.status(404).json({
          ok: false,
          error: "no_rows",
          message: "Nenhum item foi localizado para preencher o template.",
        });
      }

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(req.file.buffer);
      const sheet =
        workbook.getWorksheet("Promoções") ||
        workbook.getWorksheet("Promocoes");

      if (!sheet) {
        return res.status(400).json({
          ok: false,
          error: "invalid_template",
          message: 'Não encontrei a aba "Promoções" no template enviado.',
        });
      }

      const startRow = 6;
      const maxRows = Math.max(rows.length + startRow + 5, 1000);
      for (let i = 0; i < rows.length; i++) {
        const rowNumber = startRow + i;
        const row = sheet.getRow(rowNumber);
        const data = rows[i];
        row.getCell("A").value = data["Titulo do anuncio"] || "";
        row.getCell("B").value = data["Numero do anuncio"] || "";
        row.getCell("C").value = data.SKU || "";
        row.getCell("D").value =
          data["Preco original"] === "" ? "" : Number(data["Preco original"]);
        row.getCell("E").value =
          data.Porcentagem === "" ? "" : Math.round(Number(data.Porcentagem));
        row.getCell("F").value =
          data["Preco final"] === "" ? "" : Number(data["Preco final"]);
        row.getCell("G").value = row.getCell("G").value || "";
        row.getCell("H").value = row.getCell("H").value || "";
        row.getCell("I").value = "";
        row.getCell("J").value = "";
        row.getCell("K").value = "";
        row.getCell("L").value = data["Status campanha"] || "";
        row.getCell("M").value = "Participar";
        row.getCell("N").value = "";
        row.commit();
      }

      for (let rowNumber = startRow + rows.length; rowNumber <= maxRows; rowNumber++) {
        const row = sheet.getRow(rowNumber);
        for (const col of ["A", "B", "C", "D", "E", "F", "I", "J", "L", "M", "N"]) {
          row.getCell(col).value = "";
        }
        row.commit();
      }

      const buffer = await workbook.xlsx.writeBuffer();
      const filename = buildExportFilename(
        (campaign_name || promotionId) + "-template-ml"
      );
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`
      );
      return res.send(Buffer.from(buffer));
    } catch (e) {
      console.error(
        "[/api/promocoes/promotions/:promotionId/fill-ml-template] erro:",
        e
      );
      return res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  }
);

/* ===========================================================
 * NOVO ENDPOINT: aplicar em massa TODOS OS FILTRADOS (backend job)
 * compatível com o front: POST /api/promocoes/promotions/:promotionId/apply-bulk
 * Body:
 * {
 *   "promotion_type": "DEAL|SELLER_CAMPAIGN|SMART|PRICE_MATCHING|PRICE_MATCHING_MELI_ALL|MARKETPLACE_CAMPAIGN|PRICE_DISCOUNT|DOD",
 *   "filters": { "query_mlb": "...", "query_mlbs": ["MLB..."], "status": "candidate|started|all", "discount_max": 15 },
 *   "price_policy": "min"|"max",
 *   "options": { "dryRun": false, "expected_total": 123 }
 * }
 * =========================================================== */
// POST /api/promocoes/promotions/:promotionId/apply-bulk
core.post(
  "/api/promocoes/promotions/:promotionId/apply-bulk",
  createAuditAction({
    evento: "promotion_bulk_apply_started",
    metadata: (req) => ({
      promotion_id: req.params?.promotionId || null,
      promotion_type: req.body?.promotion_type || null,
      promotion_name: req.body?.promotion_name || req.body?.campaign_name || null,
      expected_total:
        req.body?.options?.expected_total ?? req.body?.expected_total ?? null,
      filters: req.body?.filters || null,
      seller_manual_percent:
        req.body?.options?.seller_manual_percent ??
        req.body?.seller_manual_percent ??
        null,
      deal_manual_percent:
        req.body?.options?.deal_manual_percent ??
        req.body?.deal_manual_percent ??
        null,
      lightning_stock:
        req.body?.options?.lightning_stock ??
        req.body?.lightning_stock ??
        null,
    }),
  }),
  async (req, res) => {
    try {
      if (
        !PromoJobsService ||
        typeof PromoJobsService.enqueueBulkApply !== "function"
      ) {
        return res
          .status(503)
          .json({ success: false, error: "PromoJobsService indisponível" });
      }
      PromoJobsService.init?.();

      const creds = res.locals.mlCreds || {};
      const accountKey = resolveAccountKeyFromLocals(res);
      if (!accountKey) {
        return res.status(400).json({
          success: false,
          error: "Conta selecionada e obrigatoria para iniciar jobs.",
        });
      }
      const accountLabel = res.locals.accountLabel || accountKey;

      // pega :promotionId da URL e usa como promotion_id internamente
      const { promotionId: promotion_id } = req.params || {};
      const {
        promotion_type,
        promotion_name,
        filters: fIn = {},
        options = {},
      } = req.body || {};
      let selectionPromotionName = null;

      if (!promotion_id || !promotion_type) {
        return res.status(400).json({
          success: false,
          error: "promotionId e promotion_type são obrigatórios",
        });
      }

      const t = String(promotion_type).toUpperCase();
      const allowed = new Set([
        "DEAL",
        "SELLER_CAMPAIGN",
        "SMART",
        "PRE_NEGOTIATED",
        "UNHEALTHY_STOCK",
        "PRICE_MATCHING",
        "PRICE_MATCHING_MELI_ALL",
        "MARKETPLACE_CAMPAIGN",
        "PRICE_DISCOUNT",
        "DOD",
        "LIGHTNING",
      ]);
      if (!allowed.has(t)) {
        return res
          .status(400)
          .json({ success: false, error: `promotion_type inválido: ${t}` });
      }
      const sellerManualPercent =
        options.seller_manual_percent == null
          ? null
          : Number(options.seller_manual_percent);
      const dealManualPercent =
        options.deal_manual_percent == null
          ? null
          : Number(options.deal_manual_percent);
      const lightningStock = resolveLightningApplyStock(
        options.lightning_stock
      );
      if (
        t === "SELLER_CAMPAIGN" &&
        !isValidManualPromoPercent(sellerManualPercent)
      ) {
        return res.status(400).json({
          success: false,
          error: manualPromoPercentMessage("seller_manual_percent"),
        });
      }
      if (
        requiresDealManualPercent(t) &&
        !isValidManualPromoPercent(dealManualPercent)
      ) {
        return res.status(400).json({
          success: false,
          error: manualPromoPercentMessage("deal_manual_percent"),
        });
      }
      if (t === "LIGHTNING" && lightningStock == null) {
        return res.status(400).json({
          success: false,
          error:
            "lightning_stock deve ser um inteiro maior ou igual a 5 para aplicação em massa de LIGHTNING.",
        });
      }

      const selectionToken = String(
        req.body?.selection_token ||
          req.body?.token ||
          options.selection_token ||
          ""
      ).trim();
      let selectionItems = null;
      let selectionIds = [];
      let selectionApplicationSource = selectionToken ? "list_validation" : "list_selection_ids";

      // normaliza filtros do front
      let filters = {
        status:
          fIn.status && String(fIn.status).toLowerCase() !== "all"
            ? String(fIn.status)
            : null,
        maxDesc:
          fIn.discount_max != null
            ? Number(fIn.discount_max)
            : fIn.maxDesc != null
            ? Number(fIn.maxDesc)
            : null,
        mlb: normalizeMlbId(fIn.query_mlb ?? fIn.mlb ?? null) || null,
        mlbs: normalizeMlbList(fIn.query_mlbs ?? fIn.mlbs ?? null),
      };

      if (selectionToken) {
        if (
          !PromoSelectionStore ||
          typeof PromoSelectionStore.getSelection !== "function"
        ) {
          return res.status(503).json({
            success: false,
            error: "PromoSelectionStore indisponivel para usar selection_token.",
          });
        }

        const selection = await PromoSelectionStore.getSelection(selectionToken, {
          accountKey,
        });
        if (!selection) {
          return res.status(404).json({
            success: false,
            error: "Selecao nao encontrada ou expirada.",
          });
        }
        selectionPromotionName = selection.promotionName || selection.meta?.promotionName || null;
        if (
          String(selection.promotionId || "") !== String(promotion_id) ||
          String(selection.promotionType || "").toUpperCase() !== t
        ) {
          return res.status(409).json({
            success: false,
            error: "selection_token nao pertence a campanha informada.",
          });
        }

        selectionItems = Array.isArray(selection.items)
          ? selection.items
              .map((item) =>
                item && typeof item === "object"
                  ? {
                      ...item,
                      id: String(item.id || item.item_id || "")
                        .trim()
                        .toUpperCase(),
                    }
                  : { id: String(item || "").trim().toUpperCase() }
              )
              .filter((item) => String(item?.id || item?.item_id || "").trim())
          : [];
        selectionIds = [
          ...new Set(
            selectionItems
              .map((item) =>
                String(item?.id || item?.item_id || "")
                  .trim()
                  .toUpperCase()
              )
              .filter(Boolean)
          ),
        ];
        if (!selectionIds.length) {
          return res.status(409).json({
            success: false,
            error: "Selecao preparada vazia. Refaca a verificacao antes de aplicar.",
          });
        }

        const fSel = selection.filters || {};
        selectionApplicationSource =
          selection.meta?.application_source || selectionApplicationSource;
        filters = {
          status: fSel.status || null,
          maxDesc: fSel.percent_max != null ? Number(fSel.percent_max) : null,
          mlb: fSel.mlb || null,
          mlbs: selectionIds,
        };
        await PromoSelectionStore.touch?.(selectionToken);
      } else {
        selectionIds = normalizeMlbList(
          req.body?.selection_ids ??
            req.body?.selectionIds ??
            req.body?.ids ??
            fIn.selection_ids ??
            fIn.selectionIds ??
            null
        );
        if (!selectionIds.length) {
          return res.status(409).json({
            success: false,
            error:
              "apply-bulk legado exige selection_token ou selection_ids. Prepare a selecao antes de aplicar.",
          });
        }
        filters = {
          ...filters,
          mlb: null,
          mlbs: selectionIds,
        };
      }

      const enqueueResult = await PromoJobsService.enqueueBulkApply({
        mlCreds: creds,
        accountKey,
        accountLabel,
        action: "apply",
        promotion: {
          id: String(promotion_id),
          type: t,
          name: String(selectionPromotionName || promotion_name || promotion_id),
        },
        filters,
        price_policy: "min",
        options: {
          dryRun: !!options.dryRun,
          expected_total: selectionIds.length || options.expected_total || null,
          prevalidated_selection: true,
          application_source: selectionApplicationSource,
          selection_count: selectionIds.length,
          seller_manual_percent: sellerManualPercent,
          deal_manual_percent: dealManualPercent,
          lightning_stock: lightningStock,
        },
        selectionItems:
          Array.isArray(selectionItems) && isOfferBasedPromotionType(t)
            ? selectionItems.map(compactPreparedOfferSelectionItem)
            : Array.isArray(selectionItems) && selectionItems.length <= 200
              ? selectionItems
              : null,
        auditContext: buildAuditContext(req, res, accountKey, accountLabel),
      });

      const normalizedEnqueue = normalizePromoEnqueueResult(enqueueResult);
      const jobId = normalizedEnqueue.id;
      const encodedJobId = encodePromotionJobId(PROMO_JOB_SOURCE_BULL, jobId);
      return res.json({
        success: true,
        job_id: encodedJobId,
        reused: normalizedEnqueue.reused,
        reused_reason: normalizedEnqueue.reusedReason,
        ...promotionJobIdentity(encodedJobId, PROMO_JOB_SOURCE_BULL),
        account: {
          key: accountKey,
          label: accountLabel,
        },
      });
    } catch (e) {
      console.error(
        "[/api/promocoes/promotions/:promotionId/apply-bulk] erro:",
        e
      );
      return res
        .status(Number(e?.statusCode || 500))
        .json({ success: false, error: e.message || String(e), code: e?.code || null });
    }
  }
);

// === PREPARAR JOB EM MASSA (todas as páginas/filtrados) ===
core.post(
  "/api/promocoes/bulk/prepare",
  createAuditAction({
    evento: "promotion_bulk_prepare",
    metadata: (req) => ({
      action: req.body?.action || "apply",
      promotion_id: req.body?.promotion_id || null,
      promotion_type: req.body?.promotion_type || null,
      promotion_name: req.body?.promotion_name || req.body?.campaign_name || null,
      filters: req.body?.filters || null,
      price_policy: req.body?.price_policy || null,
    }),
  }),
  async (req, res) => {
  try {
    if (
      !PromoJobsService ||
      typeof PromoJobsService.enqueueBulkApply !== "function"
    ) {
      return res
        .status(503)
        .json({ ok: false, error: "PromoJobsService indisponível" });
    }
    PromoJobsService.init?.();

    const creds = res.locals.mlCreds || {};
    const accountKey = resolveAccountKeyFromLocals(res);
    if (!accountKey) {
      return res.status(400).json({
        ok: false,
        error: "Conta selecionada e obrigatoria para preparar jobs.",
      });
    }
    const accountLabel = res.locals.accountLabel || accountKey;

    const {
      action = "apply", // 'apply' | 'remove'
      promotion_id,
      promotion_type,
      promotion_name,
      filters = {}, // { status, maxDesc, mlb }
      price_policy = "min", // 'min' | 'max'
      options = {},
    } = req.body || {};

    if (!promotion_id || !promotion_type) {
      return res.status(400).json({
        ok: false,
        error: "promotion_id e promotion_type são obrigatórios.",
      });
    }
    const promotionTypeUp = String(promotion_type || "").toUpperCase();
    const isApplyAction = String(action || "apply").toLowerCase() === "apply";
    const sellerManualPercent =
      options.seller_manual_percent == null
        ? null
        : Number(options.seller_manual_percent);
    const dealManualPercent =
      options.deal_manual_percent == null
        ? null
        : Number(options.deal_manual_percent);
    const lightningStock = resolveLightningApplyStock(options.lightning_stock);

    if (
      isApplyAction &&
      promotionTypeUp === "SELLER_CAMPAIGN" &&
      !isValidManualPromoPercent(sellerManualPercent)
    ) {
      return res.status(400).json({
        ok: false,
        error: manualPromoPercentMessage("seller_manual_percent"),
      });
    }
    if (
      isApplyAction &&
      requiresDealManualPercent(promotionTypeUp) &&
      !isValidManualPromoPercent(dealManualPercent)
    ) {
      return res.status(400).json({
        ok: false,
        error: manualPromoPercentMessage("deal_manual_percent"),
      });
    }
    if (isApplyAction && promotionTypeUp === "LIGHTNING" && lightningStock == null) {
      return res.status(400).json({
        ok: false,
        error:
          "lightning_stock deve ser um inteiro maior ou igual a 5 para aplicação em massa de LIGHTNING.",
      });
    }

    const enqueueResult = await PromoJobsService.enqueueBulkApply({
      mlCreds: creds,
      accountKey,
      accountLabel,
      action,
      promotion: {
        id: promotion_id,
        type: promotionTypeUp,
        name: String(promotion_name || promotion_id),
      },
      filters,
      price_policy: String(price_policy || "").toLowerCase() === "max" ? "max" : "min",
      options: {
        dryRun: !!options.dryRun,
        expected_total: options.expected_total ?? null,
        seller_manual_percent: sellerManualPercent,
        deal_manual_percent: dealManualPercent,
        lightning_stock: lightningStock,
      },
      auditContext: buildAuditContext(req, res, accountKey, accountLabel),
    });

    const normalizedEnqueue = normalizePromoEnqueueResult(enqueueResult);
    const jobId = normalizedEnqueue.id;
    const encodedJobId = encodePromotionJobId(PROMO_JOB_SOURCE_BULL, jobId);
    return res.json({
      ok: true,
      job_id: encodedJobId,
      reused: normalizedEnqueue.reused,
      reused_reason: normalizedEnqueue.reusedReason,
      ...promotionJobIdentity(encodedJobId, PROMO_JOB_SOURCE_BULL),
      account: {
        key: accountKey,
        label: accountLabel,
      },
    });
  } catch (e) {
    console.error("[/api/promocoes/bulk/prepare] erro:", e);
    return res.status(Number(e?.statusCode || 500)).json({ ok: false, error: e.message || String(e), code: e?.code || null });
  }
  },
);

/**
 * Inteligência de promoções - análise SMART por rebate.
 * A análise é somente leitura e roda em background para não travar a página.
 */
core.post(
  "/api/promocoes/intelligence/smart/analyze",
  createAuditAction({
    evento: "promotion_smart_analysis_requested",
    metadata: (_req, res) => ({
      account_key: resolveAccountKeyFromLocals(res) || null,
    }),
  }),
  async (req, res) => {
    try {
      if (!PromoSmartOptimizerService?.startAnalysis) {
        return res.status(503).json({ ok: false, error: "Serviço de inteligência SMART indisponível." });
      }
      const accountKey = resolveAccountKeyFromLocals(res);
      if (!accountKey) {
        return res.status(400).json({ ok: false, error: "Selecione uma conta Mercado Livre." });
      }
      const accountLabel = res.locals?.accountLabel || accountKey;
      PromoSmartOptimizerService.init?.();
      const analysisId = await PromoSmartOptimizerService.startAnalysis({
        mlCreds: res.locals.mlCreds || {},
        accountKey,
        accountLabel,
        auditContext: buildAuditContext(req, res, accountKey, accountLabel),
      });
      return res.status(202).json({
        ok: true,
        analysis_id: analysisId,
        status_url: `/api/promocoes/intelligence/smart/analyses/${encodeURIComponent(analysisId)}`,
        account: { key: accountKey, label: accountLabel },
      });
    } catch (error) {
      console.error("[/api/promocoes/intelligence/smart/analyze] erro:", error);
      return res.status(500).json({ ok: false, error: error?.message || String(error) });
    }
  },
);

core.get("/api/promocoes/intelligence/smart/analyses/:analysis_id", async (req, res) => {
  try {
    if (!PromoSmartOptimizerService?.getAnalysis) {
      return res.status(503).json({ ok: false, error: "Serviço de inteligência SMART indisponível." });
    }
    const accountKey = resolveAccountKeyFromLocals(res);
    if (!accountKey) {
      return res.status(400).json({ ok: false, error: "Selecione uma conta Mercado Livre." });
    }
    const analysis = await PromoSmartOptimizerService.getAnalysis(req.params.analysis_id, { accountKey });
    if (!analysis) {
      return res.status(404).json({ ok: false, error: "Análise não encontrada ou expirada." });
    }
    return res.json({ ok: true, analysis_id: req.params.analysis_id, ...analysis });
  } catch (error) {
    console.error("[/api/promocoes/intelligence/smart/analyses/:id] erro:", error);
    return res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
});

core.post(
  "/api/promocoes/intelligence/smart/optimize",
  createAuditAction({
    evento: "promotion_smart_optimization_requested",
    metadata: (req) => ({
      analysis_id: req.body?.analysis_id || null,
      selected_count: Array.isArray(req.body?.opportunity_ids) ? req.body.opportunity_ids.length : 0,
    }),
  }),
  async (req, res) => {
    try {
      if (!PromoSmartOptimizerService?.enqueueOptimization) {
        return res.status(503).json({ ok: false, error: "Serviço de inteligência SMART indisponível." });
      }
      const accountKey = resolveAccountKeyFromLocals(res);
      if (!accountKey) {
        return res.status(400).json({ ok: false, error: "Selecione uma conta Mercado Livre." });
      }
      const analysisId = String(req.body?.analysis_id || "").trim();
      const opportunityIds = Array.isArray(req.body?.opportunity_ids)
        ? req.body.opportunity_ids.map((value) => String(value || "").trim()).filter(Boolean)
        : [];
      if (!analysisId) {
        return res.status(400).json({ ok: false, error: "analysis_id é obrigatório." });
      }
      if (!opportunityIds.length) {
        return res.status(400).json({ ok: false, error: "Selecione ao menos uma oportunidade segura." });
      }

      const accountLabel = res.locals?.accountLabel || accountKey;
      PromoSmartOptimizerService.init?.();
      const created = await PromoSmartOptimizerService.enqueueOptimization({
        analysisId,
        opportunityIds,
        accountKey,
        accountLabel,
        mlCreds: res.locals.mlCreds || {},
        auditContext: buildAuditContext(req, res, accountKey, accountLabel),
      });
      const encodedJobId = encodePromotionJobId(PROMO_JOB_SOURCE_SMART, created.id);
      return res.status(202).json({
        ok: true,
        job_id: encodedJobId,
        operation_id: created.operationId,
        total: created.total,
        ...promotionJobIdentity(encodedJobId, PROMO_JOB_SOURCE_SMART),
        account: { key: accountKey, label: accountLabel },
      });
    } catch (error) {
      const message = error?.message || String(error);
      const status = /expirou|não foi encontrada|outra conta|selecione/i.test(message) ? 409 : 500;
      console.error("[/api/promocoes/intelligence/smart/optimize] erro:", error);
      return res.status(status).json({ ok: false, error: message });
    }
  },
);

/** Jobs – barra lateral de progresso (lista + detalhe + remover em massa) */
core.get("/api/promocoes/jobs", async (req, res) => {
  try {
    const accountKey = resolveAccountKeyFromLocals(res);
    if (!accountKey) {
      return res.json({ ok: true, jobs: [] });
    }
    const requestedSource = String(req.query?.source || "").trim().toLowerCase();
    const sourceFilter =
      [PROMO_JOB_SOURCE_REMOVE, PROMO_JOB_SOURCE_BULL, PROMO_JOB_SOURCE_SMART].includes(requestedSource)
        ? requestedSource
        : null;
    const includeRemove = !sourceFilter || sourceFilter === PROMO_JOB_SOURCE_REMOVE;
    const includePromo = !sourceFilter || sourceFilter === PROMO_JOB_SOURCE_BULL;
    const includeSmart = !sourceFilter || sourceFilter === PROMO_JOB_SOURCE_SMART;

    // As três filas são independentes. Consultá-las em série fazia o painel
    // esperar a soma das latências do Redis (no HAR real chegou a ~20 s).
    // Rodamos em paralelo e isolamos falhas para uma fonte não derrubar as demais.
    if (includeRemove) {
      ensurePromoBulkRemoveWorker();
    }
    const [ours, bull, smart] = await Promise.all([
      includeRemove && PromoBulkRemove?.listRecent
        ? PromoBulkRemove.listRecent(25, { accountKey })
            .then((jobs) => jobs.map((job) => ({ ...job, source: PROMO_JOB_SOURCE_REMOVE })))
            .catch(() => [])
        : Promise.resolve([]),
      includePromo && PromoJobsService?.listRecent
        ? PromoJobsService.listRecent(25, { accountKey })
            .then((jobs) => jobs.map((job) => ({ ...job, source: PROMO_JOB_SOURCE_BULL })))
            .catch(() => [])
        : Promise.resolve([]),
      includeSmart && PromoSmartOptimizerService?.listRecent
        ? PromoSmartOptimizerService.listRecent(25, { accountKey })
            .then((jobs) => jobs.map((job) => ({ ...job, source: PROMO_JOB_SOURCE_SMART })))
            .catch(() => [])
        : Promise.resolve([]),
    ]);

    // Normalizador super tolerante (cada fonte usa nomes diferentes)
    const norm = (j) => {
      if (!j) return null;
      const source = String(j.source || "").trim().toLowerCase() || null;
      const id = encodePromotionJobId(
        source,
        String(j.id || j.job_id || j._id || "")
      );
      const state = String(j.state || j.status || j.phase || "queued");

      // números
      const processed =
        Number(
          j.processed ??
            j.done ??
            j.success ??
            j.stats?.processed ??
            j.progress?.processed ??
            0
        ) || 0;
      const total =
        Number(
          j.total ??
            j.expected_total ??
            j.count ??
            j.stats?.total ??
            j.progress?.total ??
            0
        ) || 0;

      // progresso %
      const rawProgress =
        typeof j.progress === "number" ? j.progress : j.progress?.percent;
      let progress = Number(
        rawProgress ?? j.percent ?? j.percentage ?? j.stats?.percent ?? 0
      );
      if (!progress && total > 0) {
        progress = Math.max(
          0,
          Math.min(100, Math.round((processed / total) * 100))
        );
      }
      if (!Number.isFinite(progress)) progress = 0;

      // descrição amigável
      const label = j.title || j.name || j.description || "";
      const updated_at = j.updated_at || j.ts || Date.now();
      const failed =
        Number(
          j.failed ??
            j.errors ??
            j.error_count ??
            j.failures ??
            j.counters?.failed ??
            j.stats?.failed ??
            0
        ) || 0;
      const success =
        Number(j.success ?? j.counters?.success ?? j.stats?.success ?? 0) || 0;
      const accountKey =
        j.account?.key || j.accountKey || j.account_key || null;
      const accountLabel =
        j.account?.label || j.accountLabel || j.account_label || accountKey || null;

      return attachPromotionJobContract({
        id,
        raw_id: String(j.id || j.job_id || j._id || ""),
        source,
        state,
        lifecycle_status: j.lifecycle_status || null,
        processed,
        total,
        progress,
        failed,
        success,
        counters: { processed, total, success, failed },
        label,
        updated_at,
        account:
          accountKey || accountLabel
            ? {
                key: accountKey || null,
                label: accountLabel || accountKey || null,
              }
            : null,
        accountKey,
        accountLabel,
        has_errors: j.has_errors ?? failed > 0,
        download_csv_url: j.download_csv_url || null,
        review_action: j.review_action || null,
        safety_paused: j.safety_paused === true,
        resumable: j.resumable === true,
        pending: Number(j.pending || 0),
        resume_url: j.resume_url || null,
        full_report_url: j.full_report_url || null,
        retry_wait: j.retry_wait === true,
        retry_at: j.retry_at || null,
        retry_attempt: j.retry_attempt || null,
        retry_max_attempts: j.retry_max_attempts || null,
        retry_reason: j.retry_reason || null,
        cancel_requested: j.cancel_requested === true,
        operation_id: j.operation_id || null,
        remediation_total: Number(j.remediation_total || 0),
        remediation_pending: Number(j.remediation_pending || 0),
        remediation_resolved: Number(j.remediation_resolved || 0),
        remediation_critical: Number(j.remediation_critical || 0),
        queue_position: j.queue_position ?? null,
        queue_wait_seconds: j.queue_wait_seconds ?? 0,
        queue_reason: j.queue_reason || null,
        worker_status: j.worker_status || null,
        worker_last_seen: j.worker_last_seen || null,
        worker_instance: j.worker_instance || null,
        worker_delayed: j.worker_delayed === true,
        stalled_warning: j.stalled_warning === true,
        failed_reason: j.failed_reason || null,
        items_per_minute: j.items_per_minute ?? null,
        eta_seconds: j.eta_seconds ?? null,
        item_concurrency: j.item_concurrency ?? null,
        item_concurrency_max: j.item_concurrency_max ?? null,
        last_item_duration_ms: j.last_item_duration_ms ?? null,
      }, {
        backendJobId: id,
        kind: source,
        ...(typeof j.can_cancel === "boolean" ? { canCancel: j.can_cancel } : {}),
      });
    };

    const merged = [...ours, ...bull, ...smart]
      .map(norm)
      .filter(Boolean)
      // mais recentes primeiro
      .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));

    // evita 304/ETag e força atualização no fetch
    res.set(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate"
    );
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.set("Surrogate-Control", "no-store");

    return res.json({ ok: true, jobs: merged });
  } catch (e) {
    console.error("[/api/promocoes/jobs] erro:", e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

core.get("/api/promocoes/jobs/:job_id", async (req, res) => {
  try {
    const { source, rawId } = decodePromotionJobId(req.params.job_id);
    const accountKey = resolveAccountKeyFromLocals(res);
    if (!accountKey) {
      return res.status(400).json({ ok: false, error: "Conta selecionada e obrigatoria." });
    }
    if (!source || source === PROMO_JOB_SOURCE_REMOVE) {
      ensurePromoBulkRemoveWorker();
      const j = PromoBulkRemove?.jobDetail
        ? await PromoBulkRemove.jobDetail(rawId, { accountKey })
        : null;
      if (j) {
        return res.json(attachPromotionJobContract({
          ...j,
          id: encodePromotionJobId(PROMO_JOB_SOURCE_REMOVE, j.id),
          raw_id: String(j.id || rawId || ""),
          source: PROMO_JOB_SOURCE_REMOVE,
        }, {
          backendJobId: encodePromotionJobId(PROMO_JOB_SOURCE_REMOVE, j.id),
          kind: PROMO_JOB_SOURCE_REMOVE,
        }));
      }
    }

    if (!source || source === PROMO_JOB_SOURCE_BULL) {
      if (PromoJobsService?.jobDetail) {
        const jb = await PromoJobsService.jobDetail(rawId, { accountKey });
        if (jb) {
          return res.json(attachPromotionJobContract({
            ...jb,
            id: encodePromotionJobId(PROMO_JOB_SOURCE_BULL, jb.id),
            raw_id: String(jb.id || rawId || ""),
            source: PROMO_JOB_SOURCE_BULL,
          }, {
            backendJobId: encodePromotionJobId(PROMO_JOB_SOURCE_BULL, jb.id),
            kind: PROMO_JOB_SOURCE_BULL,
          }));
        }
      }
    }

    if (!source || source === PROMO_JOB_SOURCE_SMART) {
      if (PromoSmartOptimizerService?.jobDetail) {
        const js = await PromoSmartOptimizerService.jobDetail(rawId, { accountKey });
        if (js) {
          const encoded = encodePromotionJobId(PROMO_JOB_SOURCE_SMART, js.id);
          return res.json(attachPromotionJobContract({
            ...js,
            id: encoded,
            raw_id: String(js.id || rawId || ""),
            source: PROMO_JOB_SOURCE_SMART,
          }, { backendJobId: encoded, kind: PROMO_JOB_SOURCE_SMART }));
        }
      }
    }

    return res.status(404).json({ ok: false, error: "job não encontrado" });
  } catch (e) {
    console.error("[/api/promocoes/jobs/:id] erro:", e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

core.post(
  "/api/promocoes/jobs/:job_id/cancel",
  createAuditAction({
    evento: "promotion_job_cancel_requested_by_user",
    metadata: (req) => ({ job_id: req.params?.job_id || null }),
  }),
  async (req, res) => {
  try {
    const { source, rawId } = decodePromotionJobId(req.params.job_id);
    const accountKey = resolveAccountKeyFromLocals(res);
    if (!accountKey) {
      return res.status(400).json({ ok: false, error: "Conta selecionada e obrigatoria." });
    }

    let result = null;
    if ((!source || source === PROMO_JOB_SOURCE_REMOVE) && PromoBulkRemove?.cancelJob) {
      result = await PromoBulkRemove.cancelJob(rawId, { accountKey });
    }
    if (!result && (!source || source === PROMO_JOB_SOURCE_BULL) && PromoJobsService?.cancelJob) {
      result = await PromoJobsService.cancelJob(rawId, {
        accountKey,
        cancelAuditContext: buildAuditContext(req, res, accountKey),
      });
    }
    if (!result && (!source || source === PROMO_JOB_SOURCE_SMART) && PromoSmartOptimizerService?.cancelJob) {
      result = await PromoSmartOptimizerService.cancelJob(rawId, { accountKey });
    }

    if (!result) {
      return res.status(404).json({ ok: false, error: "job nao encontrado" });
    }
    if (!result.ok) {
      return res.status(409).json({
        ok: false,
        error: result.error || "Nao foi possivel cancelar o job.",
        status: result.status || null,
      });
    }
    const encodedJobId = encodePromotionJobId(source || PROMO_JOB_SOURCE_BULL, rawId);
    const processed = Number(result.processed || 0);
    const total = Number(result.total || 0);
    const coverage = total > 0 ? Math.max(0, Math.min(100, Math.round((processed / total) * 100))) : 0;
    const canceledJob = attachPromotionJobContract({
      id: encodedJobId,
      source: source || PROMO_JOB_SOURCE_BULL,
      status: result.status || "cancelado",
      completed: result.status === "cancelado",
      processed,
      total,
      progress: coverage,
    }, { backendJobId: encodedJobId });
    return res.json({
      ok: true,
      job_id: encodedJobId,
      job_uid: canceledJob.job_uid,
      backend_job_id: canceledJob.backend_job_id,
      lifecycle_status: canceledJob.lifecycle_status,
      job_contract: canceledJob.job_contract,
      status: result.status || "cancelado",
      processed,
      total,
      progress: coverage,
    });
  } catch (e) {
    console.error("[/api/promocoes/jobs/:job_id/cancel] erro:", e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
  },
);

core.post(
  "/api/promocoes/jobs/:job_id/resume",
  createAuditAction({
    evento: "promotion_job_resume_requested",
    metadata: (req) => ({ job_id: req.params?.job_id || null }),
  }),
  async (req, res) => {
    try {
      const { source, rawId } = decodePromotionJobId(req.params.job_id);
      const accountKey = resolveAccountKeyFromLocals(res);
      if (!accountKey) {
        return res.status(400).json({ ok: false, error: "Conta selecionada e obrigatoria." });
      }
      if (source && source !== PROMO_JOB_SOURCE_BULL) {
        return res.status(400).json({ ok: false, error: "Este tipo de job nao permite retomada." });
      }
      const result = PromoJobsService?.resumePendingJob
        ? await PromoJobsService.resumePendingJob(rawId, { accountKey })
        : null;
      if (!result) {
        return res.status(404).json({ ok: false, error: "Job nao encontrado." });
      }
      if (!result.ok) {
        return res.status(409).json({
          ok: false,
          error: result.error || "Nao foi possivel retomar o job.",
          status: result.status || null,
        });
      }
      const encodedJobId = encodePromotionJobId(PROMO_JOB_SOURCE_BULL, result.id);
      return res.json({
        ok: true,
        job_id: encodedJobId,
        pending: result.pending,
        ...promotionJobIdentity(encodedJobId, PROMO_JOB_SOURCE_BULL),
      });
    } catch (e) {
      console.error("[/api/promocoes/jobs/:job_id/resume] erro:", e);
      return res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  },
);

core.get("/api/promocoes/jobs/:job_id/failed-items", async (req, res) => {
  try {
    const { rawId } = decodePromotionJobId(req.params.job_id);
    const accountKey = resolveAccountKeyFromLocals(res);
    if (!accountKey) {
      return res.status(400).json({ ok: false, error: "Conta selecionada e obrigatoria." });
    }
    const jb = PromoJobsService?.jobDetail
      ? await PromoJobsService.jobDetail(rawId, { accountKey })
      : null;
    if (!jb) {
      return res.status(404).json({ ok: false, error: "job não encontrado" });
    }
    const failedItems = Array.isArray(jb?.data?.failedItems)
      ? jb.data.failedItems
      : [];
    const encodedJobId = encodePromotionJobId(PROMO_JOB_SOURCE_BULL, rawId);
    return res.json({
      ok: true,
      job_id: encodedJobId,
      ...promotionJobIdentity(encodedJobId, PROMO_JOB_SOURCE_BULL),
      failed_items: failedItems,
      item_ids: failedItems.map((x) => String(x?.id || "").trim()).filter(Boolean),
    });
  } catch (e) {
    console.error("[/api/promocoes/jobs/:job_id/failed-items] erro:", e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

core.get("/api/promocoes/jobs/:job_id/item-traces", async (req, res) => {
  try {
    const { rawId } = decodePromotionJobId(req.params.job_id);
    const accountKey = resolveAccountKeyFromLocals(res);
    if (!accountKey) {
      return res.status(400).json({ ok: false, error: "Conta selecionada e obrigatoria." });
    }
    const itemIdFilter = String(req.query.item_id || "").trim().toUpperCase();
    const onlyFailed = String(req.query.only_failed || "").toLowerCase() === "true";
    const onlyOk = String(req.query.only_ok || "").toLowerCase() === "true";
    const jb = PromoJobsService?.jobDetail
      ? await PromoJobsService.jobDetail(rawId, { accountKey })
      : null;

    if (!jb) {
      return res.status(404).json({ ok: false, error: "job não encontrado" });
    }

    let traces = Array.isArray(jb?.data?.itemTraces)
      ? jb.data.itemTraces
      : Array.isArray(jb?.result?.item_traces)
        ? jb.result.item_traces
        : [];

    if (itemIdFilter) {
      traces = traces.filter(
        (trace) => String(trace?.item_id || "").trim().toUpperCase() === itemIdFilter
      );
    }
    if (onlyFailed && !onlyOk) {
      traces = traces.filter((trace) => trace?.ok === false);
    } else if (onlyOk && !onlyFailed) {
      traces = traces.filter((trace) => trace?.ok === true);
    }

    const encodedJobId = encodePromotionJobId(PROMO_JOB_SOURCE_BULL, rawId);
    return res.json({
      ok: true,
      job_id: encodedJobId,
      ...promotionJobIdentity(encodedJobId, PROMO_JOB_SOURCE_BULL),
      total: traces.length,
      traces
    });
  } catch (e) {
    console.error("[/api/promocoes/jobs/:job_id/item-traces] erro:", e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

core.get(
  "/api/promocoes/jobs/:job_id/download.xlsx",
  createAuditAction({
    evento: "promotion_job_results_xlsx_downloaded",
    metadata: (req) => {
      const { source, rawId } = decodePromotionJobId(req.params?.job_id);
      return {
        job_id: String(req.params?.job_id || "").trim() || null,
        raw_job_id: rawId || null,
        source: source || null,
      };
    },
  }),
  async (req, res) => {
    try {
      const { source, rawId } = decodePromotionJobId(req.params.job_id);
      const accountKey = resolveAccountKeyFromLocals(res);
      if (!accountKey) {
        return res.status(400).json({ ok: false, error: "Conta selecionada e obrigatoria." });
      }
      if (source && ![PROMO_JOB_SOURCE_BULL, PROMO_JOB_SOURCE_SMART].includes(source)) {
        return res.status(400).json({ ok: false, error: "Excel indisponivel para este job." });
      }

      let file = null;
      if ((!source || source === PROMO_JOB_SOURCE_BULL) && PromoJobsService?.getJobXlsx) {
        file = await PromoJobsService.getJobXlsx(rawId, { accountKey });
      }
      if (!file && (!source || source === PROMO_JOB_SOURCE_SMART) && PromoSmartOptimizerService?.getJobXlsx) {
        file = await PromoSmartOptimizerService.getJobXlsx(rawId, { accountKey });
      }
      if (!file?.buffer) {
        return res.status(404).json({ ok: false, error: "Excel do job nao encontrado." });
      }

      res.setHeader(
        "Content-Type",
        file.contentType || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
      return res.send(file.buffer);
    } catch (e) {
      console.error("[/api/promocoes/jobs/:job_id/download.xlsx] erro:", e);
      return res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  },
);

core.get(
  "/api/promocoes/jobs/:job_id/reviews.csv",
  createAuditAction({
    evento: "promotion_job_reviews_downloaded",
    metadata: (req) => ({ job_id: req.params?.job_id || null }),
  }),
  async (req, res) => {
    try {
      const { source, rawId } = decodePromotionJobId(req.params.job_id);
      const accountKey = resolveAccountKeyFromLocals(res);
      if (!accountKey) {
        return res.status(400).json({ ok: false, error: "Conta selecionada e obrigatoria." });
      }
      if (source && source !== PROMO_JOB_SOURCE_BULL) {
        return res.status(400).json({ ok: false, error: "CSV de revisoes indisponivel para este job." });
      }
      const file = PromoJobsService?.getJobCsv
        ? await PromoJobsService.getJobCsv(rawId, { accountKey, reviewsOnly: true })
        : null;
      if (!file?.csv) {
        return res.status(404).json({ ok: false, error: "CSV de revisoes nao encontrado." });
      }
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
      return res.send(file.csv);
    } catch (e) {
      console.error("[/api/promocoes/jobs/:job_id/reviews.csv] erro:", e);
      return res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  },
);

core.get(
  "/api/promocoes/jobs/:job_id/download.csv",
  createAuditAction({
    evento: "promotion_job_results_downloaded",
    metadata: (req) => {
      const { source, rawId } = decodePromotionJobId(req.params?.job_id);
      return {
        job_id: String(req.params?.job_id || "").trim() || null,
        raw_job_id: rawId || null,
        source: source || null,
      };
    },
  }),
  async (req, res) => {
  try {
    const { source, rawId } = decodePromotionJobId(req.params.job_id);
    const accountKey = resolveAccountKeyFromLocals(res);
    if (!accountKey) {
      return res.status(400).json({ ok: false, error: "Conta selecionada e obrigatoria." });
    }

    let file = null;
    if ((!source || source === PROMO_JOB_SOURCE_REMOVE) && PromoBulkRemove?.getJobCsv) {
      file = await PromoBulkRemove.getJobCsv(rawId, { accountKey });
    }
    if (!file && (!source || source === PROMO_JOB_SOURCE_BULL) && PromoJobsService?.getJobCsv) {
      file = await PromoJobsService.getJobCsv(rawId, { accountKey });
    }

    if (!file?.csv) {
      return res.status(404).json({ ok: false, error: "CSV do job nao encontrado" });
    }

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
    return res.send(file.csv);
  } catch (e) {
    console.error("[/api/promocoes/jobs/:job_id/download.csv] erro:", e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
  },
);

// Iniciar job de REMOÇÃO em massa (via seu service -> adapter)
core.post(
  "/api/promocoes/jobs/remove",
  createAuditAction({
    evento: "promotion_bulk_remove_started",
    metadata: (req) => ({
      total_items: Array.isArray(req.body?.items) ? req.body.items.length : 0,
      sample_ids: Array.isArray(req.body?.items) ? req.body.items.slice(0, 20) : [],
      delay_ms: Number(req.body?.delay_ms ?? 250) || 0,
    }),
  }),
  async (req, res) => {
  try {
    if (!PromoBulkRemove?.startRemoveJob) {
      return res
        .status(503)
        .json({ ok: false, error: "Adapter de remoção não configurado" });
    }
    ensurePromoBulkRemoveWorker();
    const body = req.body || {};
    const items = Array.isArray(body.items) ? body.items : [];
    const delay = Number(body.delay_ms ?? 250) || 0;

    if (!items.length) {
      return res
        .status(400)
        .json({ ok: false, error: 'Informe "items": [MLB...]' });
    }
    const accountKey = resolveAccountKeyFromLocals(res);
    if (!accountKey) {
      return res.status(400).json({
        ok: false,
        error: "Conta selecionada e obrigatoria para iniciar remocao.",
      });
    }

    const job = await PromoBulkRemove.startRemoveJob({
      mlbIds: items,
      delayMs: delay,
      mlCreds: res.locals.mlCreds || {},
      accountKey,
      accountLabel: res.locals.accountLabel || accountKey,
      auditContext: buildAuditContext(req, res, accountKey, res.locals.accountLabel || accountKey),
      logger: console,
    });

    const encodedJobId = encodePromotionJobId(PROMO_JOB_SOURCE_REMOVE, job.id);
    const contractedJob = attachPromotionJobContract({
      ...job,
      id: encodedJobId,
      raw_id: String(job.id || ""),
      source: PROMO_JOB_SOURCE_REMOVE,
    }, { backendJobId: encodedJobId, kind: PROMO_JOB_SOURCE_REMOVE });
    return res.json({
      ok: true,
      job_id: encodedJobId,
      ...promotionJobIdentity(encodedJobId, PROMO_JOB_SOURCE_REMOVE),
      job: contractedJob,
    });
  } catch (e) {
    console.error("[/api/promocoes/jobs/remove] erro:", e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
  },
);

core.post(
  "/api/promocoes/selection/list-validation-job",
  createAuditAction({
    evento: "promotion_list_validation_job_started",
    metadata: (req) => ({
      promotion_id: req.body?.promotion_id || null,
      promotion_type: req.body?.promotion_type || null,
      status: req.body?.status || null,
      mlbs_count: Array.isArray(req.body?.mlbs) ? req.body.mlbs.length : null,
      percent_max: req.body?.percent_max ?? null,
      application_source: "list_validation",
    }),
  }),
  async (req, res) => {
  try {
    if (
      !PromoJobsService ||
      typeof PromoJobsService.enqueueListValidation !== "function"
    ) {
      return res
        .status(503)
        .json({ ok: false, error: "PromoJobsService indisponivel para validar lista." });
    }

    const {
      promotion_id,
      promotion_type,
      promotion_name,
      status,
      mlbs,
      raw_list,
      percent_max,
    } = req.body || {};

    if (!promotion_id || !promotion_type) {
      return res.status(400).json({
        ok: false,
        error: "promotion_id e promotion_type sao obrigatorios.",
      });
    }

    const typeUp = String(promotion_type || "").toUpperCase();
    const supportsList =
      typeUp === "DEAL" ||
      typeUp === "SELLER_CAMPAIGN" ||
      typeUp === "SMART" ||
      typeUp === "PRE_NEGOTIATED" ||
      typeUp.startsWith("PRICE_MATCHING");
    if (!supportsList) {
      return res.status(400).json({
        ok: false,
        error: "Validacao por lista esta disponivel para Smart, Pre-acordo, Seller e Deal.",
      });
    }

    const normalizedMlbs = normalizeMlbList(mlbs || raw_list);
    if (!normalizedMlbs.length) {
      return res.status(400).json({
        ok: false,
        error: "Informe ao menos 1 MLB valido para validar a lista.",
      });
    }
    if (normalizedMlbs.length > 5000) {
      return res.status(400).json({
        ok: false,
        error: "Informe no maximo 5000 MLBs por job de validacao de lista.",
      });
    }

    const pct = Number(percent_max);
    if (!isValidManualPromoPercent(pct)) {
      return res.status(400).json({
        ok: false,
        error: `Informe um percentual valido entre 0,01 e ${MANUAL_PROMO_MAX_PERCENT}%.`,
      });
    }

    const accountKey = resolveAccountKeyFromLocals(res);
    if (!accountKey) {
      return res.status(400).json({
        ok: false,
        error: "Conta selecionada e obrigatoria para validar lista.",
      });
    }
    const accountLabel = String(res.locals.accountLabel || accountKey);

    PromoJobsService.init?.();
    PromoJobsService.initWorker?.();

    const jobId = await PromoJobsService.enqueueListValidation({
      mlCreds: res.locals.mlCreds || {},
      accountKey,
      accountLabel,
      promotion: {
        id: String(promotion_id),
        type: typeUp,
        name: String(promotion_name || promotion_id),
      },
      raw_list: raw_list || mlbs || normalizedMlbs,
      mlbs: normalizedMlbs,
      filters: {
        status: status || null,
        percent_max: pct,
        mlbs: normalizedMlbs,
      },
      auditContext: buildAuditContext(req, res, accountKey, accountLabel),
    });

    const encodedJobId = encodePromotionJobId(PROMO_JOB_SOURCE_BULL, jobId);
    return res.json({
      ok: true,
      job_id: encodedJobId,
      ...promotionJobIdentity(encodedJobId, PROMO_JOB_SOURCE_BULL),
      total: normalizedMlbs.length,
      account: {
        key: accountKey,
        label: accountLabel,
      },
    });
  } catch (e) {
    console.error("[/api/promocoes/selection/list-validation-job] erro:", e);
    const statusCode = Number(e?.statusCode || e?.status) || 500;
    return res.status(statusCode).json({
      ok: false,
      error: e.message || String(e),
      code: e?.code || null,
    });
  }
  },
);

/**
 * Prepara seleção global (conta todos os itens filtrados) e devolve um token.
 * Body: { promotion_id, promotion_type, status, mlb, mlbs, percent_max, stock_min, stock_max, lightning_stock }
 *
 * Usada pelo botão "Selecionar toda a campanha (filtrados)" no front.
 */
core.post(
  "/api/promocoes/selection/prepare",
  createAuditAction({
    evento: "promotion_selection_prepare",
    metadata: (req) => ({
      promotion_id: req.body?.promotion_id || null,
      promotion_type: req.body?.promotion_type || null,
      promotion_name: req.body?.promotion_name || req.body?.campaign_name || null,
      status: req.body?.status || null,
      mlb: req.body?.mlb || null,
      mlbs_count: Array.isArray(req.body?.mlbs) ? req.body.mlbs.length : null,
      percent_max: req.body?.percent_max ?? null,
      stock_min: req.body?.stock_min ?? null,
      stock_max: req.body?.stock_max ?? null,
      lightning_stock: req.body?.lightning_stock ?? null,
    }),
  }),
  async (req, res) => {
  try {
    const {
      promotion_id,
      promotion_type,
      promotion_name,
      status, // 'started' | 'candidate' | 'scheduled' | null
      mlb, // opcional, string MLB123...
      mlbs, // opcional, array/string de MLBs
      percent_max, // opcional, número (desconto máx. %)
      stock_min, // opcional, estoque total minimo
      stock_max, // opcional, estoque total maximo
      lightning_stock, // quantidade promocional solicitada
    } = req.body || {};

    if (!promotion_id || !promotion_type) {
      return res.status(400).json({
        ok: false,
        error: "promotion_id e promotion_type são obrigatórios.",
      });
    }

    // credenciais e conta já estão em res.locals, igual nas outras rotas
    const creds = res.locals.mlCreds || {};
    const accountKey = resolveAccountKeyFromLocals(res);
    if (!accountKey) {
      return res.status(400).json({
        ok: false,
        error: "Conta selecionada e obrigatoria para preparar a selecao.",
      });
    }

    // 🚫 ML não aceita limit >= 100 â†’ usamos 50 (seguro)
    const ML_LIMIT = 50;
    const mlbList = normalizeMlbList(mlbs);
    if (mlbList.length > 300) {
      return res.status(400).json({
        ok: false,
        error: "Informe no maximo 300 MLBs por preparacao.",
      });
    }
    const mlbListSet = mlbList.length ? new Set(mlbList) : null;
    const singleMlb = mlbListSet ? null : normalizeMlbId(mlb);

    let searchAfter = null;
    const ids = [];
    const seenIds = new Set();
    let page = 0;

    const hasPercentFilter =
      percent_max != null &&
      percent_max !== "" &&
      Number.isFinite(Number(percent_max));
    const percentMaxNum = hasPercentFilter ? Number(percent_max) : null;
    const parseOptionalStockInt = (value) => {
      if (value == null || value === "") return null;
      const parsed = Number(value);
      return Number.isInteger(parsed) && parsed >= 5 ? parsed : NaN;
    };
    const stockMinNum = parseOptionalStockInt(stock_min);
    const stockMaxNum = parseOptionalStockInt(stock_max);
    if (Number.isNaN(stockMinNum) || Number.isNaN(stockMaxNum)) {
      return res.status(400).json({
        ok: false,
        error: "Os filtros de estoque devem ser numeros inteiros maiores ou iguais a 5.",
      });
    }
    if (stockMinNum != null && stockMaxNum != null && stockMaxNum < stockMinNum) {
      return res.status(400).json({
        ok: false,
        error: "O estoque maximo deve ser maior ou igual ao estoque minimo.",
      });
    }
    const promotionTypeUp = String(promotion_type || "").toUpperCase();
    const hasLightningStock = lightning_stock != null && lightning_stock !== "";
    const lightningStockNum = promotionTypeUp === "LIGHTNING" && hasLightningStock
      ? resolveLightningApplyStock(lightning_stock)
      : null;
    if (promotionTypeUp === "LIGHTNING" && hasLightningStock && lightningStockNum == null) {
      return res.status(400).json({
        ok: false,
        error: "Informe uma quantidade promocional inteira de no minimo 5 unidades.",
      });
    }
    const saveSelection =
      PromoSelectionStore?.saveSelection ||
      PromoSelectionStore?.createSelection ||
      null;

    const cacheKey = buildSelectionPrepareCacheKey({
      accountKey,
      promotionId: promotion_id,
      promotionType: promotion_type,
      status: status || null,
      mlb: singleMlb || null,
      mlbs: mlbList,
      percentMax: percentMaxNum,
      stockMin: stockMinNum,
      stockMax: stockMaxNum,
      lightningStock: lightningStockNum,
    });
    const preparationId = selectionPreparationId(cacheKey);
    const preparationStatusUrl = `/api/promocoes/selection/prepare/${encodeURIComponent(preparationId)}`;
    const cached = getSelectionPrepareCacheEntry(cacheKey);
    if (cached) {
      if (typeof saveSelection === "function") {
        const stored = await saveSelection({
          accountKey,
          userId: req.user?.id || req.user?.uid || null,
          promotionId: promotion_id,
          promotionType: promotion_type,
          promotionName: promotion_name || null,
          filters: {
            status: status || null,
            mlb: singleMlb || null,
            mlbs: mlbListSet ? mlbList : null,
            percent_max: percentMaxNum,
            stock_min: stockMinNum,
            stock_max: stockMaxNum,
            lightning_stock: lightningStockNum,
          },
          ids: Array.isArray(cached.ids) ? cached.ids : [],
          items:
            Array.isArray(cached.items) && cached.items.length
              ? cached.items
              : Array.isArray(cached.ids)
              ? cached.ids
              : [],
          meta: {
            createdAt: cached.createdAt || Date.now(),
            cachedPrepare: true,
          },
        });

        return res.json({
          ok: true,
          token: stored?.token || null,
          total: Number.isFinite(Number(stored?.total))
            ? Number(stored.total)
            : Array.isArray(cached.ids)
            ? cached.ids.length
            : 0,
          ids: Array.isArray(cached.ids) ? cached.ids : [],
          meta: stored?.meta || null,
        });
      }

      return res.json(
        buildSelectionPrepareSuccessPayload({
          accountKey,
          promotionId: promotion_id,
          promotionType: promotion_type,
          status,
          mlb: singleMlb,
          mlbs: mlbList,
          percentMaxNum,
          stockMinNum,
          stockMaxNum,
          lightningStockNum,
          ids: cached.ids,
          cached: true,
          cachedAt: cached.createdAt,
        }),
      );
    }

    const distributedState = await getSelectionPreparationState(preparationId);
    if (distributedState?.accountKey && distributedState.accountKey !== accountKey) {
      return res.status(409).json({ ok: false, error: "Preparacao pertence a outra conta." });
    }
    if (distributedState?.status === "ready" && distributedState?.result) {
      return res.status(Number(distributedState.result.status || 200)).json(distributedState.result.body || {});
    }
    // Falhas nao ficam cacheadas como bloqueio: um novo POST com os mesmos filtros
    // pode iniciar uma nova preparacao imediatamente apos o erro anterior.

    const inFlight = getSelectionPrepareInFlight(cacheKey);
    if (inFlight || distributedState?.status === "processing") {
      return res.status(202).json({
        ok: true,
        pending: true,
        preparation_id: preparationId,
        status_url: preparationStatusUrl,
        retry_after_ms: SELECTION_PREPARE_RETRY_MS,
      });
    }

    const preparationLock = await acquireSelectionPreparationLock(preparationId);
    if (!preparationLock.acquired) {
      return res.status(202).json({
        ok: true,
        pending: true,
        preparation_id: preparationId,
        status_url: preparationStatusUrl,
        retry_after_ms: SELECTION_PREPARE_RETRY_MS,
      });
    }
    await setSelectionPreparationState(preparationId, {
      status: "processing",
      accountKey,
      startedAt: Date.now(),
      promotionId: String(promotion_id),
      promotionType: promotionTypeUp,
    });

    const work = (async () => {
      const preparedItems = [];
      const usePreparedSelectionItems =
        isStrictPreparedSelectionPromotionType(promotion_type) ||
        isOfferBasedPromotionType(promotion_type) ||
        ["SELLER_CAMPAIGN", "DEAL", "DOD", "LIGHTNING"].includes(promotionTypeUp);
      const groupManualRowsBeforeEligibility =
        hasPercentFilter &&
        !status &&
        ["SELLER_CAMPAIGN", "DEAL", "DOD", "LIGHTNING"].includes(promotionTypeUp);
      const manualRowsById = new Map();

      if (mlbListSet && promotionTypeUp === "SELLER_CAMPAIGN") {
        for (const itemId of mlbList) {
          const snapshot = await fetchItemPromotionSnapshot(
            req,
            creds,
            itemId,
            promotion_id
          ).catch(() => null);
          if (!snapshot) continue;

          if (
            status &&
            normalizeStatusServer(snapshot.status) !== normalizeStatusServer(status)
          ) {
            continue;
          }

          if (hasPercentFilter) {
            if (!isSellerPercentApplicableServer(snapshot, percentMaxNum)) {
              continue;
            }
          }

          ids.push(itemId);
          preparedItems.push({
            ...snapshot,
            id: itemId,
            item_id: itemId,
            promotion_id,
            promotion_type: promotionTypeUp,
          });
        }

        const createdAt = Date.now();
        setSelectionPrepareCacheEntry(cacheKey, {
          ids: [...ids],
          items: preparedItems.map((item) => ({ ...item })),
          createdAt,
        });

        if (typeof saveSelection !== "function") {
          return {
            status: 200,
            body: buildSelectionPrepareSuccessPayload({
              accountKey,
              promotionId: promotion_id,
              promotionType: promotion_type,
              status,
              mlb: singleMlb,
              mlbs: mlbList,
              percentMaxNum,
              stockMinNum,
              stockMaxNum,
              lightningStockNum,
              ids,
            }),
          };
        }

        const stored = await saveSelection({
          accountKey,
          userId: req.user?.id || req.user?.uid || null,
          promotionId: promotion_id,
          promotionType: promotion_type,
          promotionName: promotion_name || null,
          filters: {
            status: status || null,
            mlb: singleMlb || null,
            mlbs: mlbList,
            percent_max: percentMaxNum,
            stock_min: stockMinNum,
            stock_max: stockMaxNum,
            lightning_stock: lightningStockNum,
          },
          ids,
          items: preparedItems.length === ids.length ? preparedItems : ids,
          meta: {
            createdAt,
            directMlbValidation: true,
          },
        });

        const token = stored?.token || null;
        const total = Number(stored?.total);
        const meta = stored?.meta || null;

        return {
          status: 200,
          body: {
            ok: true,
            token,
            total: Number.isFinite(total) ? total : ids.length,
            meta,
            ids,
          },
        };
      }

      while (true) {
        page += 1;
        if (page > 500) break; // trava de segurança absurda

        const base = `https://api.mercadolibre.com/seller-promotions/promotions/${encodeURIComponent(
          promotion_id
        )}/items`;

        const params = new URLSearchParams();
        params.set("promotion_type", String(promotion_type).toUpperCase());
        params.set("limit", String(ML_LIMIT));
        params.set("app_version", "v2");

        if (status) params.set("status", String(status));
        if (searchAfter) params.set("search_after", String(searchAfter));
        if (singleMlb) params.set("item_id", String(singleMlb));

        const url = `${base}?${params.toString()}`;

        const r = await authFetchWithRetryOn429(req, url, {}, creds, {
          retries: 5,
          baseDelayMs: 900,
          retryServerErrors: true,
        });

        if (!r.ok) {
          const txt = await r.text().catch(() => "");
          let ml_body;
          try {
            ml_body = txt ? JSON.parse(txt) : null;
          } catch {
            ml_body = { raw: txt };
          }

          console.error(
            "Erro ao consultar itens da promoção no ML:",
            r.status,
            ml_body
          );

          return {
            status: r.status === 429 ? 429 : 502,
            body: {
              ok: false,
              error:
                r.status === 429
                  ? "O Mercado Livre limitou temporariamente as consultas desta campanha."
                  : "Falha ao consultar itens da promoção no ML.",
              status: r.status,
              ml_body,
              url,
            },
          };
        }

        const js = await r.json().catch(() => ({}));
        const results = Array.isArray(js.results) ? js.results : [];
        if (!results.length) break;

        const promotionBenefits = js.promotion_benefits || null;
        const availableQuantityById = promotionTypeUp === "LIGHTNING"
          ? await fetchItemsAvailableQuantityMap(
              req,
              creds,
              results.map((item) => item?.id || item?.item_id).filter(Boolean)
            )
          : {};

        for (const it of results) {
          const id = String(it.id || it.item_id || "").trim();
          if (!id) continue;
          if (singleMlb && id !== singleMlb) continue;
          if (mlbListSet && !mlbListSet.has(id.toUpperCase())) continue;
          if (
            status &&
            normalizeStatusServer(it?.status) !== normalizeStatusServer(status)
          ) continue;
          if (
            ["SMART", "LIGHTNING", "PRE_NEGOTIATED"].includes(promotionTypeUp) &&
            normalizeStatusServer(it?.status) !== "candidate"
          ) continue;
          const normalizedId = id.toUpperCase();

          if (groupManualRowsBeforeEligibility) {
            const rows = manualRowsById.get(normalizedId) || [];
            const availableQuantity = availableQuantityById[normalizedId];
            rows.push({
              ...it,
              id: normalizedId,
              item_id: normalizedId,
              available_quantity: Number.isFinite(availableQuantity)
                ? availableQuantity
                : it?.available_quantity ?? null,
            });
            manualRowsById.set(normalizedId, rows);
            continue;
          }

          if (seenIds.has(normalizedId)) continue;
          let candidate = it;

          if (hasPercentFilter) {
            if (isOfferBasedPromotionType(promotionTypeUp)) {
              candidate = selectOfferWithinPercentCap(
                it,
                promotionTypeUp,
                promotionBenefits,
                percentMaxNum,
              );
              if (!candidate) continue;
            } else if (
              ["DEAL", "DOD", "LIGHTNING"].includes(
                String(promotion_type || "").toUpperCase()
              )
            ) {
              if (shouldFetchSnapshotForPreparePercentFilter(it, promotion_type)) {
                const snapshot = await fetchItemPromotionSnapshot(
                  req,
                  creds,
                  id,
                  promotion_id
                ).catch(() => null);
                candidate = snapshot
                  ? preferPromotionSnapshot(it, snapshot, promotion_type)
                  : it;
              }
              if (
                !isDealPercentApplicableServer(
                  { ...candidate, promotion_type },
                  percentMaxNum
                )
              ) continue;
            } else {
              if (shouldFetchSnapshotForPreparePercentFilter(it, promotion_type)) {
                const snapshot = await fetchItemPromotionSnapshot(
                  req,
                  creds,
                  id,
                  promotion_id
                ).catch(() => null);
                candidate = snapshot
                  ? preferPromotionSnapshot(it, snapshot, promotion_type)
                  : it;
              }

              if (promotionTypeUp === "SELLER_CAMPAIGN") {
                if (!isSellerPercentApplicableServer(candidate, percentMaxNum)) {
                  continue;
                }
              } else {
                const pct = computeDescPctServer(
                  candidate,
                  promotion_type,
                  promotionBenefits
                );
                if (pct == null || Number(pct) > percentMaxNum) continue;
              }
            }
          }

          if (promotionTypeUp === "LIGHTNING") {
            const availableQuantity = availableQuantityById[id.toUpperCase()];
            if (
              (stockMinNum != null || stockMaxNum != null) &&
              !Number.isFinite(availableQuantity)
            ) continue;
            if (stockMinNum != null && availableQuantity < stockMinNum) continue;
            if (stockMaxNum != null && availableQuantity > stockMaxNum) continue;

            const stockBounds = getLightningStockBoundsServer(candidate);
            if (
              lightningStockNum != null &&
              stockBounds.min != null &&
              lightningStockNum < stockBounds.min
            ) continue;
            if (
              lightningStockNum != null &&
              stockBounds.max != null &&
              lightningStockNum > stockBounds.max
            ) continue;
            if (
              lightningStockNum != null &&
              Number.isFinite(availableQuantity) &&
              lightningStockNum > availableQuantity
            ) continue;

            candidate = {
              ...candidate,
              available_quantity: Number.isFinite(availableQuantity)
                ? availableQuantity
                : candidate?.available_quantity ?? null,
            };
          }

          if (usePreparedSelectionItems) {
            const prepared = await enrichPreparedSelectionItem(
              req,
              creds,
              candidate,
              promotion_id,
              promotion_type,
              promotionBenefits
            ).catch(() => null);
            if (prepared) preparedItems.push(prepared);
          }
          seenIds.add(normalizedId);
          ids.push(id);
        }

        const paging = js.paging || {};
        searchAfter =
          paging.search_after || paging.searchAfter || paging.next_token || null;

        if (!searchAfter) break;
      }

      if (groupManualRowsBeforeEligibility) {
        for (const [normalizedId, rows] of manualRowsById.entries()) {
          const candidateRows = promotionTypeUp === "LIGHTNING"
            ? rows.filter(
                (row) => normalizeStatusServer(row?.status) === "candidate",
              )
            : rows;
          if (!candidateRows.length) continue;
          let eligibilityRows = candidateRows;
          if (
            rows.some((row) =>
              shouldFetchSnapshotForPreparePercentFilter(row, promotionTypeUp),
            )
          ) {
            const snapshot = await fetchItemPromotionSnapshot(
              req,
              creds,
              normalizedId,
              promotion_id,
            ).catch(() => null);
            if (snapshot) eligibilityRows = [...rows, snapshot];
          }

          let candidate = mergeManualPromotionRowsServer(
            eligibilityRows,
            promotionTypeUp,
          );
          if (!candidate) continue;

          const applicable =
            promotionTypeUp === "SELLER_CAMPAIGN"
              ? isSellerPercentApplicableServer(candidate, percentMaxNum)
              : isDealPercentApplicableServer(candidate, percentMaxNum);
          if (!applicable) continue;

          if (promotionTypeUp === "LIGHTNING") {
            const availableQuantity = toNumSafe(candidate?.available_quantity);
            if (
              (stockMinNum != null || stockMaxNum != null) &&
              !Number.isFinite(availableQuantity)
            ) continue;
            if (stockMinNum != null && availableQuantity < stockMinNum) continue;
            if (stockMaxNum != null && availableQuantity > stockMaxNum) continue;

            const stockBounds = getLightningStockBoundsServer(candidate);
            if (
              lightningStockNum != null &&
              stockBounds.min != null &&
              lightningStockNum < stockBounds.min
            ) continue;
            if (
              lightningStockNum != null &&
              stockBounds.max != null &&
              lightningStockNum > stockBounds.max
            ) continue;
            if (
              lightningStockNum != null &&
              Number.isFinite(availableQuantity) &&
              lightningStockNum > availableQuantity
            ) continue;
          }

          if (usePreparedSelectionItems) {
            candidate = await enrichPreparedSelectionItem(
              req,
              creds,
              candidate,
              promotion_id,
              promotion_type,
              null,
            ).catch(() => null);
            if (!candidate) continue;
            preparedItems.push(candidate);
          }

          seenIds.add(normalizedId);
          ids.push(normalizedId);
        }
      }

      const createdAt = Date.now();
      setSelectionPrepareCacheEntry(cacheKey, {
        ids: [...ids],
        items:
          usePreparedSelectionItems && preparedItems.length === ids.length
            ? preparedItems.map((item) => ({ ...item }))
            : null,
        createdAt,
      });

      if (typeof saveSelection !== "function") {
        return {
          status: 200,
          body: buildSelectionPrepareSuccessPayload({
            accountKey,
            promotionId: promotion_id,
            promotionType: promotion_type,
            status,
            mlb: singleMlb,
            mlbs: mlbList,
            percentMaxNum,
            stockMinNum,
            stockMaxNum,
            lightningStockNum,
            ids,
          }),
        };
      }

      const stored = await saveSelection({
        accountKey,
        userId: req.user?.id || req.user?.uid || null,
        promotionId: promotion_id,
        promotionType: promotion_type,
        promotionName: promotion_name || null,
        filters: {
          status: status || null,
          mlb: singleMlb || null,
          mlbs: mlbListSet ? mlbList : null,
          percent_max: percentMaxNum,
          stock_min: stockMinNum,
          stock_max: stockMaxNum,
          lightning_stock: lightningStockNum,
        },
        ids,
        items:
          usePreparedSelectionItems && preparedItems.length === ids.length
            ? preparedItems
            : ids,
        meta: {
          createdAt,
        },
      });

      const token = stored?.token || null;
      const total = Number(stored?.total);
      const meta = stored?.meta || null;

      return {
        status: 200,
        body: {
          ok: true,
          token,
          total: Number.isFinite(total) ? total : ids.length,
          meta,
          ids,
        },
      };
    })();

    const trackedWork = setSelectionPrepareInFlight(
      cacheKey,
      work
        .catch((error) => ({
          status: 500,
          body: {
            ok: false,
            error: error?.message || "Erro ao preparar seleção.",
          },
        }))
        .then(async (preparedResult) => {
          await setSelectionPreparationState(preparationId, {
            status: Number(preparedResult?.status || 500) >= 400 ? "failed" : "ready",
            accountKey,
            finishedAt: Date.now(),
            result: preparedResult,
          });
          return preparedResult;
        })
        .finally(() => preparationLock.release()),
    );
    const result = await Promise.race([
      trackedWork,
      new Promise((resolve) =>
        setTimeout(
          () => resolve({ pending: true }),
          SELECTION_PREPARE_SYNC_WAIT_MS,
        ),
      ),
    ]);
    if (result?.pending) {
      return res.status(202).json({
        ok: true,
        pending: true,
        preparation_id: preparationId,
        status_url: preparationStatusUrl,
        retry_after_ms: SELECTION_PREPARE_RETRY_MS,
      });
    }
    return res.status(result.status).json(result.body);
  } catch (e) {
    console.error("Erro em /api/promocoes/selection/prepare:", e);
    return res.status(500).json({
      ok: false,
      error: "Erro interno ao preparar seleção.",
    });
  }
  },
);

core.get(
  "/api/promocoes/selection/prepare/:preparation_id",
  async (req, res) => {
    const preparationId = String(req.params?.preparation_id || "").trim();
    if (!/^[a-f0-9]{24}$/i.test(preparationId)) {
      return res.status(400).json({ ok: false, error: "preparation_id invalido." });
    }
    const accountKey = resolveAccountKeyFromLocals(res);
    if (!accountKey) {
      return res.status(400).json({ ok: false, error: "Conta selecionada obrigatoria." });
    }
    const state = await getSelectionPreparationState(preparationId);
    if (!state) {
      return res.status(404).json({ ok: false, error: "Preparacao nao encontrada ou expirada." });
    }
    if (state.accountKey && state.accountKey !== accountKey) {
      return res.status(404).json({ ok: false, error: "Preparacao nao encontrada ou expirada." });
    }
    if (state.status === "processing") {
      return res.status(202).json({
        ok: true,
        pending: true,
        preparation_id: preparationId,
        retry_after_ms: SELECTION_PREPARE_RETRY_MS,
      });
    }
    if (state.result) {
      return res.status(Number(state.result.status || (state.status === "failed" ? 500 : 200))).json(
        state.result.body || {},
      );
    }
    return res.status(500).json({ ok: false, error: "Estado da preparacao invalido." });
  },
);

/**
 * Dispara job de aplicacao em lista validada.
 * Este fluxo nao depende do PromoSelectionStore porque a validacao da lista pode
 * rodar no worker e o store em memoria nao atravessa processos no Render.
 */
core.post(
  "/api/promocoes/jobs/apply-list",
  createAuditAction({
    evento: "promotion_apply_list_started",
    metadata: (req) => ({
      promotion_id: req.body?.promotion_id || null,
      promotion_type: req.body?.promotion_type || null,
      promotion_name: req.body?.promotion_name || req.body?.campaign_name || null,
      total_ids: normalizeMlbList(
        req.body?.selection_ids ||
          req.body?.selectionIds ||
          req.body?.mlbs ||
          req.body?.ids ||
          null
      ).length,
      seller_manual_percent:
        req.body?.options?.seller_manual_percent ??
        req.body?.seller_manual_percent ??
        null,
      deal_manual_percent:
        req.body?.options?.deal_manual_percent ??
        req.body?.deal_manual_percent ??
        null,
    }),
  }),
  async (req, res) => {
    try {
      if (
        !PromoJobsService ||
        typeof PromoJobsService.enqueueBulkApply !== "function"
      ) {
        return res
          .status(503)
          .json({ ok: false, error: "PromoJobsService indisponível." });
      }

      const accountKey = resolveAccountKeyFromLocals(res);
      if (!accountKey) {
        return res.status(400).json({
          ok: false,
          error: "Conta selecionada e obrigatoria para iniciar jobs.",
        });
      }
      const accountLabel = String(res.locals.accountLabel || accountKey);
      const creds = res.locals.mlCreds || {};
      const body = req.body || {};
      const optionsIn = body.options || {};
      const promotionId = String(body.promotion_id || body.promotionId || "").trim();
      const promotionType = String(body.promotion_type || body.promotionType || "")
        .trim()
        .toUpperCase();
      const promotionName = String(
        body.promotion_name || body.campaign_name || body.promotionName || promotionId
      ).trim();
      const selectionIds = normalizeMlbList(
        body.selection_ids || body.selectionIds || body.mlbs || body.ids || null
      );

      if (!promotionId || !promotionType) {
        return res.status(400).json({
          ok: false,
          error: "promotion_id e promotion_type são obrigatórios.",
        });
      }
      if (!selectionIds.length) {
        return res.status(400).json({
          ok: false,
          error: "selection_ids deve conter ao menos 1 MLB elegível.",
        });
      }
      if (selectionIds.length > 5000) {
        return res.status(400).json({
          ok: false,
          error: "A lista pode conter no máximo 5.000 MLBs por job.",
        });
      }

      const allowed = new Set([
        "DEAL",
        "SELLER_CAMPAIGN",
        "SMART",
        "PRICE_MATCHING",
        "PRICE_MATCHING_MELI_ALL",
        "MARKETPLACE_CAMPAIGN",
        "PRE_NEGOTIATED",
        "UNHEALTHY_STOCK",
        "PRICE_DISCOUNT",
        "DOD",
        "LIGHTNING",
      ]);
      if (!allowed.has(promotionType)) {
        return res.status(400).json({
          ok: false,
          error: `promotion_type inválido: ${promotionType}`,
        });
      }

      const sellerManualPercent =
        optionsIn.seller_manual_percent == null && body.seller_manual_percent == null
          ? null
          : Number(optionsIn.seller_manual_percent ?? body.seller_manual_percent);
      const dealManualPercent =
        optionsIn.deal_manual_percent == null && body.deal_manual_percent == null
          ? null
          : Number(optionsIn.deal_manual_percent ?? body.deal_manual_percent);
      const lightningStock = resolveLightningApplyStock(
        optionsIn.lightning_stock ?? body.lightning_stock
      );
      if (
        promotionType === "SELLER_CAMPAIGN" &&
        !isValidManualPromoPercent(sellerManualPercent)
      ) {
        return res.status(400).json({
          ok: false,
          error: manualPromoPercentMessage("seller_manual_percent"),
        });
      }
      if (
        requiresDealManualPercent(promotionType) &&
        !isValidManualPromoPercent(dealManualPercent)
      ) {
        return res.status(400).json({
          ok: false,
          error: manualPromoPercentMessage("deal_manual_percent"),
        });
      }
      if (promotionType === "LIGHTNING" && lightningStock == null) {
        return res.status(400).json({
          ok: false,
          error:
            "lightning_stock deve ser um inteiro maior ou igual a 5 para aplicação por lista de LIGHTNING.",
        });
      }

      const status = body.status && String(body.status).toLowerCase() !== "all"
        ? String(body.status)
        : null;
      const percentMax =
        body.percent_max != null
          ? Number(body.percent_max)
          : body.discount_max != null
            ? Number(body.discount_max)
            : null;

      PromoJobsService.init?.();
      const enqueueResult = await PromoJobsService.enqueueBulkApply({
        mlCreds: creds,
        accountKey,
        accountLabel,
        action: "apply",
        promotion: { id: promotionId, type: promotionType, name: promotionName || promotionId },
        filters: {
          status,
          maxDesc: Number.isFinite(percentMax) ? percentMax : null,
          mlb: null,
          mlbs: selectionIds,
        },
        price_policy: "min",
        options: {
          dryRun: !!optionsIn.dryRun,
          expected_total: selectionIds.length,
          prevalidated_selection: true,
          seller_manual_percent: sellerManualPercent,
          deal_manual_percent: dealManualPercent,
          lightning_stock: lightningStock,
          list_apply: true,
        },
        auditContext: buildAuditContext(req, res, accountKey, accountLabel),
      });

      const normalizedEnqueue = normalizePromoEnqueueResult(enqueueResult);
      const jobId = normalizedEnqueue.id;
      const encodedJobId = encodePromotionJobId(PROMO_JOB_SOURCE_BULL, jobId);
      return res.json({
        ok: true,
        success: true,
        job_id: encodedJobId,
        reused: normalizedEnqueue.reused,
        reused_reason: normalizedEnqueue.reusedReason,
        ...promotionJobIdentity(encodedJobId, PROMO_JOB_SOURCE_BULL),
        total: selectionIds.length,
        account: {
          key: accountKey,
          label: accountLabel,
        },
      });
    } catch (e) {
      console.error("[/api/promocoes/jobs/apply-list] erro:", e);
      return res.status(Number(e?.statusCode || 500)).json({ ok: false, error: e.message || String(e), code: e?.code || null });
    }
  },
);

/**
 * Dispara job em massa (apply/remove) a partir do token da seleção preparada.
 * Body: { token, action: "apply"|"remove", values?: { dryRun?: boolean } }
 */
core.post(
  "/api/promocoes/jobs/apply-mass",
  createAuditAction({
    evento: "promotion_apply_mass_started",
    metadata: (req) => ({
      token_prefix: req.body?.token ? String(req.body.token).slice(0, 24) : null,
      action: req.body?.action || "apply",
      dry_run: !!req.body?.values?.dryRun,
      promotion_name: req.body?.promotion_name || req.body?.campaign_name || null,
    }),
  }),
  async (req, res) => {
  try {
    if (
      !PromoJobsService ||
      typeof PromoJobsService.enqueueBulkApply !== "function"
    ) {
      return res
        .status(503)
        .json({ ok: false, error: "PromoJobsService indisponível." });
    }
    if (
      !PromoSelectionStore ||
      typeof PromoSelectionStore.getSelection !== "function"
    ) {
      return res
        .status(503)
        .json({ ok: false, error: "PromoSelectionStore indisponível." });
    }

    const { token, action = "apply", values = {} } = req.body || {};
    if (!token) {
      return res.status(400).json({ ok: false, error: "token é obrigatório." });
    }

    const accountKey = resolveAccountKeyFromLocals(res);
    if (!accountKey) {
      return res.status(400).json({
        ok: false,
        error: "Conta selecionada e obrigatoria para iniciar jobs.",
      });
    }
    const accountLabel = String(res.locals.accountLabel || accountKey);
    const selection = await PromoSelectionStore.getSelection(token, { accountKey });

    if (!selection) {
      return res
        .status(404)
        .json({ ok: false, error: "Seleção não encontrada ou expirada." });
    }

    const creds = res.locals.mlCreds || {};
    const promotionId = selection.promotionId;
    const promotionType = selection.promotionType;
    const promotionName =
      selection.promotionName ||
      selection.meta?.promotionName ||
      req.body?.promotion_name ||
      req.body?.campaign_name ||
      promotionId;
    const promotionTypeUp = String(promotionType || "").toUpperCase();
    const isApplyAction = String(action || "apply").toLowerCase() === "apply";
    const fSel = selection.filters || {};

    // adapta filtros para o formato do PromoJobsService
    const filters = {
      status: fSel.status || null,
      maxDesc: fSel.percent_max != null ? Number(fSel.percent_max) : null,
      mlb: fSel.mlb || null,
      mlbs: normalizeMlbList(fSel.mlbs || null),
    };

    const options = {
      dryRun: !!values.dryRun,
      expected_total: Array.isArray(selection.items)
        ? selection.items.length
        : 0,
      seller_manual_percent:
        values.seller_manual_percent == null
          ? null
          : Number(values.seller_manual_percent),
      deal_manual_percent:
        values.deal_manual_percent == null
          ? null
          : Number(values.deal_manual_percent),
      lightning_stock: resolveLightningApplyStock(values.lightning_stock),
      application_source: selection.meta?.application_source || "selection_token",
      selection_count: Number(selection.meta?.selection_count || selection.total || 0) || null,
    };
    if (
      isApplyAction &&
      promotionTypeUp === "SELLER_CAMPAIGN" &&
      !isValidManualPromoPercent(options.seller_manual_percent)
    ) {
      return res.status(400).json({
        ok: false,
        error: manualPromoPercentMessage("seller_manual_percent"),
      });
    }
    if (
      isApplyAction &&
      requiresDealManualPercent(promotionTypeUp) &&
      !isValidManualPromoPercent(options.deal_manual_percent)
    ) {
      return res.status(400).json({
        ok: false,
        error: manualPromoPercentMessage("deal_manual_percent"),
      });
    }
    if (
      isApplyAction &&
      promotionTypeUp === "LIGHTNING" &&
      options.lightning_stock == null
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "lightning_stock deve ser um inteiro maior ou igual a 5 para aplicação em massa de LIGHTNING.",
      });
    }
    const selectionItems = Array.isArray(selection.items)
      ? selection.items.map((item) =>
          item && typeof item === "object"
            ? {
                ...item,
                id: String(item.id || item.item_id || "")
                  .trim()
                  .toUpperCase(),
              }
            : { id: String(item || "").trim().toUpperCase() }
        )
      : null;
    const selectionIds = Array.isArray(selectionItems)
      ? [
          ...new Set(
            selectionItems
              .map((item) => String(item?.id || item?.item_id || "").trim().toUpperCase())
              .filter(Boolean),
          ),
        ]
      : [];
    if (selectionIds.length) {
      filters.mlbs = selectionIds;
      options.prevalidated_selection = true;
      options.application_source = selection.meta?.application_source || "selection_token";
      options.selection_count = selectionIds.length;
    }
    const inlineSelectionItems =
      Array.isArray(selectionItems) && isOfferBasedPromotionType(promotionTypeUp)
        ? selectionItems.map(compactPreparedOfferSelectionItem)
        : Array.isArray(selectionItems) && selectionItems.length <= 200
          ? selectionItems
          : null;

    PromoJobsService.init?.();

    const enqueueResult = await PromoJobsService.enqueueBulkApply({
      mlCreds: creds,
      accountKey,
      accountLabel,
      action,
      promotion: {
        id: String(promotionId),
        type: promotionTypeUp,
        name: String(promotionName || promotionId),
      },
      filters,
      selectionItems: inlineSelectionItems,
      price_policy: "min",
      options,
      auditContext: buildAuditContext(req, res, accountKey, accountLabel),
    });

    // renova TTL da seleção enquanto o job é criado
    await PromoSelectionStore.touch?.(token);

    const normalizedEnqueue = normalizePromoEnqueueResult(enqueueResult);
    const jobId = normalizedEnqueue.id;
    const encodedJobId = encodePromotionJobId(PROMO_JOB_SOURCE_BULL, jobId);
    return res.json({
      ok: true,
      job_id: encodedJobId,
      reused: normalizedEnqueue.reused,
      reused_reason: normalizedEnqueue.reusedReason,
      ...promotionJobIdentity(encodedJobId, PROMO_JOB_SOURCE_BULL),
      account: {
        key: accountKey,
        label: accountLabel,
      },
    });
  } catch (e) {
    console.error("[/api/promocoes/jobs/apply-mass] erro:", e);
    return res.status(Number(e?.statusCode || 500)).json({ ok: false, error: e.message || String(e), code: e?.code || null });
  }
  },
);

// ---- Montagem do router com aliases funcionais (shim)
const router = express.Router();

// Mantém as rotas com prefixo já definido dentro do "core"
router.use(core);

module.exports = router;




