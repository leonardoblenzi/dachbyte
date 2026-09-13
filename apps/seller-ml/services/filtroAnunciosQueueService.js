"use strict";

const Bull = require("bull");
const { makeBullClient, getSharedRedis } = require("../lib/redisClient");

const db = require("../db/db");
const { metricsPorItens } = require("./adsService");
const PromoPricing = require("./mlPromotionPricing");
const TokenService = require("./tokenService");
const { applyPromotionSnapshot } = require("./filtroPromoSnapshot");
const {
  reserveAdsFilterCredits,
  settleCredits,
} = require("./hubCreditsService");
const {
  reconcileCompletedQueueJob,
  sameCsvExportRequest,
  shouldSupersedeOpenJob,
} = require("./filtroJobReconciliation");

const _fetch = typeof fetch !== "undefined" ? fetch : require("node-fetch");
const fetchRef = (...args) => _fetch(...args);
const STALE_ACTIVE_JOB_MS = Math.max(
  60 * 1000,
  Number(process.env.FILTRO_ANUNCIOS_STALE_ACTIVE_JOB_MS || 3 * 60 * 1000)
);
const ML_ORDERS_SEARCH_MAX_WINDOW = 10000;
const ML_ORDERS_SEARCH_PAGE_LIMIT = 50;
const ML_ITEM_SEARCH_SCAN_LIMIT = Math.min(
  100,
  Math.max(1, Number(process.env.FILTRO_ANUNCIOS_SCAN_LIMIT || 100))
);
const ML_SELLER_SKU_SEARCH_LIMIT = Math.min(
  100,
  Math.max(1, Number(process.env.FILTRO_ANUNCIOS_SELLER_SKU_LIMIT || 100))
);
const ML_ITEMS_BATCH_SIZE = 20;
const ML_ITEMS_DETAIL_CONCURRENCY = Math.max(
  1,
  Math.min(8, Number(process.env.FILTRO_ANUNCIOS_ITEMS_DETAIL_CONCURRENCY || 4))
);
const ML_VARIATION_DETAIL_CONCURRENCY = Math.max(
  1,
  Math.min(6, Number(process.env.FILTRO_ANUNCIOS_VARIATION_DETAIL_CONCURRENCY || 4))
);
const VARIATION_GTIN_FAILURE_SAMPLE_LIMIT = 8;
const ML_SKU_CATALOG_MAX_AGE_HOURS = Math.max(
  1,
  Number(process.env.FILTRO_ANUNCIOS_SKU_CATALOG_MAX_AGE_HOURS || 168)
);
const FILTRO_ANUNCIOS_LOCK_DURATION_MS = Math.max(
  60 * 1000,
  Number(process.env.FILTRO_ANUNCIOS_LOCK_DURATION_MS || 30 * 60 * 1000)
);
const FILTRO_ANUNCIOS_STALLED_INTERVAL_MS = Math.max(
  30 * 1000,
  Number(process.env.FILTRO_ANUNCIOS_STALLED_INTERVAL_MS || 2 * 60 * 1000)
);
const FILTRO_ANUNCIOS_MAX_STALLED_COUNT = Math.max(
  1,
  Number(process.env.FILTRO_ANUNCIOS_MAX_STALLED_COUNT || 5)
);
const FILTRO_ANUNCIOS_COMPLETION_GRACE_MS = Math.max(
  5 * 1000,
  Number(process.env.FILTRO_ANUNCIOS_COMPLETION_GRACE_MS || 30 * 1000)
);

const FULL_ITEM_ATTRIBUTES = [
  "id",
  "title",
  "status",
  "price",
  "original_price",
  "currency_id",
  "available_quantity",
  "seller_custom_field",
  "thumbnail",
  "permalink",
  "date_created",
  "parent_item_id",
  "category_id",
  "listing_type_id",
  "catalog_listing",
  "shipping",
  "attributes",
  "variations",
  "sold_quantity",
];

const LIGHT_LOOKUP_ITEM_ATTRIBUTES = [
  "id",
  "date_created",
  "parent_item_id",
  "seller_custom_field",
  "seller_sku",
  "attributes",
  "variations",
];

const VARIATION_DETAIL_ATTRIBUTES = [
  "id",
  "attribute_combinations",
  "attributes",
  "available_quantity",
  "seller_custom_field",
];

class JobCancelledError extends Error {
  constructor(message = "Job cancelado pelo usuario.") {
    super(message);
    this.name = "JobCancelledError";
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function unique(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

function progressValue(start, end, current, total) {
  const safeTotal = Math.max(1, Number(total || 1));
  const safeCurrent = Math.max(0, Math.min(safeTotal, Number(current || 0)));
  const pct = safeCurrent / safeTotal;
  return Math.round(start + (end - start) * pct);
}

function ordersSearchPageLimit(offset, preferredLimit = ML_ORDERS_SEARCH_PAGE_LIMIT) {
  const safeOffset = Math.max(0, Math.trunc(Number(offset) || 0));
  const remaining = ML_ORDERS_SEARCH_MAX_WINDOW - safeOffset;
  if (remaining <= 0) return 0;
  return Math.max(0, Math.min(Math.trunc(Number(preferredLimit) || 0), remaining));
}

async function updateJobProgress(job, value) {
  const next = Math.max(0, Math.min(100, Math.round(Number(value || 0))));
  const prev = Math.round(Number(job._progress || 0));
  if (next > prev) {
    job.progress(next);
  }
}

async function callMaybeAsync(fn, payload) {
  if (typeof fn === "function") {
    await fn(payload);
  }
}

async function checkMaybeCancelled(fn) {
  if (typeof fn === "function") {
    await fn();
  }
}

function toProgressCount(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.round(num);
}

function toNonNegativeCount(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.round(num);
}

function normalizeVariationGtinFailureSamples(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry && typeof entry === "object")
    .slice(0, VARIATION_GTIN_FAILURE_SAMPLE_LIMIT)
    .map((entry) => ({
      item_id: upper(entry.item_id || entry.mlb || ""),
      variation_id: String(entry.variation_id || "").trim() || null,
      status: Number.isFinite(Number(entry.status)) ? Number(entry.status) : null,
      message: String(entry.message || "").slice(0, 240),
    }));
}

function variationGtinStatusFields(meta) {
  return {
    variation_gtin_checked: toNonNegativeCount(meta?.variation_gtin_checked),
    variation_gtin_enriched: toNonNegativeCount(meta?.variation_gtin_enriched),
    variation_gtin_failed: toNonNegativeCount(meta?.variation_gtin_failed),
    variation_gtin_failure_samples: normalizeVariationGtinFailureSamples(
      meta?.variation_gtin_failure_samples
    ),
  };
}

function isValkeyLoadingError(err) {
  const text = String(err?.message || err?.error || err || "");
  return /\bLOADING\b/i.test(text) && /Valkey|Redis|dataset|memory/i.test(text);
}

const upper = (v) =>
  String(v || "")
    .trim()
    .toUpperCase();

const datePart = (iso) => String(iso || "").slice(0, 10);

function parseYmd(value) {
  const text = String(value || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) ? date : null;
}

function formatYmd(date) {
  return date instanceof Date && Number.isFinite(date.getTime())
    ? date.toISOString().slice(0, 10)
    : null;
}

function addDaysYmd(value, days) {
  const date = parseYmd(value);
  if (!date) return null;
  date.setUTCDate(date.getUTCDate() + Math.trunc(Number(days) || 0));
  return formatYmd(date);
}

function splitDateRange(fromYmd, toYmd, chunkDays = 7) {
  const from = parseYmd(fromYmd);
  const to = parseYmd(toYmd);
  if (!from || !to || from > to) return [];
  const safeChunkDays = Math.max(1, Math.trunc(Number(chunkDays) || 7));
  const ranges = [];
  let cursor = formatYmd(from);

  while (cursor && cursor <= toYmd) {
    const endCandidate = addDaysYmd(cursor, safeChunkDays - 1);
    const end = endCandidate && endCandidate < toYmd ? endCandidate : toYmd;
    ranges.push({ from: cursor, to: end });
    cursor = addDaysYmd(end, 1);
  }

  return ranges;
}

function round2(value) {
  const num = Number(value || 0);
  return Math.round((num + Number.EPSILON) * 100) / 100;
}

function firstPositiveNumber(candidates) {
  for (const candidate of candidates) {
    const num = Number(candidate);
    if (Number.isFinite(num) && num > 0) return num;
  }
  return null;
}

function firstPercentNumber(candidates) {
  for (const candidate of candidates) {
    const num = Number(candidate);
    if (Number.isFinite(num) && num > 0 && num < 100) return round2(num);
  }
  return null;
}

function normalizePromoStatus(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function isCurrentPromoStatus(status) {
  const normalized = normalizePromoStatus(status);
  return ["started", "active", "in_progress"].includes(normalized);
}

function normalizeItemPromotionPayload(payload) {
  const source = Array.isArray(payload)
    ? payload
    : payload?.results || payload?.items || payload?.promotions || payload?.data || [];
  const promotions = Array.isArray(source) ? source : [];
  let best = null;

  for (const promo of promotions) {
    const status = normalizePromoStatus(promo?.status || promo?.item_status || promo?.state);
    if (!isCurrentPromoStatus(status)) continue;

    const explicitPct = firstPercentNumber([
      promo?.discount_percentage,
      promo?.discount_percent,
      promo?.loyalty_percentage,
      promo?.metadata?.discount_percentage,
    ]);
    const contributionPct = firstPercentNumber([
      Number(promo?.seller_percentage || 0) + Number(promo?.meli_percentage || 0),
      Number(promo?.metadata?.seller_percentage || 0) +
        Number(promo?.metadata?.meli_percentage || 0),
    ]);
    const directPct =
      explicitPct ||
      contributionPct ||
      firstPercentNumber([
        promo?.seller_percentage,
        promo?.meli_percentage,
        promo?.metadata?.seller_percentage,
        promo?.metadata?.meli_percentage,
      ]);
    const original = firstPositiveNumber([
      promo?.original_price,
      promo?.regular_amount,
      promo?.base_price,
      promo?.list_price,
    ]);
    const discounted = firstPositiveNumber([
      promo?.price,
      promo?.deal_price,
      promo?.top_deal_price,
      promo?.suggested_discounted_price,
      promo?.max_discounted_price,
      promo?.new_price,
      promo?.amount,
    ]);
    const computedPct = PromoPricing.computePromoPercent(original, discounted);
    const pct = directPct || computedPct;
    if (!(pct > 0)) continue;
    const promoPrice =
      discounted || (original && directPct ? round2(original * (1 - directPct / 100)) : null);

    if (!best || Number(best.promo_pct || 0) < Number(pct || 0)) {
      best = {
        promo_active: true,
        promo_pct: round2(pct),
        current_price: promoPrice,
        original_price: original,
        promo_name:
          promo?.name ||
          promo?.title ||
          promo?.promotion_name ||
          promo?.type ||
          promo?.promotion_type ||
          "Promo atual",
        promo_id: promo?.id || promo?.promotion_id || promo?.offer_id || null,
        promo_status: status || "active",
        promo_source: "seller_promotions_item",
      };
    }
  }

  return best;
}

function overlapPeriod(startDate, endDate, fromDate, toDate) {
  const start = String(startDate || "").slice(0, 10);
  const end = String(endDate || "").slice(0, 10);
  if (!start && !end) return true;
  if (start && toDate && start > toDate) return false;
  if (end && fromDate && end < fromDate) return false;
  return true;
}

function hasCommercialPeriod(filters) {
  return !!(filters?.date_from && filters?.date_to);
}

function getRowLookupIds(row) {
  return unique([
    upper(row?.item_id),
    upper(row?.mlb),
    ...(Array.isArray(row?.related_item_ids) ? row.related_item_ids.map(upper) : []),
  ]).filter(Boolean);
}

function centsToAmount(cents) {
  const value = Number(cents);
  if (!Number.isFinite(value) || value <= 0) return null;
  return round2(value / 100);
}

function centsToCsvAmount(cents) {
  const value = Number(cents);
  if (!Number.isFinite(value) || value < 0) return null;
  return round2(value / 100);
}

function csvEscape(value) {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\n\r;]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function asFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseIsoDateOnly(value) {
  const raw = String(value || "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const dt = new Date(`${raw}T00:00:00.000Z`);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function daysSinceDate(value) {
  const dt = parseIsoDateOnly(value);
  if (!dt) return null;
  const now = new Date();
  const todayUtc = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  );
  const targetUtc = Date.UTC(
    dt.getUTCFullYear(),
    dt.getUTCMonth(),
    dt.getUTCDate()
  );
  return Math.max(0, Math.floor((todayUtc - targetUtc) / 86400000));
}

function resolvePromoSnapshotForCsv(row) {
  const baseCentsRaw = asFiniteNumber(row?.original_price_cents);
  const currentCentsRaw = asFiniteNumber(row?.current_price_cents);
  const baseCents =
    baseCentsRaw !== null && baseCentsRaw > 0
      ? baseCentsRaw
      : currentCentsRaw !== null && currentCentsRaw > 0
        ? currentCentsRaw
        : null;
  const currentCents =
    currentCentsRaw !== null && currentCentsRaw > 0 ? currentCentsRaw : null;
  const inferredPct =
    baseCents !== null && currentCents !== null && baseCents > currentCents
      ? round2(((baseCents - currentCents) / baseCents) * 100)
      : null;
  const explicitPct = asFiniteNumber(row?.promo_pct);
  const promoActive = row?.promo_active === true || (inferredPct !== null && inferredPct > 0);
  return {
    active: promoActive,
    pct:
      promoActive && explicitPct !== null && explicitPct > 0
        ? explicitPct
        : promoActive
          ? inferredPct
          : null,
    basePrice:
      asFiniteNumber(row?.promo_base_price) ??
      (baseCents !== null ? round2(baseCents / 100) : null),
    currentPrice:
      asFiniteNumber(row?.promo_current_price) ??
      (promoActive && currentCents !== null ? round2(currentCents / 100) : null),
    status: row?.promo_status || (promoActive ? "active" : "sem_promocao"),
    name: row?.promo_name || (promoActive ? "Promo atual" : null),
    id: row?.promo_id || null,
  };
}

function enrichRowForCsv(row, meta) {
  const hasCommercial = !!meta?.filters?.date_from && !!meta?.filters?.date_to;
  const promo = resolvePromoSnapshotForCsv(row);
  const netUnits = row?.sales_units ?? null;
  const netRevenueCents = row?.sold_value_cents ?? null;
  const grossUnits = row?.gross_sales_units ?? netUnits;
  const grossRevenueCents = row?.gross_sold_value_cents ?? netRevenueCents;
  const refundedUnits = row?.refunded_sales_units ?? 0;
  const refundedRevenueCents = row?.refunded_value_cents ?? 0;
  return {
    ...row,
    ...(hasCommercial
      ? {
          qnt_vendas_total: grossUnits,
          valor_venda_total: centsToCsvAmount(grossRevenueCents),
          qnt_vendas_reembolso: refundedUnits,
          valor_reembolso: centsToCsvAmount(refundedRevenueCents),
          qnt_vendas: netUnits,
          valor_venda: centsToCsvAmount(netRevenueCents),
          dias_desde_ultima_venda: daysSinceDate(row?.ultima_venda),
        }
      : {}),
    promo_active: promo.active,
    promo_pct: promo.pct,
    promo_base_price: promo.basePrice,
    promo_current_price: promo.currentPrice,
    promo_status: promo.status,
    promo_name: promo.name,
    promo_id: promo.id,
  };
}

function rowToCsvLine(row, fields) {
  return fields.map((field) => csvEscape(row?.[field])).join(";");
}

function promoSeedScore(seed) {
  if (!seed || typeof seed !== "object") return 0;
  let score = 0;
  if (asFiniteNumber(seed.itemPrice) !== null) score += 1;
  if (asFiniteNumber(seed.itemOriginalPrice) !== null) score += 1;
  if (asFiniteNumber(seed.inferredPromoPct) !== null) score += 1;
  return score;
}

function buildPromoPriceSeedMap(rows) {
  const out = new Map();
  for (const row of rows || []) {
    const lookupIds = getRowLookupIds(row);
    if (!lookupIds.length) continue;

    const itemPrice = centsToAmount(row?.current_price_cents);
    const itemOriginalPrice = centsToAmount(row?.original_price_cents);
    const inferredPromoPct = PromoPricing.computePromoPercent(
      itemOriginalPrice,
      itemPrice
    );
    const next = {
      itemPrice,
      itemOriginalPrice,
      inferredPromoPct,
    };

    for (const id of lookupIds) {
      const current = out.get(id);
      if (!current || promoSeedScore(next) > promoSeedScore(current)) {
        out.set(id, next);
      }
    }
  }
  return out;
}

function isPromoSnapshotResolved(row) {
  if (!row || typeof row !== "object") return false;
  if (row.promo_active === true || row.promo_active === false) return true;
  if (row.promo_status != null && String(row.promo_status).trim()) return true;
  if (row.promo_base_price != null || row.promo_current_price != null) return true;
  return false;
}

async function httpGetJson(url, headers = {}, retries = 3) {
  let last;

  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetchRef(url, { headers });
      const status = r.status;
      const text = await r.text();

      if (status === 429 || (status >= 500 && status < 600)) {
        await sleep(400 * (i + 1));
        continue;
      }

      if (!r.ok) {
        const error = new Error(`GET ${url} -> ${status} :: ${text.slice(0, 300)}`);
        error.status = status;
        error.body = text;
        error.url = url;
        throw error;
      }

      return JSON.parse(text);
    } catch (e) {
      last = e;
      if (
        e?.status &&
        e.status !== 429 &&
        !(e.status >= 500 && e.status < 600)
      ) {
        break;
      }
      await sleep(250 * (i + 1));
    }
  }

  throw last || new Error("httpGetJson failed");
}

function buildMlHeaders(token, headers = {}) {
  return {
    Accept: "application/json",
    ...(headers || {}),
    Authorization: `Bearer ${token}`,
  };
}

async function prepareJobAuthState({ token, mlCreds } = {}) {
  const creds = { ...(mlCreds || {}) };
  if (token) creds.access_token = token;

  const authState = {
    token: token || creds.access_token || null,
    creds,
  };

  if (!authState.token && Object.keys(creds).length) {
    await renewAuthState(authState);
  }

  if (!authState.token) {
    throw new Error("Token Mercado Livre ausente para processar o filtro.");
  }

  return authState;
}

async function renewAuthState(authState) {
  if (!authState?.creds || !Object.keys(authState.creds).length) {
    return false;
  }

  const renewed = await TokenService.renovarToken(authState.creds);
  const nextToken = renewed?.access_token || authState.token;
  if (!nextToken) return false;

  authState.token = nextToken;
  authState.creds.access_token = nextToken;
  if (renewed?.refresh_token) authState.creds.refresh_token = renewed.refresh_token;
  if (renewed?.expires_in) {
    authState.creds.access_expires_at = new Date(
      Date.now() + Number(renewed.expires_in) * 1000
    ).toISOString();
  }
  return true;
}

async function httpGetMlJson(url, authState, headers = {}, retries = 3) {
  if (!authState?.token) {
    throw new Error("Token Mercado Livre ausente para consultar a API.");
  }

  try {
    return await httpGetJson(
      url,
      buildMlHeaders(authState.token, headers),
      retries
    );
  } catch (error) {
    if (error?.status !== 401) throw error;

    console.warn(
      "[FiltroAnunciosQueueService] token recusado pela API ML; renovando e tentando novamente:",
      error?.message || error
    );

    const renewed = await renewAuthState(authState);
    if (!renewed) throw error;

    return httpGetJson(
      url,
      buildMlHeaders(authState.token, headers),
      retries
    );
  }
}

async function fetchMlJson(
  url,
  { token = null, authState = null, headers = {}, retries = 3 } = {}
) {
  if (authState) {
    return httpGetMlJson(url, authState, headers, retries);
  }

  if (!token) {
    throw new Error("Token Mercado Livre ausente para consultar a API.");
  }

  return httpGetJson(url, buildMlHeaders(token, headers), retries);
}

async function getSellerProfile(authStateOrToken) {
  const authState =
    authStateOrToken && typeof authStateOrToken === "object"
      ? authStateOrToken
      : null;
  const token = authState ? null : authStateOrToken;

  return fetchMlJson("https://api.mercadolibre.com/users/me", {
    token,
    authState,
    retries: 3,
  });
}

async function getSellerId(token) {
  const j = await getSellerProfile(token);
  return j.id;
}

async function fetchAllItemIds({
  token,
  authState = null,
  sellerId,
  status,
  onProgress = null,
}) {
  try {
    let scrollId = null;
    const all = [];
    let pages = 0;

    for (;;) {
      const url = new URL(
        `https://api.mercadolibre.com/users/${sellerId}/items/search`
      );
      url.searchParams.set("status", status);
      url.searchParams.set("search_type", "scan");
      url.searchParams.set("limit", String(ML_ITEM_SEARCH_SCAN_LIMIT));
      if (scrollId) url.searchParams.set("scroll_id", scrollId);

      const j = await fetchMlJson(url.toString(), {
        token,
        authState,
        retries: 3,
      });

      const results = Array.isArray(j?.results) ? j.results : [];
      all.push(...results);
      if (typeof onProgress === "function") {
        onProgress({ count: all.length, page_size: results.length });
      }

      scrollId = j?.scroll_id || null;
      pages += 1;
      if (!scrollId) break;
      if (pages >= 1000) break;
    }

    const uniqueScanIds = Array.from(new Set(all.map((x) => upper(x))));
    if (uniqueScanIds.length > 0) {
      return uniqueScanIds;
    }

    // Some scan responses can return only scroll_id in early calls.
    // If scan ended sem IDs, fallback to offset search for resilience.
    console.warn(
      "[fetchAllItemIds] scan retornou 0 IDs, aplicando fallback por offset",
      { sellerId, status }
    );
  } catch {
    // fallback por offset
  }

  const all = [];
  let offset = 0;
  const limit = ML_ITEM_SEARCH_SCAN_LIMIT;

  for (;;) {
    const url = new URL(
      `https://api.mercadolibre.com/users/${sellerId}/items/search`
    );
    url.searchParams.set("status", status);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));

    const j = await fetchMlJson(url.toString(), {
      token,
      authState,
      retries: 3,
    });

    const results = Array.isArray(j?.results) ? j.results : [];
    all.push(...results);
    if (typeof onProgress === "function") {
      onProgress({
        count: all.length,
        total: Number(j?.paging?.total || 0),
      });
    }

    offset += limit;
    if (offset > 1000) break;

    const total = Number(j?.paging?.total || 0);
    if (!total || offset >= total) break;
  }

  return Array.from(new Set(all.map((x) => upper(x))));
}

async function fetchItemIdsBySellerSku({
  token,
  authState = null,
  sellerId,
  status,
  sku,
  searchParam = "seller_sku",
  onProgress = null,
}) {
  const term = String(sku || "").trim();
  if (!term) return [];
  const param =
    String(searchParam || "").trim().toLowerCase() === "sku"
      ? "sku"
      : "seller_sku";

  const all = [];
  let offset = 0;
  const limit = ML_SELLER_SKU_SEARCH_LIMIT;

  for (;;) {
    const url = new URL(
      `https://api.mercadolibre.com/users/${sellerId}/items/search`
    );
    url.searchParams.set(param, term);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    if (status && status !== "all") {
      url.searchParams.set("status", String(status));
    }

    const j = await fetchMlJson(url.toString(), {
      token,
      authState,
      retries: 3,
    });

    const results = Array.isArray(j?.results) ? j.results : [];
    all.push(...results);

    const total = Number(j?.paging?.total || 0);
    const current = total
      ? Math.min(offset + results.length, total)
      : offset + results.length;
    if (typeof onProgress === "function") {
      onProgress({
        current: Math.max(0, current),
        total: total || Math.max(1, current),
      });
    }

    offset += limit;

    if (!results.length) break;
    if (total && offset >= total) break;
    if (offset > 5000) break;
  }

  return unique(all.map((x) => upper(x)));
}

function shouldDebugSkuLookup(rawSku) {
  const flag = String(process.env.FILTRO_ANUNCIOS_DEBUG_SKU_LOOKUP || "").trim();
  if (!flag) return false;
  if (/^(1|true|yes|on)$/i.test(flag)) return true;

  const wanted = normalizeSkuCompactToken(rawSku);
  if (!wanted) return false;

  return flag
    .split(/[\s,;]+/)
    .map((part) => normalizeSkuCompactToken(part))
    .filter(Boolean)
    .includes(wanted);
}

async function debugSkuLookupTotals({
  token,
  authState = null,
  sellerId,
  sku,
  status,
}) {
  const term = String(sku || "").trim();
  if (!term || !shouldDebugSkuLookup(term)) return;

  const cases = [
    { param: "seller_sku", withStatus: false },
    { param: "sku", withStatus: false },
    { param: "seller_sku", withStatus: true },
    { param: "sku", withStatus: true },
  ];

  for (const testCase of cases) {
    const url = new URL(
      `https://api.mercadolibre.com/users/${sellerId}/items/search`
    );
    url.searchParams.set(testCase.param, term);
    url.searchParams.set("limit", "50");
    url.searchParams.set("offset", "0");
    if (testCase.withStatus && status && status !== "all") {
      url.searchParams.set("status", String(status));
    }

    try {
      const json = await fetchMlJson(url.toString(), {
        token,
        authState,
        retries: 1,
      });
      const results = Array.isArray(json?.results) ? json.results : [];
      console.warn("[FiltroAnunciosQueueService][sku-debug]", {
        seller_id: sellerId,
        sku: term,
        param: testCase.param,
        status: testCase.withStatus ? status || "all" : "sem_status",
        total: Number(json?.paging?.total || 0),
        returned: results.length,
        results: results.slice(0, 20),
      });
    } catch (error) {
      console.warn("[FiltroAnunciosQueueService][sku-debug] falha", {
        seller_id: sellerId,
        sku: term,
        param: testCase.param,
        status: testCase.withStatus ? status || "all" : "sem_status",
        message: error?.message || String(error),
      });
    }
  }
}

function mapTipo(listingTypeId) {
  const id = String(listingTypeId || "").toLowerCase();
  if (id === "gold_pro" || id === "gold_premium") return "Premium";
  if (id === "gold_special") return "Classico";
  return id || "—";
}

function mapEnvio(shipping) {
  return shipping?.free_shipping ? "Frete gratis" : "Por conta do comprador";
}

function mapDetalhes(item) {
  return item?.catalog_listing ? "Catalogo" : "Normal";
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return null;
}

function toStockInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.trunc(n));
}

function resolveListingStock(item) {
  const variations = Array.isArray(item?.variations) ? item.variations : [];
  if (variations.length) {
    return {
      total: variations.reduce(
        (sum, variation) => sum + toStockInt(variation?.available_quantity),
        0
      ),
      source: "variations",
      variationsCount: variations.length,
    };
  }

  return {
    total: toStockInt(item?.available_quantity),
    source: "item",
    variationsCount: 0,
  };
}

function pickSkuFromAttr(attr) {
  if (!attr) return null;

  return firstNonEmpty(
    attr.value_name,
    attr.value_id,
    Array.isArray(attr.values) ? attr.values[0]?.name : null,
    Array.isArray(attr.values) ? attr.values[0]?.id : null
  );
}

function extractSkuFromItem(item) {
  if (!item || typeof item !== "object") return null;

  const attrs = Array.isArray(item.attributes) ? item.attributes : [];

  const skuAttr =
    attrs.find((a) => String(a?.id || "").toUpperCase() === "SELLER_SKU") ||
    attrs.find(
      (a) => String(a?.name || "").trim().toLowerCase() === "sku"
    ) ||
    attrs.find((a) =>
      String(a?.name || "").trim().toLowerCase().includes("sku")
    );

  const itemLevelSku = firstNonEmpty(
    pickSkuFromAttr(skuAttr),
    item.seller_sku,
    item.seller_custom_field
  );

  if (itemLevelSku) return itemLevelSku;

  const variations = Array.isArray(item.variations) ? item.variations : [];
  const found = [];

  for (const v of variations) {
    const vAttrs = Array.isArray(v?.attributes) ? v.attributes : [];
    const vSkuAttr =
      vAttrs.find((a) => String(a?.id || "").toUpperCase() === "SELLER_SKU") ||
      vAttrs.find(
        (a) => String(a?.name || "").trim().toLowerCase() === "sku"
      ) ||
      vAttrs.find((a) =>
        String(a?.name || "").trim().toLowerCase().includes("sku")
      );

    const vSku = firstNonEmpty(
      pickSkuFromAttr(vSkuAttr),
      v?.seller_custom_field
    );

    if (vSku) found.push(vSku);
  }

  const unique = Array.from(
    new Set(found.map((x) => String(x).trim()).filter(Boolean))
  );

  if (unique.length === 1) return unique[0];
  if (unique.length > 1) return unique.join(" | ");
  return null;
}

function normalizeSkuToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normalizeSkuCompactToken(value) {
  return normalizeSkuToken(value).replace(/[^a-z0-9]/g, "");
}

function normalizeLookupType(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "ean" || raw === "gtin" || raw === "barcode") return "ean";
  if (raw === "mlb" || raw === "item" || raw === "item_id") return "mlb";
  return "sku";
}

function parseSkuQueryList(raw) {
  return unique(
    String(raw || "")
      .split(/[\n,;]+/)
      .map((part) => normalizeSkuToken(part))
      .filter(Boolean),
  );
}

function parseSkuSearchTerms(raw) {
  return unique(
    String(raw || "")
      .split(/[\n,;]+/)
      .map((part) => String(part || "").trim())
      .filter(Boolean),
  );
}

function buildSellerSkuSearchVariants(rawSku) {
  const term = String(rawSku || "").trim();
  if (!term) return [];
  const variants = [term, term.toUpperCase(), term.toLowerCase()];
  const compact = term.replace(/[^a-z0-9]/gi, "");
  if (compact && compact !== term) {
    variants.push(compact, compact.toUpperCase(), compact.toLowerCase());
  }

  const letterNumber = compact.match(/^([a-z]+)(\d.+)$/i);
  if (letterNumber) {
    const prefix = letterNumber[1];
    const suffix = letterNumber[2];
    variants.push(
      suffix,
      `${prefix} ${suffix}`,
      `${prefix}-${suffix}`,
      `${prefix}_${suffix}`,
      `${prefix.toUpperCase()} ${suffix}`,
      `${prefix.toUpperCase()}-${suffix}`,
      `${prefix.toUpperCase()}_${suffix}`,
    );
  }

  return unique(variants);
}

function normalizeIdentifierToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function parseIdentifierQueryList(raw) {
  return unique(
    String(raw || "")
      .split(/[\n,;]+/)
      .map((part) => normalizeIdentifierToken(part))
      .filter(Boolean),
  );
}

function buildRowSkuTokens(row) {
  const tokens = [];

  if (row?.sku) {
    String(row.sku)
      .split("|")
      .forEach((part) => {
        const tk = normalizeSkuToken(part);
        if (tk) tokens.push(tk);
      });
  }

  if (Array.isArray(row?.sku_values)) {
    for (const sku of row.sku_values) {
      const tk = normalizeSkuToken(sku);
      if (tk) tokens.push(tk);
    }
  }

  if (Array.isArray(row?.variation_details)) {
    for (const variation of row.variation_details) {
      const tk = normalizeSkuToken(variation?.sku);
      if (tk) tokens.push(tk);
    }
  }

  return unique(tokens);
}

function rowMatchesSkuQuery(row, skuTerms) {
  if (!Array.isArray(skuTerms) || !skuTerms.length) return true;
  const rowTokens = buildRowSkuTokens(row);
  if (!rowTokens.length) return false;
  const termTokens = unique(
    skuTerms
      .flatMap((term) => [normalizeSkuToken(term), normalizeSkuCompactToken(term)])
      .filter(Boolean),
  );

  return rowTokens.some((token) => {
    const normalized = normalizeSkuToken(token);
    const compact = normalizeSkuCompactToken(token);
    return termTokens.some((term) => {
      if (!term) return false;
      if (normalized === term || compact === term) return true;
      if (term.length < 4 || compact.length < 4) return false;
      const shorter = term.length <= compact.length ? term : compact;
      const longer = term.length <= compact.length ? compact : term;
      return shorter.length >= 5 && longer.includes(shorter);
    });
  });
}

function skuSortKeyFromToken(token, skuTerms) {
  const normalized = normalizeSkuToken(token);
  const compact = normalizeSkuCompactToken(token);
  const terms = Array.isArray(skuTerms) ? skuTerms : [];

  for (let index = 0; index < terms.length; index++) {
    const term = normalizeSkuToken(terms[index]);
    const termCompact = normalizeSkuCompactToken(term);
    if (!term || !termCompact) continue;

    const exact = normalized === term || compact === termCompact;
    const family =
      exact ||
      normalized.startsWith(`${term}-`) ||
      normalized.startsWith(`${term}_`) ||
      normalized.startsWith(`${term} `) ||
      compact.startsWith(termCompact);

    if (!family) continue;

    const rawRest = exact
      ? ""
      : normalized.startsWith(term)
        ? normalized.slice(term.length)
        : compact.slice(termCompact.length);
    const rest = String(rawRest || "").replace(/^[-_\s]+/, "");
    const suffixMatch = rest.match(/^(\d+)/);
    const suffixNumber = suffixMatch ? Number(suffixMatch[1]) : Number.POSITIVE_INFINITY;

    return {
      termIndex: index,
      rank: exact ? 0 : 1,
      suffixNumber,
      suffixText: rest,
      normalized,
    };
  }

  const genericSuffix = normalized.match(/^(.*?)[-_\s]+(\d+)$/);
  return {
    termIndex: Number.POSITIVE_INFINITY,
    rank: 2,
    suffixNumber: genericSuffix ? Number(genericSuffix[2]) : Number.POSITIVE_INFINITY,
    suffixText: genericSuffix ? genericSuffix[2] : "",
    normalized,
  };
}

function compareSkuSortKeys(a, b) {
  if (a.termIndex !== b.termIndex) return a.termIndex - b.termIndex;
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.suffixNumber !== b.suffixNumber) return a.suffixNumber - b.suffixNumber;
  const suffixCmp = String(a.suffixText || "").localeCompare(String(b.suffixText || ""), "pt-BR", {
    numeric: true,
    sensitivity: "base",
  });
  if (suffixCmp) return suffixCmp;
  return String(a.normalized || "").localeCompare(String(b.normalized || ""), "pt-BR", {
    numeric: true,
    sensitivity: "base",
  });
}

function skuSortKeyForRow(row, skuTerms) {
  const tokens = buildRowSkuTokens(row);
  if (!tokens.length) return skuSortKeyFromToken("", skuTerms);
  return tokens
    .map((token) => skuSortKeyFromToken(token, skuTerms))
    .sort(compareSkuSortKeys)[0];
}

function compareRowsBySkuFamily(a, b, skuTerms) {
  const primary = compareSkuSortKeys(
    skuSortKeyForRow(a, skuTerms),
    skuSortKeyForRow(b, skuTerms)
  );
  if (primary) return primary;

  const mlbCmp = String(a?.mlb || "").localeCompare(String(b?.mlb || ""), "pt-BR", {
    numeric: true,
    sensitivity: "base",
  });
  if (mlbCmp) return mlbCmp;

  return String(a?.variation_id || "").localeCompare(String(b?.variation_id || ""), "pt-BR", {
    numeric: true,
    sensitivity: "base",
  });
}

function rowFromLookupItem(item) {
  const extractedSku = extractSkuFromItem(item);
  const extractedIdentifiers = extractIdentifiersFromItem(item);
  return {
    mlb: upper(item?.parent_item_id) || upper(item?.id),
    item_id: upper(item?.id),
    parent_item_id: upper(item?.parent_item_id) || null,
    sku: extractedSku,
    sku_values: extractedSku ? String(extractedSku).split("|").map((part) => part.trim()).filter(Boolean) : [],
    gtin: extractedIdentifiers[0] || null,
    gtin_values: extractedIdentifiers,
    ean_values: extractedIdentifiers,
    variation_details: buildVariationDetails(item, extractedSku, extractedIdentifiers),
  };
}

function itemMatchesSkuQuery(item, skuTerms) {
  return rowMatchesSkuQuery(rowFromLookupItem(item), skuTerms);
}

function itemMatchesIdentifierQuery(item, identifierTerms) {
  return rowMatchesIdentifierQuery(rowFromLookupItem(item), identifierTerms);
}

function resolveAccountKeyForCatalog(account = null, mlCreds = null) {
  const candidates = [
    account?.meli_conta_id,
    account?.key,
    account?.accountKey,
    account?.account_key,
    mlCreds?.account_key,
    mlCreds?.accountKey,
    mlCreds?.meli_conta_id,
  ];
  for (const candidate of candidates) {
    const text = String(candidate || "").trim();
    if (text) return text;
  }
  return "";
}

function buildSkuCatalogFamilyClauses(skuTerms, params) {
  const clauses = [];
  for (const rawTerm of Array.isArray(skuTerms) ? skuTerms : []) {
    const term = normalizeSkuToken(rawTerm);
    if (!term) continue;
    params.push(term);
    const exact = `$${params.length}`;
    params.push(`${term}-%`);
    const dash = `$${params.length}`;
    params.push(`${term} %`);
    const spaced = `$${params.length}`;
    params.push(`${term}\\_%`);
    const underscored = `$${params.length}`;
    clauses.push(
      `(lower(reference_sku) = ${exact} ` +
        `or lower(reference_sku) like ${dash} ` +
        `or lower(reference_sku) like ${spaced} ` +
        `or lower(reference_sku) like ${underscored} escape '\\')`
    );
  }
  return clauses;
}

async function fetchCatalogItemIdsBySku({
  accountKey,
  skuTerms,
  status = "active",
  maxAgeHours = ML_SKU_CATALOG_MAX_AGE_HOURS,
}) {
  const safeAccountKey = String(accountKey || "").trim();
  if (!safeAccountKey || !Array.isArray(skuTerms) || !skuTerms.length) return null;

  const normalizedStatus = String(status || "active").toLowerCase();
  if (normalizedStatus !== "active") return null;

  try {
    const runResult = await db.query(
      `select id, finished_at, total_items, total_skus
         from ml.mercadolivre_sku_sync_runs
        where account_key = $1
          and status = 'completed'
          and finished_at >= now() - ($2::numeric * interval '1 hour')
        order by finished_at desc
        limit 1`,
      [safeAccountKey, maxAgeHours]
    );
    const run = runResult.rows?.[0] || null;
    if (!run) return null;

    const params = [safeAccountKey, run.id];
    const clauses = buildSkuCatalogFamilyClauses(skuTerms, params);
    if (!clauses.length) return null;

    const result = await db.query(
      `select distinct mlb
         from ml.mercadolivre_sku_catalog_items
        where account_key = $1
          and sync_run_id = $2
          and status = 'active'
          and (${clauses.join(" or ")})
        order by mlb asc`,
      params
    );

    return {
      ids: unique((result.rows || []).map((row) => upper(row.mlb))),
      run: {
        id: run.id,
        finished_at: run.finished_at,
        total_items: Number(run.total_items || 0),
        total_skus: Number(run.total_skus || 0),
      },
    };
  } catch (error) {
    const message = String(error?.message || "");
    if (message.includes("mercadolivre_sku_catalog")) return null;
    console.warn("[FiltroAnunciosQueueService] catalogo SKU indisponivel:", message || error);
    return null;
  }
}

function isCatalogIdentifierAttr(attr) {
  const id = String(attr?.id || "").trim().toUpperCase();
  const name = String(attr?.name || "").trim().toLowerCase();
  return (
    ["GTIN", "EAN", "UPC", "JAN", "ISBN", "BARCODE"].includes(id) ||
    name === "gtin" ||
    name === "ean" ||
    name === "upc" ||
    name === "jan" ||
    name === "isbn" ||
    name.includes("codigo de barras") ||
    name.includes("código de barras")
  );
}

function collectAttrValues(attr) {
  const out = [];
  if (!attr || typeof attr !== "object") return out;
  [attr.value_name, attr.value_id].forEach((value) => {
    if (value !== null && value !== undefined && String(value).trim()) out.push(String(value).trim());
  });
  if (Array.isArray(attr.values)) {
    attr.values.forEach((value) => {
      [value?.name, value?.id].forEach((raw) => {
        if (raw !== null && raw !== undefined && String(raw).trim()) out.push(String(raw).trim());
      });
    });
  }
  return out;
}

function extractIdentifiersFromItem(item) {
  if (!item || typeof item !== "object") return [];
  const values = [];
  const collect = (attrs) => {
    (Array.isArray(attrs) ? attrs : []).forEach((attr) => {
      if (!isCatalogIdentifierAttr(attr)) return;
      values.push(...collectAttrValues(attr));
    });
  };

  collect(item.attributes);
  (Array.isArray(item.variations) ? item.variations : []).forEach((variation) => {
    collect(variation?.attributes);
    collect(variation?.attribute_combinations);
  });
  return unique(values.map((value) => String(value).trim()).filter(Boolean));
}

function extractSkuFromVariation(variation) {
  if (!variation || typeof variation !== "object") return null;
  const attrs = [
    ...(Array.isArray(variation.attributes) ? variation.attributes : []),
    ...(Array.isArray(variation.attribute_combinations) ? variation.attribute_combinations : []),
  ];
  const skuAttr =
    attrs.find((a) => String(a?.id || "").toUpperCase() === "SELLER_SKU") ||
    attrs.find((a) => String(a?.name || "").trim().toLowerCase() === "sku") ||
    attrs.find((a) => String(a?.name || "").trim().toLowerCase().includes("sku"));
  return firstNonEmpty(pickSkuFromAttr(skuAttr), variation.seller_custom_field);
}

function extractIdentifiersFromVariation(variation) {
  if (!variation || typeof variation !== "object") return [];
  const values = [];
  const attrs = [
    ...(Array.isArray(variation.attributes) ? variation.attributes : []),
    ...(Array.isArray(variation.attribute_combinations) ? variation.attribute_combinations : []),
  ];
  attrs.forEach((attr) => {
    if (!isCatalogIdentifierAttr(attr)) return;
    values.push(...collectAttrValues(attr));
  });
  return unique(values.map((value) => String(value).trim()).filter(Boolean));
}

function variationLabel(variation) {
  const attrs = [
    ...(Array.isArray(variation?.attribute_combinations)
      ? variation.attribute_combinations
      : []),
    ...(Array.isArray(variation?.attributes) ? variation.attributes : []),
  ];
  const parts = attrs
    .map((attr) => {
      const name = String(attr?.name || attr?.id || "").trim();
      const value = firstNonEmpty(
        attr?.value_name,
        attr?.value_id,
        Array.isArray(attr?.values) ? attr.values[0]?.name : null,
        Array.isArray(attr?.values) ? attr.values[0]?.id : null
      );
      if (!name || !value) return "";
      if (String(name).trim().toLowerCase().includes("sku")) return "";
      return `${name}: ${value}`;
    })
    .filter(Boolean);
  return unique(parts).join(" | ");
}

function buildVariationDetails(item, fallbackSku = null, fallbackIdentifiers = []) {
  const variations = Array.isArray(item?.variations) ? item.variations : [];
  return variations.map((variation) => {
    const identifiers = extractIdentifiersFromVariation(variation);
    return {
      variation_id: variation?.id ? String(variation.id) : null,
      variation_name: variationLabel(variation),
      sku: extractSkuFromVariation(variation) || fallbackSku || null,
      gtin: identifiers[0] || fallbackIdentifiers[0] || null,
      gtin_values: identifiers.length ? identifiers : fallbackIdentifiers,
      gtin_source: identifiers.length ? "variation" : fallbackIdentifiers.length ? "item" : null,
      stock_total: toStockInt(variation?.available_quantity),
    };
  });
}

function expandRowsByVariations(rows) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const details = Array.isArray(row?.variation_details)
      ? row.variation_details.filter(Boolean)
      : [];
    if (!details.length) {
      out.push(row);
      continue;
    }

    for (const variation of details) {
      out.push({
        ...row,
        sku: variation.sku || row.sku,
        gtin: variation.gtin || row.gtin,
        gtin_values: Array.isArray(variation.gtin_values) && variation.gtin_values.length
          ? variation.gtin_values
          : row.gtin_values,
        sku_values: variation.sku ? [variation.sku] : row.sku_values,
        ean_values: Array.isArray(variation.gtin_values) && variation.gtin_values.length
          ? variation.gtin_values
          : row.ean_values,
        stock_total: toStockInt(variation.stock_total),
        stock_source: "variation",
        stock_variations_count: 1,
        variation_id: variation.variation_id || null,
        variation_name: variation.variation_name || null,
      });
    }
  }
  return out;
}

function buildRowIdentifierTokens(row) {
  const tokens = [];
  const add = (value) => {
    const token = normalizeIdentifierToken(value);
    if (token) tokens.push(token);
  };
  add(row?.gtin);
  add(row?.ean);
  add(row?.barcode);
  if (Array.isArray(row?.gtin_values)) row.gtin_values.forEach(add);
  if (Array.isArray(row?.ean_values)) row.ean_values.forEach(add);
  if (Array.isArray(row?.barcode_values)) row.barcode_values.forEach(add);
  return unique(tokens);
}

function rowMatchesIdentifierQuery(row, terms) {
  if (!Array.isArray(terms) || !terms.length) return true;
  const rowTokens = buildRowIdentifierTokens(row);
  if (!rowTokens.length) return false;
  return rowTokens.some((token) => terms.includes(token));
}

async function fetchItemsBatch({
  token,
  authState = null,
  ids,
  attributes = FULL_ITEM_ATTRIBUTES,
}) {
  const url = new URL("https://api.mercadolibre.com/items");
  url.searchParams.set("ids", ids.join(","));
  url.searchParams.set("attributes", attributes.join(","));

  const j = await fetchMlJson(url.toString(), {
    token,
    authState,
    retries: 3,
  });

  const arr = Array.isArray(j) ? j : [];
  return arr
    .filter((x) => x && x.code === 200 && x.body && x.body.id)
    .map((x) => x.body);
}

async function fetchItemBatches({
  token,
  authState = null,
  ids = [],
  attributes = FULL_ITEM_ATTRIBUTES,
  concurrency = ML_ITEMS_DETAIL_CONCURRENCY,
  onBatch = null,
  onItems = null,
  collect = true,
  checkCancelled = null,
}) {
  const cleanIds = unique(ids.map((id) => upper(id)));
  const batches = chunk(cleanIds, ML_ITEMS_BATCH_SIZE);
  const out = [];
  let nextIndex = 0;
  let completed = 0;
  const workerCount = Math.min(Math.max(1, Number(concurrency) || 1), Math.max(1, batches.length));

  async function worker() {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= batches.length) return;
      await checkMaybeCancelled(checkCancelled);
      const part = await fetchItemsBatch({
        token,
        authState,
        ids: batches[index],
        attributes,
      });
      if (collect) out.push(...part);
      if (typeof onItems === "function" && part.length) {
        await onItems(part, { index, completed, total: batches.length });
      }
      completed += 1;
      await callMaybeAsync(onBatch, {
        index,
        completed,
        total: batches.length,
        item_count: collect ? out.length : Math.min(completed * ML_ITEMS_BATCH_SIZE, cleanIds.length),
        ids_count: cleanIds.length,
      });
    }
  }

  if (!batches.length) return [];
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return out;
}

async function fetchVariationDetail({
  token,
  authState = null,
  itemId,
  variationId,
}) {
  const safeItemId = upper(itemId);
  const safeVariationId = String(variationId || "").trim();
  if (!safeItemId || !safeVariationId) return null;

  const url = new URL(
    `https://api.mercadolibre.com/items/${encodeURIComponent(safeItemId)}/variations/${encodeURIComponent(safeVariationId)}`
  );
  url.searchParams.set("attributes", VARIATION_DETAIL_ATTRIBUTES.join(","));

  const detail = await fetchMlJson(url.toString(), {
    token,
    authState,
    retries: 2,
  });
  return detail && typeof detail === "object" ? detail : null;
}

function buildVariationGtinFailureSample(target, error) {
  const message = String(error?.message || error || "Erro ao consultar variacao").slice(0, 240);
  return {
    item_id: upper(target?.itemId || target?.row?.item_id || target?.row?.mlb || ""),
    variation_id: String(target?.variationId || target?.variation?.variation_id || "").trim() || null,
    status: Number.isFinite(Number(error?.status)) ? Number(error.status) : null,
    message,
  };
}

async function enrichVariationGtins({
  rows = [],
  token,
  authState = null,
  concurrency = ML_VARIATION_DETAIL_CONCURRENCY,
  checkCancelled = null,
  onProgress = null,
}) {
  const targets = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const details = Array.isArray(row?.variation_details) ? row.variation_details : [];
    for (const variation of details) {
      const variationId = String(variation?.variation_id || "").trim();
      if (!variationId) continue;
      const hasVariationGtin =
        variation.gtin_source === "variation" &&
        Array.isArray(variation.gtin_values) &&
        variation.gtin_values.length;
      if (hasVariationGtin) continue;
      targets.push({ row, variation, itemId: row.item_id || row.mlb, variationId });
    }
  }

  if (!targets.length) return { checked: 0, enriched: 0, failed: 0, failure_samples: [] };

  let nextIndex = 0;
  let checked = 0;
  let enriched = 0;
  let failed = 0;
  const failureSamples = [];
  const workerCount = Math.min(Math.max(1, Number(concurrency) || 1), targets.length);

  async function worker() {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= targets.length) return;
      await checkMaybeCancelled(checkCancelled);

      const target = targets[index];
      try {
        const detail = await fetchVariationDetail({
          token,
          authState,
          itemId: target.itemId,
          variationId: target.variationId,
        });
        const identifiers = extractIdentifiersFromVariation(detail);
        if (identifiers.length) {
          target.variation.gtin = identifiers[0];
          target.variation.gtin_values = identifiers;
          target.variation.gtin_source = "variation";
          enriched += 1;
        }
      } catch (error) {
        failed += 1;
        if (failureSamples.length < VARIATION_GTIN_FAILURE_SAMPLE_LIMIT) {
          failureSamples.push(buildVariationGtinFailureSample(target, error));
        }
        console.warn("[FiltroAnunciosQueueService] falha ao consultar GTIN da variacao:", {
          item_id: target.itemId,
          variation_id: target.variationId,
          error: error?.message || String(error),
        });
      }

      checked += 1;
      await callMaybeAsync(onProgress, {
        checked,
        enriched,
        total: targets.length,
      });
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return { checked, enriched, failed, failure_samples: failureSamples };
}

function normalizeCategoryPayload(categoryId, payload) {
  if (!payload || typeof payload !== "object") {
    return {
      id: categoryId,
      name: null,
      path: null,
    };
  }
  const pathRoot = Array.isArray(payload.path_from_root)
    ? payload.path_from_root
        .map((node) => String(node?.name || "").trim())
        .filter(Boolean)
    : [];
  return {
    id: payload.id || categoryId,
    name: payload.name || null,
    path: pathRoot.length ? pathRoot.join(" > ") : payload.name || null,
  };
}

async function fetchCategoryDetail({ categoryId, authState = null, token = null }) {
  const id = String(categoryId || "").trim();
  if (!id) return null;
  const url = `https://api.mercadolibre.com/categories/${encodeURIComponent(id)}`;
  try {
    const payload = await fetchMlJson(url, {
      token,
      authState,
      retries: 3,
    });
    return normalizeCategoryPayload(id, payload);
  } catch (error) {
    console.warn("[FiltroAnunciosQueueService] falha ao buscar categoria:", id, error?.message || error);
    return normalizeCategoryPayload(id, null);
  }
}

async function enrichRowsWithCategories(rows, {
  token = null,
  authState = null,
  onProgress = null,
  throwIfCancelled = null,
} = {}) {
  const targetRows = Array.isArray(rows) ? rows : [];
  const categoryIds = unique(
    targetRows
      .map((row) => String(row?.category_id || "").trim())
      .filter(Boolean)
  );
  if (!categoryIds.length) return targetRows;

  const cache = new Map();
  let cursor = 0;
  let processed = 0;
  const concurrency = Math.min(6, categoryIds.length);

  async function worker() {
    while (cursor < categoryIds.length) {
      const index = cursor;
      cursor += 1;
      const categoryId = categoryIds[index];
      await checkMaybeCancelled(throwIfCancelled);
      const detail = await fetchCategoryDetail({ categoryId, authState, token });
      cache.set(categoryId, detail);
      processed += 1;
      await callMaybeAsync(onProgress, {
        current: processed,
        total: categoryIds.length,
      });
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  for (const row of targetRows) {
    const categoryId = String(row?.category_id || "").trim();
    const detail = categoryId ? cache.get(categoryId) : null;
    row.category_name = detail?.name || null;
    row.category_path = detail?.path || null;
  }

  return targetRows;
}

async function fetchSalesMap({
  token,
  authState = null,
  sellerId,
  date_from,
  date_to,
  itemToParent = null,
  onProgress = null,
  includeOrderStatus = "paid",
}) {
  async function run(mode) {
    const out = new Map();
    let truncated = false;
    let totalAvailable = 0;
    let scanned = 0;
    const ranges = splitDateRange(date_from, date_to, 7);

    for (const range of ranges.length ? ranges : [{ from: date_from, to: date_to }]) {
      let offset = 0;
      let rangeTotal = 0;
      let rangeTruncated = false;

      for (;;) {
        const limit = ordersSearchPageLimit(offset);
        if (limit <= 0) {
          truncated = true;
          rangeTruncated = true;
          break;
        }

        const url = new URL("https://api.mercadolibre.com/orders/search");
        url.searchParams.set("seller", String(sellerId));
        if (includeOrderStatus) {
          url.searchParams.set("order.status", String(includeOrderStatus));
        }
        url.searchParams.set(
          `order.${mode}.from`,
          `${range.from}T00:00:00.000-00:00`
        );
        url.searchParams.set(`order.${mode}.to`, `${range.to}T23:59:59.999-00:00`);
        url.searchParams.set("sort", "date_desc");
        url.searchParams.set("limit", String(limit));
        url.searchParams.set("offset", String(offset));

        const j = await fetchMlJson(url.toString(), {
          token,
          authState,
          retries: 3,
        });

        const results = Array.isArray(j?.results) ? j.results : [];
        const total = Number(j?.paging?.total || 0);
        rangeTotal = total || rangeTotal;
        totalAvailable += !offset ? rangeTotal : 0;

        for (const order of results) {
          const orderDateIso =
            order?.[mode] || order?.date_closed || order?.date_created;
          const orderDay = datePart(orderDateIso);

          for (const it of order.order_items || []) {
            const rawId = upper(it?.item?.id);
            if (!rawId) continue;

            const mlb = itemToParent?.get(rawId) || rawId;
            const qty = Number(it?.quantity || 0);
            const unit = Number(it?.unit_price || 0);
            const revenue = unit * qty;

            const prev = out.get(mlb) || {
              units: 0,
              revenue_cents: 0,
              last_sale: null,
            };

            prev.units += qty;
            prev.revenue_cents += Math.round(revenue * 100);

            if (orderDay && (!prev.last_sale || orderDay > prev.last_sale)) {
              prev.last_sale = orderDay;
            }

            out.set(mlb, prev);
          }
        }

        offset += results.length || limit;
        scanned += results.length;
        const cappedRangeTotal = rangeTotal
          ? Math.min(rangeTotal, ML_ORDERS_SEARCH_MAX_WINDOW)
          : offset;
        const progressTotal = Math.max(scanned, totalAvailable || cappedRangeTotal || 1);
        if (rangeTotal > ML_ORDERS_SEARCH_MAX_WINDOW && offset >= ML_ORDERS_SEARCH_MAX_WINDOW) {
          truncated = true;
          rangeTruncated = true;
        }
        if (typeof onProgress === "function") {
          onProgress({
            current: Math.min(scanned, progressTotal),
            total: progressTotal,
            mode,
            truncated,
            total_available: totalAvailable,
            max_window: ML_ORDERS_SEARCH_MAX_WINDOW,
          });
        }
        if (!results.length || !rangeTotal || offset >= rangeTotal || rangeTruncated) break;

        await sleep(0);
      }
    }

    return out;
  }

  try {
    return await run("date_closed");
  } catch (e) {
    console.warn(
      "[fetchSalesMap] date_closed falhou, fallback date_created:",
      e?.message || e
    );
    return await run("date_created");
  }
}

function emptySalesBucket() {
  return {
    units: 0,
    revenue_cents: 0,
    last_sale: null,
  };
}

function buildSalesBreakdown(netMap, grossMap) {
  const out = new Map();
  const ids = unique([
    ...Array.from(netMap?.keys?.() || []),
    ...Array.from(grossMap?.keys?.() || []),
  ]);

  for (const id of ids) {
    const net = netMap.get(id) || emptySalesBucket();
    const gross = grossMap.get(id) || net;
    const refundUnits = Math.max(0, Number(gross.units || 0) - Number(net.units || 0));
    const refundRevenueCents = Math.max(
      0,
      Number(gross.revenue_cents || 0) - Number(net.revenue_cents || 0)
    );

    out.set(id, {
      net_units: Number(net.units || 0),
      net_revenue_cents: Number(net.revenue_cents || 0),
      gross_units: Number(gross.units || 0),
      gross_revenue_cents: Number(gross.revenue_cents || 0),
      refunded_units: refundUnits,
      refunded_revenue_cents: refundRevenueCents,
      last_sale: net.last_sale || gross.last_sale || null,
    });
  }

  return out;
}

async function fetchSalesAfterMap({
  token,
  authState = null,
  sellerId,
  date_to,
  itemToParent = null,
  onProgress = null,
}) {
  const out = new Map();
  const toDate = String(date_to || "").trim();
  if (!toDate) return out;

  const today = new Date().toISOString().slice(0, 10);
  if (toDate >= today) return out;

  const fromDt = new Date(`${toDate}T00:00:00.000Z`);
  fromDt.setUTCDate(fromDt.getUTCDate() + 1);
  const fromIso = fromDt.toISOString().slice(0, 10);

  async function run(mode) {
    let truncated = false;
    let totalAvailable = 0;
    let scanned = 0;
    const ranges = splitDateRange(fromIso, today, 7);

    for (const range of ranges.length ? ranges : [{ from: fromIso, to: today }]) {
      let offset = 0;
      let rangeTotal = 0;
      let rangeTruncated = false;

      for (;;) {
        const limit = ordersSearchPageLimit(offset);
        if (limit <= 0) {
          truncated = true;
          rangeTruncated = true;
          break;
        }

        const url = new URL("https://api.mercadolibre.com/orders/search");
        url.searchParams.set("seller", String(sellerId));
        url.searchParams.set("order.status", "paid");
        url.searchParams.set(
          `order.${mode}.from`,
          `${range.from}T00:00:00.000-00:00`
        );
        url.searchParams.set(`order.${mode}.to`, `${range.to}T23:59:59.999-00:00`);
        url.searchParams.set("sort", "date_desc");
        url.searchParams.set("limit", String(limit));
        url.searchParams.set("offset", String(offset));

        const j = await fetchMlJson(url.toString(), {
          token,
          authState,
          retries: 3,
        });

        const results = Array.isArray(j?.results) ? j.results : [];
        const total = Number(j?.paging?.total || 0);
        rangeTotal = total || rangeTotal;
        totalAvailable += !offset ? rangeTotal : 0;

        for (const order of results) {
          for (const it of order.order_items || []) {
            const rawId = upper(it?.item?.id);
            if (!rawId) continue;

            const mlb = itemToParent?.get(rawId) || rawId;
            const qty = Number(it?.quantity || 0);
            const unit = Number(it?.unit_price || 0);
            const revenue = unit * qty;

            const prev = out.get(mlb) || {
              units: 0,
              revenue_cents: 0,
            };

            prev.units += qty;
            prev.revenue_cents += Math.round(revenue * 100);

            out.set(mlb, prev);
          }
        }

        offset += results.length || limit;
        scanned += results.length;
        const cappedRangeTotal = rangeTotal
          ? Math.min(rangeTotal, ML_ORDERS_SEARCH_MAX_WINDOW)
          : offset;
        const progressTotal = Math.max(scanned, totalAvailable || cappedRangeTotal || 1);
        if (rangeTotal > ML_ORDERS_SEARCH_MAX_WINDOW && offset >= ML_ORDERS_SEARCH_MAX_WINDOW) {
          truncated = true;
          rangeTruncated = true;
        }
        if (typeof onProgress === "function") {
          onProgress({
            current: Math.min(scanned, progressTotal),
            total: progressTotal,
            mode,
            truncated,
            total_available: totalAvailable,
            max_window: ML_ORDERS_SEARCH_MAX_WINDOW,
          });
        }
        if (!results.length || !rangeTotal || offset >= rangeTotal || rangeTruncated) break;

        await sleep(0);
      }
    }
  }

  try {
    await run("date_closed");
  } catch (e) {
    console.warn(
      "[fetchSalesAfterMap] date_closed falhou, fallback date_created:",
      e?.message || e
    );
    out.clear();
    await run("date_created");
  }

  return out;
}

async function fetchVisitsMap({
  token,
  authState = null,
  ids,
  date_from,
  date_to,
  concurrency = 4,
  onProgress = null,
}) {
  const out = new Map();
  const queue = ids.slice();
  let processed = 0;
  const total = queue.length;

  async function worker() {
    while (queue.length) {
      const id = queue.shift();
      if (!id) break;

      const qs = new URLSearchParams();
      qs.set("ids", id);
      qs.set("date_from", date_from);
      qs.set("date_to", date_to);
      qs.set("unit", "day");
      if (!authState) qs.set("access_token", token);

      const url = `https://api.mercadolibre.com/items/visits?${qs.toString()}`;

      try {
        const j = authState
          ? await fetchMlJson(url, { authState, retries: 2 })
          : await httpGetJson(url, {}, 2);
        const arr = Array.isArray(j)
          ? j
          : Array.isArray(j?.results)
            ? j.results
            : [];
        const v = arr[0];
        const total = Number(v?.total_visits ?? v?.total ?? 0);
        out.set(id, Number.isFinite(total) ? total : 0);
      } catch {
        out.set(id, 0);
      }

      processed += 1;
      if (typeof onProgress === "function") {
        onProgress({ current: processed, total });
      }

      await sleep(80);
    }
  }

  const workers = [];
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.all(workers);

  return out;
}

async function fetchPromotionsMap({
  token,
  authState = null,
  sellerId,
  itemIds,
  date_from,
  date_to,
  maxCardsToScan = null,
  onProgress = null,
  throwIfCancelled = null,
}) {
  const targetIds = new Set((itemIds || []).map((x) => upper(x)).filter(Boolean));
  const out = new Map();
  if (!targetIds.size) return out;

  const promoApiBases = [
    "https://api.mercadolibre.com/seller-promotions",
    "https://api.mercadolibre.com/marketplace/seller-promotions",
  ];

  async function fetchJsonWithFallback(builders, retries = 2) {
    let lastError = null;
    for (const build of builders) {
      await checkMaybeCancelled(throwIfCancelled);
      const url = build();
      try {
        return await fetchMlJson(url.toString(), {
          token,
          authState,
          retries,
        });
      } catch (error) {
        if (error instanceof JobCancelledError) throw error;
        lastError = error;
      }
    }
    throw lastError || new Error("Falha ao consultar endpoint de promocoes.");
  }

  let cards = [];
  let offset = 0;
  const limit = 50;

  for (;;) {
    await checkMaybeCancelled(throwIfCancelled);
    const raw = await fetchJsonWithFallback(
      promoApiBases.flatMap((base) => [
        () => {
          const url = new URL(`${base}/users/${sellerId}`);
          url.searchParams.set("app_version", "v2");
          url.searchParams.set("limit", String(limit));
          url.searchParams.set("offset", String(offset));
          return url;
        },
        () => {
          const url = new URL(`${base}/users/${sellerId}`);
          url.searchParams.set("limit", String(limit));
          url.searchParams.set("offset", String(offset));
          return url;
        },
      ]),
      2,
    );

    const results = raw?.results || raw?.promotions || raw?.data || [];
    cards.push(...results);

    const total = Number(raw?.paging?.total || 0);
    offset += limit;
    if (!results.length || !total || offset >= total) break;
  }

  const relevantCards = cards.filter((card) => {
    const status = String(card?.status || "").toLowerCase();
    if (["finished", "expired", "cancelled"].includes(status)) return false;
    return overlapPeriod(
      card?.start_date || card?.valid_from,
      card?.finish_date || card?.valid_to,
      date_from,
      date_to
    );
  });
  const scanLimit = Number(maxCardsToScan || 0);
  const cardsToScan =
    Number.isFinite(scanLimit) && scanLimit > 0
      ? relevantCards.slice(0, scanLimit)
      : relevantCards;

  async function fetchPromotionItems(promotionLabel, promotionId, type, status) {
    let searchAfter = null;

    for (;;) {
      await checkMaybeCancelled(throwIfCancelled);
      const raw = await fetchJsonWithFallback(
        promoApiBases.flatMap((base) => [
          () => {
            const url = new URL(
              `${base}/promotions/${encodeURIComponent(promotionId)}/items`
            );
            url.searchParams.set("promotion_type", type);
            url.searchParams.set("status", status);
            url.searchParams.set("status_item", "active");
            url.searchParams.set("limit", "50");
            url.searchParams.set("app_version", "v2");
            if (searchAfter) url.searchParams.set("search_after", searchAfter);
            return url;
          },
          () => {
            const url = new URL(
              `${base}/promotions/${encodeURIComponent(promotionId)}/items`
            );
            url.searchParams.set("promotion_type", type);
            url.searchParams.set("status", status);
            url.searchParams.set("status_item", "active");
            url.searchParams.set("limit", "50");
            if (searchAfter) url.searchParams.set("search_after", searchAfter);
            return url;
          },
        ]),
        2,
      );

      const items = raw?.results || raw?.items || raw?.data || [];
      for (const item of items) {
        const id = upper(item?.id || item?.item_id);
        if (!id || !targetIds.has(id)) continue;

        const srcStatus = String(item?.status || item?.item_status || status || "")
          .trim()
          .toLowerCase();
        if (srcStatus === "candidate") continue;

        const current = out.get(id);

        let promoPct = null;
        if (item?.discount_percentage != null) {
          promoPct = Number(item.discount_percentage);
        } else {
          const original = Number(item?.original_price || 0);
          const discounted = Number(
            item?.top_deal_price ??
              item?.suggested_discounted_price ??
              item?.max_discounted_price ??
              0
          );
          if (original > 0 && discounted >= 0) {
            promoPct = ((original - discounted) / original) * 100;
          }
        }

        const normalizedPct =
          promoPct != null && Number.isFinite(Number(promoPct))
            ? Math.round(Number(promoPct) * 10) / 10
            : null;

        if (!current || (current.promo_pct || 0) < (normalizedPct || 0)) {
          out.set(id, {
            promo_active: true,
            promo_pct: normalizedPct,
            promo_name: promotionLabel || String(promotionId),
            promo_id: promotionId,
            promo_status: srcStatus,
          });
        }
      }

      searchAfter = raw?.paging?.searchAfter || raw?.paging?.search_after || null;
      if (!searchAfter || !items.length) break;
    }
  }

  for (let idx = 0; idx < cardsToScan.length; idx++) {
    await checkMaybeCancelled(throwIfCancelled);
    const card = cardsToScan[idx];
    const promotionId = card?.id || card?.promotion_id || card?.code;
    const type = String(card?.type || card?.promotion_type || "SMART").toUpperCase();
    const promotionLabel =
      card?.name || card?.title || card?.promotion_name || String(promotionId);
    if (!promotionId) continue;

    try {
      await fetchPromotionItems(promotionLabel, promotionId, type, "started");
    } catch (e) {
      if (e instanceof JobCancelledError) throw e;
      console.warn(
        `[fetchPromotionsMap] falha na promocao ${promotionId}:`,
        e?.message || e
      );
    }

    if (out.size >= targetIds.size) break;
    await callMaybeAsync(onProgress, {
      current: idx + 1,
      total: cardsToScan.length || 1,
    });
    await sleep(20);
  }

  return out;
}

async function fetchAtacadoPromoPricingMap({
  token,
  authState = null,
  itemIds,
  priceSeedById = null,
  salePriceIds = null,
  concurrency = 5,
  onProgress = null,
  throwIfCancelled = null,
}) {
  const ids = unique((itemIds || []).map(upper));
  const out = new Map();
  if (!ids.length) return out;

  await checkMaybeCancelled(throwIfCancelled);
  const state = authState || { token, creds: {} };
  if (!state.creds) state.creds = {};
  if (!state.token && token) state.token = token;

  const detailsById = new Map();
  if (priceSeedById instanceof Map) {
    for (const id of ids) {
      const seed = priceSeedById.get(id) || null;
      if (!seed) continue;
      detailsById.set(id, {
        id,
        price: Number(seed.itemPrice || 0) || null,
        original_price: Number(seed.itemOriginalPrice || 0) || null,
      });
    }
  }

  const missingDetailIds = ids.filter((id) => !detailsById.has(id));
  if (missingDetailIds.length) {
    const details = [];
    const detailChunks = chunk(missingDetailIds, 20);
    for (let index = 0; index < detailChunks.length; index += 1) {
      await checkMaybeCancelled(throwIfCancelled);
      const slice = await fetchItemsBatch({
        token: state.token || token,
        authState: state,
        ids: detailChunks[index],
      });
      details.push(...slice);
    }
    for (const item of details) {
      const itemId = upper(item?.id);
      if (!itemId) continue;
      detailsById.set(itemId, item);
    }
  }

  const explicitSalePriceSelection =
    Array.isArray(salePriceIds) || salePriceIds instanceof Set;
  const salePriceList = Array.isArray(salePriceIds)
    ? salePriceIds
    : salePriceIds instanceof Set
      ? Array.from(salePriceIds)
      : [];
  const salePriceSet = new Set(unique(salePriceList.map(upper)));
  const shouldFetchSalePrice = (id) =>
    explicitSalePriceSelection ? salePriceSet.has(id) : true;

  const queue = ids.slice();
  let processed = 0;
  let cancelled = false;

  async function worker() {
    while (queue.length) {
      if (cancelled) throw new JobCancelledError();
      try {
        await checkMaybeCancelled(throwIfCancelled);
      } catch (error) {
        cancelled = true;
        throw error;
      }
      const id = queue.shift();
      if (!id) break;

      const item = detailsById.get(id) || null;
      if (item) {
        let salePricePayload = null;
        let salePriceInfo = null;
        let salePricePromotion = null;

        if (shouldFetchSalePrice(id)) {
          try {
            const salePriceUrl = new URL(
              `https://api.mercadolibre.com/items/${encodeURIComponent(id)}/sale_price`
            );
            salePriceUrl.searchParams.set("context", "channel_marketplace");
            salePriceUrl.searchParams.set("quantity", "1");
            salePricePayload = await fetchMlJson(salePriceUrl.toString(), {
              token: state.token || token,
              authState: state,
              retries: 2,
            });
            salePriceInfo = PromoPricing.extractSalePriceInfo(salePricePayload || {});

            const promoId = firstNonEmpty(
              salePricePayload?.promotion_id,
              salePricePayload?.sale_price?.promotion_id,
              salePricePayload?.price?.promotion_id,
              salePricePayload?.metadata?.promotion_id,
              salePriceInfo?.promotion_id
            );
            const promoType = firstNonEmpty(
              salePricePayload?.promotion_type,
              salePricePayload?.sale_price?.promotion_type,
              salePricePayload?.price?.promotion_type,
              salePricePayload?.metadata?.promotion_type,
              salePriceInfo?.promotion_type
            );
            const promoPct = firstPercentNumber([
              salePriceInfo?.discount_percent,
              salePricePayload?.discount_percentage,
              salePricePayload?.discount_percent,
              salePricePayload?.metadata?.discount_percentage,
              salePricePayload?.metadata?.discount_percent,
            ]);

            if (promoId || promoType || promoPct) {
              salePricePromotion = {
                promo_active: true,
                promo_pct: promoPct,
                promo_id: promoId || null,
                promo_name: promoType ? `Promo ${promoType}` : "Promo atual",
                promo_status: "active",
                current_price: Number(salePriceInfo?.amount || 0) || null,
                original_price: Number(salePriceInfo?.regular_amount || 0) || null,
                promo_source: "sale_price",
              };
            }
          } catch {
            salePriceInfo = null;
            salePricePromotion = null;
          }
        }

        const snapshot = PromoPricing.resolvePromotionSnapshot({
          itemPrice: item?.price,
          itemOriginalPrice: item?.original_price,
          salePriceInfo,
          itemPromotion: salePricePromotion,
        });

        out.set(id, {
          promo_active: !!snapshot.promo_active,
          promo_pct: snapshot.promo_pct ?? null,
          current_price: snapshot.current_price,
          original_price: snapshot.original_price,
          promo_name: snapshot.promo_name,
          promo_id: snapshot.promo_id,
          promo_status: snapshot.promo_status,
          promo_source: "atacado_pricing",
        });
      }

      processed += 1;
      await callMaybeAsync(onProgress, {
        current: processed,
        total: ids.length || 1,
      });
      await sleep(5);
    }
  }

  const workers = [];
  const size = Math.max(1, Math.min(concurrency, queue.length || 1));
  for (let i = 0; i < size; i += 1) workers.push(worker());
  await Promise.all(workers);
  return out;
}

class FiltroAnunciosQueueService {
  constructor() {
    const queueName =
      process.env.FILTRO_ANUNCIOS_QUEUE_NAME ||
      "Filtro Anuncios Export Queue v3";
    this.queue = new Bull(queueName, {
      createClient: (type) => makeBullClient(type, queueName),
      settings: {
        lockDuration: FILTRO_ANUNCIOS_LOCK_DURATION_MS,
        stalledInterval: FILTRO_ANUNCIOS_STALLED_INTERVAL_MS,
        maxStalledCount: FILTRO_ANUNCIOS_MAX_STALLED_COUNT,
      },
    });
    this.redis = getSharedRedis("app");
    this.storagePrefix =
      process.env.FILTRO_ANUNCIOS_STORAGE_PREFIX ||
      "ml:filtro-anuncios:v3";
    this.ttlSeconds = Math.max(
      3600,
      Number(process.env.FILTRO_ANUNCIOS_TTL_SECONDS || 6 * 60 * 60)
    );
    this.workerStarted = false;
  }

  _metaKey(jobId) {
    return `${this.storagePrefix}:${jobId}:meta`;
  }

  _dataKey(jobId) {
    return `${this.storagePrefix}:${jobId}:rows`;
  }

  _dataChunkKey(jobId, index) {
    return `${this.storagePrefix}:${jobId}:rows:${index}`;
  }

  _csvKey(jobId) {
    return `${this.storagePrefix}:${jobId}:csv`;
  }

  _csvChunkKey(jobId, index) {
    return `${this.storagePrefix}:${jobId}:csv:${index}`;
  }

  async _readJsonKey(key) {
    try {
      const raw = await this.redis.get(key);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      if (isValkeyLoadingError(err)) throw err;
      return null;
    }
  }

  async _writeJsonKey(key, payload) {
    await this.redis.set(key, JSON.stringify(payload), "EX", this.ttlSeconds);
  }

  async _deleteResultChunks(jobId) {
    const current = await this._readJsonKey(this._dataKey(jobId));
    if (!current?.__chunked || !Array.isArray(current.chunks)) return;
    for (const key of current.chunks) {
      if (key) await this.redis.del(key).catch(() => {});
    }
  }

  async _deleteCsvChunks(jobId) {
    const current = await this._readJsonKey(this._csvKey(jobId));
    if (!current?.__csv || !Array.isArray(current.chunks)) return;
    for (const key of current.chunks) {
      if (key) await this.redis.del(key).catch(() => {});
    }
  }

  async _writeCsvManifest(jobId, patch) {
    const current = (await this._readJsonKey(this._csvKey(jobId))) || { __csv: true };
    await this._writeJsonKey(this._csvKey(jobId), {
      ...current,
      ...patch,
      __csv: true,
      updated_at: new Date().toISOString(),
    });
  }

  async _readCsvManifest(jobId) {
    const manifest = await this._readJsonKey(this._csvKey(jobId));
    return manifest?.__csv ? manifest : null;
  }

  async _readMeta(jobId) {
    return this._readJsonKey(this._metaKey(jobId));
  }

  async _writeMeta(jobId, patch) {
    let cur = await this._readMeta(jobId);
    if (!cur) cur = {};
    cur = { ...cur, ...patch, updated_at: new Date().toISOString() };
    await this._writeJsonKey(this._metaKey(jobId), cur);
  }

  async _writeResults(jobId, rows) {
    const safeRows = Array.isArray(rows) ? rows : [];
    const chunkSize = Math.max(
      250,
      Number(process.env.FILTRO_ANUNCIOS_RESULT_CHUNK_SIZE || 1000)
    );
    const chunkThreshold = Math.max(
      chunkSize,
      Number(process.env.FILTRO_ANUNCIOS_RESULT_CHUNK_THRESHOLD || 5000)
    );

    await this._deleteResultChunks(jobId);

    if (safeRows.length <= chunkThreshold) {
      await this._writeJsonKey(this._dataKey(jobId), safeRows);
      return;
    }

    const chunks = [];
    for (let i = 0; i < safeRows.length; i += chunkSize) {
      const index = chunks.length;
      const key = this._dataChunkKey(jobId, index);
      const part = safeRows.slice(i, i + chunkSize);
      await this._writeJsonKey(key, part);
      chunks.push(key);
      await sleep(1);
    }

    await this._writeJsonKey(this._dataKey(jobId), {
      __chunked: true,
      total: safeRows.length,
      chunk_size: chunkSize,
      chunks,
    });
  }

  async _readPersistedTotal(jobId) {
    const payload = await this._readJsonKey(this._dataKey(jobId));
    if (Array.isArray(payload)) return payload.length;
    if (payload?.__chunked && Number.isFinite(Number(payload.total))) {
      return Number(payload.total);
    }
    return null;
  }

  async _throwIfCancelled(jobId) {
    const meta = await this._readMeta(jobId);
    if (meta?.cancel_requested || meta?.status === "cancelado") {
      throw new JobCancelledError();
    }
  }

  _canAccess(meta, currentContaId = null) {
    const wanted = Number(currentContaId || 0) || null;
    const fromMeta = Number(meta?.account?.meli_conta_id || 0) || null;
    if (!wanted || !fromMeta) return false;
    return wanted === fromMeta;
  }

  async _cancelOpenJobsForAccount(account, { reason = "superseded" } = {}) {
    const currentContaId = Number(account?.meli_conta_id || 0) || null;
    if (!currentContaId) return;

    const jobs = await this.queue
      .getJobs(["active", "waiting", "delayed"], 0, 100, false)
      .catch(() => []);

    for (const job of jobs) {
      const jobId = String(job?.id || "");
      if (!jobId) continue;

      const meta =
        (await this._readMeta(jobId)) ||
        this._fallbackMetaFromJob(job) ||
        {};
      if (!this._canAccess(meta, currentContaId)) continue;
      const kind = String(meta?.kind || job?.data?.kind || "").trim();
      if (!shouldSupersedeOpenJob({ kind })) continue;

      const state = await job.getState().catch(() => "unknown");
      if (state === "waiting" || state === "delayed") {
        await job.remove().catch(() => {});
        await this._writeMeta(jobId, {
          status: "cancelado",
          cancel_requested: false,
          cancel_reason: reason,
          finished_at: new Date().toISOString(),
        });
        continue;
      }

      if (state === "active") {
        const updatedAtMs = meta?.updated_at ? Date.parse(meta.updated_at) : 0;
        const ageMs = updatedAtMs ? Date.now() - updatedAtMs : Infinity;
        const rawProgress = Math.round(Number(job?._progress || 0));
        await this._writeMeta(jobId, {
          status: "cancelando",
          cancel_requested: true,
          cancel_reason: reason,
        });
        if (rawProgress >= 100 || ageMs > STALE_ACTIVE_JOB_MS) {
          await this._forceCancelStaleJob(job, jobId, {
            reason,
            state,
            rawProgress,
            ageMs,
          });
        }
      }
    }
  }

  async _forceCancelStaleJob(job, jobId, details = {}) {
    const safeId = String(jobId || "").trim();
    if (!job || !safeId) return false;

    const message =
      details?.reason === "novo_filtro"
        ? "Consulta anterior substituida por uma nova consulta."
        : "Consulta anterior estava presa e foi cancelada automaticamente.";

    try {
      if (typeof job.moveToFailed === "function") {
        await job.moveToFailed(new JobCancelledError(message), true);
      } else {
        await job.remove();
      }
    } catch (error) {
      try {
        await job.remove();
      } catch {
        console.warn("[FiltroAnunciosQueueService] nao foi possivel remover job stale:", safeId, error?.message || error);
      }
    }

    await this._writeMeta(safeId, {
      status: "cancelado",
      cancel_requested: false,
      cancel_reason: details?.reason || "stale",
      stale_recovered: true,
      stale_details: {
        state: details?.state || null,
        progress: details?.rawProgress ?? null,
        age_ms: Number.isFinite(Number(details?.ageMs)) ? Math.round(Number(details.ageMs)) : null,
      },
      finished_at: new Date().toISOString(),
      progress_phase: "Cancelado",
      progress_current: null,
      progress_total: null,
    });
    return true;
  }

  _fallbackMetaFromJob(job) {
    if (!job?.data?.account) return null;
    return {
      account: job.data.account,
      created_at: new Date(job.timestamp || Date.now()).toISOString(),
      updated_at: new Date(job.processedOn || job.finishedOn || job.timestamp || Date.now()).toISOString(),
    };
  }

  _normalizeQueueStatus(metaStatus, queueState) {
    const meta = String(metaStatus || "").trim().toLowerCase();
    const state = String(queueState || "").trim().toLowerCase();

    if (meta === "cancelando" || meta === "cancelado") return meta;
    if (meta === "concluido" || meta === "erro") return meta;
    if (meta === "completed") return "concluido";
    if (meta === "failed") return "erro";
    if (state === "failed") return "erro";
    if (state === "completed") {
      // Bull can report completed a tick before the final metadata/results are visible.
      // Keep the API in progress until the worker writes the terminal metadata.
      return meta === "aguardando" ? "aguardando" : "processando";
    }
    if (state === "active") return "processando";
    if (state === "waiting" || state === "delayed") {
      return meta === "processando" ? "processando" : "aguardando";
    }

    if (meta === "active") return "processando";
    if (meta === "waiting" || meta === "delayed") return "aguardando";
    return meta || "desconhecido";
  }

  async _reconcileCompletedJob(jobId, job, meta, state, status) {
    if (String(state || "").toLowerCase() !== "completed") {
      return { status, persistedTotal: null, meta };
    }

    const persistedTotal = await this._readPersistedTotal(jobId);
    const kind = String(meta?.kind || job?.data?.kind || "").trim();
    const csvManifest = kind === "csv_export"
      ? await this._readCsvManifest(jobId)
      : null;
    const recovery = reconcileCompletedQueueJob({
      queueState: state,
      status,
      kind,
      persistedTotal,
      csvManifest,
      finishedOn: job?.finishedOn || meta?.finished_at,
      updatedAt: meta?.updated_at || meta?.created_at,
      graceMs: FILTRO_ANUNCIOS_COMPLETION_GRACE_MS,
    });

    if (!recovery) return { status, persistedTotal, meta };

    const patch = {
      status: recovery.status,
      total: recovery.total,
      error: recovery.error,
      errors: recovery.status === "erro" ? 1 : 0,
      progress_phase: recovery.progressPhase,
      progress_current: recovery.total,
      progress_total: recovery.total,
      finished_at: meta?.finished_at || new Date().toISOString(),
      terminal_recovered: true,
    };
    if (recovery.downloadReady) {
      patch.download_csv_url = `/api/analytics/filtro-anuncios/jobs/${encodeURIComponent(String(jobId))}/download.csv`;
    }
    await this._writeMeta(jobId, patch);
    return {
      status: recovery.status,
      persistedTotal: recovery.total,
      meta: { ...meta, ...patch },
    };
  }

  async _mapJob(jobId, job = null, meta = null) {
    const currentJob = job || (await this.queue.getJob(String(jobId)));
    let currentMeta =
      meta || (await this._readMeta(jobId)) || this._fallbackMetaFromJob(currentJob) || {};
    const state = currentJob
      ? await currentJob.getState().catch(() => "unknown")
      : "missing";
    let status = this._normalizeQueueStatus(currentMeta.status, state);

    const rawProgress = currentJob ? Number(currentJob._progress || 0) : 0;
    const reconciliation = await this._reconcileCompletedJob(
      jobId,
      currentJob,
      currentMeta,
      state,
      status
    );
    status = reconciliation.status;
    currentMeta = reconciliation.meta;
    let persistedTotal = reconciliation.persistedTotal;
    const terminal =
      status === "concluido" || status === "erro" || status === "cancelado";
    const progress = terminal
      ? 100
      : Math.max(0, Math.min(100, Math.round(rawProgress)));
    const rawCount =
      currentMeta.total ??
      currentJob?.returnvalue?.total ??
      currentJob?.returnvalue?.result?.total ??
      null;
    let count = Number.isFinite(Number(rawCount)) ? Number(rawCount) : null;
    if (count == null && Number.isFinite(persistedTotal)) {
      count = Number(persistedTotal);
    }
    let persistedResultTotal = null;
    if (status === "concluido" || status === "erro") {
      if (!Number.isFinite(persistedTotal)) {
        persistedTotal = await this._readPersistedTotal(jobId);
      }
      if (Number.isFinite(persistedTotal)) {
        persistedResultTotal = Number(persistedTotal);
        if (count == null) {
          count = persistedResultTotal;
        }
      }
    }
    const errorMessage =
      currentMeta.error ||
      currentJob?.failedReason ||
      (status === "erro" ? "erro" : null);
    const progressPhase = String(currentMeta.progress_phase || "").trim() || null;
    const phaseLooksRunning =
      !!progressPhase &&
      !/^(aguardando|na fila|pending|waiting)$/i.test(progressPhase);
    if (status === "aguardando" && !terminal && (rawProgress > 0 || phaseLooksRunning)) {
      status = "processando";
    }
    const progressCurrent = toProgressCount(currentMeta.progress_current);
    const progressTotal = toProgressCount(currentMeta.progress_total);
    const hasProgressCounts =
      progressCurrent !== null && progressTotal !== null && progressTotal > 0;
    const processingState = progressPhase
      ? hasProgressCounts
        ? `${progressPhase}... ${progressCurrent}/${progressTotal}`
        : `${progressPhase}... ${progress}%`
      : `processando ${progress}%`;
    const liveTotal =
      status === "concluido"
        ? count
        : progressTotal !== null
          ? progressTotal
          : count;

    const kind = String(currentMeta.kind || currentJob?.data?.kind || "").trim();
    const title =
      currentMeta.title ||
      (kind === "csv_export"
        ? "Exportacao CSV enriquecida"
        : "Filtro de anuncios");
    const downloadCsvUrl =
      (status === "concluido" ? currentMeta.download_csv_url : null) ||
      (kind === "csv_export" && status === "concluido"
        ? `/api/analytics/filtro-anuncios/jobs/${encodeURIComponent(String(jobId))}/download.csv`
        : null);

    return {
      id: String(jobId),
      kind: kind || "query",
      title,
      state:
        status === "aguardando"
          ? "aguardando"
          : status === "cancelando"
            ? "cancelando"
          : status === "cancelado"
            ? "cancelado"
            : status === "concluido"
                ? count == null
                  ? "concluido"
                  : `concluido: ${count} resultado(s)`
                : status === "erro"
                  ? errorMessage || "erro"
                  : processingState,
      status,
      progress,
      processed: progressCurrent,
      total: liveTotal,
      result_total: persistedResultTotal,
      has_results: Number.isFinite(persistedResultTotal) && persistedResultTotal > 0,
      progress_phase: progressPhase,
      progress_current: progressCurrent,
      progress_total: progressTotal,
      errors: status === "erro" ? Math.max(1, Number(currentMeta.errors || 0)) : 0,
      error: errorMessage || null,
      created_at:
        currentMeta.created_at ||
        (currentJob?.timestamp ? new Date(currentJob.timestamp).toISOString() : new Date().toISOString()),
      updated_at:
        currentMeta.updated_at ||
        currentMeta.finished_at ||
        (currentJob?.finishedOn ? new Date(currentJob.finishedOn).toISOString() : null) ||
        (currentJob?.processedOn ? new Date(currentJob.processedOn).toISOString() : null) ||
        currentMeta.created_at ||
        new Date().toISOString(),
      completed: terminal,
      account: currentMeta.account || currentJob?.data?.account || null,
      cancelable: !terminal,
      result: terminal ? { total: count } : null,
      download_csv_url: downloadCsvUrl,
      warnings: Array.isArray(currentMeta.warnings) ? currentMeta.warnings : [],
      ...variationGtinStatusFields(currentMeta),
      sales_truncated: currentMeta.sales_truncated === true,
      review_action:
        downloadCsvUrl && status === "concluido"
          ? {
              type: "download_csv",
              label: kind === "csv_export" ? "Baixar CSV" : "Gerar CSV",
              url: downloadCsvUrl,
              download: true,
            }
          : null,
    };
  }

  _setupProcessor() {
    if (this.workerStarted) return;
    this.workerStarted = true;

    this.queue.process("export", 1, async (job) => {
      const { token, filters, account, mlCreds } = job.data;
      const jobId = String(job.id);

      console.log(
        "[FiltroAnunciosQueueService] processor picked job:",
        jobId,
        {
          account: account || null,
          has_period: hasCommercialPeriod(filters),
          include_visits: !!filters?.include_visits,
          include_ads: !!filters?.include_ads,
          include_category: !!filters?.include_category,
          include_promos: !!filters?.include_promos,
        }
      );

      await this._writeMeta(jobId, {
        job_id: jobId,
        status: "processando",
        created_at: new Date().toISOString(),
        filters,
        account: account || null,
        progress_phase: "Preparando consulta",
        progress_current: null,
        progress_total: null,
      });

      let lastProgressMetaWriteAt = 0;
      let lastProgressMetaSig = "";
      const publishProgressMeta = async ({
        phase = null,
        current = null,
        total = null,
        force = false,
      } = {}) => {
        const safePhase = phase ? String(phase).trim() : null;
        const safeCurrent = toProgressCount(current);
        const safeTotal = toProgressCount(total);
        const sig = `${safePhase || ""}|${safeCurrent ?? ""}|${safeTotal ?? ""}`;
        const now = Date.now();
        if (!force) {
          if (sig === lastProgressMetaSig && now - lastProgressMetaWriteAt < 1200) return;
          if (now - lastProgressMetaWriteAt < 320) return;
        }
        lastProgressMetaWriteAt = now;
        lastProgressMetaSig = sig;
        await this._writeMeta(jobId, {
          progress_phase: safePhase,
          progress_current: safeCurrent,
          progress_total: safeTotal,
        });
      };

      try {
        await this._throwIfCancelled(jobId);
        await updateJobProgress(job, 2);
        await publishProgressMeta({ phase: "Autenticando", force: true });
        const commercialPeriodOn = hasCommercialPeriod(filters);
        const authState = await prepareJobAuthState({ token, mlCreds });

        const sellerProfile = await getSellerProfile(authState);
        const sellerId = sellerProfile?.id;
        if (!sellerId) throw new Error("Nao foi possivel identificar o seller.");
        await this._throwIfCancelled(jobId);
        await updateJobProgress(job, 6);
        await publishProgressMeta({ phase: "Carregando anuncios ativos", force: true });

        const wantedStatus = String(filters.status || "all");
        const statuses =
          wantedStatus === "all" ? ["active", "paused"] : [wantedStatus];

        let lookupType = normalizeLookupType(filters?.lookup_type || "sku");
        let skuTerms = parseSkuQueryList(filters?.sku_query);
        let skuSearchTerms = lookupType === "sku" ? parseSkuSearchTerms(filters?.sku_query) : [];
        const identifierTerms =
          lookupType === "ean" ? parseIdentifierQueryList(filters?.sku_query) : [];
        const rawLookupTerms = parseSkuSearchTerms(filters?.sku_query);
        const accountKey = resolveAccountKeyForCatalog(account, mlCreds);
        let allIds = [];
        let usedCatalogFastPath = false;

        const fetchAllIdsFromAccount = async (phaseOverride = null) => {
          const idsFromAccount = [];
          for (let index = 0; index < statuses.length; index++) {
            await this._throwIfCancelled(jobId);
            const st = statuses[index];
            const ids = await fetchAllItemIds({
              token,
              authState,
              sellerId,
              status: st,
              onProgress: ({ count, total }) => {
                const baseStart = progressValue(6, 14, index, statuses.length);
                const baseEnd = progressValue(6, 14, index + 1, statuses.length);
                const current = total ? Math.min(count, total) : count;
                updateJobProgress(
                  job,
                  progressValue(baseStart, baseEnd, current, total || Math.max(1, current))
                );
                publishProgressMeta({
                  phase:
                    phaseOverride ||
                    (st === "paused"
                      ? "Carregando anuncios pausados"
                      : "Carregando anuncios ativos"),
                  current,
                  total: total || null,
                }).catch(() => {});
              },
            });
            idsFromAccount.push(...ids);
          }
          return idsFromAccount;
        };

        if (lookupType === "mlb" && rawLookupTerms.length) {
          const sourceMlbs = unique(
            rawLookupTerms
              .map((term) => upper(term))
              .filter((term) => /^MLB\d{6,}$/.test(term))
          );
          if (!sourceMlbs.length) {
            throw new Error("Informe ao menos um MLB valido para localizar o SKU.");
          }

          await publishProgressMeta({ phase: "Identificando SKU pelo MLB", force: true });
          const sourceItems = [];
          const sourceBatches = chunk(sourceMlbs, 20);
          for (let i = 0; i < sourceBatches.length; i++) {
            await this._throwIfCancelled(jobId);
            const part = await fetchItemsBatch({
              token,
              authState,
              ids: sourceBatches[i],
            });
            sourceItems.push(...part);
          }

          const resolvedSkus = unique(
            sourceItems.flatMap((item) =>
              String(extractSkuFromItem(item) || "")
                .split("|")
                .map((part) => part.trim())
                .filter(Boolean)
            )
          );
          if (!resolvedSkus.length) {
            throw new Error("Nao foi possivel identificar SKU no MLB informado.");
          }

          lookupType = "sku";
          skuSearchTerms = resolvedSkus;
          skuTerms = parseSkuQueryList(resolvedSkus.join(","));
          filters.lookup_type = "sku";
          filters.sku_query = resolvedSkus.join(",");
          await this._writeMeta(jobId, {
            filters: { ...filters },
            resolved_lookup: {
              type: "mlb",
              source_mlbs: sourceMlbs,
              resolved_skus: resolvedSkus,
            },
          });
        }

        if (lookupType === "sku" && skuTerms.length) {
          await publishProgressMeta({ phase: "Buscando SKU no catalogo local", force: true });
          const catalogLookup = await fetchCatalogItemIdsBySku({
            accountKey,
            skuTerms,
            status: wantedStatus,
          });
          if (catalogLookup?.ids?.length) {
            allIds.push(...catalogLookup.ids);
            usedCatalogFastPath = true;
            await publishProgressMeta({
              phase: "SKU localizado no catalogo local",
              current: catalogLookup.ids.length,
              total: catalogLookup.ids.length,
              force: true,
            });
            await this._writeMeta(jobId, {
              lookup_source: "sku_catalog",
              sku_catalog_run: catalogLookup.run || null,
            });
          }
        }

        if (usedCatalogFastPath && skuSearchTerms.length) {
          await publishProgressMeta({ phase: "Complementando SKU na origem", force: true });
          for (const st of statuses) {
            for (const sku of skuSearchTerms) {
              await this._throwIfCancelled(jobId);
              const variants = buildSellerSkuSearchVariants(sku);
              for (const variant of variants) {
                let directIds = [];
                for (const searchParam of ["seller_sku", "sku"]) {
                  directIds = await fetchItemIdsBySellerSku({
                    token,
                    authState,
                    sellerId,
                    status: st,
                    sku: variant,
                    searchParam,
                  });
                  if (directIds.length) break;
                }
                if (directIds.length) {
                  allIds.push(...directIds);
                  break;
                }
              }
            }
          }
        }

        if (!usedCatalogFastPath) {
          if ((lookupType === "sku" || lookupType === "mlb") && skuSearchTerms.length) {
            let skuSearchErrors = 0;
            let skuSearchAttempts = 0;
            let stage = 0;
            const stagesTotal = Math.max(1, statuses.length * skuSearchTerms.length);

            for (let s = 0; s < statuses.length; s++) {
              const st = statuses[s];

              for (let k = 0; k < skuSearchTerms.length; k++) {
                await this._throwIfCancelled(jobId);
                const sku = skuSearchTerms[k];
                skuSearchAttempts += 1;

                try {
                  await debugSkuLookupTotals({
                    token,
                    authState,
                    sellerId,
                    sku,
                    status: st,
                  });
                  const variants = buildSellerSkuSearchVariants(sku);
                  let ids = [];
                  for (const variant of variants) {
                    for (const searchParam of ["seller_sku", "sku"]) {
                      ids = await fetchItemIdsBySellerSku({
                        token,
                        authState,
                        sellerId,
                        status: st,
                        sku: variant,
                        searchParam,
                        onProgress: ({ current, total }) => {
                          const baseStart = progressValue(6, 14, stage, stagesTotal);
                          const baseEnd = progressValue(6, 14, stage + 1, stagesTotal);
                          updateJobProgress(
                            job,
                            progressValue(baseStart, baseEnd, current, total || 1)
                          );
                          publishProgressMeta({
                            phase: "Buscando SKU na origem",
                            current,
                            total,
                          }).catch(() => {});
                        },
                      });
                      if (ids.length) break;
                    }
                    if (ids.length) break;
                  }
                  allIds.push(...ids);
                } catch (e) {
                  skuSearchErrors += 1;
                  console.warn(
                    "[FiltroAnunciosQueueService] falha pontual na busca por SKU na origem:",
                    e?.message || e
                  );
                }

                stage += 1;
              }
            }

            const allSkuLookupsFailed =
              skuSearchAttempts > 0 &&
              skuSearchErrors >= skuSearchAttempts &&
              allIds.length === 0;
            const accountIds = await fetchAllIdsFromAccount(
              allSkuLookupsFailed
                ? "Verificando SKU nos atributos"
                : "Complementando SKU nos atributos"
            );
            allIds.push(...accountIds);
          } else if (identifierTerms.length) {
            allIds = await fetchAllIdsFromAccount("Verificando EAN/GTIN nos atributos");
          } else {
            allIds = await fetchAllIdsFromAccount();
          }
        }
        allIds = Array.from(new Set(allIds));

        if (
          !usedCatalogFastPath &&
          allIds.length &&
          ((lookupType === "ean" && identifierTerms.length) || skuTerms.length)
        ) {
          await publishProgressMeta({
            phase:
              lookupType === "ean"
                ? "Filtrando EAN nos detalhes leves"
                : "Filtrando SKU nos detalhes leves",
            current: 0,
            total: allIds.length,
            force: true,
          });
          const lightItems = await fetchItemBatches({
            token,
            authState,
            ids: allIds,
            attributes: LIGHT_LOOKUP_ITEM_ATTRIBUTES,
            concurrency: ML_ITEMS_DETAIL_CONCURRENCY,
            checkCancelled: () => this._throwIfCancelled(jobId),
            onBatch: ({ completed, total, ids_count }) => {
              updateJobProgress(job, progressValue(14, 25, completed, total));
              publishProgressMeta({
                phase:
                  lookupType === "ean"
                    ? "Filtrando EAN nos detalhes leves"
                    : "Filtrando SKU nos detalhes leves",
                current: Math.min(completed * ML_ITEMS_BATCH_SIZE, ids_count),
                total: ids_count,
              }).catch(() => {});
            },
          });
          const dateToForLightLookup = String(filters.date_to || "").trim();
          allIds = unique(
            lightItems
              .filter((item) => {
                const created = datePart(item?.date_created);
                if (commercialPeriodOn && dateToForLightLookup && created && created > dateToForLightLookup) {
                  return false;
                }
                if (lookupType === "ean" && identifierTerms.length) {
                  return itemMatchesIdentifierQuery(item, identifierTerms);
                }
                return itemMatchesSkuQuery(item, skuTerms);
              })
              .map((item) => upper(item?.id))
          );
          await this._writeMeta(jobId, {
            lookup_source: lookupType === "ean" ? "light_ean_scan" : "light_sku_scan",
          });
        }

        await updateJobProgress(job, 15);
        await publishProgressMeta({
          phase: "Carregando detalhes dos anuncios",
          current: 0,
          total: allIds.length,
          force: true,
        });

        const itemToParent = new Map();
        const byMlb = new Map();
        const dateTo = String(filters.date_to || "").trim();

        const ingestDetailItem = (it) => {
            const itemId = upper(it?.id);
            if (!itemId) return;

            const parentId = upper(it?.parent_item_id) || itemId;
            itemToParent.set(itemId, parentId);
            if (!itemToParent.has(parentId)) itemToParent.set(parentId, parentId);
            const created = datePart(it?.date_created);
            if (commercialPeriodOn && dateTo && created && created > dateTo) return;
            const extractedSku = extractSkuFromItem(it);
            const extractedIdentifiers = extractIdentifiersFromItem(it);
            const stockSnapshot = resolveListingStock(it);
            const variationDetails = buildVariationDetails(
              it,
              extractedSku,
              extractedIdentifiers
            );

            const row = {
              mlb: parentId,
              item_id: itemId,
              parent_item_id: parentId !== itemId ? parentId : null,
              date_created: created || null,
              status: it?.status || null,
              category_id: it?.category_id || null,
              category_name: null,
              category_path: null,
              sku: extractedSku,
              gtin: extractedIdentifiers[0] || null,
              gtin_values: extractedIdentifiers,
              title: it?.title || "",
              listing_type_id: it?.listing_type_id || null,
              current_price_cents: Math.round(Number(it?.price || 0) * 100),
              original_price_cents:
                it?.original_price === null || it?.original_price === undefined
                  ? null
                  : Math.round(Number(it.original_price || 0) * 100),
              sold_quantity_total:
                it?.sold_quantity === null || it?.sold_quantity === undefined
                  ? null
                  : Number(it.sold_quantity || 0),
              stock_total: stockSnapshot.total,
              stock_source: stockSnapshot.source,
              stock_variations_count: stockSnapshot.variationsCount,
              variation_details: variationDetails,
              related_item_ids: [itemId],
              sku_values: extractedSku ? [extractedSku] : [],
              ean_values: extractedIdentifiers,
              tipo: mapTipo(it?.listing_type_id),
              catalog_listing: !!it?.catalog_listing,
              detalhes: mapDetalhes(it),
              shipping_free: !!it?.shipping?.free_shipping,
              envio: mapEnvio(it?.shipping),
              sales_units: 0,
              sold_value_cents: 0,
              gross_sales_units: 0,
              gross_sold_value_cents: 0,
              refunded_sales_units: 0,
              refunded_value_cents: 0,
              visits: null,
              ultima_venda: null,
              sales_after_units: 0,
              sales_after_value_cents: 0,
              ads_in_campaign: null,
              ads_status: null,
              ads_clicks: null,
              ads_impressions: null,
              ads_spend_cents: null,
              ads_revenue_cents: null,
              ads_roas: null,
              promo_active: null,
              promo_pct: null,
              promo_name: null,
              promo_status: null,
              promo_id: null,
              promo_base_price: null,
              promo_current_price: null,
            };

            const cur = byMlb.get(parentId);
            if (!cur) {
              byMlb.set(parentId, row);
            } else {
              if (!cur.date_created || (row.date_created && row.date_created < cur.date_created)) {
                cur.date_created = row.date_created;
              }
              if (!cur.title && row.title) cur.title = row.title;
              if (!cur.sku && row.sku) cur.sku = row.sku;
              if (!cur.gtin && row.gtin) cur.gtin = row.gtin;
              if (!cur.status && row.status) cur.status = row.status;
              if (!cur.category_id && row.category_id) cur.category_id = row.category_id;
              const knownItemIds = Array.isArray(cur.related_item_ids)
                ? cur.related_item_ids
                : [];
              if (!knownItemIds.includes(itemId)) {
                cur.stock_total = toStockInt(cur.stock_total) + toStockInt(row.stock_total);
                cur.stock_variations_count =
                  toStockInt(cur.stock_variations_count) +
                  toStockInt(row.stock_variations_count);
                cur.stock_source =
                  cur.stock_source === "variations" || row.stock_source === "variations"
                    ? "variations"
                    : "item";
              }
              cur.related_item_ids = unique([
                ...knownItemIds,
                itemId,
              ]);
              cur.sku_values = unique([
                ...(Array.isArray(cur.sku_values) ? cur.sku_values : []),
                ...(row.sku ? [row.sku] : []),
              ]);
              cur.gtin_values = unique([
                ...(Array.isArray(cur.gtin_values) ? cur.gtin_values : []),
                ...(Array.isArray(row.gtin_values) ? row.gtin_values : []),
              ]);
              cur.ean_values = unique([
                ...(Array.isArray(cur.ean_values) ? cur.ean_values : []),
                ...(Array.isArray(row.ean_values) ? row.ean_values : []),
              ]);
              cur.variation_details = [
                ...(Array.isArray(cur.variation_details) ? cur.variation_details : []),
                ...(Array.isArray(row.variation_details) ? row.variation_details : []),
              ];
              if ((!cur.sku || !String(cur.sku).trim()) && cur.sku_values.length) {
                cur.sku = cur.sku_values.join(" | ");
              }
              if ((!cur.gtin || !String(cur.gtin).trim()) && cur.gtin_values.length) {
                cur.gtin = cur.gtin_values.join(" | ");
              }
            }
        };

        await fetchItemBatches({
          token,
          authState,
          ids: allIds,
          attributes: FULL_ITEM_ATTRIBUTES,
          concurrency: ML_ITEMS_DETAIL_CONCURRENCY,
          collect: false,
          checkCancelled: () => this._throwIfCancelled(jobId),
          onItems: (items) => {
            for (const it of items) ingestDetailItem(it);
          },
          onBatch: ({ completed, total, ids_count }) => {
            const pct = progressValue(15, 35, completed, total);
            updateJobProgress(job, Math.min(pct, 35));
            publishProgressMeta({
              phase: "Carregando detalhes dos anuncios",
              current: Math.min(completed * ML_ITEMS_BATCH_SIZE, ids_count),
              total: ids_count,
            }).catch(() => {});
          },
        });

        let rows = Array.from(byMlb.values()).filter((r) => r.mlb);
        if (lookupType === "ean" && identifierTerms.length) {
          rows = rows.filter((r) => rowMatchesIdentifierQuery(r, identifierTerms));
        } else if (skuTerms.length) {
          rows = rows.filter((r) => rowMatchesSkuQuery(r, skuTerms));
        }

        const stockOp = String(filters.stock_op || "all").toLowerCase();
        const applyStockFilter = () => {
          if (!stockOp || stockOp === "all") return;
          if (stockOp === "zero") {
            rows = rows.filter((r) => toStockInt(r.stock_total) === 0);
          } else {
            const stockValue = toStockInt(filters.stock_value);
            rows = rows.filter((r) => {
              const stock = toStockInt(r.stock_total);
              if (stockOp === "gt") return stock > stockValue;
              if (stockOp === "lt") return stock < stockValue;
              if (stockOp === "eq") return stock === stockValue;
              return true;
            });
          }
        };

        if (!filters.detail_variations) {
          applyStockFilter();
        }

        if (filters.envio && filters.envio !== "all") {
          rows = rows.filter((r) => {
            if (filters.envio === "free") return r.shipping_free === true;
            if (filters.envio === "buyer") return r.shipping_free === false;
            return true;
          });
        }

        if (filters.tipo && filters.tipo !== "all") {
          rows = rows.filter((r) => {
            const id = String(r.listing_type_id || "").toLowerCase();
            if (filters.tipo === "classic") return id === "gold_special";
            if (filters.tipo === "premium") {
              return id === "gold_pro" || id === "gold_premium";
            }
            return true;
          });
        }

        if (filters.detalhes && filters.detalhes !== "all") {
          rows = rows.filter((r) => {
            if (filters.detalhes === "catalog") return r.catalog_listing === true;
            if (filters.detalhes === "normal") return r.catalog_listing === false;
            return true;
          });
        }

        if (filters.detail_variations) {
          await publishProgressMeta({ phase: "Complementando EAN das variacoes", force: true });
          await this._writeMeta(jobId, {
            variation_gtin_checked: 0,
            variation_gtin_enriched: 0,
            variation_gtin_failed: 0,
            variation_gtin_failure_samples: [],
          });
          const variationGtinResult = await enrichVariationGtins({
            rows,
            token,
            authState,
            checkCancelled: () => this._throwIfCancelled(jobId),
            onProgress: ({ checked, total }) => {
              updateJobProgress(job, progressValue(35, 42, checked, total || 1));
              publishProgressMeta({
                phase: "Complementando EAN das variacoes",
                current: checked,
                total,
              }).catch(() => {});
            },
          });
          await this._writeMeta(jobId, {
            variation_gtin_checked: variationGtinResult.checked,
            variation_gtin_enriched: variationGtinResult.enriched,
            variation_gtin_failed: variationGtinResult.failed,
            variation_gtin_failure_samples: Array.isArray(variationGtinResult.failure_samples)
              ? variationGtinResult.failure_samples
              : [],
          });
        }

        await updateJobProgress(job, 42);
        const commercialWarnings = [];
        const addCommercialWarning = (message) => {
          const text = String(message || "").trim();
          if (text && !commercialWarnings.includes(text)) commercialWarnings.push(text);
        };

        if (commercialPeriodOn) {
          await this._throwIfCancelled(jobId);
          const netSalesMap = await fetchSalesMap({
            token,
            authState,
            sellerId,
            date_from: filters.date_from,
            date_to: filters.date_to,
            itemToParent,
            onProgress: (progress) => {
              const { current, total } = progress || {};
              if (progress?.truncated) {
                addCommercialWarning(
                  `O Mercado Livre limita a leitura de pedidos a ${progress.max_window || ML_ORDERS_SEARCH_MAX_WINDOW} registros por consulta. Use um periodo menor para consolidar 100% das vendas.`
                );
              }
              updateJobProgress(job, progressValue(42, 60, current, total));
              publishProgressMeta({
                phase: "Consolidando vendas no periodo",
                current,
                total,
              }).catch(() => {});
            },
          });
          await this._throwIfCancelled(jobId);
          const grossSalesMap = await fetchSalesMap({
            token,
            authState,
            sellerId,
            date_from: filters.date_from,
            date_to: filters.date_to,
            itemToParent,
            includeOrderStatus: null,
            onProgress: (progress) => {
              const { current, total } = progress || {};
              if (progress?.truncated) {
                addCommercialWarning(
                  `O Mercado Livre limita a leitura de pedidos a ${progress.max_window || ML_ORDERS_SEARCH_MAX_WINDOW} registros por consulta. Use um periodo menor para consolidar 100% das vendas totais.`
                );
              }
              updateJobProgress(job, progressValue(55, 60, current, total));
              publishProgressMeta({
                phase: "Consolidando vendas totais",
                current,
                total,
              }).catch(() => {});
            },
          });
          const salesBreakdownMap = buildSalesBreakdown(netSalesMap, grossSalesMap);

          for (const r of rows) {
            const s = salesBreakdownMap.get(r.mlb) || {
              net_units: 0,
              net_revenue_cents: 0,
              gross_units: 0,
              gross_revenue_cents: 0,
              refunded_units: 0,
              refunded_revenue_cents: 0,
              last_sale: null,
            };
            r.sales_units = s.net_units;
            r.sold_value_cents = s.net_revenue_cents;
            r.gross_sales_units = s.gross_units;
            r.gross_sold_value_cents = s.gross_revenue_cents;
            r.refunded_sales_units = s.refunded_units;
            r.refunded_value_cents = s.refunded_revenue_cents;
            r.ultima_venda = s.last_sale || null;
          }

          if (commercialWarnings.length) {
            await this._writeMeta(jobId, {
              warnings: commercialWarnings,
              sales_truncated: true,
            });
          }

          if (filters.sales_op && filters.sales_op !== "all") {
            const val = Number(filters.sales_value || 0);
            rows = rows.filter((r) => {
              if (filters.sales_op === "gt") return (r.sales_units || 0) > val;
              if (filters.sales_op === "lt") return (r.sales_units || 0) < val;
              return true;
            });
          }
        } else {
          for (const r of rows) {
            r.sales_units = null;
            r.sold_value_cents = null;
            r.gross_sales_units = null;
            r.gross_sold_value_cents = null;
            r.refunded_sales_units = null;
            r.refunded_value_cents = null;
            r.ultima_venda = null;
          }
        }

        await updateJobProgress(job, 60);

        if (commercialPeriodOn && filters.sales_no_sales_after) {
          const v = Number(filters.sales_value || 0);
          const op = String(filters.sales_op || "all");
          const ok = (op === "lt" && v === 1) || v === 0;

          if (ok) {
            await this._throwIfCancelled(jobId);
            await updateJobProgress(job, 62);

            const afterMap = await fetchSalesAfterMap({
              token,
              authState,
              sellerId,
              date_to: filters.date_to,
              itemToParent,
              onProgress: (progress) => {
                const { current, total } = progress || {};
                if (progress?.truncated) {
                  addCommercialWarning(
                    `O filtro "sem vendas apos o periodo" tambem atingiu o limite de ${progress.max_window || ML_ORDERS_SEARCH_MAX_WINDOW} pedidos do Mercado Livre.`
                  );
                }
                updateJobProgress(job, progressValue(62, 72, current, total));
                publishProgressMeta({
                  phase: "Filtrando sem vendas apos o periodo",
                  current,
                  total,
                }).catch(() => {});
              },
            });

            rows = rows.filter((r) => {
              const s = afterMap.get(r.mlb) || { units: 0, revenue_cents: 0 };
              r.sales_after_units = s.units;
              r.sales_after_value_cents = s.revenue_cents;
              return (s.units || 0) === 0;
            });

            if (commercialWarnings.length) {
              await this._writeMeta(jobId, {
                warnings: commercialWarnings,
                sales_truncated: true,
              });
            }
          }
        }

        await updateJobProgress(job, 72);

        if (commercialPeriodOn) {
          for (const r of rows) {
            if (!r.ultima_venda) r.ultima_venda = r.date_created || null;
          }
        }

        if (commercialPeriodOn && filters.include_visits) {
          await this._throwIfCancelled(jobId);
          await updateJobProgress(job, 74);

          const ids = unique(rows.flatMap((r) => getRowLookupIds(r)));
          const visitsMap = await fetchVisitsMap({
            token,
            authState,
            ids,
            date_from: filters.date_from,
            date_to: filters.date_to,
            concurrency: 4,
            onProgress: ({ current, total }) => {
              updateJobProgress(job, progressValue(74, 82, current, total));
              publishProgressMeta({
                phase: "Carregando visitas",
                current,
                total,
              }).catch(() => {});
            },
          });

          for (const r of rows) {
            const visitIds = getRowLookupIds(r);
            r.visits = visitIds.reduce(
              (sum, id) => sum + Number(visitsMap.get(id) ?? 0),
              0
            );
          }
        }

        await updateJobProgress(job, 82);

        if (commercialPeriodOn && filters.include_ads) {
          await this._throwIfCancelled(jobId);
          const ids = unique(rows.flatMap((r) => getRowLookupIds(r)));
          const adsMap = {};
          const adChunks = chunk(ids, 25);
          await publishProgressMeta({
            phase: "Carregando ads",
            current: 0,
            total: ids.length,
            force: true,
          });

          for (let i = 0; i < adChunks.length; i++) {
            await this._throwIfCancelled(jobId);
            let partial = null;
            try {
              partial = await metricsPorItens({
                mlbIds: adChunks[i],
                date_from: filters.date_from,
                date_to: filters.date_to,
                access_token: authState.token || token,
              });
            } catch (error) {
              if (!String(error?.message || error).includes("401")) throw error;
              const renewed = await renewAuthState(authState);
              if (!renewed) throw error;
              partial = await metricsPorItens({
                mlbIds: adChunks[i],
                date_from: filters.date_from,
                date_to: filters.date_to,
                access_token: authState.token || token,
              });
            }
            Object.assign(adsMap, partial || {});
            await updateJobProgress(job, progressValue(82, 92, i + 1, Math.max(1, adChunks.length)));
            await publishProgressMeta({
              phase: "Carregando ads",
              current: Math.min((i + 1) * 25, ids.length),
              total: ids.length,
            });
          }

          for (const r of rows) {
            const relatedAds = getRowLookupIds(r)
              .map((id) => adsMap?.[id] || null)
              .filter(Boolean);

            if (!relatedAds.length) {
              r.ads_in_campaign = false;
              r.ads_status = "none";
              r.ads_clicks = 0;
              r.ads_impressions = 0;
              r.ads_spend_cents = 0;
              r.ads_revenue_cents = 0;
              r.ads_roas = null;
              continue;
            }

            const spendCents = relatedAds.reduce(
              (sum, ads) => sum + Number(ads?.spend_cents || 0),
              0
            );
            const revenueCents = relatedAds.reduce(
              (sum, ads) => sum + Number(ads?.revenue_cents || 0),
              0
            );
            r.ads_in_campaign = relatedAds.some((ads) => !!ads.in_campaign);
            r.ads_status =
              relatedAds.find((ads) => String(ads?.status || "").trim())?.status || "active";
            r.ads_clicks = relatedAds.reduce(
              (sum, ads) => sum + Number(ads?.clicks || 0),
              0
            );
            r.ads_impressions = relatedAds.reduce(
              (sum, ads) => sum + Number(ads?.impressions || 0),
              0
            );
            r.ads_spend_cents = spendCents;
            r.ads_revenue_cents = revenueCents;
            r.ads_roas =
              spendCents > 0 ? Math.round((revenueCents / spendCents) * 100) / 100 : null;
          }
        }

        await updateJobProgress(job, 92);

        if (filters.include_category) {
          await this._throwIfCancelled(jobId);
          await publishProgressMeta({
            phase: "Carregando categorias",
            current: 0,
            total: unique(rows.map((r) => r.category_id).filter(Boolean)).length,
            force: true,
          });
          await enrichRowsWithCategories(rows, {
            token,
            authState,
            throwIfCancelled: () => this._throwIfCancelled(jobId),
            onProgress: ({ current, total }) => {
              updateJobProgress(job, progressValue(92, 96, current, total || 1));
              publishProgressMeta({
                phase: "Carregando categorias",
                current,
                total,
              }).catch(() => {});
            },
          });
        }

        if (filters.include_promos) {
          await this._throwIfCancelled(jobId);
          await updateJobProgress(job, filters.include_category ? 97 : 94);
          const promoItemIds = unique(rows.flatMap((row) => getRowLookupIds(row)));
          await publishProgressMeta({
            phase: "Identificando promocoes",
            current: 0,
            total: promoItemIds.length,
            force: true,
          });
          const promotionsMap = await fetchPromotionsMap({
            token: authState.token || token,
            authState,
            sellerId,
            itemIds: promoItemIds,
            date_from: filters.date_from,
            date_to: filters.date_to,
            throwIfCancelled: () => this._throwIfCancelled(jobId),
            onProgress: ({ current, total }) => {
              updateJobProgress(job, progressValue(94, 98, current, total || 1));
              publishProgressMeta({
                phase: "Identificando promocoes",
                current,
                total,
              }).catch(() => {});
            },
          });
          const promotionalItemIds = Array.from(promotionsMap.keys());
          let exactPromoPricingMap = new Map();
          if (promoItemIds.length) {
            const priceSeedById = buildPromoPriceSeedMap(rows);
            await publishProgressMeta({
              phase: "Confirmando precos promocionais",
              current: 0,
              total: promoItemIds.length,
              force: true,
            });
            exactPromoPricingMap = await fetchAtacadoPromoPricingMap({
              token: authState.token || token,
              authState,
              itemIds: promoItemIds,
              priceSeedById,
              salePriceIds: promoItemIds,
              concurrency: ML_VARIATION_DETAIL_CONCURRENCY,
              throwIfCancelled: () => this._throwIfCancelled(jobId),
              onProgress: ({ current, total }) => {
                updateJobProgress(job, progressValue(96, 98, current, total || 1));
                publishProgressMeta({
                  phase: "Confirmando precos promocionais",
                  current,
                  total,
                }).catch(() => {});
              },
            });
          }
          applyPromotionSnapshot(rows, promotionsMap, exactPromoPricingMap);
          const exactPromoActiveIds = Array.from(exactPromoPricingMap.entries())
            .filter(([, promo]) => promo?.promo_active === true)
            .map(([id]) => id);
          const totalPromoActiveIds = new Set([
            ...promotionalItemIds,
            ...exactPromoActiveIds,
          ]);
          await this._writeMeta(jobId, {
            promo_items_checked: promoItemIds.length,
            promo_items_active: totalPromoActiveIds.size,
            promo_items_active_from_campaigns: promotionalItemIds.length,
            promo_prices_checked: promoItemIds.length,
            promo_prices_confirmed: exactPromoActiveIds.length,
            promo_snapshot_ready: true,
          });
          await publishProgressMeta({
            phase: "Promocoes carregadas",
            current: totalPromoActiveIds.size,
            total: promoItemIds.length,
            force: true,
          });
          await updateJobProgress(job, 98);
        }

        await publishProgressMeta({ phase: "Finalizando base consultada", force: true });
        await updateJobProgress(job, 98);

        if (filters.detail_variations) {
          rows = expandRowsByVariations(rows);
          if (lookupType === "ean" && identifierTerms.length) {
            rows = rows.filter((r) => rowMatchesIdentifierQuery(r, identifierTerms));
          } else if (skuTerms.length) {
            rows = rows.filter((r) => rowMatchesSkuQuery(r, skuTerms));
          }
          applyStockFilter();
        }

        const dir =
          String(filters.sort_dir || "desc").toLowerCase() === "asc" ? 1 : -1;
        const by = String(filters.sort_by || "sold_value");

        rows.sort((a, b) => {
          if (lookupType === "sku" && skuTerms.length) {
            const skuCmp = compareRowsBySkuFamily(a, b, skuTerms);
            if (skuCmp) return skuCmp;
          }
          if (by === "title") {
            return dir * String(a.title || "").localeCompare(String(b.title || ""));
          }
          if (by === "sales_units") {
            return dir * ((a.sales_units || 0) - (b.sales_units || 0));
          }
          return dir * ((a.sold_value_cents || 0) - (b.sold_value_cents || 0));
        });

        await this._writeResults(jobId, rows);

        await this._writeMeta(jobId, {
          status: "concluido",
          total: rows.length,
          progress_phase: "Concluido",
          progress_current: rows.length,
          progress_total: rows.length,
          finished_at: new Date().toISOString(),
          seller_id: sellerId,
        });

        await updateJobProgress(job, 100);
        return { total: rows.length };
      } catch (e) {
        if (e instanceof JobCancelledError) {
          await this._writeMeta(jobId, {
            status: "cancelado",
            error: null,
            cancel_requested: false,
            progress_phase: "Cancelado",
            finished_at: new Date().toISOString(),
          });
          await updateJobProgress(job, 100);
          return { total: 0, cancelled: true };
        }
        await this._writeMeta(jobId, {
          status: "erro",
          error: e.message || String(e),
          progress_phase: "Erro",
          finished_at: new Date().toISOString(),
        });
        throw e;
      }
    });

    this.queue.process("csv_export", 1, async (job) => {
      const {
        sourceJobId,
        token,
        mlCreds,
        account,
        fields,
        sourceMeta,
        filename,
      } = job.data || {};
      const jobId = String(job.id);
      const sourceId = String(sourceJobId || "").trim();
      const csvFields = Array.isArray(fields) ? fields.filter(Boolean) : [];
      if (!sourceId) throw new Error("Job de origem ausente para gerar CSV.");
      if (!csvFields.length) throw new Error("Campos do CSV ausentes.");

      await this._deleteCsvChunks(jobId);
      await this._writeMeta(jobId, {
        job_id: jobId,
        kind: "csv_export",
        title: "Exportacao CSV enriquecida",
        source_job_id: sourceId,
        status: "processando",
        created_at: new Date().toISOString(),
        account: account || null,
        progress_phase: "Preparando CSV",
        progress_current: 0,
        progress_total: null,
        error: null,
        total: null,
      });

      const chunks = [];
      let currentLines = [`${csvFields.join(";")}\n`];
      let processed = 0;
      let chunkIndex = 0;
      const rowsPerWrite = Math.max(
        100,
        Number(process.env.FILTRO_ANUNCIOS_CSV_ROWS_PER_CHUNK || 1000)
      );
      const progressBatchSize = Math.max(
        50,
        Number(process.env.FILTRO_ANUNCIOS_CSV_PROGRESS_BATCH_SIZE || 250)
      );

      const flush = async (force = false) => {
        if (!force && currentLines.length < rowsPerWrite) return;
        if (!currentLines.length) return;
        const key = this._csvChunkKey(jobId, chunkIndex);
        chunkIndex += 1;
        await this.redis.set(key, currentLines.join(""), "EX", this.ttlSeconds);
        chunks.push(key);
        currentLines = [];
        await this._writeCsvManifest(jobId, {
          ready: false,
          source_job_id: sourceId,
          filename: filename || `${sourceId}_filtro_anuncios.csv`,
          chunks,
          rows: processed,
        });
      };

      try {
        const meta = sourceMeta || (await this._readMeta(sourceId)) || {};
        const total = await this._readPersistedTotal(sourceId);
        await this._writeMeta(jobId, {
          total: Number.isFinite(total) ? total : null,
          progress_total: Number.isFinite(total) ? total : null,
          progress_phase: "Gerando CSV",
        });
        let authState = null;

        await this.forEachResultChunk(sourceId, async (rows) => {
          await this._throwIfCancelled(jobId);
          const workingRows = Array.isArray(rows) ? rows.map((row) => ({ ...row })) : [];
          if (!workingRows.length) return;

          for (let offset = 0; offset < workingRows.length; offset += progressBatchSize) {
            await this._throwIfCancelled(jobId);
            const batch = workingRows.slice(offset, offset + progressBatchSize);
            const unresolvedPromos = meta?.filters?.include_promos
              ? batch.some((row) => !isPromoSnapshotResolved(row))
              : false;

            if (unresolvedPromos) {
              await this._writeMeta(jobId, {
                progress_phase: "Validando promocoes do CSV",
                progress_current: processed,
                progress_total: Number.isFinite(total) ? total : null,
              });
              if (!authState) {
                authState = await prepareJobAuthState({ token, mlCreds });
              }
              await this.applyLivePromoPricing(batch, {
                token: authState?.token || token,
                mlCreds,
                authState,
                salePriceLimit: 0,
              });
            }

            for (const rawRow of batch) {
              const row = enrichRowForCsv(rawRow, meta);
              currentLines.push(`${rowToCsvLine(row, csvFields)}\n`);
              processed += 1;

              if (currentLines.length >= rowsPerWrite) {
                await flush(true);
              }
            }

            await updateJobProgress(
              job,
              Number.isFinite(total) && total > 0
                ? progressValue(1, 99, processed, total)
                : Math.min(99, Math.max(1, Number(job._progress || 0) + 1))
            );
            await this._writeMeta(jobId, {
              progress_phase: "Gerando CSV",
              progress_current: processed,
              progress_total: Number.isFinite(total) ? total : null,
            });
          }
        });

        await flush(true);
        await this._writeCsvManifest(jobId, {
          ready: true,
          source_job_id: sourceId,
          filename: filename || `${sourceId}_filtro_anuncios.csv`,
          chunks,
          rows: processed,
        });
        const downloadUrl = `/api/analytics/filtro-anuncios/jobs/${encodeURIComponent(jobId)}/download.csv`;
        await this._writeMeta(jobId, {
          status: "concluido",
          total: processed,
          progress_phase: "CSV pronto",
          progress_current: processed,
          progress_total: processed,
          finished_at: new Date().toISOString(),
          download_csv_url: downloadUrl,
        });
        await updateJobProgress(job, 100);
        return { total: processed, download_csv_url: downloadUrl };
      } catch (e) {
        if (e instanceof JobCancelledError) {
          await this._writeMeta(jobId, {
            status: "cancelado",
            error: null,
            cancel_requested: false,
            progress_phase: "Cancelado",
            finished_at: new Date().toISOString(),
          });
          await updateJobProgress(job, 100);
          return { total: processed, cancelled: true };
        }
        await this._writeMeta(jobId, {
          status: "erro",
          error: e.message || String(e),
          progress_phase: "Erro",
          progress_current: processed,
          finished_at: new Date().toISOString(),
        });
        throw e;
      }
    });

    this.queue.on("failed", async (job, err) => {
      console.error("[FiltroAnunciosQueueService] job failed:", job?.id, err?.message || err);
      await settleCredits(job?.data?.creditReservation, { release: true });
    });
    this.queue.on("completed", async (job) => {
      console.log("[FiltroAnunciosQueueService] job completed:", job?.id);
      await settleCredits(job?.data?.creditReservation, { release: false });
    });
  }

  initWorker() {
    const wasStarted = this.workerStarted;
    this._setupProcessor();
    if (!wasStarted) {
      console.log("[FiltroAnunciosQueueService] worker iniciado");
    }
    return this.queue;
  }

  async enqueue({ token, filters, account, mlCreds = null, cancelOpenJobs = true }) {
    const creditReservation = await reserveAdsFilterCredits({
      mlCreds,
      account,
      filters,
    });

    if (cancelOpenJobs !== false) {
      await this._cancelOpenJobsForAccount(account, { reason: "novo_filtro" });
    }

    let job;
    try {
      job = await this.queue.add(
        "export",
        {
          token,
          filters,
          account: account || null,
          mlCreds: mlCreds || null,
          creditReservation,
        },
        { attempts: 1, removeOnComplete: 50, removeOnFail: 50 }
      );
    } catch (error) {
      await settleCredits(creditReservation, { release: true });
      throw error;
    }

    const jobId = String(job.id);

    console.log("[FiltroAnunciosQueueService] enqueue job:", jobId, {
      account: account || null,
      has_period: hasCommercialPeriod(filters),
      include_visits: !!filters?.include_visits,
      include_ads: !!filters?.include_ads,
      include_category: !!filters?.include_category,
      include_promos: !!filters?.include_promos,
    });

    await this._writeMeta(jobId, {
      job_id: jobId,
      status: "aguardando",
      created_at: new Date().toISOString(),
      filters: filters || null,
      account: account || null,
      total: null,
      progress_phase: "Aguardando",
      progress_current: null,
      progress_total: null,
      error: null,
      seller_id: null,
      credit_reservation: {
        operation_key: creditReservation?.operation_key || null,
        reserved_credits: creditReservation?.reserved_credits || 0,
        bypass: Boolean(creditReservation?.bypass),
      },
    });
    return jobId;
  }

  async enqueueCsvExport({
    sourceJobId,
    token,
    mlCreds = null,
    account = null,
    fields = [],
    sourceMeta = null,
    filename = null,
  }) {
    const sourceId = String(sourceJobId || "").trim();
    if (!sourceId) throw new Error("Job de origem ausente para exportar CSV.");

    const requestedFields = Array.isArray(fields) ? fields.filter(Boolean) : [];
    const currentContaId = Number(account?.meli_conta_id || 0) || null;
    const openJobs = await this.queue
      .getJobs(["active", "waiting", "delayed"], 0, 100, false)
      .catch(() => []);
    for (const openJob of openJobs) {
      const openData = openJob?.data || {};
      if (String(openData.kind || "").trim() !== "csv_export") continue;
      if (!sameCsvExportRequest(
        { sourceJobId: openData.sourceJobId, fields: openData.fields },
        { sourceJobId: sourceId, fields: requestedFields }
      )) continue;

      const openMeta = await this._readMeta(String(openJob.id));
      if (currentContaId && !this._canAccess(openMeta || { account: openData.account }, currentContaId)) {
        continue;
      }
      if (openMeta?.cancel_requested || openMeta?.status === "cancelado") continue;
      return String(openJob.id);
    }

    const job = await this.queue.add(
      "csv_export",
      {
        kind: "csv_export",
        sourceJobId: sourceId,
        token,
        mlCreds: mlCreds || null,
        account: account || null,
        fields: requestedFields,
        sourceMeta: sourceMeta || null,
        filename: filename || `${sourceId}_filtro_anuncios.csv`,
      },
      { attempts: 1, removeOnComplete: 50, removeOnFail: 50 }
    );

    const jobId = String(job.id);
    await this._writeMeta(jobId, {
      job_id: jobId,
      kind: "csv_export",
      title: "Exportacao CSV enriquecida",
      source_job_id: sourceId,
      status: "aguardando",
      created_at: new Date().toISOString(),
      account: account || null,
      total: null,
      progress_phase: "Aguardando",
      progress_current: null,
      progress_total: null,
      error: null,
      download_csv_url: null,
    });
    return jobId;
  }

  async getStatus(jobId, { currentContaId = null } = {}) {
    const job = await this.queue.getJob(String(jobId));
    let meta =
      (await this._readMeta(jobId)) || this._fallbackMetaFromJob(job) || null;
    if (!meta || !this._canAccess(meta, currentContaId)) return null;
    const state = job ? await job.getState().catch(() => "unknown") : "missing";
    let status = this._normalizeQueueStatus(meta.status, state);
    let total =
      meta.total ??
      job?.returnvalue?.total ??
      job?.returnvalue?.result?.total ??
      null;
    const reconciliation = await this._reconcileCompletedJob(
      jobId,
      job,
      meta,
      state,
      status
    );
    status = reconciliation.status;
    meta = reconciliation.meta;
    if (Number.isFinite(reconciliation.persistedTotal)) {
      total = reconciliation.persistedTotal;
    }
    const terminal =
      status === "concluido" || status === "erro" || status === "cancelado";
    const progress = terminal
      ? 100
      : job
        ? Math.max(0, Math.min(100, Math.round(Number(job._progress || 0))))
        : 0;
    let persistedResultTotal = null;
    if (status === "concluido" || status === "erro") {
      const persistedTotal = Number.isFinite(reconciliation.persistedTotal)
        ? reconciliation.persistedTotal
        : await this._readPersistedTotal(jobId);
      if (Number.isFinite(persistedTotal)) {
        persistedResultTotal = Number(persistedTotal);
        if (total == null) {
          total = persistedResultTotal;
        }
      }
    }
    const progressPhase = String(meta.progress_phase || "").trim() || null;
    const phaseLooksRunning =
      !!progressPhase &&
      !/^(aguardando|na fila|pending|waiting)$/i.test(progressPhase);
    if (status === "aguardando" && !terminal && (progress > 0 || phaseLooksRunning)) {
      status = "processando";
    }
    const progressCurrent = toProgressCount(meta.progress_current);
    const progressTotal = toProgressCount(meta.progress_total);
    const liveTotal =
      status === "concluido"
        ? total
        : progressTotal !== null
          ? progressTotal
          : total;
    const kind = String(meta?.kind || job?.data?.kind || "query").trim() || "query";
    const title =
      meta.title ||
      (kind === "csv_export"
        ? "Exportacao CSV enriquecida"
        : "Filtro de anuncios");
    const downloadCsvUrl =
      (status === "concluido" ? meta.download_csv_url : null) ||
      (kind === "csv_export" && status === "concluido"
        ? `/api/analytics/filtro-anuncios/jobs/${encodeURIComponent(String(jobId))}/download.csv`
        : null);

    return {
      job_id: jobId,
      id: String(jobId),
      kind,
      title,
      status,
      progress,
      processed: progressCurrent,
      total: liveTotal,
      result_total: persistedResultTotal,
      has_results: Number.isFinite(persistedResultTotal) && persistedResultTotal > 0,
      progress_phase: progressPhase,
      progress_current: progressCurrent,
      progress_total: progressTotal,
      error: meta.error || job?.failedReason || null,
      account: meta.account || job?.data?.account || null,
      seller_id: meta.seller_id || null,
      download_csv_url: downloadCsvUrl,
      review_action:
        downloadCsvUrl && status === "concluido"
          ? {
              type: "download_csv",
              label: kind === "csv_export" ? "Baixar CSV" : "Gerar CSV",
              url: downloadCsvUrl,
              download: true,
            }
          : null,
      ...variationGtinStatusFields(meta),
    };
  }

  async getMeta(jobId) {
    const job = await this.queue.getJob(String(jobId));
    return (await this._readMeta(jobId)) || this._fallbackMetaFromJob(job);
  }

  async patchMeta(jobId, patch = {}) {
    const safeId = String(jobId || "").trim();
    if (!safeId || !patch || typeof patch !== "object") return;
    await this._writeMeta(safeId, patch);
  }

  async getResults(jobId) {
    const payload = await this._readJsonKey(this._dataKey(jobId));
    if (Array.isArray(payload)) return payload;
    if (!payload?.__chunked || !Array.isArray(payload.chunks)) return [];

    const rows = [];
    for (const key of payload.chunks) {
      const part = await this._readJsonKey(key);
      if (Array.isArray(part) && part.length) rows.push(...part);
    }
    return rows;
  }

  async getResultsPage(jobId, {
    offset = 0,
    limit = 50,
    predicate = null,
    countUniqueMlb = false,
  } = {}) {
    const safeOffset = Math.max(0, Number(offset || 0));
    const safeLimit = Math.max(1, Number(limit || 50));
    const matches = typeof predicate === "function" ? predicate : () => true;
    const payload = await this._readJsonKey(this._dataKey(jobId));

    if (Array.isArray(payload)) {
      const filtered = payload.filter(matches);
      const uniqueMlbs = countUniqueMlb
        ? new Set(
            filtered
              .map((row) => String(row?.mlb || row?.parent_item_id || row?.item_id || "").trim())
              .filter(Boolean)
          )
        : null;
      return {
        rows: filtered.slice(safeOffset, safeOffset + safeLimit),
        total: filtered.length,
        uniqueMlbTotal: uniqueMlbs ? uniqueMlbs.size : null,
      };
    }

    if (!payload?.__chunked || !Array.isArray(payload.chunks)) {
      return { rows: [], total: 0, uniqueMlbTotal: countUniqueMlb ? 0 : null };
    }

    const pageRows = [];
    const uniqueMlbs = countUniqueMlb ? new Set() : null;
    let total = 0;
    for (const key of payload.chunks) {
      const part = await this._readJsonKey(key);
      if (!Array.isArray(part) || !part.length) continue;
      for (const row of part) {
        if (!matches(row)) continue;
        if (uniqueMlbs) {
          const mlb = String(row?.mlb || row?.parent_item_id || row?.item_id || "").trim();
          if (mlb) uniqueMlbs.add(mlb);
        }
        if (total >= safeOffset && pageRows.length < safeLimit) {
          pageRows.push(row);
        }
        total += 1;
      }
    }

    return { rows: pageRows, total, uniqueMlbTotal: uniqueMlbs ? uniqueMlbs.size : null };
  }

  async forEachResultChunk(jobId, callback) {
    if (typeof callback !== "function") return;
    const payload = await this._readJsonKey(this._dataKey(jobId));

    if (Array.isArray(payload)) {
      await callback(payload);
      return;
    }

    if (!payload?.__chunked || !Array.isArray(payload.chunks)) return;

    for (const key of payload.chunks) {
      const part = await this._readJsonKey(key);
      if (Array.isArray(part) && part.length) {
        await callback(part);
      }
    }
  }

  async getCsvManifest(jobId) {
    return this._readCsvManifest(jobId);
  }

  async streamCsvToResponse(jobId, res) {
    const manifest = await this._readCsvManifest(jobId);
    if (!manifest?.ready || !Array.isArray(manifest.chunks) || !manifest.chunks.length) {
      const error = new Error("CSV ainda nao esta pronto para download.");
      error.status = 409;
      throw error;
    }

    for (const key of manifest.chunks) {
      const chunkText = await this.redis.get(key);
      if (chunkText) res.write(chunkText);
    }
  }

  async updateResults(jobId, rows) {
    await this._writeResults(jobId, Array.isArray(rows) ? rows : []);
  }

  async applyLivePromoPricing(rows, {
    token,
    mlCreds = null,
    authState = null,
    salePriceLimit = 0,
  } = {}) {
    const targetRows = Array.isArray(rows) ? rows : [];
    if (!targetRows.length) return targetRows;
    const unresolvedRows = targetRows.filter((row) => !isPromoSnapshotResolved(row));
    if (!unresolvedRows.length) return targetRows;

    const preparedAuthState = authState || await prepareJobAuthState({ token, mlCreds });
    const ids = unique(unresolvedRows.flatMap((r) => getRowLookupIds(r)));
    if (!ids.length) return targetRows;

    const promoPriceSeedById = buildPromoPriceSeedMap(unresolvedRows);
    const promoInferredIds = ids.filter(
      (id) => Number(promoPriceSeedById.get(id)?.inferredPromoPct || 0) > 0
    );

    let salePriceIds = ids;
    const limit = Number(salePriceLimit || 0);
    if (limit > 0 && ids.length > limit) {
      const inferredSet = new Set(promoInferredIds);
      salePriceIds =
        promoInferredIds.length >= limit
          ? promoInferredIds.slice(0, limit)
          : [...promoInferredIds, ...ids.filter((id) => !inferredSet.has(id))].slice(0, limit);
    }

    const promoMap = await fetchAtacadoPromoPricingMap({
      token: preparedAuthState.token || token,
      authState: preparedAuthState,
      itemIds: ids,
      priceSeedById: promoPriceSeedById,
      salePriceIds,
      concurrency: 6,
      onProgress: null,
      throwIfCancelled: null,
    });

    for (const row of unresolvedRows) {
      const lookupIds = getRowLookupIds(row);
      const promoEntries = lookupIds.map((id) => promoMap.get(id) || null).filter(Boolean);
      const bestEntry =
        promoEntries.sort((a, b) => Number(b?.promo_pct || 0) - Number(a?.promo_pct || 0))[0] ||
        null;

      if (Number(bestEntry?.current_price || 0) > 0) {
        row.current_price_cents = Math.round(Number(bestEntry.current_price || 0) * 100);
      }
      if (Number(bestEntry?.original_price || 0) > 0) {
        row.original_price_cents = Math.round(Number(bestEntry.original_price || 0) * 100);
      }

      const baseCents =
        row.original_price_cents != null && Number(row.original_price_cents) > 0
          ? Number(row.original_price_cents)
          : row.current_price_cents != null && Number(row.current_price_cents) > 0
            ? Number(row.current_price_cents)
            : null;
      const currentCents =
        row.current_price_cents != null && Number(row.current_price_cents) > 0
          ? Number(row.current_price_cents)
          : null;
      const inferredPromoPct =
        baseCents != null && currentCents != null && baseCents > currentCents
          ? round2(((baseCents - currentCents) / baseCents) * 100)
          : null;

      row.promo_active = !!bestEntry?.promo_active || (inferredPromoPct != null && inferredPromoPct > 0);
      row.promo_pct = bestEntry?.promo_pct ?? (row.promo_active ? inferredPromoPct : null);
      row.promo_status = row.promo_active ? bestEntry?.promo_status || "active" : "sem_promocao";
      row.promo_name = row.promo_active ? bestEntry?.promo_name || "Promo atual" : null;
      row.promo_id = row.promo_active ? bestEntry?.promo_id || null : null;
      row.promo_base_price = baseCents != null ? round2(baseCents / 100) : null;
      row.promo_current_price =
        row.promo_active && currentCents != null ? round2(currentCents / 100) : null;
      row.promo_snapshot_source = bestEntry?.promo_source || "sale_price";
    }

    return targetRows;
  }

  async listJobs({ currentContaId = null, limit = 25 } = {}) {
    const jobs = await this.queue.getJobs(
      ["active", "waiting", "delayed", "failed", "completed"],
      0,
      Math.max(0, Number(limit || 25) - 1),
      false
    );

    const mapped = [];
    for (const job of jobs) {
      if (!job || job.id === null || job.id === undefined) {
        continue;
      }
      const jobId = String(job.id);
      const meta = await this._readMeta(jobId);
      const fallbackMeta =
        meta ||
        (job?.data?.account
          ? {
              account: job.data.account,
              created_at: new Date(job.timestamp || Date.now()).toISOString(),
            }
          : null);
      if (!fallbackMeta || !this._canAccess(fallbackMeta, currentContaId)) continue;
      mapped.push(await this._mapJob(jobId, job, fallbackMeta));
    }

    return mapped
      .sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0))
      .slice(0, Math.max(1, Number(limit || 25)));
  }

  async getJobDetail(jobId, { currentContaId = null } = {}) {
    const job = await this.queue.getJob(String(jobId));
    const meta =
      (await this._readMeta(jobId)) || this._fallbackMetaFromJob(job) || null;
    if (!meta || !this._canAccess(meta, currentContaId)) return null;
    return this._mapJob(jobId, job, meta);
  }

  async cancelJob(jobId, { currentContaId = null } = {}) {
    const meta = await this._readMeta(jobId);
    if (!meta || !this._canAccess(meta, currentContaId)) return null;

    const job = await this.queue.getJob(String(jobId));
    if (!job) {
      await this._writeMeta(jobId, {
        status: "cancelado",
        cancel_requested: false,
        finished_at: new Date().toISOString(),
      });
      return { ok: true, job_id: String(jobId), status: "cancelado" };
    }

    const state = await job.getState().catch(() => "unknown");
    if (state === "completed" || state === "failed") {
      return { ok: false, job_id: String(jobId), status: state, error: "Job ja finalizado." };
    }

    if (state === "waiting" || state === "delayed") {
      await job.remove();
      await this._writeMeta(jobId, {
        status: "cancelado",
        cancel_requested: false,
        finished_at: new Date().toISOString(),
      });
      return { ok: true, job_id: String(jobId), status: "cancelado" };
    }

    await this._writeMeta(jobId, {
      status: "cancelando",
      cancel_requested: true,
    });

    return { ok: true, job_id: String(jobId), status: "cancelando" };
  }
}

module.exports = new FiltroAnunciosQueueService();
