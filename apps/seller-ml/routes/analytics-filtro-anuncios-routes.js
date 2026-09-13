"use strict";

const express = require("express");
const { createAuditAction } = require("../middleware/auditAction");

const router = express.Router();

const filtroQueue = require("../services/filtroAnunciosQueueService");
const TokenService = require("../services/tokenService");
const { attachJobReview } = require("../services/jobReviewHelper");
const {
  attachJobContract,
  backendJobIdFromUid,
} = require("../services/jobContract");

const COMMERCIAL_PERIOD_LIMIT_NO_LOOKUP_DAYS = 90;
const COMMERCIAL_PERIOD_LIMIT_LOOKUP_DAYS = 180;
const COMMERCIAL_PERIOD_LIMIT_ADVANCED_DAYS = 367;

function toInt(v, def = 0) {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : def;
}

function toNum(v, def = 0) {
  const n = Number(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : def;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function toBool(v, def = false) {
  if (v === true || v === false) return v;
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return def;
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function isValkeyLoadingError(err) {
  const text = String(err?.message || err?.error || err || "");
  return /\bLOADING\b/i.test(text) && /Valkey|Redis|dataset|memory/i.test(text);
}

function sendValkeyLoading(res, err) {
  return res.status(503).json({
    ok: false,
    transient: true,
    code: "VALKEY_LOADING",
    error:
      "Banco de jobs temporariamente carregando dados em memoria. Tente novamente em alguns segundos.",
    details: err?.message || String(err || ""),
  });
}

function getCurrentContaId(req) {
  const raw =
    req.res?.locals?.mlCreds?.meli_conta_id ||
    req.cookies?.meli_conta_id ||
    null;

  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function getCurrentAccountLabel(req) {
  return req.res?.locals?.accountLabel || req.res?.locals?.accountKey || null;
}

function getCurrentContaNumeric(req) {
  return getCurrentContaId(req);
}

function isoDateStringFromDate(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function daysBetweenInclusive(fromDt, toDt) {
  const from = Date.UTC(
    fromDt.getUTCFullYear(),
    fromDt.getUTCMonth(),
    fromDt.getUTCDate()
  );
  const to = Date.UTC(
    toDt.getUTCFullYear(),
    toDt.getUTCMonth(),
    toDt.getUTCDate()
  );
  return Math.floor((to - from) / 86400000) + 1;
}

function formatIsoAsBr(value) {
  const raw = String(value || "").trim().slice(0, 10);
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return raw;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

function normalizeDateFilterInput(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const br = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return raw;
}

async function resolveCurrentAccessToken(req) {
  if (req.access_token && typeof req.access_token === "string") {
    return req.access_token;
  }

  const creds = req.res?.locals?.mlCreds || null;
  if (!creds) {
    throw new Error("Credenciais da conta atual nao foram carregadas.");
  }
  if (creds.oauth_token_error) {
    throw new Error(`Credenciais OAuth da conta atual nao foram carregadas: ${creds.oauth_token_error}`);
  }

  const token = await TokenService.renovarTokenSeNecessario(creds);
  if (!token || typeof token !== "string") {
    throw new Error("Nao consegui obter token da conta OAuth atual.");
  }

  return token;
}

function buildWorkerMlCreds(req, accessToken = null) {
  const source = req.res?.locals?.mlCreds || {};
  const allowed = [
    "meli_conta_id",
    "meli_user_id",
    "account_key",
    "tenant_id",
    "account_label",
    "billing_status",
    "billing_mode",
    "usage_policy",
    "range_enforcement",
    "billing_plan_code",
    "billing_order_range_code",
    "billing_account",
    "app_id",
    "client_secret",
    "refresh_token",
    "access_token",
    "access_expires_at",
    "redirect_uri",
    "APP_ID",
    "CLIENT_SECRET",
    "REFRESH_TOKEN",
    "ACCESS_TOKEN",
    "ML_APP_ID",
    "ML_CLIENT_SECRET",
    "ML_REFRESH_TOKEN",
    "REDIRECT_URI",
    "ML_REDIRECT_URI",
    "accountKey",
    "accessExpiresAt",
  ];
  const out = {};

  for (const key of allowed) {
    if (source[key] !== undefined && source[key] !== null) {
      out[key] = source[key];
    }
  }

  if (accessToken) out.access_token = accessToken;
  return Object.keys(out).length ? out : null;
}

function parseFiltersFromReq(req) {
  const src = req.body && Object.keys(req.body).length ? req.body : req.query;

  const date_from = normalizeDateFilterInput(src.date_from);
  const date_to = normalizeDateFilterInput(src.date_to);
  const has_period = !!(date_from && date_to);
  const allow_long_period = toBool(src.allow_long_period, false);
  const status = String(src.status || "all").trim();

  const envio = String(src.envio || "all").trim();
  const tipo = String(src.tipo || "all").trim();
  const detalhes = String(src.detalhes || "all").trim();
  const rawStockOp = String(src.stock_op || "all").trim().toLowerCase();
  const stock_op = ["gt", "lt", "eq", "zero"].includes(rawStockOp)
    ? rawStockOp
    : "all";
  const stock_value = stock_op === "zero" || stock_op === "all"
    ? null
    : toInt(src.stock_value, NaN);

  const sales_op = has_period ? String(src.sales_op || "all").trim() : "all";
  const sales_value = has_period ? toNum(src.sales_value ?? src.sales_val ?? 0, 0) : 0;

  let sales_no_sales_after = toBool(src.sales_no_sales_after, false);
  const okNoAfter =
    (sales_op === "lt" && Number(sales_value) === 1) ||
    Number(sales_value) === 0;
  if (!okNoAfter) sales_no_sales_after = false;

  const include_visits = has_period ? toBool(src.include_visits, false) : false;
  const include_ads = has_period ? toBool(src.include_ads, false) : false;
  const include_promos = toBool(src.include_promos, false);
  const include_category = toBool(src.include_category, false);

  const sort_by = String(src.sort_by || "sold_value").trim();
  const sort_dir =
    String(src.sort_dir || "desc").toLowerCase() === "asc" ? "asc" : "desc";
  const lookup_type = normalizeLookupType(src.lookup_type || src.search_type || "sku");
  const sku_query = String(src.sku_query || "").trim();
  const detail_variations = toBool(src.detail_variations, false) || !!sku_query;

  const q = String(src.q || "").trim();

  return {
    date_from,
    date_to,
    has_period,
    allow_long_period,
    status,
    envio,
    tipo,
    detalhes,
    stock_op,
    stock_value,
    sales_op,
    sales_value,
    sales_no_sales_after,
    include_visits,
    include_ads,
    include_promos,
    include_category,
    detail_variations,
    sort_by,
    sort_dir,
    lookup_type,
    sku_query,
    q,
  };
}

function validateRequiredFilters(filters) {
  if (["gt", "lt", "eq"].includes(filters.stock_op)) {
    const n = Number(filters.stock_value);
    if (!Number.isInteger(n) || n < 0) {
      const e = new Error("stock_value invalido. Informe um inteiro maior ou igual a zero.");
      e.status = 400;
      throw e;
    }
  }

  if ((filters.date_from && !filters.date_to) || (!filters.date_from && filters.date_to)) {
    const e = new Error("Informe o periodo completo: date_from e date_to.");
    e.status = 400;
    throw e;
  }

  if (!filters.date_from && !filters.date_to) return;

  const fromDt = parseIsoDateOnly(filters.date_from);
  if (!fromDt) {
    const e = new Error("date_from invalido. Use yyyy-mm-dd.");
    e.status = 400;
    throw e;
  }

  const toDt = parseIsoDateOnly(filters.date_to);
  if (!toDt) {
    const e = new Error("date_to invalido. Use yyyy-mm-dd.");
    e.status = 400;
    throw e;
  }

  const today = new Date();
  const minDate = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  );
  minDate.setUTCFullYear(minDate.getUTCFullYear() - 1);

  if (fromDt < minDate) {
    const e = new Error(
      `date_from fora do limite: maximo 1 ano para tras (minimo ${formatIsoAsBr(
        isoDateStringFromDate(minDate)
      )}).`
    );
    e.status = 400;
    throw e;
  }

  if (toDt < fromDt) {
    const e = new Error("date_to nao pode ser menor que date_from.");
    e.status = 400;
    throw e;
  }

  const periodDays = daysBetweenInclusive(fromDt, toDt);
  const hasLookupTerm = !!String(filters.sku_query || "").trim();
  const normalMaxDays = hasLookupTerm
    ? COMMERCIAL_PERIOD_LIMIT_LOOKUP_DAYS
    : COMMERCIAL_PERIOD_LIMIT_NO_LOOKUP_DAYS;
  const maxDays = filters.allow_long_period
    ? COMMERCIAL_PERIOD_LIMIT_ADVANCED_DAYS
    : normalMaxDays;

  if (periodDays > COMMERCIAL_PERIOD_LIMIT_ADVANCED_DAYS) {
    const e = new Error("Periodo maximo permitido: 1 ano.");
    e.status = 400;
    throw e;
  }

  if (periodDays > maxDays) {
    const detail = hasLookupTerm
      ? "com busca especifica por MLB/SKU/EAN"
      : "sem busca especifica por MLB/SKU/EAN";
    const e = new Error(
      `Periodo de ${periodDays} dias bloqueado: limite normal de ${normalMaxDays} dias ${detail}. ` +
        "Para consultar ate 1 ano, envie allow_long_period=1."
    );
    e.status = 400;
    throw e;
  }
}

function buildEndpoints(jobId) {
  return {
    status_url: `/api/analytics/filtro-anuncios/jobs/${jobId}`,
    items_url: `/api/analytics/filtro-anuncios/jobs/${jobId}/items`,
    download_csv_url: `/api/analytics/filtro-anuncios/jobs/${jobId}/download.csv`,
  };
}

function attachFiltroJobContract(job, options = {}) {
  return attachJobContract(job, {
    module: "filtro-anuncios",
    kind: job?.kind || options.kind || "query",
    ...options,
  });
}

function resolveFiltroBackendJobId(value) {
  return backendJobIdFromUid("filtro-anuncios", value);
}

function csvEscape(v) {
  const s = v === null || v === undefined ? "" : String(v);
  if (/[",\n\r;]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function asFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function resolvePromoSnapshot(row) {
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
    baseCents !== null &&
    currentCents !== null &&
    baseCents > currentCents
      ? Math.round((((baseCents - currentCents) / baseCents) * 100 + Number.EPSILON) * 10) / 10
      : null;

  const explicitActive = row?.promo_active === true;
  const explicitPct = asFiniteNumber(row?.promo_pct);
  const promoActive = explicitActive || (inferredPct !== null && inferredPct > 0);

  const promoPct = promoActive
    ? explicitPct !== null && explicitPct > 0
      ? explicitPct
      : inferredPct
    : null;

  const promoBase =
    asFiniteNumber(row?.promo_base_price) ??
    (baseCents !== null ? baseCents / 100 : null);
  const promoCurrent =
    asFiniteNumber(row?.promo_current_price) ??
    (promoActive && currentCents !== null ? currentCents / 100 : null);

  const promoStatus =
    row?.promo_status || (promoActive ? "active" : "sem_promocao");
  const promoName =
    row?.promo_name || (promoActive ? "Promo atual" : null);

  return {
    active: promoActive,
    pct: promoPct,
    basePrice: promoBase,
    currentPrice: promoCurrent,
    status: promoStatus,
    name: promoName,
    id: row?.promo_id || null,
  };
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

function enrichRowsForCsv(rows, meta) {
  const hasCommercial =
    !!meta?.filters?.date_from && !!meta?.filters?.date_to;

  if (!hasCommercial) return rows;

  return (Array.isArray(rows) ? rows : []).map((row) => ({
    ...row,
    dias_desde_ultima_venda: daysSinceDate(row?.ultima_venda),
  }));
}

function enrichRowsWithPromoSnapshot(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const promo = resolvePromoSnapshot(row);
    return {
      ...row,
      promo_active: promo.active,
      promo_pct: promo.pct,
      promo_base_price: promo.basePrice,
      promo_current_price: promo.currentPrice,
      promo_status: promo.status,
      promo_name: promo.name,
      promo_id: promo.id,
    };
  });
}

function toCSV(rows, fields) {
  const header = fields.join(";");
  const lines = rows.map((r) => fields.map((f) => csvEscape(r?.[f])).join(";"));
  return [header, ...lines].join("\n");
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
  return String(raw || "")
    .split(/[\n,;]+/)
    .map((part) => normalizeSkuToken(part))
    .filter(Boolean);
}

function buildRowSkuTokens(row) {
  const out = [];

  if (row?.sku) {
    String(row.sku)
      .split("|")
      .forEach((part) => {
        const token = normalizeSkuToken(part);
        if (token) out.push(token);
      });
  }

  if (Array.isArray(row?.sku_values)) {
    for (const raw of row.sku_values) {
      const token = normalizeSkuToken(raw);
      if (token) out.push(token);
    }
  }

  return Array.from(new Set(out));
}

function rowMatchesSkuTerms(row, skuTerms) {
  if (!Array.isArray(skuTerms) || !skuTerms.length) return true;
  const rowTokens = buildRowSkuTokens(row);
  if (!rowTokens.length) return false;
  const termTokens = Array.from(
    new Set(
      skuTerms
        .flatMap((term) => [normalizeSkuToken(term), normalizeSkuCompactToken(term)])
        .filter(Boolean),
    ),
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

function normalizeIdentifierToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function parseIdentifierQueryList(raw) {
  return String(raw || "")
    .split(/[\n,;]+/)
    .map((part) => normalizeIdentifierToken(part))
    .filter(Boolean);
}

function buildRowIdentifierTokens(row) {
  const out = [];
  const add = (value) => {
    const token = normalizeIdentifierToken(value);
    if (token) out.push(token);
  };

  add(row?.gtin);
  add(row?.ean);
  add(row?.barcode);
  if (Array.isArray(row?.gtin_values)) row.gtin_values.forEach(add);
  if (Array.isArray(row?.ean_values)) row.ean_values.forEach(add);
  if (Array.isArray(row?.barcode_values)) row.barcode_values.forEach(add);
  return Array.from(new Set(out));
}

function rowMatchesIdentifierTerms(row, terms) {
  if (!Array.isArray(terms) || !terms.length) return true;
  const rowTokens = buildRowIdentifierTokens(row);
  if (!rowTokens.length) return false;
  return rowTokens.some((token) => terms.includes(token));
}

function filterRowsByLookup(rows, { lookupType = "sku", query = "" } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const type = normalizeLookupType(lookupType);
  if (type === "ean") {
    const terms = parseIdentifierQueryList(query);
    return terms.length ? list.filter((r) => rowMatchesIdentifierTerms(r, terms)) : list;
  }
  if (type === "mlb") {
    const terms = String(query || "")
      .split(/[\n,;]+/)
      .map((part) => String(part || "").trim())
      .filter(Boolean);
    return terms.length ? list.filter((r) => rowMatchesLookup(r, { lookupType: type, query })) : list;
  }

  const skuTerms = parseSkuQueryList(query);
  return skuTerms.length ? list.filter((r) => rowMatchesSkuTerms(r, skuTerms)) : list;
}

function rowMatchesLookup(row, { lookupType = "sku", query = "" } = {}) {
  const type = normalizeLookupType(lookupType);
  if (type === "ean") {
    const terms = parseIdentifierQueryList(query);
    return rowMatchesIdentifierTerms(row, terms);
  }
  if (type === "mlb") {
    const terms = String(query || "")
      .split(/[\n,;]+/)
      .map((part) => String(part || "").trim().toUpperCase())
      .filter(Boolean);
    if (!terms.length) return true;
    const ids = [
      row?.mlb,
      row?.item_id,
      row?.parent_item_id,
      ...(Array.isArray(row?.related_item_ids) ? row.related_item_ids : []),
    ]
      .map((id) => String(id || "").trim().toUpperCase())
      .filter(Boolean);
    return ids.some((id) => terms.includes(id));
  }
  const skuTerms = parseSkuQueryList(query);
  return rowMatchesSkuTerms(row, skuTerms);
}

function rowMatchesSearchText(row, q) {
  const term = String(q || "").trim().toLowerCase();
  if (!term) return true;
  const mlb = String(row?.mlb || "").toLowerCase();
  const sku = String(row?.sku || "").toLowerCase();
  const title = String(row?.title || "").toLowerCase();
  const created = String(row?.date_created || "").toLowerCase();
  const lastSale = String(row?.ultima_venda || "").toLowerCase();
  const variationId = String(row?.variation_id || "").toLowerCase();
  const variationName = String(row?.variation_name || "").toLowerCase();
  return (
    mlb.includes(term) ||
    sku.includes(term) ||
    title.includes(term) ||
    created.includes(term) ||
    lastSale.includes(term) ||
    variationId.includes(term) ||
    variationName.includes(term)
  );
}

function buildResultsPredicate({ meta = null, req = null, q = "" } = {}) {
  const lookupType = meta?.filters?.lookup_type || req?.query?.lookup_type || "sku";
  const query = meta?.filters?.sku_query || req?.query?.sku_query || "";
  return (row) =>
    rowMatchesLookup(row, { lookupType, query }) &&
    rowMatchesSearchText(row, q);
}

function normalizeStatus(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "concluído") return "concluido";
  return raw;
}

async function computeLookupFilteredTotalForJob(jobId, filters = {}) {
  const query = filters?.sku_query || "";
  const lookupType = normalizeLookupType(filters?.lookup_type || "sku");
  const hasTerms =
    lookupType === "ean"
      ? parseIdentifierQueryList(query).length > 0
      : lookupType === "mlb"
        ? String(query || "").split(/[\n,;]+/).some((part) => String(part || "").trim())
      : parseSkuQueryList(query).length > 0;
  if (!hasTerms) return null;

  const result = await filtroQueue.getResultsPage(jobId, {
    offset: 0,
    limit: 1,
    predicate: (row) => rowMatchesLookup(row, { lookupType, query }),
  });
  return result.total;
}

function buildLookupFilteredTotalSignature(filters = {}) {
  const query = filters?.sku_query || "";
  const lookupType = normalizeLookupType(filters?.lookup_type || "sku");
  const terms =
    lookupType === "ean"
      ? parseIdentifierQueryList(query)
      : lookupType === "mlb"
        ? String(query || "")
            .split(/[\n,;]+/)
            .map((part) => normalizeIdentifierToken(part))
            .filter(Boolean)
        : parseSkuQueryList(query);

  if (!terms.length) return null;
  return JSON.stringify({ lookup_type: lookupType, terms });
}

function withLookupFilteredTotal(jobLike, total) {
  const filteredTotal = Number(total);
  if (!Number.isFinite(filteredTotal)) return jobLike;

  const next = {
    ...jobLike,
    total: filteredTotal,
    state: `concluido: ${filteredTotal} resultado(s)`,
  };

  if ("count" in next) next.count = filteredTotal;
  if ("count_total" in next) next.count_total = filteredTotal;

  return next;
}

async function applySkuAwareTotal(jobLike, meta) {
  if (!jobLike || typeof jobLike !== "object") return jobLike;

  const status = normalizeStatus(jobLike.status);
  if (status !== "concluido") return jobLike;

  const signature = buildLookupFilteredTotalSignature(meta?.filters || {});
  if (!signature) return jobLike;

  const hasCachedTotal = Object.prototype.hasOwnProperty.call(
    meta || {},
    "lookup_filtered_total"
  );
  const cachedTotal = Number(meta?.lookup_filtered_total);
  if (
    meta?.lookup_filtered_total_signature === signature &&
    hasCachedTotal &&
    Number.isFinite(cachedTotal)
  ) {
    return withLookupFilteredTotal(jobLike, cachedTotal);
  }

  const jobId = String(jobLike.job_id || jobLike.id || "").trim();
  if (!jobId) return jobLike;

  const filteredTotal = await computeLookupFilteredTotalForJob(jobId, meta?.filters || {});
  if (!Number.isFinite(filteredTotal)) return jobLike;

  await filtroQueue.patchMeta(jobId, {
    lookup_filtered_total: filteredTotal,
    lookup_filtered_total_signature: signature,
    lookup_filtered_total_cached_at: new Date().toISOString(),
  }).catch((err) => {
    console.warn(
      "[filtro-anuncios] nao foi possivel salvar lookup_filtered_total:",
      err?.message || err
    );
  });

  return withLookupFilteredTotal(jobLike, filteredTotal);
}

function defaultCsvFields(meta) {
  const filters = meta?.filters || {};
  const hasCommercialPeriod = !!(filters.date_from && filters.date_to);
  const fields = [
    "mlb",
    "sku",
    "gtin",
    "title",
    "date_created",
    "status",
    "parent_item_id",
    "tipo",
    "envio",
    "stock_total",
    "stock_source",
    "stock_variations_count",
  ];

  if (hasCommercialPeriod) {
    fields.push(
      "qnt_vendas_total",
      "valor_venda_total",
      "qnt_vendas_reembolso",
      "valor_reembolso",
      "qnt_vendas",
      "valor_venda",
      "sales_units",
      "sold_value_cents",
      "ultima_venda"
    );
  } else {
    fields.push("current_price_cents", "sold_quantity_total");
  }

  if (filters.detail_variations) {
    fields.push("variation_id", "variation_name");
  }

  if (filters.include_category) {
    fields.push("category_id", "category_name", "category_path");
  }
  if (filters.include_visits) fields.push("visits");
  if (hasCommercialPeriod) {
    fields.push("dias_desde_ultima_venda");
  }
  if (filters.include_ads) {
    fields.push(
      "ads_in_campaign",
      "ads_roas",
      "ads_spend_cents",
      "ads_clicks",
      "ads_impressions",
      "ads_revenue_cents",
      "ads_status",
    );
  }
  if (filters.include_promos) {
    fields.push(
      "promo_base_price",
      "promo_current_price",
      "promo_active",
      "promo_pct",
      "promo_status",
    );
  }
  return fields;
}

async function readJobMeta(jobId) {
  return filtroQueue.getMeta(jobId);
}

async function applyLivePromoPricingIfNeeded(req, rows, meta, { salePriceLimit = 0 } = {}) {
  if (!meta?.filters?.include_promos) return Array.isArray(rows) ? rows : [];
  const targetRows = Array.isArray(rows) ? rows : [];
  if (!targetRows.length) return targetRows;

  const token = await resolveCurrentAccessToken(req);
  await filtroQueue.applyLivePromoPricing(targetRows, {
    token,
    mlCreds: buildWorkerMlCreds(req, token),
    salePriceLimit,
  });
  return targetRows;
}

function assertJobBelongsToCurrentAccount(req, meta) {
  const currentContaId = getCurrentContaId(req);
  const jobContaId = Number(meta?.account?.meli_conta_id || 0) || null;

  if (!jobContaId || !currentContaId) return;

  if (jobContaId !== currentContaId) {
    const e = new Error("Este job pertence a outra conta selecionada.");
    e.status = 409;
    e.details = {
      current_meli_conta_id: currentContaId,
      job_meli_conta_id: jobContaId,
    };
    throw e;
  }
}

async function getValidatedJobMeta(req, jobId) {
  const meta = await readJobMeta(jobId);
  if (!meta) {
    const e = new Error("Metadata do job nao encontrada.");
    e.status = 404;
    throw e;
  }

  assertJobBelongsToCurrentAccount(req, meta);
  return meta;
}

async function handleJobItems(req, res) {
  try {
    const job_id = resolveFiltroBackendJobId(req.params.job_id);
    if (!job_id) {
      return res.status(400).json({ ok: false, error: "job_id invalido" });
    }

    const meta = await getValidatedJobMeta(req, job_id);
    const currentContaId = getCurrentContaNumeric(req);

    const page = clamp(toInt(req.query.page, 1), 1, 999999);
    const limit = clamp(toInt(req.query.limit, 50), 10, 200);
    const q = String(req.query.q || "").trim().toLowerCase();

    const st = await filtroQueue.getStatus(job_id, { currentContaId });
    if (!st) {
      return res.status(404).json({
        ok: false,
        error: "Job nao encontrado.",
      });
    }
    const hasPartialRows =
      st.status === "erro" &&
      (st.has_results === true || Number(st.result_total || 0) > 0);
    if (st.status !== "concluido" && !hasPartialRows) {
      return res.status(202).json({
        ok: true,
        job_id,
        status: st.status,
        progress: st.progress,
        total: st.total ?? null,
        message: "Job ainda nao terminou. Continue consultando o status.",
        endpoints: buildEndpoints(job_id),
      });
    }

    const start = (page - 1) * limit;
    const { rows: pageRows, total, uniqueMlbTotal } = await filtroQueue.getResultsPage(job_id, {
      offset: start,
      limit,
      predicate: buildResultsPredicate({ meta, req, q }),
      countUniqueMlb: true,
    });
    try {
      await applyLivePromoPricingIfNeeded(req, pageRows, meta, { salePriceLimit: 0 });
    } catch (promoError) {
      console.warn(
        "[analytics-filtro-anuncios] falha no enriquecimento de promo por pagina:",
        promoError?.message || promoError
      );
    }
    const data = pageRows.map((r) => ({
      ...(() => {
        const promo = resolvePromoSnapshot(r);
        return {
          promo_ativa: promo.active,
          promo_percentual: promo.pct,
          promo_preco_base: promo.basePrice,
          promo_preco_vigente: promo.currentPrice,
        };
      })(),
      mlb: r.mlb,
      sku: r.sku,
      gtin: r.gtin,
      nome_anuncio: r.title,
      tipo: r.tipo,
      envios: r.envio,
      estoque:
        r.stock_total === null || r.stock_total === undefined
          ? null
          : Number(r.stock_total || 0),
      estoque_origem: r.stock_source || null,
      estoque_variacoes:
        r.stock_variations_count === null || r.stock_variations_count === undefined
          ? null
          : Number(r.stock_variations_count || 0),
      variation_id: r.variation_id || null,
      variation_name: r.variation_name || null,
      valor_venda:
        r.sold_value_cents === null || r.sold_value_cents === undefined
          ? null
          : Number(r.sold_value_cents || 0) / 100,
      qnt_vendas:
        r.sales_units === null || r.sales_units === undefined
          ? null
          : r.sales_units || 0,
      ultima_venda: r.ultima_venda || null,
      preco_atual:
        r.current_price_cents === null || r.current_price_cents === undefined
          ? null
          : Number(r.current_price_cents || 0) / 100,
      vendidos_total:
        r.sold_quantity_total === null || r.sold_quantity_total === undefined
          ? null
          : Number(r.sold_quantity_total || 0),
      visitas:
        r.visits === null || r.visits === undefined ? null : Number(r.visits || 0),
      date_created: r.date_created || null,
      status: r.status || null,
      parent_item_id: r.parent_item_id || null,
      categoria_id: r.category_id || null,
      categoria_nome: r.category_name || null,
      categoria_caminho: r.category_path || null,
      ads_em_campanha: !!r.ads_in_campaign,
      ads_roas: r.ads_roas ?? null,
      ads_investimento:
        r.ads_spend_cents === null || r.ads_spend_cents === undefined
          ? null
          : Number(r.ads_spend_cents || 0) / 100,
      ads_cliques:
        r.ads_clicks === null || r.ads_clicks === undefined
          ? null
          : Number(r.ads_clicks || 0),
      ads_impressoes:
        r.ads_impressions === null || r.ads_impressions === undefined
          ? null
          : Number(r.ads_impressions || 0),
    }));

    return res.json({
      ok: true,
      job_id,
      page,
      limit,
      total,
      unique_mlb_total: uniqueMlbTotal,
      data,
      endpoints: buildEndpoints(job_id),
    });
  } catch (err) {
    console.error("handleJobItems erro:", err);
    if (isValkeyLoadingError(err)) return sendValkeyLoading(res, err);
    return res.status(err.status || 500).json({
      ok: false,
      error: err.message || "Erro interno",
      details: err.details || null,
    });
  }
}

router.post(
  "/filtro-anuncios/jobs",
  createAuditAction({
    evento: "listing_filter_job_started",
    metadata: (req) => {
      const filters = parseFiltersFromReq(req);
      return {
        filters,
      };
    },
  }),
  express.json({ limit: "1mb" }),
  async (req, res) => {
    try {
      const currentContaId = getCurrentContaId(req);
      if (!currentContaId) {
        return res.status(400).json({
          ok: false,
          error: "Nenhuma conta Mercado Livre OAuth esta selecionada.",
        });
      }

      const filters = parseFiltersFromReq(req);
      validateRequiredFilters(filters);

      const token = await resolveCurrentAccessToken(req);
      // Fallback defensivo: se o serviço worker separado estiver indisponível,
      // a própria instância web consegue consumir essa fila e evita jobs presos
      // eternamente em "aguardando/processando 0%".
      filtroQueue.initWorker?.();

      const job_id = await filtroQueue.enqueue({
        token,
        mlCreds: buildWorkerMlCreds(req, token),
        filters,
        account: {
          meli_conta_id: currentContaId,
          label: getCurrentAccountLabel(req),
        },
      });
      const createdJob = attachFiltroJobContract(
        {
          id: String(job_id),
          status: "aguardando",
          completed: false,
          progress: 0,
          cancelable: true,
        },
        { backendJobId: job_id },
      );

      return res.status(202).json({
        ok: true,
        meli_conta_id: currentContaId,
        job_id,
        job_uid: createdJob.job_uid,
        backend_job_id: createdJob.backend_job_id,
        lifecycle_status: createdJob.lifecycle_status,
        job_contract: createdJob.job_contract,
        message: "Job criado. Consulte o status e depois pagine os resultados.",
        endpoints: buildEndpoints(job_id),
        filters,
      });
    } catch (err) {
      console.error("POST /api/analytics/filtro-anuncios/jobs erro:", err);
      if (isValkeyLoadingError(err)) return sendValkeyLoading(res, err);
      return res.status(err.status || 500).json({
        ok: false,
        error: err.message || "Erro interno",
      });
    }
  }
);

router.get("/filtro-anuncios/jobs", async (req, res) => {
  try {
    const currentContaId = getCurrentContaNumeric(req);
    if (!currentContaId) {
      return res.status(400).json({
        ok: false,
        error: "Nenhuma conta Mercado Livre OAuth esta selecionada.",
      });
    }

    const jobs = await filtroQueue.listJobs({
      currentContaId,
      limit: clamp(toInt(req.query.limit, 25), 1, 100),
    });

    const jobsWithSkuAwareTotal = await Promise.all(
      jobs.map(async (job) => {
        const jobId = String(job?.id || "").trim();
        if (!jobId) return job;
        try {
          const meta = await getValidatedJobMeta(req, jobId);
          return applySkuAwareTotal(job, meta);
        } catch {
          return job;
        }
      }),
    );

    return res.json({
      ok: true,
      jobs: jobsWithSkuAwareTotal.map((job) =>
        attachFiltroJobContract(attachJobReview(job, {
          basePath: "/api/analytics/filtro-anuncios/jobs",
          hasCsv: job?.status === "concluido",
          label: job?.kind === "csv_export" ? "Baixar CSV" : "Gerar CSV",
        })),
      ),
    });
  } catch (err) {
    console.error("GET /api/analytics/filtro-anuncios/jobs erro:", err);
    if (isValkeyLoadingError(err)) return sendValkeyLoading(res, err);
    return res.status(500).json({
      ok: false,
      error: err.message || "Erro interno",
    });
  }
});

router.get("/filtro-anuncios/jobs/:job_id", async (req, res) => {
  try {
    const job_id = resolveFiltroBackendJobId(req.params.job_id);
    if (!job_id) {
      return res.status(400).json({ ok: false, error: "job_id invalido" });
    }
    const currentContaId = getCurrentContaNumeric(req);
    if (!currentContaId) {
      return res.status(400).json({
        ok: false,
        error: "Nenhuma conta Mercado Livre OAuth esta selecionada.",
      });
    }

    const st = await filtroQueue.getStatus(job_id, { currentContaId });
    if (!st) {
      return res.status(404).json({
        ok: false,
        error: "Job nao encontrado.",
      });
    }
    const meta = await getValidatedJobMeta(req, job_id);
    const stWithSkuAwareTotal = await applySkuAwareTotal(st, meta);

    return res.json({
      ok: true,
      ...attachFiltroJobContract(attachJobReview(stWithSkuAwareTotal, {
        basePath: "/api/analytics/filtro-anuncios/jobs",
        hasCsv: stWithSkuAwareTotal?.status === "concluido",
        label: stWithSkuAwareTotal?.kind === "csv_export" ? "Baixar CSV" : "Gerar CSV",
      })),
      endpoints: buildEndpoints(job_id),
    });
  } catch (err) {
    console.error("GET /api/analytics/filtro-anuncios/jobs/:job_id erro:", err);
    if (isValkeyLoadingError(err)) return sendValkeyLoading(res, err);
    return res.status(err.status || 500).json({
      ok: false,
      error: err.message || "Erro interno",
      details: err.details || null,
    });
  }
});

router.post(
  "/filtro-anuncios/jobs/:job_id/cancel",
  createAuditAction({
    evento: "listing_filter_job_canceled",
    metadata: (req) => ({
      job_id: String(req.params?.job_id || "").trim() || null,
    }),
  }),
  async (req, res) => {
  try {
    const job_id = resolveFiltroBackendJobId(req.params.job_id);
    if (!job_id) {
      return res.status(400).json({ ok: false, error: "job_id invalido" });
    }

    const currentContaId = getCurrentContaNumeric(req);
    if (!currentContaId) {
      return res.status(400).json({
        ok: false,
        error: "Nenhuma conta Mercado Livre OAuth esta selecionada.",
      });
    }

    const result = await filtroQueue.cancelJob(job_id, { currentContaId });
    if (!result) {
      return res.status(404).json({ ok: false, error: "Job nao encontrado." });
    }

    if (!result.ok) {
      return res.status(409).json({
        ok: false,
        error: result.error || "Nao foi possivel cancelar o job.",
        status: result.status || null,
      });
    }

    const canceledJob = attachFiltroJobContract({
      id: job_id,
      status: result.status || "cancelado",
      completed: result.status === "cancelado",
      progress: result.status === "cancelado" ? 100 : 0,
      cancelable: result.status !== "cancelado",
    });
    return res.json({
      ok: true,
      job_id,
      job_uid: canceledJob.job_uid,
      backend_job_id: canceledJob.backend_job_id,
      lifecycle_status: canceledJob.lifecycle_status,
      job_contract: canceledJob.job_contract,
      status: result.status || "cancelado",
    });
  } catch (err) {
    console.error("POST /api/analytics/filtro-anuncios/jobs/:job_id/cancel erro:", err);
    if (isValkeyLoadingError(err)) return sendValkeyLoading(res, err);
    return res.status(500).json({
      ok: false,
      error: err.message || "Erro interno",
    });
  }
});

router.get("/filtro-anuncios/jobs/:job_id/items", handleJobItems);

router.get(
  "/filtro-anuncios/jobs/:job_id/download.csv",
  createAuditAction({
    evento: "listing_filter_results_downloaded",
    metadata: (req) => ({
      job_id: String(req.params?.job_id || "").trim() || null,
    }),
  }),
  async (req, res) => {
  try {
    const job_id = resolveFiltroBackendJobId(req.params.job_id);
    if (!job_id) {
      return res.status(400).json({ ok: false, error: "job_id invalido" });
    }

    const meta = await getValidatedJobMeta(req, job_id);
    const currentContaId = getCurrentContaNumeric(req);

    const st = await filtroQueue.getStatus(job_id, { currentContaId });
    if (!st) {
      return res.status(404).json({
        ok: false,
        error: "Job nao encontrado.",
      });
    }

    if (meta?.kind === "csv_export") {
      if (st.status !== "concluido") {
        const errorMessage =
          st.status === "erro"
            ? st.error || meta.error || "Exportacao CSV falhou."
            : "CSV ainda nao esta pronto para download.";
        return res.status(409).json({
          ok: false,
          error: errorMessage,
          status: st.status,
          progress: st.progress,
        });
      }

      const csvManifest = await filtroQueue.getCsvManifest(job_id);
      const filename = csvManifest?.filename || `${job_id}_filtro_anuncios.csv`;
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.write("\uFEFF");
      await filtroQueue.streamCsvToResponse(job_id, res);
      return res.end();
    }

    const hasPartialRows =
      st.has_results === true || Number(st.result_total || 0) > 0;
    if (st.status === "cancelado") {
      return res.status(409).json({
        ok: false,
        error: "Job cancelado. Nao ha CSV disponivel para download.",
        status: st.status,
        progress: st.progress,
        endpoints: buildEndpoints(job_id),
      });
    }
    if (st.status !== "concluido" && !hasPartialRows) {
      return res.status(409).json({
        ok: false,
        error: "Job ainda nao esta concluido para download.",
        status: st.status,
        progress: st.progress,
        endpoints: buildEndpoints(job_id),
      });
    }

    const fields = String(req.query.fields || defaultCsvFields(meta).join(","))
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const token = await resolveCurrentAccessToken(req);
    const exportJobId = await filtroQueue.enqueueCsvExport({
      sourceJobId: job_id,
      token,
      mlCreds: buildWorkerMlCreds(req, token),
      account: meta.account || st.account || null,
      fields,
      sourceMeta: meta,
      filename: `${job_id}_filtro_anuncios.csv`,
    });
    filtroQueue.initWorker?.();

    return res.status(202).json({
      ok: true,
      status: "queued",
      message: "Exportacao CSV enriquecida iniciada. Acompanhe no painel de processos.",
      export_job_id: exportJobId,
      job_id: exportJobId,
      source_job_id: job_id,
      endpoints: buildEndpoints(exportJobId),
    });
  } catch (err) {
    console.error(
      "GET /api/analytics/filtro-anuncios/jobs/:job_id/download.csv erro:",
      err
    );
    if (isValkeyLoadingError(err)) return sendValkeyLoading(res, err);
    return res.status(err.status || 500).json({
      ok: false,
      error: err.message || "Erro interno",
      details: err.details || null,
    });
  }
});

router.get(
  "/filtro-anuncios",
  createAuditAction({
    evento: "listing_filter_job_started",
    metadata: (req) => {
      if (String(req.query?.job_id || "").trim()) {
        return {
          mode: "results_view",
          job_id: String(req.query?.job_id || "").trim(),
        };
      }

      const filters = parseFiltersFromReq(req);
      return {
        mode: "job_create",
        filters,
      };
    },
    skip: (req) => !!String(req.query?.job_id || "").trim(),
  }),
  async (req, res) => {
  try {
    const job_id = String(req.query.job_id || "").trim();

    if (job_id) {
      req.params.job_id = job_id;
      return handleJobItems(req, res);
    }

    const currentContaId = getCurrentContaId(req);
    if (!currentContaId) {
      return res.status(400).json({
        ok: false,
        error: "Nenhuma conta Mercado Livre OAuth esta selecionada.",
      });
    }

    const filters = parseFiltersFromReq(req);
    validateRequiredFilters(filters);

    const token = await resolveCurrentAccessToken(req);

    const newJobId = await filtroQueue.enqueue({
      token,
      mlCreds: buildWorkerMlCreds(req, token),
      filters,
      account: {
        meli_conta_id: currentContaId,
        label: getCurrentAccountLabel(req),
      },
    });

    return res.status(202).json({
      ok: true,
      meli_conta_id: currentContaId,
      job_id: newJobId,
      message:
        "Job criado. Consulte o status e depois carregue a pagina de resultados.",
      endpoints: buildEndpoints(newJobId),
      filters,
    });
  } catch (err) {
    console.error("GET /api/analytics/filtro-anuncios erro:", err);
    if (isValkeyLoadingError(err)) return sendValkeyLoading(res, err);
    return res.status(err.status || 500).json({
      ok: false,
      error: err.message || "Erro interno",
      details: err.details || null,
    });
  }
});

module.exports = router;
