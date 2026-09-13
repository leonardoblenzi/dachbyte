"use strict";

const fetch = require("node-fetch");
const XLSX = require("xlsx");
const db = require("../db/db");
const TokenService = require("./tokenService");
const MarketingMlService = require("./marketingMlService");

const ML_API_BASE = "https://api.mercadolibre.com";
const INVENTORY_CACHE = new Map();
const LISTING_FEE_CACHE = new Map();
const SHIPPING_TARIFF_CACHE = new Map();
const ORDER_DISCOUNT_CACHE = new Map();
const SHIPMENT_COST_CACHE = new Map();
const QUICK_MARGIN_CACHE = new Map();
const INVENTORY_TTL_MS = 1000 * 60 * 5;
const LISTING_FEE_TTL_MS = 1000 * 60 * 30;
const SHIPPING_TARIFF_TTL_MS = 1000 * 60 * 30;
const ORDER_DISCOUNT_TTL_MS = 1000 * 60 * 30;
const SHIPMENT_COST_TTL_MS = 1000 * 60 * 30;
const QUICK_MARGIN_TTL_MS = 1000 * 60 * 5;
const DEFAULT_SCAN_LIMIT = 800;
const DEFAULT_EXPORT_SCAN_LIMIT = 10000;
const DEFAULT_MARGIN_SCOPE_LIMIT = 800;
const DEFAULT_MARGIN_ORDER_LIMIT = 10000;
const MAX_MARGIN_RANGE_DAYS = 92;

function now() {
  return Date.now();
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function roundNumber(value, decimals = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(decimals));
}

function percentChange(current, previous) {
  const cur = Number(current);
  const prev = Number(previous);
  if (!Number.isFinite(cur) || !Number.isFinite(prev) || prev <= 0) return null;
  return roundNumber(((cur - prev) / prev) * 100, 2);
}

function dateOnly(value) {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function maybeNumber(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value).trim();
  const normalized = text.includes(",")
    ? text.replace(/\./g, "").replace(",", ".")
    : text;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function orderLifecycleStatus(order = {}, shipment = {}) {
  const orderStatus = normalizeString(order?.status).toLowerCase();
  const shippingStatus = normalizeString(
    shipment?.status || order?.shipping?.status || order?.shipping_status,
  ).toLowerCase();
  const shippingSubstatus = normalizeString(
    shipment?.substatus || shipment?.sub_status || order?.shipping?.substatus || order?.shipping?.sub_status,
  ).toLowerCase();
  const tags = [
    ...(Array.isArray(order?.tags) ? order.tags : []),
    ...(Array.isArray(order?.shipping?.tags) ? order.shipping.tags : []),
    ...(Array.isArray(shipment?.tags) ? shipment.tags : []),
  ].map((tag) => normalizeString(tag).toLowerCase());
  const paymentStatuses = (Array.isArray(order?.payments) ? order.payments : [])
    .map((payment) => normalizeString(payment?.status).toLowerCase());
  const hasTag = (...values) => values.some((value) => tags.includes(value));
  const lifecycleText = [orderStatus, shippingStatus, shippingSubstatus, ...tags, ...paymentStatuses].join(" ");
  const hasLifecycleTerm = (...terms) => terms.some((term) => lifecycleText.includes(term));

  if (["cancelled", "canceled"].includes(orderStatus) || ["cancelled", "canceled"].includes(shippingStatus)) {
    return "Cancelado";
  }
  if (
    ["refunded", "partially_refunded", "returned"].includes(orderStatus) ||
    ["returned", "returned_to_sender"].includes(shippingStatus) ||
    paymentStatuses.some((status) => ["refunded", "partially_refunded"].includes(status))
  ) {
    return "Devolvido";
  }
  if (
    hasTag("has_return", "return_in_progress", "return_started") ||
    ["returning", "return_in_progress"].includes(shippingStatus)
  ) {
    return "Devolução";
  }
  if (
    hasTag("claim_opened", "claim") ||
    order?.claim?.id ||
    order?.claim_id ||
    hasLifecycleTerm("lost", "damaged", "delay", "delayed", "claim", "mediation", "mediacao", "reclam")
  ) {
    return "Problema";
  }
  if (shippingStatus === "delivered") return "Concluído";
  if (["shipped", "out_for_delivery", "in_transit"].includes(shippingStatus)) return "A caminho";
  return "Preparando";
}

function resolveRealizedGmv({
  orderProductTotal = null,
  fullOrderRevenue = 0,
  revenueBase = 0,
  buyerShippingFull = 0,
  selectionRatio = 1,
  totalCosts = 0,
} = {}) {
  // REGRA DAVANTTI: GMV e o TOTAL BRUTO DO PEDIDO, antes das deducoes
  // financeiras do Mercado Livre. Na order do ML, `total_amount` representa
  // os produtos; o frete pago pelo comprador vem do shipment e compoe o total
  // bruto exibido pelo integrador.
  //
  // Exemplo:
  //   produtos 734,44 + frete comprador 96,71 = GMV 831,15
  //
  // Comissao, cupom, imposto, CMV e tarifa de envio continuam como custos
  // separados e sao descontados somente depois, no Resultado.
  const explicitProductTotal = maybeNumber(orderProductTotal);
  const productTotal =
    explicitProductTotal != null && explicitProductTotal >= 0
      ? explicitProductTotal
      : numberOrZero(fullOrderRevenue) || numberOrZero(revenueBase);
  const fullGmv = Math.max(0, productTotal + numberOrZero(buyerShippingFull));
  const ratio = Math.max(0, Math.min(1, numberOrZero(selectionRatio)));
  const gmv = roundNumber(fullGmv * ratio, 2);
  const profit = roundNumber(gmv - numberOrZero(totalCosts), 2);

  return {
    gmv,
    source:
      explicitProductTotal != null && explicitProductTotal >= 0
        ? "order.total_amount+buyer_shipping"
        : "order.items+buyer_shipping",
    payment_ids: [],
    product_revenue: numberOrZero(revenueBase),
    profit,
    marginPct: gmv > 0 ? (profit / gmv) * 100 : 0,
  };
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeSku(value) {
  return normalizeString(value).toUpperCase();
}

function normalizeStatus(value) {
  const raw = normalizeString(value).toLowerCase();
  return raw || "all";
}

function isMarketingPeriodScope(query = {}) {
  const q = normalizeString(query.q);
  const status = normalizeString(query.status || "all").toLowerCase();
  const marginStatus = normalizeString(query.margin_status || "all").toLowerCase();
  const costStatus = normalizeString(query.cost_status || "all").toLowerCase();
  const equilibriumState = normalizeString(query.equilibrium_state || "all").toLowerCase();
  return !q
    && (!status || status === "all")
    && (!marginStatus || marginStatus === "all")
    && (!costStatus || costStatus === "all")
    && (!equilibriumState || equilibriumState === "all")
    && maybeNumber(query.min_margin) == null
    && maybeNumber(query.max_margin) == null;
}

function textIncludes(value, term) {
  return String(value || "").toLowerCase().includes(term);
}

function parseDateOnly(value) {
  const raw = normalizeString(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  return raw;
}

function todayISO() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);
}

function addDaysISO(value, days) {
  const d = new Date(`${value}T12:00:00`);
  d.setDate(d.getDate() + Number(days || 0));
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);
}

function defaultRange() {
  const to = todayISO();
  return { date_from: addDaysISO(to, -6), date_to: to };
}

function diffDaysInclusive(from, to) {
  const a = new Date(`${from}T12:00:00`);
  const b = new Date(`${to}T12:00:00`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
  return Math.floor((b.getTime() - a.getTime()) / 86400000) + 1;
}

function resolveDateRange(query = {}) {
  const fallback = defaultRange();
  const from = parseDateOnly(query.date_from || query.dateFrom) || fallback.date_from;
  const to = parseDateOnly(query.date_to || query.dateTo) || fallback.date_to;
  const range = from <= to ? { date_from: from, date_to: to } : { date_from: to, date_to: from };
  if (diffDaysInclusive(range.date_from, range.date_to) > MAX_MARGIN_RANGE_DAYS) {
    const err = new Error("Periodo maximo para margem e de 3 meses.");
    err.status = 400;
    throw err;
  }
  return range;
}

function getUserId(user) {
  const n = Number(user?.uid ?? user?.id ?? user?.user_id ?? null);
  return Number.isFinite(n) ? n : null;
}

async function prepareAuth(context = {}) {
  const creds =
    context?.mlCreds && typeof context.mlCreds === "object"
      ? { ...context.mlCreds }
      : {};
  if (!creds.account_key && context.accountKey) creds.account_key = context.accountKey;
  // O Painel ja possui um access token valido no middleware. Reutiliza-lo evita
  // uma renovacao/consulta extra antes do resumo financeiro rapido. Em 401,
  // mlRequest continua capaz de renovar usando as credenciais da conta.
  const directToken = normalizeString(context?.accessToken);
  if (directToken) return { token: directToken, creds };
  const token = await TokenService.renovarTokenSeNecessario(creds);
  return { token, creds };
}

async function mlRequest(state, path, query = {}, retries = 1) {
  const url = new URL(`${ML_API_BASE}${path}`);
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value == null || value === "") return;
    url.searchParams.set(key, String(value));
  });

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const response = await fetch(url.toString(), {
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${state.token}`,
        "x-format-new": "true",
      },
    });

    if (response.status === 401 && attempt < retries) {
      const refreshed = await TokenService.renovarToken(state.creds);
      state.token = refreshed.access_token;
      continue;
    }

    const text = await response.text().catch(() => "");
    const payload = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const err = new Error(payload?.message || payload?.error || `HTTP ${response.status}`);
      err.status = response.status;
      err.payload = payload;
      throw err;
    }
    return payload;
  }
  return {};
}

async function fetchSeller(state) {
  const payload = await mlRequest(state, "/users/me", {}, 1);
  return {
    id: payload?.id || null,
    nickname: payload?.nickname || null,
    site_id: payload?.site_id || "MLB",
  };
}

function extractReferenceSkuValues(item = {}) {
  const attrs = Array.isArray(item.attributes) ? item.attributes : [];
  const skuAttr = attrs.find((attr) =>
    ["SELLER_SKU", "SKU"].includes(String(attr?.id || "").toUpperCase()) ||
    String(attr?.name || "").trim().toLowerCase() === "sku" ||
    String(attr?.name || "").trim().toLowerCase().includes("sku"),
  );

  const pickAttrValue = (attr) =>
    normalizeString(
      attr?.value_name ||
        attr?.value_id ||
        (Array.isArray(attr?.values) ? attr.values[0]?.name || attr.values[0]?.id : ""),
    );

  const itemSku = normalizeString(
    item.seller_custom_field || item.seller_sku || pickAttrValue(skuAttr),
  );
  if (itemSku) return [normalizeSku(itemSku)];

  const variationSkus = [];
  for (const variation of Array.isArray(item.variations) ? item.variations : []) {
    const variationAttrs = Array.isArray(variation?.attributes) ? variation.attributes : [];
    const variationSkuAttr = variationAttrs.find((attr) =>
      ["SELLER_SKU", "SKU"].includes(String(attr?.id || "").toUpperCase()) ||
      String(attr?.name || "").trim().toLowerCase() === "sku" ||
      String(attr?.name || "").trim().toLowerCase().includes("sku"),
    );
    const variationSku = normalizeString(
      variation?.seller_custom_field || variation?.seller_sku || pickAttrValue(variationSkuAttr),
    );
    if (variationSku) variationSkus.push(normalizeSku(variationSku));
  }

  const unique = Array.from(new Set(variationSkus.filter(Boolean)));
  return unique;
}

function extractReferenceSku(item = {}) {
  const values = extractReferenceSkuValues(item);
  return values.length === 1 ? values[0] : "";
}

function extractVariationSkuRows(item = {}) {
  const pickAttrValue = (attr) =>
    normalizeString(
      attr?.value_name ||
        attr?.value_id ||
        (Array.isArray(attr?.values) ? attr.values[0]?.name || attr.values[0]?.id : ""),
    );
  const rows = [];
  for (const variation of Array.isArray(item?.variations) ? item.variations : []) {
    const attrs = Array.isArray(variation?.attributes) ? variation.attributes : [];
    const skuAttr = attrs.find((attr) =>
      ["SELLER_SKU", "SKU"].includes(String(attr?.id || "").toUpperCase()) ||
      String(attr?.name || "").trim().toLowerCase() === "sku" ||
      String(attr?.name || "").trim().toLowerCase().includes("sku"),
    );
    const sku = normalizeSku(
      variation?.seller_custom_field || variation?.seller_sku || pickAttrValue(skuAttr),
    );
    if (!sku) continue;
    rows.push({
      variation_id: normalizeString(variation?.id),
      reference_sku: sku,
      price: numberOrZero(variation?.price) || numberOrZero(item?.price),
      stock: numberOrZero(variation?.available_quantity),
    });
  }
  return rows;
}

function extractProductIdentifiers(item = {}) {
  const ids = new Set();
  const attrIds = ["GTIN", "EAN", "UPC", "JAN", "ISBN", "ISBN10", "ISBN13", "GTIN14"];
  const pushFromAttrs = (attrs = []) => {
    for (const attr of Array.isArray(attrs) ? attrs : []) {
      if (!attrIds.includes(String(attr?.id || "").toUpperCase())) continue;
      const values = [
        attr.value_name,
        attr.value_id,
        ...(Array.isArray(attr.values)
          ? attr.values.flatMap((value) => [value?.name, value?.id])
          : []),
      ];
      values.map(normalizeString).filter(Boolean).forEach((value) => ids.add(value));
    }
  };
  pushFromAttrs(item.attributes);
  for (const variation of Array.isArray(item.variations) ? item.variations : []) {
    pushFromAttrs(variation.attributes);
    pushFromAttrs(variation.attribute_combinations);
  }
  return Array.from(ids);
}

async function fetchItemDetails(state, ids = []) {
  const out = [];
  const cleanIds = Array.from(
    new Set(ids.map((id) => normalizeString(id)).filter(Boolean)),
  );
  for (let i = 0; i < cleanIds.length; i += 20) {
    const slice = cleanIds.slice(i, i + 20);
    const rows = await mlRequest(state, "/items", {
      ids: slice.join(","),
      attributes: [
        "id",
        "title",
        "thumbnail",
        "secure_thumbnail",
        "seller_custom_field",
        "price",
        "original_price",
        "status",
        "category_id",
        "listing_type_id",
        "catalog_listing",
        "available_quantity",
        "inventory_id",
        "seller_id",
        "shipping",
        "permalink",
        "attributes",
        "variations",
      ].join(","),
    }).catch(() => []);

    for (const row of Array.isArray(rows) ? rows : []) {
      if (row?.code !== 200 || !row?.body?.id) continue;
      const body = row.body;
      out.push({
        item_id: String(body.id),
        title: body.title || String(body.id),
        reference_sku: extractReferenceSku(body),
        reference_skus: extractReferenceSkuValues(body),
        variation_skus: extractVariationSkuRows(body),
        eans: extractProductIdentifiers(body),
        thumbnail: body.secure_thumbnail || body.thumbnail || null,
        price: numberOrZero(body.price),
        original_price: numberOrZero(body.original_price),
        status: body.status || null,
        category_id: body.category_id || null,
        listing_type_id: body.listing_type_id || null,
        catalog: !!body.catalog_listing,
        stock: numberOrZero(body.available_quantity),
        seller_id: body.seller_id || null,
        full: !!body.inventory_id,
        logistic_type: body?.shipping?.logistic_type || null,
        free_shipping: !!body?.shipping?.free_shipping,
        shipping_mode: body?.shipping?.mode || null,
        permalink: body.permalink || null,
      });
    }
  }
  return out;
}

async function fetchSellerItemIdsByStatus(state, sellerId, status, limit) {
  const ids = [];
  const pageSize = 100;
  for (let offset = 0; ids.length < limit; offset += pageSize) {
    const payload = await mlRequest(state, `/users/${encodeURIComponent(String(sellerId))}/items/search`, {
      status,
      limit: pageSize,
      offset,
    }).catch(() => null);
    const rows = Array.isArray(payload?.results) ? payload.results : [];
    ids.push(...rows.map((id) => String(id)).filter(Boolean));
    if (!rows.length || rows.length < pageSize) break;
    const total = numberOrZero(payload?.paging?.total);
    if (total > 0 && offset + rows.length >= total) break;
  }
  return ids.slice(0, limit);
}

async function fetchSellerItemIdsBySku(state, sellerId, status, sku) {
  const term = normalizeString(sku);
  if (!term) return [];
  const ids = [];
  const pageSize = 50;
  for (let offset = 0; offset <= 5000; offset += pageSize) {
    const payload = await mlRequest(state, `/users/${encodeURIComponent(String(sellerId))}/items/search`, {
      seller_sku: term,
      status: status && status !== "all" ? status : "",
      limit: pageSize,
      offset,
    }).catch(() => null);
    const rows = Array.isArray(payload?.results) ? payload.results : [];
    ids.push(...rows.map((id) => String(id)).filter(Boolean));
    const total = numberOrZero(payload?.paging?.total);
    if (!rows.length || rows.length < pageSize) break;
    if (total > 0 && offset + rows.length >= total) break;
  }
  return Array.from(new Set(ids));
}

function parseDirectLookupTerms(value) {
  const raw = normalizeString(value);
  if (!raw) return [];
  return Array.from(
    new Set(
      raw
        .split(/[\n,;]+/)
        .map((term) => normalizeString(term))
        .filter(Boolean),
    ),
  );
}

function buildSkuLookupVariants(value) {
  const term = normalizeString(value);
  if (!term) return [];
  return Array.from(new Set([term, term.toUpperCase(), term.toLowerCase()]));
}

function normalizeCostLookupType(value) {
  const raw = normalizeString(value).toLowerCase();
  if (raw === "mlb" || raw === "item" || raw === "item_id") return "mlb";
  if (raw === "ean" || raw === "gtin" || raw === "barcode") return "ean";
  if (raw === "product" || raw === "produto" || raw === "title" || raw === "titulo") {
    return "product";
  }
  if (raw === "auto" || raw === "all") return "auto";
  return "sku";
}

async function fetchTargetedCostLookupItems(context = {}, query = {}, seller = {}) {
  const terms = parseDirectLookupTerms(query.q);
  if (!terms.length || !seller?.id) return [];

  const lookupType = normalizeCostLookupType(query.lookup_type || query.search_type || "sku");
  if (lookupType === "ean" || lookupType === "product") return [];

  const state = await prepareAuth(context);
  const wantedStatus = normalizeStatus(query.status);
  const statuses = wantedStatus === "all" ? ["active", "paused", "closed"] : [wantedStatus];
  const targetIds = new Set();
  const skuTerms = [];

  for (const term of terms) {
    const normalized = term.toUpperCase();
    if (lookupType === "mlb" || (lookupType === "auto" && /^MLB\d{6,}$/.test(normalized))) {
      targetIds.add(normalized);
    } else if (lookupType === "sku" || lookupType === "auto") {
      skuTerms.push(term);
    }
  }

  for (const sku of skuTerms) {
    for (const status of statuses) {
      for (const variant of buildSkuLookupVariants(sku)) {
        const ids = await fetchSellerItemIdsBySku(state, seller.id, status, variant);
        ids.forEach((id) => targetIds.add(String(id).toUpperCase()));
        if (ids.length) break;
      }
    }
  }

  return fetchItemDetails(state, Array.from(targetIds));
}

function inventoryCacheKey(accountKey, status, maxItems) {
  return JSON.stringify({
    accountKey: String(accountKey || ""),
    status: String(status || "all"),
    maxItems,
  });
}

async function getInventorySnapshot(context = {}, opts = {}) {
  const accountKey = String(context.accountKey || context?.mlCreds?.account_key || "default");
  const status = normalizeStatus(opts.status);
  const fullScan = !!opts.full_scan;
  const maxItems = clampInt(
    opts.max_items ||
      (fullScan ? process.env.ML_FINANCE_EXPORT_SCAN_LIMIT : process.env.ML_FINANCE_SCAN_LIMIT),
    100,
    fullScan ? 10000 : 2000,
    fullScan ? DEFAULT_EXPORT_SCAN_LIMIT : DEFAULT_SCAN_LIMIT,
  );
  const key = inventoryCacheKey(accountKey, status, maxItems);
  const cached = INVENTORY_CACHE.get(key);
  if (cached && now() - cached.createdAt < INVENTORY_TTL_MS) return cached.payload;

  const state = await prepareAuth(context);
  const seller = await fetchSeller(state);
  if (!seller.id) throw new Error("Nao foi possivel identificar a conta Mercado Livre.");

  const statuses =
    status === "all" ? ["active", "paused", "closed"] : [status];
  const perStatusLimit = Math.max(50, Math.ceil(maxItems / statuses.length));
  const batches = await Promise.all(
    statuses.map((entry) =>
      fetchSellerItemIdsByStatus(state, seller.id, entry, perStatusLimit),
    ),
  );

  const ids = Array.from(new Set(batches.flat())).slice(0, maxItems);
  const items = await fetchItemDetails(state, ids);
  const payload = {
    seller,
    items,
    partial: ids.length >= maxItems,
    max_items: maxItems,
    updated_at: new Date().toISOString(),
  };
  INVENTORY_CACHE.set(key, { createdAt: now(), payload });
  return payload;
}

async function getSkuCostMap(accountKey, skus = []) {
  const normalized = Array.from(new Set(skus.map(normalizeSku).filter(Boolean)));
  if (!normalized.length) return new Map();
  const result = await db.query(
    `select reference_sku, custo_produto_unitario, updated_at
       from ml.mercadolivre_sku_costs
      where account_key = $1
        and reference_sku = any($2::text[])`,
    [String(accountKey || "default"), normalized],
  );
  return new Map(
    result.rows.map((row) => [
      normalizeSku(row.reference_sku),
      {
        cost: numberOrZero(row.custo_produto_unitario),
        updated_at: row.updated_at || null,
      },
    ]),
  );
}

async function getCatalogSkuCandidatesByMlb(accountKey, mlbs = []) {
  const normalizedMlbs = Array.from(
    new Set(mlbs.map((value) => normalizeString(value).toUpperCase()).filter(Boolean)),
  );
  if (!accountKey || !normalizedMlbs.length) return new Map();

  const result = await db.query(
    `select mlb, variation_id, reference_sku
       from ml.mercadolivre_sku_catalog_items
      where account_key = $1
        and upper(mlb) = any($2::text[])`,
    [String(accountKey), normalizedMlbs],
  ).catch((error) => {
    // Instalacoes anteriores ao catalogo continuam funcionando apenas com os
    // dados retornados pela API do Mercado Livre.
    if (String(error?.message || "").includes("mercadolivre_sku_catalog_items")) {
      return { rows: [] };
    }
    throw error;
  });

  const byMlb = new Map();
  for (const row of result.rows || []) {
    const mlb = normalizeString(row?.mlb).toUpperCase();
    const sku = normalizeSku(row?.reference_sku);
    if (!mlb || !sku) continue;
    const current = byMlb.get(mlb) || [];
    if (!current.some((entry) =>
      normalizeSku(entry?.reference_sku) === sku &&
      normalizeString(entry?.variation_id) === normalizeString(row?.variation_id)
    )) {
      current.push({
        reference_sku: sku,
        variation_id: normalizeString(row?.variation_id),
      });
    }
    byMlb.set(mlb, current);
  }
  return byMlb;
}


async function getCatalogCostCandidatesByMlb(accountKey, mlbs = []) {
  const normalizedMlbs = Array.from(
    new Set(mlbs.map((value) => normalizeString(value).toUpperCase()).filter(Boolean)),
  );
  if (!accountKey || !normalizedMlbs.length) return new Map();

  const result = await db.query(
    `select c.mlb,
            c.variation_id,
            c.reference_sku,
            coalesce(sc.custo_produto_unitario, 0) as custo_produto_unitario,
            sc.updated_at as cost_updated_at
       from ml.mercadolivre_sku_catalog_items c
       left join ml.mercadolivre_sku_costs sc
         on sc.account_key = c.account_key
        and sc.reference_sku = c.reference_sku
      where c.account_key = $1
        and upper(c.mlb) = any($2::text[])`,
    [String(accountKey), normalizedMlbs],
  ).catch((error) => {
    if (String(error?.message || "").includes("mercadolivre_sku_catalog_items")) {
      return { rows: [] };
    }
    throw error;
  });

  const byMlb = new Map();
  for (const row of result.rows || []) {
    const mlb = normalizeString(row?.mlb).toUpperCase();
    const sku = normalizeSku(row?.reference_sku);
    if (!mlb || !sku) continue;
    const current = byMlb.get(mlb) || [];
    const variationId = normalizeString(row?.variation_id);
    const cost = numberOrZero(row?.custo_produto_unitario);
    const existing = current.find((entry) =>
      normalizeSku(entry?.reference_sku) === sku &&
      normalizeString(entry?.variation_id) === variationId
    );
    if (existing) {
      // Mantem sempre o maior custo positivo encontrado para o mesmo vinculo,
      // caso existam linhas historicas/duplicadas no catalogo.
      if (cost > numberOrZero(existing.cost)) {
        existing.cost = cost;
        existing.updated_at = row?.cost_updated_at || null;
      }
    } else {
      current.push({
        reference_sku: sku,
        variation_id: variationId,
        cost,
        updated_at: row?.cost_updated_at || null,
      });
    }
    byMlb.set(mlb, current);
  }
  return byMlb;
}

async function saveSkuCost({ accountKey, sku, cost, userId, source = "manual", meta = {} }) {
  const referenceSku = normalizeSku(sku);
  if (!referenceSku) throw new Error("SKU de referencia e obrigatorio.");
  const parsedCost = Math.max(0, numberOrZero(cost));
  const saved = await db.query(
    `insert into ml.mercadolivre_sku_costs
        (account_key, reference_sku, custo_produto_unitario, updated_by, source, meta)
     values ($1, $2, $3, $4, $5, $6::jsonb)
     on conflict (account_key, reference_sku)
     do update set
       custo_produto_unitario = excluded.custo_produto_unitario,
       updated_by = excluded.updated_by,
       source = excluded.source,
       meta = excluded.meta,
       updated_at = now()
     returning reference_sku, custo_produto_unitario, updated_at`,
    [
      String(accountKey || "default"),
      referenceSku,
      parsedCost,
      userId || null,
      source,
      JSON.stringify(meta || {}),
    ],
  );

  await db.query(
    `insert into ml.mercadolivre_sku_cost_history
        (account_key, reference_sku, custo_produto_unitario, source, changed_by, meta)
     values ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      String(accountKey || "default"),
      referenceSku,
      parsedCost,
      source,
      userId || null,
      JSON.stringify(meta || {}),
    ],
  );

  INVENTORY_CACHE.clear();
  return saved.rows[0];
}

async function getAccountTax(accountKey) {
  const result = await db.query(
    `select aliquota
       from ml.mercadolivre_finance_settings
      where account_key = $1
      limit 1`,
    [String(accountKey || "default")],
  );
  const row = result.rows[0] || {};
  return {
    enabled: numberOrZero(row.aliquota) > 0,
    aliquota: numberOrZero(row.aliquota),
  };
}

async function saveAccountTax({ accountKey, aliquota, userId }) {
  const pct = Math.max(0, numberOrZero(aliquota));
  const result = await db.query(
    `insert into ml.mercadolivre_finance_settings
        (account_key, aliquota, updated_by)
     values ($1, $2, $3)
     on conflict (account_key)
     do update set
       aliquota = excluded.aliquota,
       updated_by = excluded.updated_by,
       updated_at = now()
     returning aliquota, updated_at`,
    [String(accountKey || "default"), pct, userId || null],
  );

  await db.query(
    `insert into ml.mercadolivre_finance_settings_history
        (account_key, aliquota, changed_by, source)
     values ($1, $2, $3, 'manual')`,
    [String(accountKey || "default"), pct, userId || null],
  );

  return {
    enabled: numberOrZero(result.rows[0]?.aliquota) > 0,
    aliquota: numberOrZero(result.rows[0]?.aliquota),
    updated_at: result.rows[0]?.updated_at || null,
  };
}

function groupItemsBySku(items = [], costMap = new Map()) {
  const grouped = new Map();
  for (const item of items) {
    const skuValues = Array.from(
      new Set(
        (Array.isArray(item.reference_skus) && item.reference_skus.length
          ? item.reference_skus
          : [item.reference_sku]
        )
          .map(normalizeSku)
          .filter(Boolean),
      ),
    );
    const targetSkus = skuValues.length ? skuValues : [""];
    for (const sku of targetSkus) {
      const key = sku || `SEM_SKU:${item.item_id}`;
      const current =
        grouped.get(key) ||
        {
          reference_sku: sku,
          has_reference_sku: !!sku,
          title: item.title,
          thumbnail: item.thumbnail,
          eans: new Set(),
          mlbs: [],
          statuses: new Set(),
          categories: new Set(),
          item_count: 0,
          min_price: item.price,
          max_price: item.price,
          stock: 0,
          cost: sku ? numberOrZero(costMap.get(sku)?.cost) : 0,
          cost_updated_at: sku ? costMap.get(sku)?.updated_at || null : null,
        };
      current.item_count += 1;
      current.mlbs.push(item.item_id);
      (Array.isArray(item.eans) ? item.eans : []).forEach((ean) => {
        const normalized = normalizeString(ean);
        if (normalized) current.eans.add(normalized);
      });
      current.statuses.add(item.status || "-");
      if (item.category_id) current.categories.add(item.category_id);
      current.min_price = Math.min(numberOrZero(current.min_price), numberOrZero(item.price));
      current.max_price = Math.max(numberOrZero(current.max_price), numberOrZero(item.price));
      current.stock += numberOrZero(item.stock);
      if (!current.thumbnail && item.thumbnail) current.thumbnail = item.thumbnail;
      grouped.set(key, current);
    }
  }

  return Array.from(grouped.values()).map((row) => {
    const eans = Array.from(row.eans);
    return {
      ...row,
      all_mlbs: row.mlbs.slice(),
      eans,
      ean: eans[0] || "",
      mlbs: row.mlbs.slice(0, 8),
      hidden_mlbs_count: Math.max(0, row.mlbs.length - 8),
      statuses: Array.from(row.statuses),
      categories: Array.from(row.categories),
      cost_status: row.has_reference_sku && row.cost > 0 ? "filled" : "missing",
    };
  });
}

function applyCostFilters(groups = [], query = {}) {
  const q = normalizeString(query.q).toLowerCase();
  const lookupType = normalizeCostLookupType(query.lookup_type || query.search_type || "sku");
  const costStatus = normalizeString(query.cost_status || "all").toLowerCase();
  const status = normalizeStatus(query.status);
  const category = normalizeString(query.category_id || query.category);
  return groups.filter((row) => {
    if (q) {
      const haystackParts = [];
      if (lookupType === "sku") {
        haystackParts.push(row.reference_sku);
      } else if (lookupType === "mlb") {
        haystackParts.push(...(row.mlbs || []), ...(row.all_mlbs || []));
      } else if (lookupType === "ean") {
        haystackParts.push(row.ean, ...(row.eans || []));
      } else if (lookupType === "product") {
        haystackParts.push(row.title);
      } else {
        haystackParts.push(
          row.reference_sku,
          row.ean,
          ...(row.eans || []),
          row.title,
          ...(row.mlbs || []),
          ...(row.all_mlbs || []),
          ...(row.categories || []),
        );
      }
      const haystack = haystackParts.join(" ");
      if (!textIncludes(haystack, q)) return false;
    }
    if (costStatus === "filled" && row.cost_status !== "filled") return false;
    if (costStatus === "missing" && row.cost_status !== "missing") return false;
    if (
      status !== "all" &&
      !(row.statuses || []).some((rowStatus) => normalizeStatus(rowStatus) === status)
    ) {
      return false;
    }
    if (category && !(row.categories || []).includes(category)) return false;
    return true;
  });
}

function buildCostSummary(groups = []) {
  const withSku = groups.filter((row) => row.has_reference_sku);
  const filled = withSku.filter((row) => row.cost > 0).length;
  const missing = withSku.length - filled;
  return {
    total_skus: withSku.length,
    filled_skus: filled,
    missing_skus: missing,
    no_sku_items: groups.filter((row) => !row.has_reference_sku).length,
    coverage_pct: withSku.length ? Number(((filled / withSku.length) * 100).toFixed(2)) : 0,
  };
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function shouldUseSkuCatalogForStatus(status) {
  const normalized = normalizeStatus(status);
  return normalized === "all" || normalized === "active";
}

async function getLatestSkuCatalogRun(accountKey) {
  const result = await db.query(
    `select id, status, total_items, processed_items, total_skus, no_sku_items,
            started_at, finished_at, created_at, updated_at, error, meta
       from ml.mercadolivre_sku_sync_runs
      where account_key = $1
      order by created_at desc
      limit 1`,
    [String(accountKey || "default")],
  ).catch((error) => {
    if (String(error?.message || "").includes("mercadolivre_sku_sync_runs")) return { rows: [] };
    throw error;
  });
  return result.rows[0] || null;
}

async function getSkuCatalogSummary(accountKey) {
  const result = await db.query(
    `select
        count(*)::integer as total_skus,
        count(*) filter (where coalesce(cst.custo_produto_unitario, 0) > 0)::integer as filled_skus,
        count(*) filter (where coalesce(cst.custo_produto_unitario, 0) <= 0)::integer as missing_skus
       from ml.mercadolivre_sku_catalog cat
       left join ml.mercadolivre_sku_costs cst
         on cst.account_key = cat.account_key
        and cst.reference_sku = cat.reference_sku
      where cat.account_key = $1
        and cat.is_active = true`,
    [String(accountKey || "default")],
  ).catch((error) => {
    if (String(error?.message || "").includes("mercadolivre_sku_catalog")) {
      return { rows: [{ total_skus: 0, filled_skus: 0, missing_skus: 0 }] };
    }
    throw error;
  });
  const row = result.rows[0] || {};
  const total = numberOrZero(row.total_skus);
  const filled = numberOrZero(row.filled_skus);
  const missing = numberOrZero(row.missing_skus);
  return {
    total_skus: total,
    filled_skus: filled,
    missing_skus: missing,
    no_sku_items: 0,
    coverage_pct: total ? Number(((filled / total) * 100).toFixed(2)) : 0,
  };
}

function buildCatalogWhere(query = {}, accountKey = "default") {
  const values = [String(accountKey || "default")];
  const clauses = ["cat.account_key = $1", "cat.is_active = true"];
  const status = normalizeStatus(query.status);
  if (!shouldUseSkuCatalogForStatus(status)) {
    clauses.push("false");
  }

  const q = normalizeString(query.q);
  const lookupType = normalizeCostLookupType(query.lookup_type || query.search_type || "sku");
  if (q) {
    values.push(`%${q}%`);
    const p = `$${values.length}`;
    if (lookupType === "sku") {
      clauses.push(`cat.reference_sku ilike ${p}`);
    } else if (lookupType === "mlb") {
      clauses.push(`exists (
        select 1 from ml.mercadolivre_sku_catalog_items ci
         where ci.account_key = cat.account_key
           and ci.reference_sku = cat.reference_sku
           and ci.mlb ilike ${p}
      )`);
    } else if (lookupType === "ean") {
      clauses.push(`cat.eans::text ilike ${p}`);
    } else if (lookupType === "product") {
      clauses.push(`cat.title_sample ilike ${p}`);
    } else {
      clauses.push(`(
        cat.reference_sku ilike ${p}
        or cat.title_sample ilike ${p}
        or cat.eans::text ilike ${p}
        or exists (
          select 1 from ml.mercadolivre_sku_catalog_items ci
           where ci.account_key = cat.account_key
             and ci.reference_sku = cat.reference_sku
             and ci.mlb ilike ${p}
        )
      )`);
    }
  }

  const category = normalizeString(query.category_id || query.category);
  if (category) {
    values.push(`%${category}%`);
    clauses.push(`cat.categories::text ilike $${values.length}`);
  }

  const costStatus = normalizeString(query.cost_status || "all").toLowerCase();
  if (costStatus === "filled") clauses.push("coalesce(cst.custo_produto_unitario, 0) > 0");
  if (costStatus === "missing") clauses.push("coalesce(cst.custo_produto_unitario, 0) <= 0");

  const riskStatus = normalizeString(query.risk_status || "all").toLowerCase();
  if (riskStatus === "cost_up") {
    clauses.push(`coalesce(cst.custo_produto_unitario, 0) > 0`);
    clauses.push(`coalesce((
      select ch.custo_produto_unitario
        from ml.mercadolivre_sku_cost_history ch
       where ch.account_key = cat.account_key
         and ch.reference_sku = cat.reference_sku
         and ch.created_at <= now() - interval '30 days'
       order by ch.created_at desc
       limit 1
    ), 0) > 0`);
    clauses.push(`(
      (cst.custo_produto_unitario - (
        select ch.custo_produto_unitario
          from ml.mercadolivre_sku_cost_history ch
         where ch.account_key = cat.account_key
           and ch.reference_sku = cat.reference_sku
           and ch.created_at <= now() - interval '30 days'
         order by ch.created_at desc
         limit 1
      )) / nullif((
        select ch.custo_produto_unitario
          from ml.mercadolivre_sku_cost_history ch
         where ch.account_key = cat.account_key
           and ch.reference_sku = cat.reference_sku
           and ch.created_at <= now() - interval '30 days'
         order by ch.created_at desc
         limit 1
      ), 0) * 100
    ) >= 5`);
  }
  if (riskStatus === "price_down") {
    clauses.push(`coalesce((
      select avg(ph.price)
        from ml.mercadolivre_sku_price_history ph
       where ph.account_key = cat.account_key
         and ph.reference_sku = cat.reference_sku
         and ph.snapshot_date = (
           select max(snapshot_date)
             from ml.mercadolivre_sku_price_history
            where account_key = cat.account_key
              and reference_sku = cat.reference_sku
         )
    ), 0) < coalesce((
      select avg(ph.price)
        from ml.mercadolivre_sku_price_history ph
       where ph.account_key = cat.account_key
         and ph.reference_sku = cat.reference_sku
         and ph.snapshot_date = (
           select max(snapshot_date)
             from ml.mercadolivre_sku_price_history
            where account_key = cat.account_key
              and reference_sku = cat.reference_sku
              and snapshot_date <= current_date - interval '30 days'
         )
    ), 0) * 0.95`);
  }
  if (riskStatus === "margin_risk") {
    clauses.push(`coalesce(cst.custo_produto_unitario, 0) > 0`);
    clauses.push(`coalesce(cat.max_price, cat.min_price, 0) > 0`);
    clauses.push(`((coalesce(cat.max_price, cat.min_price, 0) - cst.custo_produto_unitario) / nullif(coalesce(cat.max_price, cat.min_price, 0), 0) * 100) < 15`);
  }

  return { where: clauses.join(" and "), values };
}

function catalogRiskBaseSql(where) {
  return `
    with base as (
      select
        cat.reference_sku,
        cat.title_sample,
        cat.thumbnail,
        cat.item_count,
        cat.stock_total,
        cat.min_price,
        cat.max_price,
        cat.sample_mlbs,
        cst.custo_produto_unitario as cost,
        ch30.custo_produto_unitario as previous_cost_30d,
        coalesce(ph_latest.avg_price, cat.max_price, cat.min_price, 0)::numeric(14,2) as current_price,
        ph_latest.snapshot_date as latest_price_snapshot_date,
        ph30.avg_price as previous_price_30d,
        case
          when coalesce(ch30.custo_produto_unitario, 0) > 0 and coalesce(cst.custo_produto_unitario, 0) > 0
          then ((cst.custo_produto_unitario - ch30.custo_produto_unitario) / nullif(ch30.custo_produto_unitario, 0) * 100)
          else null
        end as cost_delta_30d_pct,
        case
          when coalesce(ph30.avg_price, 0) > 0 and coalesce(ph_latest.avg_price, cat.max_price, cat.min_price, 0) > 0
          then ((coalesce(ph_latest.avg_price, cat.max_price, cat.min_price, 0) - ph30.avg_price) / nullif(ph30.avg_price, 0) * 100)
          else null
        end as price_delta_30d_pct,
        case
          when coalesce(ph_latest.avg_price, cat.max_price, cat.min_price, 0) > 0 and coalesce(cst.custo_produto_unitario, 0) > 0
          then ((coalesce(ph_latest.avg_price, cat.max_price, cat.min_price, 0) - cst.custo_produto_unitario) / nullif(coalesce(ph_latest.avg_price, cat.max_price, cat.min_price, 0), 0) * 100)
          else null
        end as estimated_margin_pct
       from ml.mercadolivre_sku_catalog cat
       left join ml.mercadolivre_sku_costs cst
         on cst.account_key = cat.account_key
        and cst.reference_sku = cat.reference_sku
       left join lateral (
         select ch.custo_produto_unitario
           from ml.mercadolivre_sku_cost_history ch
          where ch.account_key = cat.account_key
            and ch.reference_sku = cat.reference_sku
            and ch.created_at <= now() - interval '30 days'
          order by ch.created_at desc
          limit 1
       ) ch30 on true
       left join lateral (
         select ph.snapshot_date, avg(ph.price)::numeric(14,2) as avg_price
           from ml.mercadolivre_sku_price_history ph
          where ph.account_key = cat.account_key
            and ph.reference_sku = cat.reference_sku
            and ph.snapshot_date = (
              select max(snapshot_date)
                from ml.mercadolivre_sku_price_history
               where account_key = cat.account_key
                 and reference_sku = cat.reference_sku
            )
          group by ph.snapshot_date
       ) ph_latest on true
       left join lateral (
         select ph.snapshot_date, avg(ph.price)::numeric(14,2) as avg_price
           from ml.mercadolivre_sku_price_history ph
          where ph.account_key = cat.account_key
            and ph.reference_sku = cat.reference_sku
            and ph.snapshot_date = (
              select max(snapshot_date)
                from ml.mercadolivre_sku_price_history
               where account_key = cat.account_key
                 and reference_sku = cat.reference_sku
                 and snapshot_date <= current_date - interval '30 days'
            )
          group by ph.snapshot_date
       ) ph30 on true
      where ${where}
    ),
    scored as (
      select
        *,
        case
          when estimated_margin_pct is not null and estimated_margin_pct < 15 then 'margin_risk'
          when cost_delta_30d_pct is not null and cost_delta_30d_pct >= 5 then 'cost_up'
          when price_delta_30d_pct is not null and price_delta_30d_pct <= -5 then 'price_down'
          when coalesce(cost, 0) <= 0 then 'missing_cost'
          else 'healthy'
        end as risk_type,
        (
          case when estimated_margin_pct is not null and estimated_margin_pct < 15 then 100 - greatest(estimated_margin_pct, 0) else 0 end +
          case when cost_delta_30d_pct is not null and cost_delta_30d_pct >= 5 then cost_delta_30d_pct else 0 end +
          case when price_delta_30d_pct is not null and price_delta_30d_pct <= -5 then abs(price_delta_30d_pct) else 0 end +
          case when coalesce(cost, 0) <= 0 then least(coalesce(item_count, 0), 40) else 0 end +
          least(coalesce(stock_total, 0) / 10.0, 25)
        ) as risk_score
      from base
    )`;
}

function buildCostRiskInsights(summary = {}, ranking = []) {
  const insights = [];
  const topCost = ranking.find((row) => row.risk_type === "cost_up");
  const topPrice = ranking.find((row) => row.risk_type === "price_down");
  const topMargin = ranking.find((row) => row.risk_type === "margin_risk");
  const topMissing = ranking.find((row) => row.risk_type === "missing_cost");

  if (topMargin) {
    insights.push({
      type: "margin_risk",
      severity: "danger",
      title: "Margem pressionada",
      message: `${topMargin.reference_sku} esta com margem estimada de ${roundNumber(topMargin.estimated_margin_pct, 1).toString().replace(".", ",")}%. Priorize revisao de preco ou custo.`,
    });
  }
  if (topCost) {
    insights.push({
      type: "cost_up",
      severity: "warning",
      title: "Custo em alta",
      message: `${topCost.reference_sku} subiu ${roundNumber(topCost.cost_delta_30d_pct, 1).toString().replace(".", ",")}% nos ultimos 30 dias.`,
    });
  }
  if (topPrice) {
    insights.push({
      type: "price_down",
      severity: "danger",
      title: "Preco caiu",
      message: `${topPrice.reference_sku} teve queda media de ${Math.abs(roundNumber(topPrice.price_delta_30d_pct, 1)).toString().replace(".", ",")}% no preco vigente.`,
    });
  }
  if (topMissing) {
    insights.push({
      type: "missing_cost",
      severity: "warning",
      title: "Custo ausente critico",
      message: `${summary.missing_cost_count || 0} SKU(s) ativos ainda estao sem custo. ${topMissing.reference_sku} tem ${topMissing.item_count || 0} anuncio(s) ligado(s).`,
    });
  }
  if (!insights.length) {
    insights.push({
      type: "healthy",
      severity: "success",
      title: "Sem alerta forte",
      message: "Nao encontramos aumento relevante de custo, queda forte de preco ou risco simples de margem no recorte atual.",
    });
  }
  return insights.slice(0, 5);
}

async function buildCatalogCostRiskOverview(where, values) {
  const baseSql = catalogRiskBaseSql(where);
  const [summaryResult, rankingResult] = await Promise.all([
    db.query(
      `${baseSql}
       select
         count(*)::integer as total,
         count(*) filter (where risk_type = 'missing_cost')::integer as missing_cost_count,
         count(*) filter (where risk_type = 'cost_up')::integer as cost_up_count,
         count(*) filter (where risk_type = 'price_down')::integer as price_down_count,
         count(*) filter (where risk_type = 'margin_risk')::integer as margin_risk_count,
         count(*) filter (where risk_type <> 'healthy')::integer as attention_count,
         max(latest_price_snapshot_date) as latest_price_snapshot_date
        from scored`,
      values,
    ),
    db.query(
      `${baseSql}
       select
          reference_sku,
          title_sample,
          thumbnail,
          item_count,
          stock_total,
          sample_mlbs,
          cost,
          previous_cost_30d,
          current_price,
          previous_price_30d,
          latest_price_snapshot_date,
          cost_delta_30d_pct,
          price_delta_30d_pct,
          estimated_margin_pct,
          risk_type,
          risk_score
         from scored
        where risk_type <> 'healthy'
        order by risk_score desc, reference_sku asc
        limit 10`,
      values,
    ),
  ]).catch((error) => {
    if (
      String(error?.message || "").includes("mercadolivre_sku_catalog") ||
      String(error?.message || "").includes("mercadolivre_sku_price_history")
    ) {
      return [{ rows: [{}] }, { rows: [] }];
    }
    throw error;
  });

  const summaryRow = summaryResult.rows[0] || {};
  const summary = {
    total: numberOrZero(summaryRow.total),
    missing_cost_count: numberOrZero(summaryRow.missing_cost_count),
    cost_up_count: numberOrZero(summaryRow.cost_up_count),
    price_down_count: numberOrZero(summaryRow.price_down_count),
    margin_risk_count: numberOrZero(summaryRow.margin_risk_count),
    attention_count: numberOrZero(summaryRow.attention_count),
    latest_price_snapshot_date: summaryRow.latest_price_snapshot_date || null,
  };
  const ranking = rankingResult.rows.map((row, index) => ({
    position: index + 1,
    reference_sku: normalizeSku(row.reference_sku),
    title: row.title_sample || normalizeSku(row.reference_sku),
    thumbnail: row.thumbnail || null,
    item_count: numberOrZero(row.item_count),
    stock: numberOrZero(row.stock_total),
    mlbs: asArray(row.sample_mlbs).map(normalizeString).filter(Boolean).slice(0, 4),
    cost: numberOrZero(row.cost),
    previous_cost_30d: numberOrZero(row.previous_cost_30d),
    current_price: numberOrZero(row.current_price),
    previous_price_30d: numberOrZero(row.previous_price_30d),
    latest_price_snapshot_date: row.latest_price_snapshot_date || null,
    cost_delta_30d_pct: row.cost_delta_30d_pct == null ? null : roundNumber(row.cost_delta_30d_pct, 2),
    price_delta_30d_pct: row.price_delta_30d_pct == null ? null : roundNumber(row.price_delta_30d_pct, 2),
    estimated_margin_pct: row.estimated_margin_pct == null ? null : roundNumber(row.estimated_margin_pct, 2),
    risk_type: row.risk_type || "healthy",
    risk_score: roundNumber(row.risk_score, 2),
  }));

  return {
    summary,
    ranking,
    insights: buildCostRiskInsights(summary, ranking),
  };
}

async function listSkuCatalogCosts(query = {}, context = {}) {
  const page = clampInt(query.page, 1, 9999, 1);
  const pageSize = clampInt(query.pageSize, 10, query.export_all ? 10000 : 100, 25);
  const accountKey = String(context.accountKey || "default");
  const summary = await getSkuCatalogSummary(accountKey);
  const latestSync = await getLatestSkuCatalogRun(accountKey);
  const { where, values } = buildCatalogWhere(query, accountKey);
  const riskOverviewPromise = buildCatalogCostRiskOverview(where, values);
  const countResult = await db.query(
    `select count(*)::integer as total
       from ml.mercadolivre_sku_catalog cat
       left join ml.mercadolivre_sku_costs cst
         on cst.account_key = cat.account_key
        and cst.reference_sku = cat.reference_sku
      where ${where}`,
    values,
  ).catch((error) => {
    if (String(error?.message || "").includes("mercadolivre_sku_catalog")) return { rows: [{ total: 0 }] };
    throw error;
  });
  const total = numberOrZero(countResult.rows[0]?.total);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.max(1, Math.min(page, totalPages));
  const rowsValues = [...values, pageSize, (safePage - 1) * pageSize];
  const rowsResult = await db.query(
    `select
        cat.reference_sku,
        cat.title_sample,
        cat.thumbnail,
        cat.item_count,
        cat.stock_total,
        cat.min_price,
        cat.max_price,
        cat.statuses,
        cat.categories,
        cat.eans,
        cat.sample_mlbs,
        cst.custo_produto_unitario,
        cst.updated_at as cost_updated_at,
        ch30.custo_produto_unitario as previous_cost_30d,
        ph_latest.avg_price as latest_price_snapshot,
        ph_latest.snapshot_date as latest_price_snapshot_date,
        ph30.avg_price as previous_price_30d
       from ml.mercadolivre_sku_catalog cat
       left join ml.mercadolivre_sku_costs cst
         on cst.account_key = cat.account_key
        and cst.reference_sku = cat.reference_sku
       left join lateral (
         select ch.custo_produto_unitario
           from ml.mercadolivre_sku_cost_history ch
          where ch.account_key = cat.account_key
            and ch.reference_sku = cat.reference_sku
            and ch.created_at <= now() - interval '30 days'
          order by ch.created_at desc
          limit 1
       ) ch30 on true
       left join lateral (
         select ph.snapshot_date, avg(ph.price)::numeric(14,2) as avg_price
           from ml.mercadolivre_sku_price_history ph
          where ph.account_key = cat.account_key
            and ph.reference_sku = cat.reference_sku
            and ph.snapshot_date = (
              select max(snapshot_date)
                from ml.mercadolivre_sku_price_history
               where account_key = cat.account_key
                 and reference_sku = cat.reference_sku
            )
          group by ph.snapshot_date
       ) ph_latest on true
       left join lateral (
         select ph.snapshot_date, avg(ph.price)::numeric(14,2) as avg_price
           from ml.mercadolivre_sku_price_history ph
          where ph.account_key = cat.account_key
            and ph.reference_sku = cat.reference_sku
            and ph.snapshot_date = (
              select max(snapshot_date)
                from ml.mercadolivre_sku_price_history
               where account_key = cat.account_key
                 and reference_sku = cat.reference_sku
                 and snapshot_date <= current_date - interval '30 days'
            )
          group by ph.snapshot_date
       ) ph30 on true
      where ${where}
      order by cat.reference_sku asc
      limit $${rowsValues.length - 1}
      offset $${rowsValues.length}`,
    rowsValues,
  );
  const riskOverview = await riskOverviewPromise;

  const items = rowsResult.rows.map((row) => {
    const mlbs = asArray(row.sample_mlbs).map(normalizeString).filter(Boolean);
    const cost = numberOrZero(row.custo_produto_unitario);
    const currentPrice = numberOrZero(row.latest_price_snapshot) || numberOrZero(row.max_price) || numberOrZero(row.min_price);
    const previousPrice30d = numberOrZero(row.previous_price_30d);
    const previousCost30d = numberOrZero(row.previous_cost_30d);
    const costDelta30dPct = previousCost30d > 0 ? percentChange(cost, previousCost30d) : null;
    const priceDelta30dPct = previousPrice30d > 0 ? percentChange(currentPrice, previousPrice30d) : null;
    const estimatedMarginPct =
      currentPrice > 0 && cost > 0 ? roundNumber(((currentPrice - cost) / currentPrice) * 100, 2) : null;
    const riskFlags = [];
    if (costDelta30dPct != null && costDelta30dPct >= 5) riskFlags.push("cost_up");
    if (priceDelta30dPct != null && priceDelta30dPct <= -5) riskFlags.push("price_down");
    if (estimatedMarginPct != null && estimatedMarginPct < 15) riskFlags.push("margin_risk");
    return {
      reference_sku: normalizeSku(row.reference_sku),
      has_reference_sku: true,
      title: row.title_sample || normalizeSku(row.reference_sku),
      thumbnail: row.thumbnail || null,
      eans: asArray(row.eans),
      ean: asArray(row.eans)[0] || "",
      mlbs: mlbs.slice(0, 8),
      all_mlbs: mlbs,
      hidden_mlbs_count: Math.max(0, mlbs.length - 8),
      statuses: asArray(row.statuses),
      categories: asArray(row.categories),
      item_count: numberOrZero(row.item_count),
      min_price: numberOrZero(row.min_price),
      max_price: numberOrZero(row.max_price),
      stock: numberOrZero(row.stock_total),
      cost,
      cost_updated_at: row.cost_updated_at || null,
      cost_status: cost > 0 ? "filled" : "missing",
      latest_price_snapshot: numberOrZero(row.latest_price_snapshot),
      latest_price_snapshot_date: row.latest_price_snapshot_date || null,
      previous_price_30d: previousPrice30d,
      price_delta_30d_pct: priceDelta30dPct,
      previous_cost_30d: previousCost30d,
      cost_delta_30d_pct: costDelta30dPct,
      estimated_margin_pct: estimatedMarginPct,
      risk_flags: riskFlags,
      source: "catalog",
    };
  });

  return {
    success: true,
    summary,
    risk_overview: riskOverview,
    items,
    page: safePage,
    pageSize,
    total,
    totalPages,
    meta: {
      source: "catalog",
      partial: false,
      active_only: true,
      latest_sync: latestSync,
      lookup_type: normalizeCostLookupType(query.lookup_type || query.search_type || "sku"),
    },
  };
}

function pickLatestAtOrBefore(rows = [], targetDate, key = "value") {
  const target = new Date(`${targetDate}T23:59:59`).getTime();
  let picked = null;
  for (const row of rows) {
    const ts = new Date(`${dateOnly(row.date)}T12:00:00`).getTime();
    if (!Number.isFinite(ts) || ts > target) continue;
    picked = row;
  }
  return picked ? numberOrZero(picked[key]) : null;
}

function buildTimelineAlerts({ currentCost, previousCost30, currentPrice, previousPrice30, marginPct }) {
  const alerts = [];
  const costDelta = previousCost30 > 0 ? percentChange(currentCost, previousCost30) : null;
  const priceDelta = previousPrice30 > 0 ? percentChange(currentPrice, previousPrice30) : null;
  if (costDelta != null && costDelta >= 5) {
    alerts.push({
      type: "cost_up",
      tone: costDelta >= 12 ? "danger" : "warn",
      title: "Custo subindo",
      description: `O custo deste SKU subiu ${costDelta.toFixed(1).replace(".", ",")}% nos ultimos 30 dias.`,
    });
  }
  if (priceDelta != null && priceDelta <= -5) {
    alerts.push({
      type: "price_down",
      tone: "danger",
      title: "Preco caindo",
      description: `O preco medio caiu ${Math.abs(priceDelta).toFixed(1).replace(".", ",")}% nos ultimos 30 dias.`,
    });
  }
  if (marginPct != null && marginPct < 15) {
    alerts.push({
      type: "margin_risk",
      tone: marginPct < 5 ? "danger" : "warn",
      title: "Margem em risco",
      description: `A margem estimada simples esta em ${marginPct.toFixed(1).replace(".", ",")}%. Revise preco ou custo antes de anunciar mais.`,
    });
  }
  if (!alerts.length) {
    alerts.push({
      type: "healthy",
      tone: "ok",
      title: "Sem alerta forte",
      description: "Nao encontramos aumento relevante de custo, queda forte de preco ou risco simples de margem para este SKU.",
    });
  }
  return alerts;
}

async function getSkuCostTimeline(query = {}, context = {}) {
  const accountKey = String(context.accountKey || "default");
  const referenceSku = normalizeSku(query.sku || query.reference_sku);
  if (!referenceSku) throw new Error("SKU de referencia e obrigatorio.");
  const days = clampInt(query.days, 30, 365, 180);
  const tax = await getAccountTax(accountKey);

  const [currentCostResult, costHistoryResult, priceHistoryResult, listingsResult] = await Promise.all([
    db.query(
      `select reference_sku, custo_produto_unitario, source, meta, created_at, updated_at
         from ml.mercadolivre_sku_costs
        where account_key = $1
          and reference_sku = $2
        limit 1`,
      [accountKey, referenceSku],
    ),
    db.query(
      `select reference_sku, custo_produto_unitario, source, changed_by, meta, created_at
         from ml.mercadolivre_sku_cost_history
        where account_key = $1
          and reference_sku = $2
          and created_at >= now() - ($3::int * interval '1 day')
        order by created_at asc`,
      [accountKey, referenceSku, days],
    ),
    db.query(
      `select
          snapshot_date,
          avg(price)::numeric(14,2) as avg_price,
          min(price)::numeric(14,2) as min_price,
          max(price)::numeric(14,2) as max_price,
          count(*)::integer as listings_count,
          sum(stock)::integer as stock_total,
          max(captured_at) as captured_at
         from ml.mercadolivre_sku_price_history
        where account_key = $1
          and reference_sku = $2
          and snapshot_date >= current_date - ($3::int * interval '1 day')
        group by snapshot_date
        order by snapshot_date asc`,
      [accountKey, referenceSku, days],
    ),
    db.query(
      `select mlb, variation_id, title, status, category_id, listing_type_id,
              price, stock, thumbnail, permalink, last_synced_at
         from ml.mercadolivre_sku_catalog_items
        where account_key = $1
          and reference_sku = $2
        order by status asc, price desc nulls last, mlb asc
        limit 80`,
      [accountKey, referenceSku],
    ),
  ]).catch((error) => {
    if (
      String(error?.message || "").includes("mercadolivre_sku_price_history") ||
      String(error?.message || "").includes("mercadolivre_sku_catalog_items")
    ) {
      return [{ rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }];
    }
    throw error;
  });

  const currentCostRow = currentCostResult.rows[0] || {};
  const costEvents = costHistoryResult.rows.map((row) => ({
    date: dateOnly(row.created_at),
    datetime: row.created_at,
    value: numberOrZero(row.custo_produto_unitario),
    source: row.source || "manual",
  }));
  if (!costEvents.length && currentCostRow.reference_sku) {
    costEvents.push({
      date: dateOnly(currentCostRow.updated_at || currentCostRow.created_at),
      datetime: currentCostRow.updated_at || currentCostRow.created_at,
      value: numberOrZero(currentCostRow.custo_produto_unitario),
      source: currentCostRow.source || "manual",
    });
  }

  const priceEvents = priceHistoryResult.rows.map((row) => ({
    date: dateOnly(row.snapshot_date),
    value: numberOrZero(row.avg_price),
    min_price: numberOrZero(row.min_price),
    max_price: numberOrZero(row.max_price),
    listings_count: numberOrZero(row.listings_count),
    stock_total: numberOrZero(row.stock_total),
    captured_at: row.captured_at,
  }));

  if (!priceEvents.length && listingsResult.rows.length) {
    const prices = listingsResult.rows.map((row) => numberOrZero(row.price)).filter((value) => value > 0);
    if (prices.length) {
      priceEvents.push({
        date: todayISO(),
        value: roundNumber(prices.reduce((sum, value) => sum + value, 0) / prices.length, 2),
        min_price: Math.min(...prices),
        max_price: Math.max(...prices),
        listings_count: prices.length,
        stock_total: listingsResult.rows.reduce((sum, row) => sum + numberOrZero(row.stock), 0),
        captured_at: new Date().toISOString(),
      });
    }
  }

  const dateSet = new Set([...costEvents.map((row) => row.date), ...priceEvents.map((row) => row.date)].filter(Boolean));
  const sortedDates = Array.from(dateSet).sort();
  const currentCost = numberOrZero(currentCostRow.custo_produto_unitario) || (costEvents.at(-1)?.value || 0);
  const currentPrice = priceEvents.at(-1)?.value || 0;
  const currentDate = sortedDates.at(-1) || todayISO();
  const previousDates = {
    d7: addDaysISO(currentDate, -7),
    d30: addDaysISO(currentDate, -30),
    d90: addDaysISO(currentDate, -90),
  };

  const series = sortedDates.map((date) => {
    const cost = pickLatestAtOrBefore(costEvents, date, "value");
    const price = pickLatestAtOrBefore(priceEvents, date, "value");
    const taxValue = price && tax.enabled ? price * (tax.aliquota / 100) : 0;
    const marginPct = price > 0 && cost != null && cost > 0
      ? roundNumber(((price - cost - taxValue) / price) * 100, 2)
      : null;
    return { date, cost, price, margin_pct: marginPct };
  });

  const currentMarginPct = series.at(-1)?.margin_pct ?? null;
  const previousCost30 = pickLatestAtOrBefore(costEvents, previousDates.d30, "value");
  const previousPrice30 = pickLatestAtOrBefore(priceEvents, previousDates.d30, "value");
  const previousMargin30 = series.find((row) => row.date === previousDates.d30)?.margin_pct ?? null;
  const comparisons = Object.fromEntries(
    Object.entries(previousDates).map(([key, targetDate]) => {
      const prevCost = pickLatestAtOrBefore(costEvents, targetDate, "value");
      const prevPrice = pickLatestAtOrBefore(priceEvents, targetDate, "value");
      return [
        key,
        {
          target_date: targetDate,
          cost: prevCost,
          price: prevPrice,
          cost_delta_pct: prevCost > 0 ? percentChange(currentCost, prevCost) : null,
          price_delta_pct: prevPrice > 0 ? percentChange(currentPrice, prevPrice) : null,
        },
      ];
    }),
  );

  const alerts = buildTimelineAlerts({
    currentCost,
    previousCost30,
    currentPrice,
    previousPrice30,
    marginPct: currentMarginPct,
  });

  const events = [
    ...costEvents.map((row) => ({
      date: row.date,
      datetime: row.datetime,
      type: "cost",
      label: "Custo atualizado",
      value: row.value,
      source: row.source,
    })),
    ...priceEvents.map((row) => ({
      date: row.date,
      datetime: row.captured_at,
      type: "price",
      label: "Preco ML capturado",
      value: row.value,
      listings_count: row.listings_count,
    })),
  ].sort((a, b) => String(b.datetime || b.date).localeCompare(String(a.datetime || a.date))).slice(0, 40);

  const listings = listingsResult.rows.map((row) => ({
    mlb: row.mlb,
    variation_id: row.variation_id || "",
    title: row.title || referenceSku,
    status: row.status || "",
    category_id: row.category_id || "",
    listing_type_id: row.listing_type_id || "",
    price: numberOrZero(row.price),
    stock: numberOrZero(row.stock),
    thumbnail: row.thumbnail || null,
    permalink: row.permalink || null,
    last_synced_at: row.last_synced_at || null,
  }));

  return {
    success: true,
    sku: referenceSku,
    summary: {
      current_cost: currentCost,
      previous_cost_30d: previousCost30,
      cost_delta_30d_pct: previousCost30 > 0 ? percentChange(currentCost, previousCost30) : null,
      current_price: currentPrice,
      previous_price_30d: previousPrice30,
      price_delta_30d_pct: previousPrice30 > 0 ? percentChange(currentPrice, previousPrice30) : null,
      estimated_margin_pct: currentMarginPct,
      margin_delta_30d_pp:
        currentMarginPct != null && previousMargin30 != null
          ? roundNumber(currentMarginPct - previousMargin30, 2)
          : null,
      listings_count: listings.length || priceEvents.at(-1)?.listings_count || 0,
      stock_total: listings.reduce((sum, row) => sum + numberOrZero(row.stock), 0) || priceEvents.at(-1)?.stock_total || 0,
      last_cost_update: currentCostRow.updated_at || costEvents.at(-1)?.datetime || null,
      last_price_snapshot: priceEvents.at(-1)?.date || null,
      tax_rate: tax.enabled ? tax.aliquota : 0,
      diagnosis:
        alerts[0]?.type === "healthy"
          ? "SKU sem alerta relevante no historico recente."
          : alerts.map((alert) => alert.title).join(", "),
    },
    comparisons,
    alerts,
    series,
    events,
    listings,
    meta: {
      days,
      tax_rate: tax.enabled ? tax.aliquota : 0,
      note: "Margem estimada considera preco medio, custo cadastrado e aliquota fiscal. Comissoes e frete ficam na tela de margem.",
    },
  };
}

function paginate(rows, page, pageSize) {
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.max(1, Math.min(page, totalPages));
  return {
    rows: rows.slice((safePage - 1) * pageSize, safePage * pageSize),
    page: safePage,
    pageSize,
    total,
    totalPages,
  };
}

function parseImportRows({ filename, content_base64 }) {
  const buffer = Buffer.from(String(content_base64 || ""), "base64");
  const name = String(filename || "").toLowerCase();
  if (!name.endsWith(".xlsx")) {
    const err = new Error("Formato invalido. Envie uma planilha XLSX (.xlsx).");
    err.status = 400;
    throw err;
  }
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json(sheet, { defval: "", raw: true });
}

function getRowValue(row, names = []) {
  const entries = Object.entries(row || {});
  for (const name of names) {
    const found = entries.find(([key]) => normalizeString(key).toLowerCase() === name);
    if (found) return found[1];
  }
  return "";
}

function toXlsxBuffer(workbook) {
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx", compression: true });
}

function setSheetWidths(sheet, widths = []) {
  sheet["!cols"] = widths.map((wch) => ({ wch }));
  return sheet;
}

function buildCostWorkbook(groups = []) {
  const rows = [];
  for (const group of groups) {
    const mlbs = group.all_mlbs || group.mlbs || [];
    const targets = mlbs.length ? mlbs : [""];
    for (const mlb of targets) {
      rows.push({
        MLB: mlb,
        SKU_REFERENCIA: group.reference_sku || "",
        EAN: (group.eans || []).join("|"),
        PRODUTO: group.title || "",
        STATUS: (group.statuses || []).join("|"),
        CATEGORIA: (group.categories || []).join("|"),
        PRECO_ATUAL: roundNumber(group.min_price, 2),
        CUSTO_PRODUTO: roundNumber(group.cost, 2),
      });
    }
  }
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.json_to_sheet(rows, {
    header: [
      "MLB",
      "SKU_REFERENCIA",
      "EAN",
      "PRODUTO",
      "STATUS",
      "CATEGORIA",
      "PRECO_ATUAL",
      "CUSTO_PRODUTO",
    ],
  });
  setSheetWidths(sheet, [16, 22, 20, 52, 18, 18, 16, 18]);
  XLSX.utils.book_append_sheet(workbook, sheet, "Custos por SKU");
  return workbook;
}

async function buildEanSkuMap(context = {}) {
  const snapshot = await getInventorySnapshot(context, { status: "all" });
  const map = new Map();
  for (const item of snapshot.items || []) {
    const sku = normalizeSku(item.reference_sku);
    if (!sku) continue;
    for (const ean of Array.isArray(item.eans) ? item.eans : []) {
      const normalized = normalizeString(ean).toUpperCase();
      if (normalized && !map.has(normalized)) map.set(normalized, sku);
    }
  }
  return map;
}

function listingFeeCacheKey(item) {
  return JSON.stringify({
    category_id: item.category_id || "",
    listing_type_id: item.listing_type_id || "",
    price: Number(numberOrZero(item.price).toFixed(2)),
  });
}

async function fetchListingFee(item, state) {
  if (!item.category_id || !item.listing_type_id || numberOrZero(item.price) <= 0) {
    return { sale_fee: 0, listing_fee: 0, source: "unavailable" };
  }
  const key = listingFeeCacheKey(item);
  const cached = LISTING_FEE_CACHE.get(key);
  if (cached && now() - cached.createdAt < LISTING_FEE_TTL_MS) return cached.payload;

  const payload = await mlRequest(state, "/sites/MLB/listing_prices", {
    price: Number(numberOrZero(item.price).toFixed(2)),
    category_id: item.category_id,
    listing_type_id: item.listing_type_id,
  }).catch(() => null);

  const row = Array.isArray(payload?.listing_prices)
    ? payload.listing_prices[0]
    : Array.isArray(payload)
      ? payload[0]
      : payload;
  const saleFeeDetails = row?.sale_fee_details && typeof row.sale_fee_details === "object"
    ? row.sale_fee_details
    : {};
  const listingFeeDetails = row?.listing_fee_details && typeof row.listing_fee_details === "object"
    ? row.listing_fee_details
    : {};
  const fee = {
    sale_fee: numberOrZero(row?.sale_fee_amount),
    listing_fee: numberOrZero(row?.listing_fee_amount),
    fixed_fee: numberOrZero(saleFeeDetails?.fixed_fee),
    percentage_fee: saleFeeDetails?.percentage_fee == null
      ? null
      : numberOrZero(saleFeeDetails.percentage_fee),
    meli_percentage_fee: saleFeeDetails?.meli_percentage_fee == null
      ? null
      : numberOrZero(saleFeeDetails.meli_percentage_fee),
    financing_add_on_fee: saleFeeDetails?.financing_add_on_fee == null
      ? null
      : numberOrZero(saleFeeDetails.financing_add_on_fee),
    listing_fixed_fee: listingFeeDetails?.fixed_fee == null
      ? null
      : numberOrZero(listingFeeDetails.fixed_fee),
    source: row ? "listing_prices" : "unavailable",
  };
  LISTING_FEE_CACHE.set(key, { createdAt: now(), payload: fee });
  return fee;
}

function collectShippingOptionRows(payload) {
  const rows = [];
  const push = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach((row) => push(row));
      return;
    }
    if (typeof value === "object") rows.push(value);
  };

  push(payload);
  push(payload?.options);
  push(payload?.shipping_options);
  push(payload?.available_shipping_options);
  push(payload?.results);
  push(payload?.coverage);
  push(payload?.coverage?.all_country);
  push(payload?.coverage?.country);
  push(payload?.coverage?.same_city);
  push(payload?.coverage?.local_pick_up);
  return rows;
}

function pickPreferredCost(values = [], { preferPositive = true } = {}) {
  const nums = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0);
  if (!nums.length) return null;
  if (!preferPositive) return Math.min(...nums);
  const positives = nums.filter((value) => value > 0);
  return positives.length ? Math.min(...positives) : 0;
}

function extractShippingCosts(payload, fallbackFreeShipping = null) {
  const rows = collectShippingOptionRows(payload);
  const sellerCandidates = [];
  const buyerCandidates = [];
  let freeShipping =
    typeof fallbackFreeShipping === "boolean" ? fallbackFreeShipping : null;

  for (const row of rows) {
    if (row?.free_shipping != null) freeShipping = !!row.free_shipping;
    sellerCandidates.push(
      row?.seller_cost,
      row?.seller_shipping_cost,
      row?.sender_cost,
      row?.list_cost,
      row?.base_cost,
      row?.coverage?.all_country?.list_cost,
      row?.coverage?.all_country?.cost,
      row?.coverage?.country?.list_cost,
      row?.coverage?.country?.cost,
      row?.coverage?.same_city?.list_cost,
      row?.coverage?.same_city?.cost,
    );
    buyerCandidates.push(
      row?.buyer_cost,
      row?.cost,
      row?.receiver_cost,
      row?.final_cost,
      row?.amount,
      row?.coverage?.all_country?.cost,
      row?.coverage?.country?.cost,
      row?.coverage?.same_city?.cost,
    );
  }

  const sellerCost = pickPreferredCost(sellerCandidates, { preferPositive: true });
  const buyerCost = pickPreferredCost(buyerCandidates, { preferPositive: false });
  return {
    seller_cost: Number.isFinite(sellerCost) ? sellerCost : null,
    buyer_cost: Number.isFinite(buyerCost) ? buyerCost : null,
    free_shipping:
      typeof freeShipping === "boolean" ? freeShipping : fallbackFreeShipping,
  };
}

function shippingTariffCacheKey(item, sellerId) {
  return JSON.stringify({
    sellerId: String(sellerId || item.seller_id || ""),
    item_id: item.item_id || "",
    price: Number(numberOrZero(item.price).toFixed(2)),
    listing_type_id: item.listing_type_id || "",
    logistic_type: item.logistic_type || "",
  });
}

async function fetchShippingTariff(item, state, seller = {}) {
  if (!item?.free_shipping) {
    return { seller_cost: 0, buyer_cost: 0, source: "buyer_paid" };
  }

  const key = shippingTariffCacheKey(item, seller.id);
  const cached = SHIPPING_TARIFF_CACHE.get(key);
  if (cached && now() - cached.createdAt < SHIPPING_TARIFF_TTL_MS) return cached.payload;

  const attempts = [];
  const sellerId = seller.id || item.seller_id;
  if (sellerId && item.shipping_mode === "me2") {
    attempts.push({
      source: "users_shipping_options_free",
      path: `/users/${encodeURIComponent(String(sellerId))}/shipping_options/free`,
      query: {
        item_id: item.item_id,
        mode: "me2",
        free_shipping: true,
        item_price: Number(numberOrZero(item.price).toFixed(2)),
        listing_type_id: item.listing_type_id,
        logistic_type: item.logistic_type,
      },
    });
  }
  attempts.push({
    source: "items_shipping_options_free",
    path: `/items/${encodeURIComponent(String(item.item_id))}/shipping_options/free`,
    query: {},
  });

  for (const attempt of attempts) {
    const payload = await mlRequest(state, attempt.path, attempt.query, 1).catch(() => null);
    const extracted = payload ? extractShippingCosts(payload, true) : null;
    if (Number.isFinite(Number(extracted?.seller_cost))) {
      const out = {
        seller_cost: numberOrZero(extracted.seller_cost),
        buyer_cost: numberOrZero(extracted.buyer_cost),
        source: attempt.source,
      };
      SHIPPING_TARIFF_CACHE.set(key, { createdAt: now(), payload: out });
      return out;
    }
  }

  const out = { seller_cost: 0, buyer_cost: 0, source: "unavailable" };
  SHIPPING_TARIFF_CACHE.set(key, { createdAt: now(), payload: out });
  return out;
}

function classifyMargin(row) {
  if (!row.has_cost) return "sem_custo";
  if (row.margin_value < 0) return "negativa";
  if (row.margin_pct < 10) return "baixa";
  if (row.margin_pct < 20) return "atencao";
  return "saudavel";
}

function toMlDateTime(date, end = false) {
  return `${date}T${end ? "23:59:59.999" : "00:00:00.000"}-03:00`;
}

function resolveOrderDateField(query = {}) {
  return String(query.date_field || query.dateField || "closed").trim().toLowerCase() === "created"
    ? "created"
    : "closed";
}

function pickShipmentId(order = {}) {
  return (
    order?.shipping?.id ||
    order?.shipping?.shipment_id ||
    order?.shipping_id ||
    null
  );
}

function pickNested(obj, paths = []) {
  for (const path of paths) {
    const value = String(path)
      .split(".")
      .reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
    if (value != null && value !== "") return value;
  }
  return null;
}

function normalizeLogisticType(detail = {}) {
  const raw = pickNested(detail, [
    "logistic.type",
    "logistic_type",
    "shipping.logistic_type",
    "shipping.shipping_option.logistic_type",
    "shipping_mode",
  ]);
  return normalizeString(raw).toLowerCase();
}

function isColetasLogistic(logisticType) {
  return ["cross_docking", "xd_drop_off", "self_service"].includes(
    normalizeString(logisticType).toLowerCase(),
  );
}

function findSenderCostNode(costPayload = {}, sellerId = null) {
  const senders = Array.isArray(costPayload?.senders) ? costPayload.senders : [];
  if (!senders.length) return null;
  if (sellerId != null) {
    const bySeller = senders.find((sender) => Number(sender?.user_id) === Number(sellerId));
    if (bySeller) return bySeller;
  }
  return senders[0];
}

function extractOrderItems(order = {}) {
  return (Array.isArray(order?.order_items) ? order.order_items : []).map((row) => {
    const itemId = normalizeString(row?.item?.id || row?.item_id).toUpperCase();
    const quantity = Math.max(1, numberOrZero(row?.quantity));
    const unitPrice = numberOrZero(row?.unit_price);
    return {
      item_id: itemId,
      title: row?.item?.title || itemId,
      variation_id: normalizeString(row?.item?.variation_id || row?.variation_id),
      sku_hint: normalizeSku(
        row?.item?.seller_sku ||
          row?.item?.seller_custom_field ||
          row?.seller_sku ||
          row?.seller_custom_field,
      ),
      quantity,
      unit_price: unitPrice,
      revenue: unitPrice * quantity,
      sale_fee: numberOrZero(row?.sale_fee) * quantity,
    };
  }).filter((row) => row.item_id);
}

function getCompositeOrderSkuAliases(value) {
  const sku = normalizeSku(value);
  if (!sku || !sku.includes("-")) return [];

  const parts = sku.split("-").map((part) => normalizeSku(part)).filter(Boolean);
  if (parts.length < 2) return [];

  // No ERP da Davantti algumas orders do ML gravam seller_sku no formato
  // <SKU_REFERENCIA>-<COMPLEMENTO/VARIACAO>, por exemplo 106307-105929,
  // enquanto Custos por SKU persiste o custo em 106307. O fallback e
  // propositalmente conservador: so considera o primeiro bloco quando ele e
  // um codigo numerico de referencia. A escolha final ainda exige custo
  // cadastrado ou confirmacao pelo catalogo do mesmo MLB.
  const base = parts[0];
  if (/^\d{3,}$/.test(base)) return [base];
  return [];
}

function resolveOrderItemSkuCandidates(orderItem = {}, itemDetail = {}, catalogCandidates = []) {
  const candidates = [];
  const push = (value) => {
    const sku = normalizeSku(value);
    if (sku && !candidates.includes(sku)) candidates.push(sku);
  };

  // O SKU gravado na order e a primeira referencia, mas pode ser historico,
  // legado ou diferente do SKU atualmente sincronizado no anuncio.
  push(orderItem.sku_hint);
  getCompositeOrderSkuAliases(orderItem.sku_hint).forEach(push);

  const variationId = normalizeString(orderItem.variation_id);
  if (variationId) {
    const variationRows = Array.isArray(itemDetail?.variation_skus) ? itemDetail.variation_skus : [];
    variationRows
      .filter((row) => normalizeString(row?.variation_id) === variationId)
      .forEach((row) => push(row?.reference_sku));

    // O catalogo persistido e a ponte entre o MLB/variacao e o SKU usado na
    // tela Custos por SKU. Prioriza o mesmo variation_id quando disponivel.
    (Array.isArray(catalogCandidates) ? catalogCandidates : [])
      .filter((row) => normalizeString(row?.variation_id) === variationId)
      .forEach((row) => push(row?.reference_sku));
  }

  push(itemDetail?.reference_sku);

  // Sem uma variacao identificada, so usamos listas agregadas quando apontam
  // para um unico SKU. Assim nao atribuimos o custo de outra variacao por engano.
  const referenceValues = Array.from(new Set(
    (Array.isArray(itemDetail?.reference_skus) ? itemDetail.reference_skus : [])
      .map(normalizeSku)
      .filter(Boolean),
  ));
  if (referenceValues.length === 1) push(referenceValues[0]);

  const catalogUnique = Array.from(new Set(
    (Array.isArray(catalogCandidates) ? catalogCandidates : [])
      .map((row) => normalizeSku(row?.reference_sku))
      .filter(Boolean),
  ));
  if (catalogUnique.length === 1) push(catalogUnique[0]);
  return candidates;
}

function resolveOrderItemSku(orderItem = {}, itemDetail = {}, costMap = null, catalogCandidates = []) {
  const candidates = resolveOrderItemSkuCandidates(orderItem, itemDetail, catalogCandidates);
  if (!candidates.length) return "";

  // Se mais de um SKU puder representar a mesma venda, escolhemos primeiro o
  // que realmente possui custo preenchido. Isso evita CMV zero quando a order
  // carrega um SKU antigo/composto e Custos por SKU esta preenchido no SKU atual.
  if (costMap instanceof Map) {
    const withPositiveCost = candidates.find((sku) => numberOrZero(costMap.get(sku)?.cost) > 0);
    if (withPositiveCost) return withPositiveCost;
    const withEntry = candidates.find((sku) => costMap.has(sku));
    if (withEntry) return withEntry;
  }

  return candidates[0];
}


function resolveOrderItemCatalogCostFallback(orderItem = {}, catalogCostCandidates = []) {
  const rows = (Array.isArray(catalogCostCandidates) ? catalogCostCandidates : [])
    .map((row) => ({
      reference_sku: normalizeSku(row?.reference_sku),
      variation_id: normalizeString(row?.variation_id),
      cost: numberOrZero(row?.cost),
      updated_at: row?.updated_at || null,
    }))
    .filter((row) => row.reference_sku && row.cost > 0);

  if (!rows.length) return null;

  const orderSku = normalizeSku(orderItem?.sku_hint);
  const aliases = new Set([orderSku, ...getCompositeOrderSkuAliases(orderSku)].filter(Boolean));

  // 1) Quando o seller_sku da order e composto (ex. 106307-105929),
  //    o SKU-base 106307 prevalece se o proprio MLB estiver vinculado a ele.
  const bySkuAlias = rows.find((row) => aliases.has(row.reference_sku));
  if (bySkuAlias) return bySkuAlias;

  // 2) Se a order informou variation_id, so aceitamos o custo da mesma variacao.
  const variationId = normalizeString(orderItem?.variation_id);
  if (variationId) {
    const exactVariation = rows.filter((row) => row.variation_id === variationId);
    const exactSkus = Array.from(new Set(exactVariation.map((row) => row.reference_sku)));
    if (exactSkus.length === 1) {
      return exactVariation.find((row) => row.reference_sku === exactSkus[0]) || null;
    }
  }

  // 3) Orders antigas do ML podem vir com variation_id vazio. Nesse caso,
  //    o fallback pelo MLB so e seguro quando todas as linhas com custo positivo
  //    daquele MLB convergem para um unico SKU de referencia.
  const uniqueSkus = Array.from(new Set(rows.map((row) => row.reference_sku)));
  if (uniqueSkus.length === 1) {
    return rows.find((row) => row.reference_sku === uniqueSkus[0]) || null;
  }

  return null;
}

function buildOrderDiscountBreakdown(payload = {}) {
  const details = [
    ...(Array.isArray(payload?.details) ? payload.details : []),
    ...(Array.isArray(payload?.discounts) ? payload.discounts : []),
    ...(Array.isArray(payload?.coupon) ? payload.coupon : []),
  ];
  const candidates = details.length ? details : [payload?.coupon, payload?.discount].filter(Boolean);
  return candidates.reduce((acc, entry) => {
    const type = normalizeString(
      entry?.type || entry?.discount_type || entry?.promotion_type || entry?.campaign_type,
    ).toLowerCase();
    const isCoupon = type.includes("coupon") || type.includes("cupom");
    const items = Array.isArray(entry?.items) ? entry.items : [];
    const hasSellerAmount = items.some((item) => item?.amounts?.seller != null);
    const itemTotal = items.reduce((sum, item) => sum + numberOrZero(item?.amounts?.total), 0);
    const itemSeller = items.reduce((sum, item) => sum + numberOrZero(item?.amounts?.seller), 0);
    const total =
      itemTotal ||
      numberOrZero(
        entry?.amounts?.total ??
          entry?.amount ??
          entry?.value ??
          entry?.total ??
          entry?.discount_amount,
      );
    const sellerAmount =
      hasSellerAmount
        ? itemSeller
        : isCoupon
          ? total
          : numberOrZero(entry?.amounts?.seller ?? entry?.seller_amount);
    const rebateAmount = Math.max(0, total - sellerAmount);

    acc.seller_coupon_discount += isCoupon ? sellerAmount : 0;
    acc.meli_rebate += rebateAmount;
    // Descontos promocionais nao-cupom ja estao refletidos no unit_price da order.
    // Guardamos apenas para auditoria; nunca devem ser abatidos novamente da margem.
    acc.embedded_seller_discount += isCoupon ? 0 : sellerAmount;
    return acc;
  }, { seller_coupon_discount: 0, meli_rebate: 0, embedded_seller_discount: 0 });
}

function buildOrderSearchQuery(sellerId, range, limit, offset, dateField = "closed", status = null) {
  const normalizedDateField = dateField === "created" ? "created" : "closed";
  const fromField = normalizedDateField === "created" ? "order.date_created.from" : "order.date_closed.from";
  const toField = normalizedDateField === "created" ? "order.date_created.to" : "order.date_closed.to";
  const query = {
    seller: sellerId,
    [fromField]: toMlDateTime(range.date_from, false),
    [toField]: toMlDateTime(range.date_to, true),
    sort: "date_desc",
    limit,
    offset,
  };
  if (normalizeString(status)) query["order.status"] = status;
  return query;
}

function dedupeOrdersById(rows = []) {
  const byId = new Map();
  for (const order of rows) {
    const key = normalizeString(order?.id);
    if (!key) continue;
    const current = byId.get(key);
    const currentUpdatedAt = Date.parse(current?.last_updated || "") || 0;
    const nextUpdatedAt = Date.parse(order?.last_updated || "") || 0;
    if (!current || nextUpdatedAt >= currentUpdatedAt) byId.set(key, order);
  }
  return Array.from(byId.values());
}

async function fetchOrdersByStatus(state, sellerId, range, limit, dateField = "closed", status = "paid") {
  const rows = [];
  const pageSize = Math.min(50, Math.max(1, limit));
  let totalAvailable = 0;

  for (let offset = 0; rows.length < limit; offset += pageSize) {
    const payload = await mlRequest(
      state,
      "/orders/search",
      buildOrderSearchQuery(sellerId, range, pageSize, offset, dateField, status),
    ).catch(() => null);
    const batch = Array.isArray(payload?.results) ? payload.results : [];
    totalAvailable = Math.max(totalAvailable, numberOrZero(payload?.paging?.total));
    rows.push(...batch);
    if (!batch.length || batch.length < pageSize) break;
  }
  const limitedRows = rows.slice(0, limit);
  limitedRows.total_available = totalAvailable || limitedRows.length;
  return limitedRows;
}

async function fetchPaidOrders(state, sellerId, range, limit, dateField = "closed") {
  return fetchOrdersByStatus(state, sellerId, range, limit, dateField, "paid");
}

async function fetchAllOrders(state, sellerId, range, limit, dateField = "created") {
  const rows = [];
  const pageSize = Math.min(50, Math.max(1, limit));
  let totalAvailable = 0;

  for (let offset = 0; offset < limit; offset += pageSize) {
    const payload = await mlRequest(
      state,
      "/orders/search",
      buildOrderSearchQuery(sellerId, range, pageSize, offset, dateField),
    ).catch(() => null);
    const batch = Array.isArray(payload?.results) ? payload.results : [];
    totalAvailable = Math.max(totalAvailable, numberOrZero(payload?.paging?.total));
    rows.push(...batch);
    if (!batch.length || batch.length < pageSize) break;
  }

  const output = dedupeOrdersById(rows).slice(0, limit);
  output.total_available = totalAvailable || output.length;
  return output;
}

async function fetchOrdersByStatuses(state, sellerId, range, limit, dateField, statuses = []) {
  const byId = new Map();
  let totalAvailable = 0;
  for (const status of statuses) {
    const rows = await fetchOrdersByStatus(
      state,
      sellerId,
      range,
      limit,
      dateField,
      status,
    ).catch(() => []);
    totalAvailable += numberOrZero(rows.total_available) || rows.length;
    rows.forEach((order) => {
      const key = normalizeString(order?.id);
      if (key && !byId.has(key)) byId.set(key, order);
    });
  }
  const output = Array.from(byId.values()).slice(0, limit);
  output.total_available = totalAvailable || output.length;
  return output;
}

function summarizeOrderRevenue(orders = []) {
  const orderIds = new Set();
  let revenue = 0;
  let units = 0;
  for (const order of orders) {
    if (order?.id) orderIds.add(String(order.id));
    const items = extractOrderItems(order);
    revenue += items.reduce((sum, row) => sum + numberOrZero(row.revenue), 0);
    units += items.reduce((sum, row) => sum + numberOrZero(row.quantity), 0);
  }
  return {
    revenue: Number(revenue.toFixed(2)),
    orders: orderIds.size || orders.length,
    units: Number(units.toFixed(0)),
    available: numberOrZero(orders.total_available) || orders.length,
  };
}

async function fetchGrossAdjustmentSummary(state, sellerId, range, limit, dateField = "closed") {
  const [cancelledOrders, returnedOrders] = await Promise.all([
    fetchOrdersByStatuses(state, sellerId, range, limit, dateField, ["cancelled", "canceled"]),
    fetchOrdersByStatuses(state, sellerId, range, limit, dateField, [
      "refunded",
      "partially_refunded",
      "returned",
    ]),
  ]);
  const cancelled = summarizeOrderRevenue(cancelledOrders);
  const returned = summarizeOrderRevenue(returnedOrders);
  return {
    cancelled_revenue: cancelled.revenue,
    cancelled_orders: cancelled.orders,
    cancelled_units: cancelled.units,
    cancelled_available: cancelled.available,
    returned_revenue: returned.revenue,
    returned_orders: returned.orders,
    returned_units: returned.units,
    returned_available: returned.available,
  };
}

async function fetchOrderDiscount(state, orderId) {
  if (!orderId) return { seller_coupon_discount: 0, meli_rebate: 0, embedded_seller_discount: 0 };
  const key = String(orderId);
  const cached = ORDER_DISCOUNT_CACHE.get(key);
  if (cached && now() - cached.createdAt < ORDER_DISCOUNT_TTL_MS) return cached.payload;

  const payload = await mlRequest(
    state,
    `/orders/${encodeURIComponent(key)}/discounts`,
    {},
    1,
  ).catch(() => null);
  const out = payload
    ? buildOrderDiscountBreakdown(payload)
    : { seller_coupon_discount: 0, meli_rebate: 0, embedded_seller_discount: 0 };
  ORDER_DISCOUNT_CACHE.set(key, { createdAt: now(), payload: out });
  return out;
}

async function fetchShipmentCosts(state, shipmentId, sellerId) {
  if (!shipmentId) return { buyer_shipping: 0, seller_cost: 0, logistic_type: "" };
  const key = `${String(sellerId || "")}:${String(shipmentId)}`;
  const cached = SHIPMENT_COST_CACHE.get(key);
  if (cached && now() - cached.createdAt < SHIPMENT_COST_TTL_MS) return cached.payload;

  const [shipment, costs] = await Promise.all([
    mlRequest(state, `/shipments/${encodeURIComponent(String(shipmentId))}`, {}, 1).catch(() => null),
    mlRequest(state, `/shipments/${encodeURIComponent(String(shipmentId))}/costs`, {}, 1).catch(() => null),
  ]);
  const sender = findSenderCostNode(costs, sellerId);
  const out = {
    buyer_shipping: numberOrZero(costs?.receiver?.cost),
    seller_cost: numberOrZero(sender?.cost),
    logistic_type: normalizeLogisticType(shipment || costs || {}),
    status: normalizeString(shipment?.status),
    substatus: normalizeString(shipment?.substatus || shipment?.sub_status),
    tags: Array.isArray(shipment?.tags) ? shipment.tags : [],
  };
  SHIPMENT_COST_CACHE.set(key, { createdAt: now(), payload: out });
  return out;
}

function addAllocatedMetric(map, itemId, patch = {}) {
  const key = normalizeString(itemId).toUpperCase();
  if (!key) return;
  const current =
    map.get(key) || {
      sold_units: 0,
      sold_revenue: 0,
      buyer_shipping_paid: 0,
      collection_shipping_fee: 0,
      shipping_tariff: 0,
      coupon_discount: 0,
      embedded_seller_discount: 0,
      meli_rebate: 0,
    };
  Object.entries(patch).forEach(([field, value]) => {
    current[field] = numberOrZero(current[field]) + numberOrZero(value);
  });
  map.set(key, current);
}

async function buildOrderFinancials({
  state,
  seller,
  range,
  itemIds,
  limit,
  itemsById,
  costMap,
  taxPct,
  dateField = "closed",
  status = "all",
  accountKey = null,
  ordersOverride = null,
  includeGrossAdjustments = true,
  summaryOnly = false,
  batchSize = 4,
}) {
  const idSet = new Set(Array.from(itemIds || []).map((id) => normalizeString(id).toUpperCase()));
  const hasItemFilter = idSet.size > 0;
  const detailMap = new Map(itemsById || []);
  const byItem = new Map();
  const ordersRows = [];
  const summary = {
    period_revenue: 0,
    gross_revenue: 0,
    cancelled_revenue: 0,
    returned_revenue: 0,
    product_cost: 0,
    commissions: 0,
    tax_base: 0,
    taxes: 0,
    shipping_tariff: 0,
    total_costs: 0,
    profit: 0,
    margin_pct: 0,
    buyer_shipping_paid: 0,
    collection_shipping_fee: 0,
    seller_coupon_discount: 0,
    embedded_seller_discount: 0,
    meli_rebate: 0,
    orders_scanned: 0,
    orders_available: 0,
    orders_matched: 0,
    cancelled_orders: 0,
    returned_orders: 0,
    coupons_available: true,
    cost_lines_total: 0,
    cost_lines_with_cost: 0,
    missing_cost_lines: 0,
  };

  if (!seller?.id || limit <= 0) return { summary, byItem, orders: ordersRows };

  const emptyAdjustments = {
    cancelled_revenue: 0,
    cancelled_orders: 0,
    cancelled_units: 0,
    cancelled_available: 0,
    returned_revenue: 0,
    returned_orders: 0,
    returned_units: 0,
    returned_available: 0,
  };
  const [orders, grossAdjustments] = await Promise.all([
    Array.isArray(ordersOverride)
      ? Promise.resolve(ordersOverride.slice(0, limit))
      : fetchPaidOrders(state, seller.id, range, limit, dateField),
    includeGrossAdjustments
      ? fetchGrossAdjustmentSummary(state, seller.id, range, limit, dateField).catch(() => emptyAdjustments)
      : Promise.resolve(emptyAdjustments),
  ]);
  Object.assign(summary, grossAdjustments);
  summary.orders_scanned = orders.length;
  summary.orders_available = numberOrZero(orders.total_available) || orders.length;
  const preparedOrders = [];
  const soldItemIds = new Set();

  for (const order of orders) {
    const allItems = extractOrderItems(order);
    const items = allItems.filter((row) =>
      hasItemFilter ? idSet.has(row.item_id) : true,
    );
    if (!items.length) continue;
    items.forEach((row) => soldItemIds.add(row.item_id));
    preparedOrders.push({ order, items, allItems });
  }

  const missingDetailIds = Array.from(soldItemIds).filter((id) => !detailMap.has(id));
  if (missingDetailIds.length) {
    const details = await fetchItemDetails(state, missingDetailIds).catch(() => []);
    details.forEach((item) => {
      detailMap.set(normalizeString(item.item_id).toUpperCase(), item);
    });
  }

  for (const { items } of preparedOrders) {
    items.forEach((row) => {
      if (!detailMap.has(row.item_id)) {
        detailMap.set(row.item_id, {
          item_id: row.item_id,
          title: row.title || row.item_id,
          reference_sku: "",
          reference_skus: [],
          variation_skus: [],
          status: null,
        });
      }
    });
  }

  const catalogSkuCandidates = await getCatalogSkuCandidatesByMlb(
    accountKey,
    Array.from(soldItemIds),
  ).catch(() => new Map());
  const catalogCostCandidates = await getCatalogCostCandidatesByMlb(
    accountKey,
    Array.from(soldItemIds),
  ).catch(() => new Map());

  const effectiveCostMap = new Map(costMap || []);
  const soldSkus = Array.from(new Set(
    preparedOrders.flatMap(({ items }) =>
      items.flatMap((row) => resolveOrderItemSkuCandidates(
        row,
        detailMap.get(row.item_id),
        catalogSkuCandidates.get(row.item_id) || [],
      )),
    ),
  ));
  const missingCostSkus = soldSkus.filter((sku) => !effectiveCostMap.has(sku));
  if (missingCostSkus.length && accountKey) {
    const extraCostMap = await getSkuCostMap(accountKey, missingCostSkus).catch(() => new Map());
    extraCostMap.forEach((value, key) => effectiveCostMap.set(key, value));
  }

  const statusFilter = normalizeStatus(status);
  const taxRate = Math.max(0, numberOrZero(taxPct) / 100);

  const effectiveBatchSize = Math.max(1, Math.min(16, Number(batchSize) || 4));
  for (let i = 0; i < preparedOrders.length; i += effectiveBatchSize) {
    const batch = preparedOrders.slice(i, i + effectiveBatchSize);
    await Promise.all(
      batch.map(async ({ order, items: rawItems, allItems: rawAllItems }) => {
        const orderId = order?.id;
        const items = rawItems.filter((row) => {
          if (statusFilter === "all") return true;
          const itemStatus = normalizeString(detailMap.get(row.item_id)?.status).toLowerCase();
          return !itemStatus || itemStatus === statusFilter;
        });
        if (!items.length) return;

        summary.orders_matched += 1;
        const revenueBase = items.reduce((sum, row) => sum + numberOrZero(row.revenue), 0);
        const fullOrderRevenue = (Array.isArray(rawAllItems) ? rawAllItems : items)
          .reduce((sum, row) => sum + numberOrZero(row.revenue), 0);
        const selectionRatio = fullOrderRevenue > 0
          ? Math.max(0, Math.min(1, revenueBase / fullOrderRevenue))
          : 1;
        const totalUnits = items.reduce((sum, row) => sum + Math.max(1, numberOrZero(row.quantity)), 0);
        const shipmentId = pickShipmentId(order);
        const [shipment, discounts] = await Promise.all([
          fetchShipmentCosts(state, shipmentId, seller.id).catch(() => ({
            buyer_shipping: numberOrZero(
              pickNested(order, ["shipping.cost", "shipping.cost_to_buyer", "shipping.base_cost"]),
            ),
            seller_cost: 0,
            logistic_type: normalizeLogisticType(order),
            status: normalizeString(order?.shipping?.status),
            substatus: normalizeString(order?.shipping?.substatus || order?.shipping?.sub_status),
            tags: Array.isArray(order?.shipping?.tags) ? order.shipping.tags : [],
          })),
          fetchOrderDiscount(state, orderId).catch(() => {
            summary.coupons_available = false;
            return { seller_coupon_discount: 0, meli_rebate: 0, embedded_seller_discount: 0 };
          }),
        ]);
        // Valores de pedido/shipment sao de nivel da order. Quando a consulta esta
        // filtrando apenas parte dos itens, alocamos proporcionalmente para nao
        // atribuir o frete/cupom inteiro a um subconjunto da venda.
        const sellerCouponDiscountFull = numberOrZero(discounts.seller_coupon_discount);
        const coupon = roundNumber(sellerCouponDiscountFull * selectionRatio, 2);
        // Rebate/estorno do ML e informativo: order_items[].sale_fee ja representa
        // a tarifa efetivamente cobrada (liquida). Nao somar novamente no resultado.
        const rebate = roundNumber(numberOrZero(discounts.meli_rebate) * selectionRatio, 2);
        const embeddedSellerDiscount = roundNumber(
          numberOrZero(discounts.embedded_seller_discount) * selectionRatio,
          2,
        );
        const buyerShippingFull = numberOrZero(shipment.buyer_shipping);
        const shippingTariffFull = numberOrZero(shipment.seller_cost);
        const buyerShipping = roundNumber(buyerShippingFull * selectionRatio, 2);
        const shippingTariff = roundNumber(shippingTariffFull * selectionRatio, 2);
        const collectionFee = isColetasLogistic(shipment.logistic_type)
          ? shippingTariff
          : 0;

        const resolvedItems = items.map((row) => {
          const item = detailMap.get(row.item_id) || {};
          const aliases = catalogSkuCandidates.get(row.item_id) || [];
          const directCatalogCosts = catalogCostCandidates.get(row.item_id) || [];
          const skuCandidates = resolveOrderItemSkuCandidates(row, item, aliases);
          let sku = resolveOrderItemSku(row, item, effectiveCostMap, aliases);
          let unitCost = sku ? numberOrZero(effectiveCostMap.get(sku)?.cost) : 0;
          let costResolution = unitCost > 0 ? "sku_cost_map" : "missing";

          // Fallback definitivo para orders antigas/variacoes em que o ML grava
          // seller_sku composto e/ou variation_id vazio. O vinculo e feito pelo
          // proprio MLB no catalogo persistido e so e aceito quando e seguro.
          if (unitCost <= 0) {
            const fallback = resolveOrderItemCatalogCostFallback(row, directCatalogCosts);
            if (fallback?.reference_sku && numberOrZero(fallback.cost) > 0) {
              sku = normalizeSku(fallback.reference_sku);
              unitCost = numberOrZero(fallback.cost);
              costResolution = "mlb_catalog_cost";
              if (!skuCandidates.includes(sku)) skuCandidates.push(sku);
              if (!effectiveCostMap.has(sku)) {
                effectiveCostMap.set(sku, {
                  cost: unitCost,
                  updated_at: fallback.updated_at || null,
                });
              }
            }
          }

          return {
            ...row,
            sku,
            sku_hint_original: normalizeSku(row.sku_hint),
            sku_candidates: skuCandidates,
            cost_resolution: costResolution,
            item,
            unit_cost: unitCost,
            cost_total: unitCost * numberOrZero(row.quantity),
            has_cost: Boolean(sku && unitCost > 0),
          };
        });
        const productCost = roundNumber(
          resolvedItems.reduce((sum, row) => sum + numberOrZero(row.cost_total), 0),
          2,
        );
        const commissions = roundNumber(
          resolvedItems.reduce((sum, row) => sum + numberOrZero(row.sale_fee), 0),
          2,
        );

        // GMV e Base imposto partem do total bruto do pedido: produtos +
        // frete pago pelo comprador. `order.total_amount` e a fonte primaria
        // para o valor dos produtos; quando ausente, usamos a soma dos itens.
        // Em consultas filtradas por item, o total e alocado proporcionalmente.
        const orderProductTotal = numberOrZero(order?.total_amount) || fullOrderRevenue || revenueBase;
        const fullGrossOrderGmv = Math.max(0, orderProductTotal + buyerShippingFull);
        const fullTaxBase = fullGrossOrderGmv;
        const taxBase = roundNumber(fullTaxBase * selectionRatio, 2);
        const taxes = taxRate > 0 ? roundNumber(taxBase * taxRate, 2) : 0;

        // unit_price ja e o preco promocional. Somente cupom do vendedor aplicado
        // no checkout e uma deducao adicional a receita exibida em unit_price.
        const sellerCheckoutDiscounts = coupon;
        const totalCosts = roundNumber(
          productCost + commissions + taxes + shippingTariff + sellerCheckoutDiscounts,
          2,
        );
        const realizedGmv = resolveRealizedGmv({
          orderProductTotal,
          fullOrderRevenue,
          revenueBase,
          buyerShippingFull,
          selectionRatio,
          totalCosts,
        });
        const profit = realizedGmv.profit;
        const marginPct = realizedGmv.marginPct;
        const commissionRate = revenueBase > 0
          ? Math.max(0, Math.min(0.95, commissions / revenueBase))
          : 0;
        const variableRate = commissionRate + taxRate;
        // O frete pago pelo comprador compoe o GMV bruto e a base fiscal.
        // Para o equilibrio do preco do produto, apenas a parcela tributaria
        // desse frete entra como custo fixo adicional.
        const taxBaseExtra = Math.max(0, taxBase - revenueBase);
        const fixedBreakEvenCosts = productCost + shippingTariff + sellerCheckoutDiscounts + (taxBaseExtra * taxRate);
        const breakEvenTotal = variableRate < 0.99
          ? Math.max(0, fixedBreakEvenCosts / (1 - variableRate))
          : 0;
        const soldUnitPrice = totalUnits > 0 ? revenueBase / totalUnits : 0;
        const equilibriumUnit = totalUnits > 0 ? breakEvenTotal / totalUnits : 0;
        const bufferUnit = soldUnitPrice - equilibriumUnit;
        const missingCostItems = resolvedItems.filter((row) => !row.has_cost).length;
        summary.cost_lines_total += resolvedItems.length;
        summary.cost_lines_with_cost += Math.max(0, resolvedItems.length - missingCostItems);
        summary.missing_cost_lines += missingCostItems;

        summary.period_revenue += realizedGmv.gmv;
        summary.product_cost += productCost;
        summary.commissions += commissions;
        summary.tax_base += taxBase;
        summary.taxes += taxes;
        summary.shipping_tariff += shippingTariff;
        summary.buyer_shipping_paid += buyerShipping;
        summary.collection_shipping_fee += collectionFee;
        summary.seller_coupon_discount += coupon;
        summary.embedded_seller_discount += embeddedSellerDiscount;
        summary.meli_rebate += rebate;
        summary.total_costs += totalCosts;
        summary.profit += profit;

        if (!summaryOnly) ordersRows.push({
          order_id: String(orderId || ""),
          date_created: dateField === "created"
            ? order?.date_created || order?.date_closed || null
            : order?.date_closed || order?.date_created || null,
          date_closed: order?.date_closed || null,
          lifecycle_status: orderLifecycleStatus(order, shipment),
          order_items: resolvedItems.map((row) => ({
            mlb: row.item_id,
            variation_id: row.variation_id || "",
            sku: row.sku || "",
            sku_venda_original: row.sku_hint_original || "",
            sku_candidates: Array.isArray(row.sku_candidates) ? row.sku_candidates : [],
            cost_resolution: row.cost_resolution || (row.has_cost ? "sku_cost_map" : "missing"),
            title: row.item?.title || row.title || row.item_id,
            quantity: numberOrZero(row.quantity),
            unit_price: roundNumber(row.unit_price, 2),
            unit_cost: roundNumber(row.unit_cost, 2),
            has_cost: row.has_cost,
          })),
          items_label: resolvedItems
            .map((row) => row.item?.title || row.title || row.item_id)
            .slice(0, 2)
            .join(" | "),
          item_count: resolvedItems.length,
          total_units: Number(totalUnits.toFixed(0)),
          has_cost: missingCostItems === 0,
          missing_cost_items: missingCostItems,
          logistic_type: shipment.logistic_type || normalizeLogisticType(order),
          shipping_mode:
            shippingTariff > 0 ? "Frete gratis" : buyerShipping > 0 ? "Comprador paga" : "-",
          gmv: roundNumber(realizedGmv.gmv, 2),
          gmv_source: realizedGmv.source,
          payment_ids: realizedGmv.payment_ids,
          product_revenue: roundNumber(realizedGmv.product_revenue, 2),
          sold_unit_price: roundNumber(soldUnitPrice, 2),
          product_cost: roundNumber(productCost, 2),
          commissions: roundNumber(commissions, 2),
          commission_rate_pct: roundNumber(commissionRate * 100, 4),
          tax_base: roundNumber(taxBase, 2),
          taxes: roundNumber(taxes, 2),
          tax_rate_pct: roundNumber(taxRate * 100, 4),
          shipping_tariff: roundNumber(shippingTariff, 2),
          buyer_shipping_paid: roundNumber(buyerShipping, 2),
          collection_shipping_fee: roundNumber(collectionFee, 2),
          coupon_discount: roundNumber(coupon, 2),
          // Informativos de conciliacao: nao alteram novamente o resultado.
          rebate: roundNumber(rebate, 2),
          embedded_seller_discount: roundNumber(embeddedSellerDiscount, 2),
          total_costs: roundNumber(totalCosts, 2),
          profit: roundNumber(profit, 2),
          margin_pct: roundNumber(marginPct, 2),
          equilibrium_total: roundNumber(breakEvenTotal, 2),
          equilibrium_unit: roundNumber(equilibriumUnit, 2),
          buffer_unit: roundNumber(bufferUnit, 2),
        });

        if (!summaryOnly) {
          for (const item of resolvedItems) {
            const ratio = revenueBase > 0 ? numberOrZero(item.revenue) / revenueBase : 1 / resolvedItems.length;
            addAllocatedMetric(byItem, item.item_id, {
              sold_units: item.quantity,
              sold_revenue: item.revenue,
              buyer_shipping_paid: buyerShipping * ratio,
              collection_shipping_fee: collectionFee * ratio,
              shipping_tariff: shippingTariff * ratio,
              coupon_discount: coupon * ratio,
              embedded_seller_discount: embeddedSellerDiscount * ratio,
              meli_rebate: rebate * ratio,
            });
          }
        }
      }),
    );
  }

  for (const key of [
    "buyer_shipping_paid",
    "collection_shipping_fee",
    "seller_coupon_discount",
    "embedded_seller_discount",
    "meli_rebate",
    "period_revenue",
    "product_cost",
    "commissions",
    "tax_base",
    "taxes",
    "shipping_tariff",
    "total_costs",
    "profit",
  ]) {
    summary[key] = roundNumber(summary[key], 2);
  }
  summary.gross_revenue = roundNumber(
    summary.period_revenue + numberOrZero(summary.cancelled_revenue) + numberOrZero(summary.returned_revenue),
    2,
  );
  summary.margin_pct = summary.period_revenue > 0
    ? roundNumber((summary.profit / summary.period_revenue) * 100, 2)
    : 0;
  summary.cost_coverage_pct = summary.cost_lines_total > 0
    ? roundNumber((summary.cost_lines_with_cost / summary.cost_lines_total) * 100, 2)
    : 100;
  return {
    summary,
    byItem,
    orders: ordersRows.sort((a, b) => String(b.date_created || "").localeCompare(String(a.date_created || ""))),
  };
}

function shippingModeLabel(item = {}) {
  if (item.free_shipping) return "Frete gratis";
  return "Comprador paga";
}

function normalizeRateFraction(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 1 ? n / 100 : n;
}

function calculateTargetPrice({ fixedCosts, commissionRate, taxRate, targetMargin }) {
  const denominator = 1 - numberOrZero(commissionRate) - numberOrZero(taxRate) - numberOrZero(targetMargin);
  if (denominator <= 0.001) return null;
  return roundNumber(Math.max(0, numberOrZero(fixedCosts)) / denominator, 2);
}

function expandItemsForPricing(items = []) {
  const rows = [];
  for (const item of items) {
    const directSku = normalizeSku(item?.reference_sku);
    const variations = Array.isArray(item?.variation_skus) ? item.variation_skus : [];
    if (directSku || !variations.length) {
      rows.push({ ...item, reference_sku: directSku, variation_id: "" });
      continue;
    }
    for (const variation of variations) {
      rows.push({
        ...item,
        reference_sku: normalizeSku(variation.reference_sku),
        variation_id: normalizeString(variation.variation_id),
        price: numberOrZero(variation.price) || numberOrZero(item.price),
        stock: numberOrZero(variation.stock),
      });
    }
  }
  return rows;
}

async function mapMarginRow({ item, costMap, taxPct, state, seller, orderMetrics }) {
  const sku = normalizeSku(item.reference_sku);
  const cost = sku ? numberOrZero(costMap.get(sku)?.cost) : 0;
  const [fee, shippingQuote] = await Promise.all([
    fetchListingFee(item, state),
    fetchShippingTariff(item, state, seller),
  ]);
  const metrics = orderMetrics?.get(normalizeString(item.item_id).toUpperCase()) || {};
  const price = numberOrZero(item.price);
  const commission = numberOrZero(fee.sale_fee) + numberOrZero(fee.listing_fee);
  const taxRate = Math.max(0, numberOrZero(taxPct) / 100);
  const shipping = item.free_shipping ? numberOrZero(shippingQuote.seller_cost) : 0;

  // PRECO DE EQUILIBRIO E UMA ESTIMATIVA PRE-VENDA. Ainda nao existe shipment
  // definitivo nem total do pedido, entao para anuncios em que o comprador paga
  // frete usamos a media historica por unidade observada no periodo selecionado.
  // Em frete gratis a estimativa do comprador e zero. Sem historico, nao inventamos
  // frete: usamos zero e sinalizamos a estimativa como incompleta na interface.
  const soldUnitsForEstimate = Math.max(0, numberOrZero(metrics.sold_units));
  const historicalBuyerShipping = Math.max(0, numberOrZero(metrics.buyer_shipping_paid));
  let estimatedBuyerShipping = 0;
  let buyerShippingEstimateSource = "sem_historico";
  if (item.free_shipping) {
    buyerShippingEstimateSource = "frete_gratis";
  } else if (soldUnitsForEstimate > 0 && historicalBuyerShipping > 0) {
    estimatedBuyerShipping = historicalBuyerShipping / soldUnitsForEstimate;
    buyerShippingEstimateSource = "historico_periodo";
  }
  const estimatedTaxBase = Math.max(0, price + estimatedBuyerShipping);
  const taxes = taxRate > 0 ? estimatedTaxBase * taxRate : 0;
  const listingDiscount =
    numberOrZero(item.original_price) > price ? numberOrZero(item.original_price) - price : 0;
  const couponDiscount = numberOrZero(metrics.coupon_discount);
  const embeddedSellerDiscount = numberOrZero(metrics.embedded_seller_discount);
  const rebate = numberOrZero(metrics.meli_rebate);
  const discount = listingDiscount + couponDiscount + embeddedSellerDiscount;

  const explicitRate = normalizeRateFraction(fee.percentage_fee);
  const knownFixed = Math.max(
    0,
    numberOrZero(fee.fixed_fee) +
      numberOrZero(fee.listing_fixed_fee == null ? fee.listing_fee : fee.listing_fixed_fee),
  );
  let commissionRate = explicitRate;
  let commissionFixed = knownFixed;
  if (price > 0 && commissionRate > 0) {
    commissionFixed = Math.max(0, commission - price * commissionRate);
  } else if (price > 0) {
    commissionFixed = Math.min(commission, knownFixed);
    commissionRate = Math.max(0, (commission - commissionFixed) / price);
  }
  commissionRate = Math.min(0.95, commissionRate);

  // O preco atual ja contem descontos promocionais do anuncio. Rebate e parte da
  // conciliacao da tarifa, portanto nao entra como credito adicional aqui.
  const totalCosts = cost + commission + taxes + shipping + couponDiscount;
  const marginValue = price - totalCosts;
  const marginPct = price > 0 ? (marginValue / price) * 100 : 0;

  // A precificacao estimada nao depende de rebate/cupom promocional: usa CMV,
  // frete do vendedor, parcela fixa da tarifa, percentual ML e imposto. Como o
  // imposto incide tambem sobre o frete estimado do comprador, a parcela tributaria
  // desse frete entra como custo fixo na equacao de equilibrio.
  const sustainableFixedCosts = cost + shipping + commissionFixed + (estimatedBuyerShipping * taxRate);
  const equilibriumPrice = sku && cost > 0
    ? calculateTargetPrice({
        fixedCosts: sustainableFixedCosts,
        commissionRate,
        taxRate,
        targetMargin: 0,
      })
    : null;
  const target10 = equilibriumPrice == null ? null : calculateTargetPrice({
    fixedCosts: sustainableFixedCosts,
    commissionRate,
    taxRate,
    targetMargin: 0.10,
  });
  const target15 = equilibriumPrice == null ? null : calculateTargetPrice({
    fixedCosts: sustainableFixedCosts,
    commissionRate,
    taxRate,
    targetMargin: 0.15,
  });
  const target20 = equilibriumPrice == null ? null : calculateTargetPrice({
    fixedCosts: sustainableFixedCosts,
    commissionRate,
    taxRate,
    targetMargin: 0.20,
  });
  const equilibriumBuffer = equilibriumPrice == null ? null : roundNumber(price - equilibriumPrice, 2);
  let equilibriumStatus = "sem_custo";
  if (equilibriumPrice != null) {
    if (price + 0.01 < equilibriumPrice) equilibriumStatus = "abaixo";
    else if (price <= equilibriumPrice * 1.05) equilibriumStatus = "proximo";
    else equilibriumStatus = "acima";
  }

  const row = {
    item_id: item.item_id,
    variation_id: normalizeString(item.variation_id),
    reference_sku: sku,
    title: item.title,
    thumbnail: item.thumbnail,
    status: item.status,
    category_id: item.category_id,
    listing_type_id: item.listing_type_id,
    price,
    product_cost: cost,
    has_cost: Boolean(sku && cost > 0),
    commission,
    commission_rate_pct: roundNumber(commissionRate * 100, 4),
    commission_fixed: roundNumber(commissionFixed, 2),
    estimated_buyer_shipping: roundNumber(estimatedBuyerShipping, 2),
    buyer_shipping_estimate_source: buyerShippingEstimateSource,
    tax_base_estimated: roundNumber(estimatedTaxBase, 2),
    tax_estimate_complete: buyerShippingEstimateSource !== "sem_historico",
    taxes,
    tax_rate_pct: roundNumber(taxRate * 100, 4),
    shipping,
    shipping_mode: shippingModeLabel(item),
    shipping_mode_raw: item.shipping_mode,
    logistic_type: item.logistic_type,
    free_shipping: !!item.free_shipping,
    shipping_tariff: shipping,
    discounts: discount,
    listing_discount: listingDiscount,
    coupon_discount: couponDiscount,
    embedded_seller_discount: embeddedSellerDiscount,
    rebate,
    total_costs: totalCosts,
    margin_value: marginValue,
    margin_pct: roundNumber(marginPct, 2),
    equilibrium_price: equilibriumPrice,
    price_margin_10: target10,
    price_margin_15: target15,
    price_margin_20: target20,
    equilibrium_buffer: equilibriumBuffer,
    equilibrium_status: equilibriumStatus,
    stock: item.stock,
    full: item.full,
    catalog: item.catalog,
    fee_source: fee.source,
    shipping_source: shippingQuote.source,
    sold_units: numberOrZero(metrics.sold_units),
    sold_revenue: numberOrZero(metrics.sold_revenue),
    permalink: item.permalink,
  };
  row.margin_status = classifyMargin(row);
  return row;
}

function applyMarginFilters(rows = [], query = {}) {
  const marginStatus = normalizeString(query.margin_status || "all").toLowerCase();
  const costStatus = normalizeString(query.cost_status || "all").toLowerCase();
  const min = maybeNumber(query.min_margin);
  const max = maybeNumber(query.max_margin);
  return rows.filter((row) => {
    if (marginStatus === "positive" && !(row.margin_value >= 0)) return false;
    if (marginStatus === "negative" && !(row.margin_value < 0)) return false;
    if (marginStatus === "low" && !(row.margin_value >= 0 && row.margin_pct < 10)) return false;
    if (marginStatus === "healthy" && !(row.margin_pct >= 20)) return false;
    if (costStatus === "missing" && row.has_cost) return false;
    if (costStatus === "filled" && !row.has_cost) return false;
    if (min != null && row.margin_pct < min) return false;
    if (max != null && row.margin_pct > max) return false;
    return true;
  });
}

function applyPeriodFilters(rows = [], query = {}) {
  const marginStatus = normalizeString(query.margin_status || "all").toLowerCase();
  const costStatus = normalizeString(query.cost_status || "all").toLowerCase();
  const orderStatus = normalizeString(query.order_status || "all").toLowerCase();
  const min = maybeNumber(query.min_margin);
  const max = maybeNumber(query.max_margin);
  return rows.filter((row) => {
    if (marginStatus === "positive" && !(numberOrZero(row.profit) >= 0)) return false;
    if (marginStatus === "negative" && !(numberOrZero(row.profit) < 0)) return false;
    if (marginStatus === "low" && !(numberOrZero(row.profit) >= 0 && numberOrZero(row.margin_pct) < 10)) return false;
    if (marginStatus === "healthy" && !(numberOrZero(row.margin_pct) >= 20)) return false;
    if (costStatus === "missing" && row.has_cost) return false;
    if (costStatus === "filled" && !row.has_cost) return false;
    if (min != null && numberOrZero(row.margin_pct) < min) return false;
    if (max != null && numberOrZero(row.margin_pct) > max) return false;
    const lifecycleStatus = normalizeString(row.lifecycle_status).toLowerCase();
    if (
      orderStatus === "in_progress" &&
      !["preparando", "a caminho"].includes(lifecycleStatus)
    ) return false;
    const exactStatuses = {
      preparing: "preparando",
      in_transit: "a caminho",
      completed: "concluído",
      cancelled: "cancelado",
      returning: "devolução",
      returned: "devolvido",
      problem: "problema",
    };
    if (exactStatuses[orderStatus] && lifecycleStatus !== exactStatuses[orderStatus]) return false;
    return true;
  });
}

function resolveMarginPeriodScope({ paidFinancials = {}, allOrderFinancials = {}, query = {} } = {}) {
  const summaryQuery = { ...query, order_status: "all" };
  return {
    summary: paidFinancials.summary || {},
    summaryRows: applyPeriodFilters(paidFinancials.orders || [], summaryQuery),
    periodRows: applyPeriodFilters(allOrderFinancials.orders || [], query),
  };
}

function applyEquilibriumFilters(rows = [], query = {}) {
  const base = applyMarginFilters(rows, query);
  const state = normalizeString(query.equilibrium_state || "all").toLowerCase();
  if (!state || state === "all") return base;
  const normalized = state === "below" ? "abaixo" : state === "near" ? "proximo" : state === "above" ? "acima" : state;
  return base.filter((row) => normalizeString(row.equilibrium_status).toLowerCase() === normalized);
}

function summarizeFilteredPeriodRows(rows = [], baseSummary = {}) {
  const sum = (field) => rows.reduce((total, row) => total + numberOrZero(row[field]), 0);
  const periodRevenue = sum("gmv");
  const profit = sum("profit");
  const cancelledRevenue = numberOrZero(baseSummary.cancelled_revenue);
  const returnedRevenue = numberOrZero(baseSummary.returned_revenue);
  return {
    ...baseSummary,
    period_revenue: roundNumber(periodRevenue, 2),
    gross_revenue: roundNumber(periodRevenue + cancelledRevenue + returnedRevenue, 2),
    product_cost: roundNumber(sum("product_cost"), 2),
    commissions: roundNumber(sum("commissions"), 2),
    tax_base: roundNumber(sum("tax_base"), 2),
    taxes: roundNumber(sum("taxes"), 2),
    shipping_tariff: roundNumber(sum("shipping_tariff"), 2),
    total_costs: roundNumber(sum("total_costs"), 2),
    profit: roundNumber(profit, 2),
    margin_pct: periodRevenue > 0 ? roundNumber((profit / periodRevenue) * 100, 2) : 0,
    buyer_shipping_paid: roundNumber(sum("buyer_shipping_paid"), 2),
    collection_shipping_fee: roundNumber(sum("collection_shipping_fee"), 2),
    seller_coupon_discount: roundNumber(sum("coupon_discount"), 2),
    embedded_seller_discount: roundNumber(sum("embedded_seller_discount"), 2),
    meli_rebate: roundNumber(sum("rebate"), 2),
    orders_matched: rows.length,
  };
}

function buildPeriodInsights(rows = []) {
  const negative = rows.filter((row) => numberOrZero(row.profit) < 0);
  const missing = rows.filter((row) => !row.has_cost);
  const low = rows.filter((row) => row.has_cost && numberOrZero(row.profit) >= 0 && numberOrZero(row.margin_pct) < 10);
  const topProfit = rows.slice().sort((a, b) => numberOrZero(b.profit) - numberOrZero(a.profit))[0] || null;
  const highRevenueLowMargin = rows
    .filter((row) => row.has_cost && numberOrZero(row.gmv) > 0 && numberOrZero(row.margin_pct) < 12)
    .sort((a, b) => numberOrZero(b.gmv) - numberOrZero(a.gmv))[0] || null;
  return [
    {
      type: negative.length ? "danger" : "ok",
      title: "Vendas com margem negativa",
      value: negative.length,
      text: negative.length
        ? `${negative.length} pedido(s) tiveram resultado negativo no recorte filtrado.`
        : "Nenhum pedido com resultado negativo no recorte filtrado.",
    },
    {
      type: missing.length ? "warn" : "ok",
      title: "Vendas com custo ausente",
      value: missing.length,
      text: missing.length
        ? `${missing.length} pedido(s) possuem pelo menos um SKU sem custo cadastrado.`
        : "Todos os pedidos filtrados possuem custo para os SKUs identificados.",
    },
    {
      type: low.length ? "warn" : "ok",
      title: "Vendas abaixo de 10%",
      value: low.length,
      text: low.length
        ? `${low.length} pedido(s) ficaram entre 0% e 10% de margem.`
        : "Nenhum pedido filtrado ficou entre 0% e 10% de margem.",
    },
    {
      type: topProfit ? "info" : "empty",
      title: "Maior lucro no periodo",
      value: topProfit ? numberOrZero(topProfit.profit) : 0,
      text: topProfit
        ? `Pedido ${topProfit.order_id} teve o maior resultado em reais.`
        : "Sem pedidos para comparar no recorte atual.",
    },
    {
      type: highRevenueLowMargin ? "warn" : "ok",
      title: "GMV alto, margem baixa",
      value: highRevenueLowMargin ? numberOrZero(highRevenueLowMargin.margin_pct) : 0,
      text: highRevenueLowMargin
        ? `Pedido ${highRevenueLowMargin.order_id} combina GMV relevante com margem abaixo de 12%.`
        : "Sem alerta de GMV alto com margem abaixo de 12%.",
    },
  ];
}

function buildMarginSummary(rows = [], orderSummary = {}) {
  const hasPeriodOrders = orderSummary && Object.prototype.hasOwnProperty.call(orderSummary, "period_revenue");
  const revenue = hasPeriodOrders
    ? numberOrZero(orderSummary.period_revenue)
    : rows.reduce((sum, row) => sum + numberOrZero(row.price), 0);
  const cancelledRevenue = numberOrZero(orderSummary.cancelled_revenue);
  const returnedRevenue = numberOrZero(orderSummary.returned_revenue);
  const grossRevenue = hasPeriodOrders
    ? numberOrZero(orderSummary.gross_revenue) || revenue + cancelledRevenue + returnedRevenue
    : revenue;
  const costs = hasPeriodOrders
    ? numberOrZero(orderSummary.total_costs)
    : rows.reduce((sum, row) => sum + numberOrZero(row.total_costs), 0);
  const profit = hasPeriodOrders
    ? numberOrZero(orderSummary.profit)
    : rows.reduce((sum, row) => sum + numberOrZero(row.margin_value), 0);
  const missingCost = rows.filter((row) => !row.has_cost).length;
  const negative = rows.filter((row) => row.margin_value < 0).length;
  const low = rows.filter((row) => row.has_cost && row.margin_value >= 0 && row.margin_pct < 10).length;
  const commissionsTotal = hasPeriodOrders
    ? numberOrZero(orderSummary.commissions)
    : rows.reduce((sum, row) => sum + numberOrZero(row.commission), 0);
  const taxBaseTotal = hasPeriodOrders
    ? numberOrZero(orderSummary.tax_base)
    : rows.reduce((sum, row) => sum + numberOrZero(row.tax_base_estimated || row.price), 0);
  const taxesTotal = hasPeriodOrders
    ? numberOrZero(orderSummary.taxes)
    : rows.reduce((sum, row) => sum + numberOrZero(row.taxes), 0);
  const estimatedShippingTariff = hasPeriodOrders
    ? numberOrZero(orderSummary.shipping_tariff)
    : rows.reduce((sum, row) => sum + numberOrZero(row.shipping_tariff), 0);
  const couponDiscount = numberOrZero(orderSummary.seller_coupon_discount);
  const meliRebate = hasPeriodOrders
    ? numberOrZero(orderSummary.meli_rebate)
    : rows.reduce((sum, row) => sum + numberOrZero(row.rebate), 0);
  return {
    gross_revenue: Number(grossRevenue.toFixed(2)),
    cancelled_revenue: Number(cancelledRevenue.toFixed(2)),
    returned_revenue: Number(returnedRevenue.toFixed(2)),
    considered_revenue: revenue,
    listed_revenue: revenue,
    total_costs: costs,
    projected_profit: profit,
    margin_pct: revenue > 0 ? Number(((profit / revenue) * 100).toFixed(2)) : 0,
    product_cost: hasPeriodOrders
      ? numberOrZero(orderSummary.product_cost)
      : rows.reduce((sum, row) => sum + numberOrZero(row.product_cost), 0),
    commissions: commissionsTotal,
    tax_base: Number(taxBaseTotal.toFixed(2)),
    taxes: taxesTotal,
    commissions_and_taxes: Number((commissionsTotal + taxesTotal).toFixed(2)),
    free_shipping_items: rows.filter((row) => row.free_shipping).length,
    buyer_shipping_items: rows.filter((row) => !row.free_shipping).length,
    estimated_shipping_tariff: Number(estimatedShippingTariff.toFixed(2)),
    buyer_shipping_paid: numberOrZero(orderSummary.buyer_shipping_paid),
    collection_shipping_fee: numberOrZero(orderSummary.collection_shipping_fee),
    seller_coupon_discount: couponDiscount,
    embedded_seller_discount: numberOrZero(orderSummary.embedded_seller_discount),
    // Informativo apenas. O valor ja esta refletido nas comissoes liquidas.
    meli_rebate: Number(meliRebate.toFixed(2)),
    coupons_available: orderSummary.coupons_available !== false,
    orders_scanned: numberOrZero(orderSummary.orders_scanned),
    orders_available: numberOrZero(orderSummary.orders_available),
    orders_matched: numberOrZero(orderSummary.orders_matched),
    cancelled_orders: numberOrZero(orderSummary.cancelled_orders),
    returned_orders: numberOrZero(orderSummary.returned_orders),
    summary_source: hasPeriodOrders ? "orders" : "listings",
    total_items: rows.length,
    missing_cost_items: missingCost,
    negative_items: negative,
    low_margin_items: low,
  };
}

function buildInsights(rows = []) {
  const negative = rows.filter((row) => row.margin_value < 0);
  const missing = rows.filter((row) => !row.has_cost);
  const low = rows.filter((row) => row.has_cost && row.margin_value >= 0 && row.margin_pct < 10);
  const topProfit = rows.slice().sort((a, b) => b.margin_value - a.margin_value)[0] || null;
  const highRevenueLowMargin =
    rows
      .filter((row) => row.has_cost && row.price > 0 && row.margin_pct < 12)
      .sort((a, b) => b.price - a.price)[0] || null;

  return [
    {
      type: negative.length ? "danger" : "ok",
      title: "Margem negativa",
      value: negative.length,
      text: negative.length
        ? `${negative.length} anuncio(s) vendem abaixo do custo estimado.`
        : "Nenhum anuncio com margem negativa no recorte carregado.",
    },
    {
      type: missing.length ? "warn" : "ok",
      title: "Produtos sem custo",
      value: missing.length,
      text: missing.length
        ? `${missing.length} anuncio(s) precisam de custo por SKU.`
        : "Todos os anuncios carregados possuem custo por SKU.",
    },
    {
      type: low.length ? "warn" : "ok",
      title: "Margem abaixo do ideal",
      value: low.length,
      text: low.length
        ? `${low.length} anuncio(s) estao abaixo de 10% de margem.`
        : "Nenhum anuncio carregado abaixo de 10% de margem.",
    },
    {
      type: topProfit ? "info" : "empty",
      title: "Maior lucro estimado",
      value: topProfit ? topProfit.margin_value : 0,
      text: topProfit
        ? `${topProfit.item_id} concentra o melhor resultado em reais.`
        : "Carregue anuncios para identificar oportunidades.",
    },
    {
      type: highRevenueLowMargin ? "warn" : "ok",
      title: "Bom preco, baixa margem",
      value: highRevenueLowMargin ? highRevenueLowMargin.margin_pct : 0,
      text: highRevenueLowMargin
        ? `${highRevenueLowMargin.item_id} tem preco alto e margem sensivel.`
        : "Sem alerta de faturamento alto com margem baixa no recorte.",
    },
  ];
}

function buildMarginExportWorkbook(data = {}, view = "period") {
  const workbook = XLSX.utils.book_new();
  const safeView = ["summary", "period", "equilibrium"].includes(view) ? view : "period";

  if (safeView === "summary") {
    const summary = data.summary || {};
    const rows = [
      ["Indicador", "Valor"],
      ["Vendas brutas ML", numberOrZero(summary.gross_revenue)],
      ["Canceladas", numberOrZero(summary.cancelled_revenue)],
      ["Devolvidas", numberOrZero(summary.returned_revenue)],
      ["GMV considerado", numberOrZero(summary.listed_revenue)],
      ["CMV", numberOrZero(summary.product_cost)],
      ["Comissoes ML liquidas (rebate ja considerado)", numberOrZero(summary.commissions)],
      ["Base do imposto", numberOrZero(summary.tax_base)],
      ["Impostos", numberOrZero(summary.taxes)],
      ["Tarifa de envio", numberOrZero(summary.estimated_shipping_tariff)],
      ["Frete pago pelo comprador", numberOrZero(summary.buyer_shipping_paid)],
      ["Tarifa Coletas", numberOrZero(summary.collection_shipping_fee)],
      ["Cupons do vendedor", numberOrZero(summary.seller_coupon_discount)],
      ["Rebates ML (informativo; ja considerado nas tarifas)", numberOrZero(summary.meli_rebate)],
      ["Total de custos", numberOrZero(summary.total_costs)],
      ["Resultado", numberOrZero(summary.projected_profit)],
      ["Margem (%)", numberOrZero(summary.margin_pct)],
      ["Pedidos lidos", numberOrZero(summary.orders_scanned)],
      ["Pedidos filtrados", numberOrZero(summary.orders_matched)],
    ];
    const marketing = data.marketing || null;
    if (marketing) {
      const channels = marketing.channels || {};
      const channelValue = (row) => row?.available ? numberOrZero(row.investment) : String(row?.status || "indisponivel");
      const totalKnown = numberOrZero(marketing.total_marketing_known);
      rows.push(
        ["", ""],
        ["AQUISICAO E PUBLICIDADE", ""],
        ["Product Ads", channelValue(channels.product_ads)],
        ["DSP", channelValue(channels.dsp)],
        ["Display", "Indisponivel - campanha de seguidores sem fonte publica nesta integracao"],
        ["Brand Ads", channelValue(channels.brand_ads)],
        ["Afiliados", "Indisponivel - API publica sem comissao para esta integracao"],
        ["Marketing total conhecido", totalKnown],
      );

      if (marketing.scope_compatible !== false) {
        const operational = numberOrZero(summary.projected_profit);
        const gmv = numberOrZero(summary.listed_revenue);
        const afterMarketing = operational - totalKnown;
        rows.push(
          ["Resultado operacional", operational],
          ["Resultado apos marketing", afterMarketing],
          ["Margem operacional (%)", numberOrZero(summary.margin_pct)],
          ["Margem final (%)", gmv > 0 ? roundNumber((afterMarketing / gmv) * 100, 2) : 0],
          ["TACOS total conhecido (%)", gmv > 0 ? roundNumber((totalKnown / gmv) * 100, 2) : 0],
          ["Status do resultado final", marketing.partial ? "Parcial - considera somente canais disponiveis" : "Completo"],
        );
      } else {
        rows.push(["Resultado apos marketing", "Nao calculado com filtros especificos; use apenas o periodo para comparar marketing total."]);
      }
    }

    const sheet = XLSX.utils.aoa_to_sheet(rows);
    setSheetWidths(sheet, [42, 36]);
    XLSX.utils.book_append_sheet(workbook, sheet, "Resumo");

    if (marketing) {
      const labels = {
        product_ads: "Product Ads",
        dsp: "DSP",
        display: "Display",
        brand_ads: "Brand Ads",
        affiliates: "Afiliados",
      };
      const marketingRows = Object.entries(marketing.channels || {}).map(([key, row]) => ({
        CANAL: labels[key] || key,
        STATUS: row?.status || "",
        INVESTIMENTO: row?.available ? numberOrZero(row.investment) : "",
        OBSERVACAO: row?.reason || "",
      }));
      marketingRows.push({
        CANAL: "Marketing total conhecido",
        STATUS: marketing.partial ? "parcial" : "completo",
        INVESTIMENTO: numberOrZero(marketing.total_marketing_known),
        OBSERVACAO: marketing.note || "",
      });
      const marketingSheet = XLSX.utils.json_to_sheet(marketingRows, {
        header: ["CANAL", "STATUS", "INVESTIMENTO", "OBSERVACAO"],
      });
      setSheetWidths(marketingSheet, [28, 18, 20, 80]);
      XLSX.utils.book_append_sheet(workbook, marketingSheet, "Marketing");
    }

    const insightRows = (Array.isArray(data.insights) ? data.insights : []).map((item) => ({
      TIPO: item.type || "",
      TITULO: item.title || "",
      VALOR: numberOrZero(item.value),
      DETALHE: item.text || "",
    }));
    const insightSheet = XLSX.utils.json_to_sheet(insightRows, {
      header: ["TIPO", "TITULO", "VALOR", "DETALHE"],
    });
    setSheetWidths(insightSheet, [14, 32, 16, 72]);
    XLSX.utils.book_append_sheet(workbook, insightSheet, "Insights");
    return workbook;
  }

  if (safeView === "equilibrium") {
    const rows = (Array.isArray(data.equilibrium_rows) ? data.equilibrium_rows : []).map((row) => ({
      PRODUTO: row.title || "",
      SKU: row.reference_sku || "",
      MLB: row.item_id || "",
      VARIACAO: row.variation_id || "",
      STATUS: row.status || "",
      LOGISTICA: row.logistic_type || row.shipping_mode_raw || "",
      PRECO_ATUAL: numberOrZero(row.price),
      CUSTO: numberOrZero(row.product_cost),
      COMISSAO_TOTAL_ATUAL: numberOrZero(row.commission),
      COMISSAO_PERCENTUAL: numberOrZero(row.commission_rate_pct),
      COMISSAO_FIXA_ESTIMADA: numberOrZero(row.commission_fixed),
      FRETE_COMPRADOR_ESTIMADO: numberOrZero(row.estimated_buyer_shipping),
      FONTE_FRETE_COMPRADOR_ESTIMADO: row.buyer_shipping_estimate_source || "",
      BASE_IMPOSTO_ESTIMADA: numberOrZero(row.tax_base_estimated),
      IMPOSTO_PERCENTUAL: numberOrZero(row.tax_rate_pct),
      IMPOSTO_ESTIMADO: numberOrZero(row.taxes),
      FRETE_TARIFA_VENDEDOR_ESTIMADA: numberOrZero(row.shipping_tariff),
      EQUILIBRIO_ESTIMADO_0: row.equilibrium_price == null ? "" : numberOrZero(row.equilibrium_price),
      PRECO_MARGEM_10: row.price_margin_10 == null ? "" : numberOrZero(row.price_margin_10),
      PRECO_MARGEM_15: row.price_margin_15 == null ? "" : numberOrZero(row.price_margin_15),
      PRECO_MARGEM_20: row.price_margin_20 == null ? "" : numberOrZero(row.price_margin_20),
      FOLGA: row.equilibrium_buffer == null ? "" : numberOrZero(row.equilibrium_buffer),
      SITUACAO: row.equilibrium_status || "",
    }));
    const sheet = XLSX.utils.json_to_sheet(rows, {
      header: [
        "PRODUTO", "SKU", "MLB", "VARIACAO", "STATUS", "LOGISTICA", "PRECO_ATUAL", "CUSTO",
        "COMISSAO_TOTAL_ATUAL", "COMISSAO_PERCENTUAL", "COMISSAO_FIXA_ESTIMADA",
        "FRETE_COMPRADOR_ESTIMADO", "FONTE_FRETE_COMPRADOR_ESTIMADO", "BASE_IMPOSTO_ESTIMADA",
        "IMPOSTO_PERCENTUAL", "IMPOSTO_ESTIMADO", "FRETE_TARIFA_VENDEDOR_ESTIMADA", "EQUILIBRIO_ESTIMADO_0",
        "PRECO_MARGEM_10", "PRECO_MARGEM_15", "PRECO_MARGEM_20", "FOLGA", "SITUACAO",
      ],
    });
    setSheetWidths(sheet, [52, 22, 18, 18, 14, 20, 16, 16, 20, 20, 22, 22, 28, 22, 18, 20, 24, 22, 18, 18, 18, 18, 16, 16]);
    XLSX.utils.book_append_sheet(workbook, sheet, "Equilibrio estimado");
    return workbook;
  }

  const rows = (Array.isArray(data.period_rows) ? data.period_rows : []).map((row) => {
    const items = Array.isArray(row.order_items) ? row.order_items : [];
    return {
      PEDIDO: row.order_id || "",
      DATA: dateOnly(row.date_created),
      MLBS: items.map((item) => item.mlb).filter(Boolean).join(" | "),
      SKUS: items.map((item) => item.sku).filter(Boolean).join(" | "),
      VARIACOES: items.map((item) => item.variation_id).filter(Boolean).join(" | "),
      PRODUTOS: items.map((item) => item.title).filter(Boolean).join(" | "),
      QUANTIDADE_TOTAL: numberOrZero(row.total_units),
      MODO_ENVIO: row.shipping_mode || "",
      TIPO_LOGISTICO: row.logistic_type || "",
      GMV: numberOrZero(row.gmv),
      PRECO_PRODUTO: numberOrZero(row.product_revenue),
      CMV: numberOrZero(row.product_cost),
      TARIFAS_MARKETPLACE_LIQUIDAS: numberOrZero(row.commissions),
      COMISSAO_EFETIVA_PERCENTUAL: numberOrZero(row.commission_rate_pct),
      FRETE_COMPRADOR: numberOrZero(row.buyer_shipping_paid),
      BASE_IMPOSTO: numberOrZero(row.tax_base),
      IMPOSTOS: numberOrZero(row.taxes),
      IMPOSTO_PERCENTUAL: numberOrZero(row.tax_rate_pct),
      TARIFA_ENVIO: numberOrZero(row.shipping_tariff),
      CUPOM_VENDEDOR: numberOrZero(row.coupon_discount),
      REBATE_ML_INFORMATIVO: numberOrZero(row.rebate),
      CUSTOS_TOTAIS: numberOrZero(row.total_costs),
      RESULTADO: numberOrZero(row.profit),
      MARGEM_PERCENTUAL: numberOrZero(row.margin_pct),
      EQUILIBRIO_UNITARIO: numberOrZero(row.equilibrium_unit),
      FOLGA_UNITARIA: numberOrZero(row.buffer_unit),
      CUSTO_COMPLETO: row.has_cost ? "Sim" : "Nao",
      ITENS_SEM_CUSTO: numberOrZero(row.missing_cost_items),
      STATUS: row.lifecycle_status || "",
    };
  });
  const sheet = XLSX.utils.json_to_sheet(rows, {
    header: [
      "PEDIDO", "DATA", "MLBS", "SKUS", "VARIACOES", "PRODUTOS", "QUANTIDADE_TOTAL", "MODO_ENVIO",
      "TIPO_LOGISTICO", "GMV", "PRECO_PRODUTO", "CMV", "TARIFAS_MARKETPLACE_LIQUIDAS",
      "COMISSAO_EFETIVA_PERCENTUAL", "FRETE_COMPRADOR", "BASE_IMPOSTO", "IMPOSTOS", "IMPOSTO_PERCENTUAL", "TARIFA_ENVIO",
      "CUPOM_VENDEDOR", "REBATE_ML_INFORMATIVO", "CUSTOS_TOTAIS", "RESULTADO",
      "MARGEM_PERCENTUAL", "EQUILIBRIO_UNITARIO", "FOLGA_UNITARIA", "CUSTO_COMPLETO", "ITENS_SEM_CUSTO", "STATUS",
    ],
  });
  setSheetWidths(sheet, [18, 12, 28, 28, 22, 60, 16, 18, 20, 15, 20, 15, 20, 22, 18, 18, 15, 18, 16, 18, 24, 16, 18, 16, 18, 20, 18, 16, 16]);
  XLSX.utils.book_append_sheet(workbook, sheet, "Margem por periodo");
  return workbook;
}

function quickMarginCacheKey(context = {}, range = {}, dateField = "closed") {
  return JSON.stringify({
    account: String(context.accountKey || context?.mlCreds?.account_key || "default"),
    from: range.date_from || "",
    to: range.date_to || "",
    dateField,
  });
}

function clearQuickMarginCache(_accountKey = null) {
  // Cache pequeno e somente de resumos. Ao alterar custo/imposto, limpar tudo
  // evita servir por alguns minutos um resumo de outra conta ainda baseado na
  // configuracao anterior.
  QUICK_MARGIN_CACHE.clear();
}

async function buildTargetedLiveCostPayload(query = {}, context = {}, basePayload = null) {
  const q = normalizeString(query.q);
  const lookupType = normalizeCostLookupType(query.lookup_type || query.search_type || "sku");
  if (!q || !["mlb", "sku"].includes(lookupType)) return null;

  const state = await prepareAuth(context);
  const seller = await fetchSeller(state);
  if (!seller.id) return null;

  let targetedItems = await fetchTargetedCostLookupItems(context, query, seller);

  // Busca direta e uma ferramenta de recuperacao de custo historico. Se o anuncio
  // ja saiu de "active" depois da venda, ainda precisamos permitir encontra-lo
  // pelo MLB/SKU para cadastrar o CMV. Primeiro respeitamos o filtro escolhido;
  // se nada for encontrado, repetimos a busca em todos os status conhecidos.
  let statusFilterOverridden = false;
  if (!targetedItems.length && normalizeStatus(query.status) !== "all") {
    targetedItems = await fetchTargetedCostLookupItems(
      context,
      { ...query, status: "all" },
      seller,
    );
    statusFilterOverridden = targetedItems.length > 0;
  }

  // MLB e um identificador exato. Nunca aceitar item de outro seller apenas
  // porque o ID existe no Mercado Livre.
  targetedItems = targetedItems.filter((item) =>
    !item?.seller_id || String(item.seller_id) === String(seller.id),
  );
  if (!targetedItems.length) return null;

  const skus = targetedItems.flatMap((item) =>
    Array.isArray(item.reference_skus) && item.reference_skus.length
      ? item.reference_skus
      : [item.reference_sku],
  );
  const costMap = await getSkuCostMap(context.accountKey, skus);
  const groups = groupItemsBySku(targetedItems, costMap);

  // Em uma busca direta, o texto ja foi usado para localizar o anuncio na API.
  // Reaplicar q sobre o SKU-base pode descartar variacoes validas do mesmo MLB.
  const withoutTextFilter = { ...query, q: "" };
  let filtered = applyCostFilters(groups, withoutTextFilter);

  // Se o anuncio foi localizado fora do status selecionado, ainda o exibimos
  // explicitamente para que um pedido historico possa receber custo.
  if (!filtered.length && normalizeStatus(query.status) !== "all") {
    filtered = applyCostFilters(groups, { ...withoutTextFilter, status: "all" });
    statusFilterOverridden = filtered.length > 0;
  }

  filtered.sort((a, b) =>
    String(a.reference_sku || a.title).localeCompare(
      String(b.reference_sku || b.title),
      "pt-BR",
    ),
  );

  const page = clampInt(query.page, 1, 9999, 1);
  const pageSize = clampInt(query.pageSize, 10, 100, 25);
  const pageData = paginate(filtered, page, pageSize);
  const summary = basePayload?.summary || buildCostSummary(groups);

  return {
    success: true,
    summary,
    risk_overview: basePayload?.risk_overview || {
      summary: {
        total: 0,
        missing_cost_count: 0,
        cost_up_count: 0,
        price_down_count: 0,
        margin_risk_count: 0,
        attention_count: 0,
        latest_price_snapshot_date: null,
      },
      ranking: [],
      insights: [],
    },
    items: pageData.rows,
    page: pageData.page,
    pageSize: pageData.pageSize,
    total: pageData.total,
    totalPages: pageData.totalPages,
    meta: {
      ...(basePayload?.meta || {}),
      source: "live_targeted",
      seller_id: seller.id,
      seller_nickname: seller.nickname,
      partial: false,
      targeted_items: targetedItems.length,
      lookup_type: lookupType,
      status_filter_overridden: statusFilterOverridden,
      requested_status: normalizeStatus(query.status),
      updated_at: new Date().toISOString(),
    },
  };
}

class FinanceiroMlService {
  static async listCosts(query = {}, context = {}) {
    if (String(query.force_refresh || "").toLowerCase() === "true") {
      INVENTORY_CACHE.clear();
    }

    const q = normalizeString(query.q);
    const lookupType = normalizeCostLookupType(query.lookup_type || query.search_type || "sku");
    const isDirectLookup = Boolean(q) && ["mlb", "sku"].includes(lookupType);

    const catalogSummary = await getSkuCatalogSummary(context.accountKey);
    const latestSync = await getLatestSkuCatalogRun(context.accountKey);
    if (catalogSummary.total_skus > 0 || latestSync?.status === "completed") {
      const catalogPayload = await listSkuCatalogCosts(query, context);

      // A base sincronizada continua sendo a fonte principal. Porem, uma busca
      // direta por MLB/SKU nao pode ficar limitada a ela: pedidos recentes podem
      // apontar para anuncios/variacoes que ainda nao entraram no sync, ou que
      // foram pausados/encerrados depois da venda.
      if (isDirectLookup && numberOrZero(catalogPayload?.total) === 0) {
        const targeted = await buildTargetedLiveCostPayload(query, context, catalogPayload);
        if (targeted?.total > 0) return targeted;
      }
      return catalogPayload;
    }

    const page = clampInt(query.page, 1, 9999, 1);
    const pageSize = clampInt(query.pageSize, 10, 100, 25);
    const snapshot = await getInventorySnapshot(context, {
      status: query.status || "all",
      max_items: query.max_items,
    });
    const targetedItems = await fetchTargetedCostLookupItems(context, query, snapshot.seller);
    const itemsById = new Map(
      [...(snapshot.items || []), ...targetedItems].map((item) => [
        String(item.item_id || "").toUpperCase(),
        item,
      ]),
    );
    const items = Array.from(itemsById.values());
    const skus = items.flatMap((item) =>
      Array.isArray(item.reference_skus) && item.reference_skus.length
        ? item.reference_skus
        : [item.reference_sku],
    );
    const costMap = await getSkuCostMap(context.accountKey, skus);
    const groups = groupItemsBySku(items, costMap);
    const filtered = applyCostFilters(groups, query).sort((a, b) =>
      String(a.reference_sku || a.title).localeCompare(String(b.reference_sku || b.title), "pt-BR"),
    );
    const pageData = paginate(filtered, page, pageSize);
    return {
      success: true,
      summary: buildCostSummary(groups),
      items: pageData.rows,
      page: pageData.page,
      pageSize: pageData.pageSize,
      total: pageData.total,
      totalPages: pageData.totalPages,
      meta: {
        seller_id: snapshot.seller.id,
        seller_nickname: snapshot.seller.nickname,
        partial: snapshot.partial,
        max_items: snapshot.max_items,
        targeted_items: targetedItems.length,
        lookup_type: lookupType,
        updated_at: snapshot.updated_at,
      },
    };
  }

  static async saveCost(params = {}, context = {}) {
    const saved = await saveSkuCost({
      accountKey: context.accountKey,
      sku: params.sku,
      cost: params.cost,
      userId: params.userId,
      source: "manual",
    });
    clearQuickMarginCache(context.accountKey);
    return {
      success: true,
      cost: {
        reference_sku: saved.reference_sku,
        custo_produto_unitario: numberOrZero(saved.custo_produto_unitario),
        updated_at: saved.updated_at,
      },
    };
  }

  static async costTimeline(query = {}, context = {}) {
    return getSkuCostTimeline(query, context);
  }

  static async importCosts(params = {}, context = {}) {
    const rows = parseImportRows(params);
    if (!rows.length) throw new Error("Nenhuma linha valida encontrada.");
    let updated = 0;
    const errors = [];
    let eanSkuMap = null;
    for (const row of rows) {
      let sku = normalizeSku(
        getRowValue(row, ["sku_referencia", "sku", "reference_sku", "sku referencia"]),
      );
      const eanRaw = normalizeString(
        getRowValue(row, [
          "ean",
          "gtin",
          "codigo_barras",
          "codigo barras",
          "código de barras",
          "codigo universal",
          "código universal",
        ]),
      );
      const eanCandidates = eanRaw
        .split(/[|,;/]/)
        .map((value) => normalizeString(value).toUpperCase())
        .filter(Boolean);
      if (!sku && eanCandidates.length) {
        eanSkuMap = eanSkuMap || (await buildEanSkuMap(context));
        sku = eanCandidates.map((ean) => eanSkuMap.get(ean)).find(Boolean) || "";
      }
      const cost = maybeNumber(
        getRowValue(row, ["custo_produto", "custo", "preco", "preco_custo", "custo produto"]),
      );
      if (!sku || cost == null) {
        errors.push({ sku: sku || "-", ean: eanCandidates.join("|") || "-", error: "SKU/EAN ou custo ausente." });
        continue;
      }
      await saveSkuCost({
        accountKey: context.accountKey,
        sku,
        cost,
        userId: params.userId,
        source: "import",
        meta: { filename: params.filename || "importacao", ean: eanCandidates.join("|") || null },
      });
      updated += 1;
    }
    clearQuickMarginCache(context.accountKey);
    return { success: true, updated, errors, total: rows.length };
  }

  static async exportCosts(query = {}, context = {}) {
    if (String(query.force_refresh || "").toLowerCase() === "true") {
      INVENTORY_CACHE.clear();
    }
    const catalogSummary = await getSkuCatalogSummary(context.accountKey);
    if (catalogSummary.total_skus > 0) {
      const rows = await listSkuCatalogCosts(
        {
          ...query,
          page: 1,
          pageSize: Math.min(10000, Math.max(100, catalogSummary.total_skus)),
          export_all: true,
        },
        context,
      );
      return {
        filename: "custos-mercado-livre-skus.xlsx",
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: toXlsxBuffer(buildCostWorkbook(rows.items || [])),
      };
    }
    const fullExport = String(query.export_scope || "all").toLowerCase() !== "screen";
    const snapshot = await getInventorySnapshot(context, {
      status: query.status || "all",
      max_items: query.max_items,
      full_scan: fullExport,
    });
    const targetedItems = await fetchTargetedCostLookupItems(context, query, snapshot.seller);
    const itemsById = new Map(
      [...(snapshot.items || []), ...targetedItems].map((item) => [
        String(item.item_id || "").toUpperCase(),
        item,
      ]),
    );
    const items = Array.from(itemsById.values());
    const costMap = await getSkuCostMap(
      context.accountKey,
      items.flatMap((item) =>
        Array.isArray(item.reference_skus) && item.reference_skus.length
          ? item.reference_skus
          : [item.reference_sku],
      ),
    );
    const groups = applyCostFilters(groupItemsBySku(items, costMap), query);
    return {
      filename: "custos-mercado-livre-skus.xlsx",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: toXlsxBuffer(buildCostWorkbook(groups)),
    };
  }

  static async getTax(_query = {}, context = {}) {
    return { success: true, config: await getAccountTax(context.accountKey) };
  }

  static async saveTax(params = {}, context = {}) {
    const config = await saveAccountTax({
      accountKey: context.accountKey,
      aliquota: params.aliquota,
      userId: params.userId,
    });
    clearQuickMarginCache(context.accountKey);
    return { success: true, config };
  }

  static async quickMarginSummary(query = {}, context = {}) {
    const range = resolveDateRange(query);
    const dateField = resolveOrderDateField(query);
    const forceRefresh = String(query.force_refresh || query.refresh || "").toLowerCase() === "true" || String(query.refresh || "") === "1";
    const cacheKey = quickMarginCacheKey(context, range, dateField);
    if (!forceRefresh) {
      const cached = QUICK_MARGIN_CACHE.get(cacheKey);
      if (cached && now() - cached.createdAt < QUICK_MARGIN_TTL_MS) {
        return { ...cached.payload, cache: "hit" };
      }
    }

    const ordersLimit = clampInt(
      query.orders_limit || process.env.ML_FINANCE_MARGIN_ORDER_LIMIT,
      1,
      10000,
      DEFAULT_MARGIN_ORDER_LIMIT,
    );
    const state = await prepareAuth(context);
    const seller = context?.sellerId
      ? { id: context.sellerId, nickname: context.accountLabel || null, site_id: "MLB" }
      : await fetchSeller(state);
    if (!seller?.id) throw new Error("Nao foi possivel identificar a conta Mercado Livre.");
    const tax = await getAccountTax(context.accountKey);

    const financials = await buildOrderFinancials({
      state,
      seller,
      range,
      itemIds: [],
      limit: ordersLimit,
      itemsById: new Map(),
      costMap: new Map(),
      taxPct: tax.enabled ? tax.aliquota : 0,
      dateField,
      status: "all",
      accountKey: context.accountKey,
      includeGrossAdjustments: false,
      summaryOnly: true,
      batchSize: 12,
    });

    const summary = financials.summary || {};
    const revenue = numberOrZero(summary.period_revenue);
    const ordersCount = numberOrZero(summary.orders_matched);
    const payload = {
      success: true,
      available: true,
      range,
      date_field: dateField,
      faturamento_bruto: revenue,
      faturamento_base: revenue,
      taxa_vendas: numberOrZero(summary.commissions),
      custo_envio: numberOrZero(summary.shipping_tariff),
      custo_devolucao: 0,
      base_imposto: numberOrZero(summary.tax_base),
      impostos: numberOrZero(summary.taxes),
      custo_produto: numberOrZero(summary.product_cost),
      cupom_vendedor: numberOrZero(summary.seller_coupon_discount),
      rebate_informativo: numberOrZero(summary.meli_rebate),
      desconto_promocional_embutido: numberOrZero(summary.embedded_seller_discount),
      margem_contribuicao: numberOrZero(summary.profit),
      margem_pct: numberOrZero(summary.margin_pct),
      total_custos: numberOrZero(summary.total_costs),
      orders_count: ordersCount,
      ticket_medio: ordersCount > 0 ? roundNumber(revenue / ordersCount, 2) : 0,
      cost_coverage_pct: numberOrZero(summary.cost_coverage_pct),
      missing_cost_lines: numberOrZero(summary.missing_cost_lines),
      tax_enabled: !!tax.enabled,
      tax_pct: tax.enabled ? numberOrZero(tax.aliquota) : 0,
      calculated_at: new Date().toISOString(),
      cache: "miss",
    };
    QUICK_MARGIN_CACHE.set(cacheKey, { createdAt: now(), payload });
    return payload;
  }

  static async listMargin(query = {}, context = {}) {
    if (String(query.force_refresh || "").toLowerCase() === "true") {
      INVENTORY_CACHE.clear();
      SHIPPING_TARIFF_CACHE.clear();
      ORDER_DISCOUNT_CACHE.clear();
      SHIPMENT_COST_CACHE.clear();
      clearQuickMarginCache(context.accountKey);
    }
    const page = clampInt(query.page, 1, 9999, 1);
    const pageSize = clampInt(query.pageSize, 10, 50, 25);
    const range = resolveDateRange(query);
    const dateField = resolveOrderDateField(query);
    const scopeLimit = clampInt(
      query.scope_limit || process.env.ML_FINANCE_MARGIN_SCOPE_LIMIT,
      50,
      2000,
      DEFAULT_MARGIN_SCOPE_LIMIT,
    );
    const ordersLimit = clampInt(
      query.orders_limit || process.env.ML_FINANCE_MARGIN_ORDER_LIMIT,
      0,
      10000,
      DEFAULT_MARGIN_ORDER_LIMIT,
    );
    const snapshot = await getInventorySnapshot(context, {
      status: query.status || "all",
      max_items: query.max_items,
    });
    const q = normalizeString(query.q).toLowerCase();
    let candidates = snapshot.items.filter((item) => {
      if (!q) return true;
      return (
        textIncludes(item.item_id, q) ||
        textIncludes(item.reference_sku, q) ||
        (Array.isArray(item.reference_skus) && item.reference_skus.some((sku) => textIncludes(sku, q))) ||
        textIncludes(item.title, q) ||
        textIncludes(item.category_id, q)
      );
    });
    if (query.only_full === "true") candidates = candidates.filter((item) => item.full);
    if (query.catalog === "with_catalog") candidates = candidates.filter((item) => item.catalog);
    if (query.catalog === "without_catalog") candidates = candidates.filter((item) => !item.catalog);

    const scopeTruncated = candidates.length > scopeLimit;
    candidates = candidates.slice(0, scopeLimit);
    const pricingCandidates = expandItemsForPricing(candidates);
    const costMap = await getSkuCostMap(
      context.accountKey,
      pricingCandidates.map((item) => item.reference_sku),
    );
    const tax = await getAccountTax(context.accountKey);
    const state = await prepareAuth(context);
    const itemById = new Map(
      candidates.map((item) => [normalizeString(item.item_id).toUpperCase(), item]),
    );
    const orderFinancials = await buildOrderFinancials({
      state,
      seller: snapshot.seller,
      range,
      itemIds: q ? candidates.map((item) => item.item_id) : [],
      limit: ordersLimit,
      itemsById: itemById,
      costMap,
      taxPct: tax.enabled ? tax.aliquota : 0,
      dateField,
      status: query.status || "all",
      accountKey: context.accountKey,
    }).catch(() => ({
      summary: {
        period_revenue: 0,
        gross_revenue: 0,
        cancelled_revenue: 0,
        returned_revenue: 0,
        product_cost: 0,
        commissions: 0,
        tax_base: 0,
        taxes: 0,
        shipping_tariff: 0,
        total_costs: 0,
        profit: 0,
        margin_pct: 0,
        buyer_shipping_paid: 0,
        collection_shipping_fee: 0,
        seller_coupon_discount: 0,
        embedded_seller_discount: 0,
        meli_rebate: 0,
        orders_scanned: 0,
        orders_available: 0,
        orders_matched: 0,
        cancelled_orders: 0,
        returned_orders: 0,
        coupons_available: false,
      },
      byItem: new Map(),
      orders: [],
    }));
    const allPeriodOrders = await fetchAllOrders(
      state,
      snapshot.seller.id,
      range,
      ordersLimit,
      "created",
    ).catch(() => []);
    const allOrderFinancials = await buildOrderFinancials({
      state,
      seller: snapshot.seller,
      range,
      itemIds: q ? candidates.map((item) => item.item_id) : [],
      limit: ordersLimit,
      itemsById: itemById,
      costMap,
      taxPct: tax.enabled ? tax.aliquota : 0,
      dateField: "created",
      status: query.status || "all",
      accountKey: context.accountKey,
      ordersOverride: allPeriodOrders,
      includeGrossAdjustments: false,
    }).catch(() => ({ orders: [] }));
    const rows = [];
    for (let i = 0; i < pricingCandidates.length; i += 5) {
      const batch = pricingCandidates.slice(i, i + 5);
      rows.push(
        ...(await Promise.all(
          batch.map((item) =>
            mapMarginRow({
              item,
              costMap,
              taxPct: tax.enabled ? tax.aliquota : 0,
              state,
              seller: snapshot.seller,
              orderMetrics: orderFinancials.byItem,
            }),
          ),
        )),
      );
    }

    const filtered = applyMarginFilters(rows, query).sort(
      (a, b) => numberOrZero(b.margin_value) - numberOrZero(a.margin_value),
    );
    const equilibriumRows = applyEquilibriumFilters(rows, query).sort((a, b) => {
      const aMissing = a.equilibrium_price == null ? 1 : 0;
      const bMissing = b.equilibrium_price == null ? 1 : 0;
      if (aMissing !== bMissing) return aMissing - bMissing;
      return numberOrZero(a.equilibrium_buffer) - numberOrZero(b.equilibrium_buffer);
    });
    const periodScope = resolveMarginPeriodScope({
      paidFinancials: orderFinancials,
      allOrderFinancials,
      query,
    });
    const periodRows = periodScope.periodRows;
    const filteredOrderSummary = summarizeFilteredPeriodRows(periodScope.summaryRows, periodScope.summary);
    const pageData = paginate(filtered, page, pageSize);
    const orderPartial = numberOrZero(orderFinancials.summary.orders_available) > numberOrZero(orderFinancials.summary.orders_scanned);
    return {
      success: true,
      filters: { ...range, date_field: dateField, scope_limit: scopeLimit, orders_limit: ordersLimit },
      summary: buildMarginSummary(filtered, filteredOrderSummary),
      insights: periodRows.length || orderFinancials.summary.orders_scanned
        ? buildPeriodInsights(periodRows)
        : buildInsights(filtered),
      items: pageData.rows,
      equilibrium_rows: equilibriumRows,
      period_rows: periodRows,
      page: pageData.page,
      pageSize: pageData.pageSize,
      total: pageData.total,
      totalPages: pageData.totalPages,
      meta: {
        seller_id: snapshot.seller.id,
        seller_nickname: snapshot.seller.nickname,
        partial: snapshot.partial || scopeTruncated || orderPartial,
        order_partial: orderPartial,
        max_items: snapshot.max_items,
        tax_rate: tax.aliquota,
        orders_scanned: orderFinancials.summary.orders_scanned,
        orders_available: orderFinancials.summary.orders_available,
        orders_matched: orderFinancials.summary.orders_matched,
        cancelled_orders: orderFinancials.summary.cancelled_orders,
        returned_orders: orderFinancials.summary.returned_orders,
        coupons_available: orderFinancials.summary.coupons_available !== false,
        note: orderPartial
          ? `Foram lidos ${orderFinancials.summary.orders_scanned} de ${orderFinancials.summary.orders_available} pedidos disponiveis. Aumente ML_FINANCE_MARGIN_ORDER_LIMIT se precisar de mais de ${ordersLimit}.`
          : "Resumo e precificacao usam os pedidos pagos do periodo; Margem por periodo lista todos os pedidos pela data de criacao.",
      },
    };
  }

  static async exportMargin(query = {}, context = {}) {
    const viewRaw = normalizeString(query.view || "period").toLowerCase();
    const view = ["summary", "period", "equilibrium"].includes(viewRaw) ? viewRaw : "period";
    const data = await this.listMargin({ ...query, page: 1, pageSize: 50 }, context);
    if (view === "summary") {
      try {
        const marketing = await MarketingMlService.getPeriodSummary({
          date_from: data.filters?.date_from,
          date_to: data.filters?.date_to,
          force_refresh: query.force_refresh,
        }, context);
        data.marketing = {
          ...marketing,
          scope_compatible: isMarketingPeriodScope(query),
        };
      } catch (error) {
        data.marketing = {
          success: false,
          partial: true,
          scope_compatible: isMarketingPeriodScope(query),
          channels: {
            affiliates: { status: "unsupported", available: false, reason: "API publica indisponivel." },
          },
          total_marketing_known: 0,
          note: error?.message || "Falha ao carregar marketing para exportacao.",
        };
      }
    }
    const workbook = buildMarginExportWorkbook(data, view);
    const suffix = `${data.filters?.date_from || todayISO()}-${data.filters?.date_to || todayISO()}`;
    const names = {
      summary: "resumo-margem-mercado-livre",
      period: "margem-por-periodo-mercado-livre",
      equilibrium: "preco-equilibrio-mercado-livre",
    };
    return {
      filename: `${names[view]}-${suffix}.xlsx`,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: toXlsxBuffer(workbook),
    };
  }

  static getUserId = getUserId;
}

FinanceiroMlService._test = {
  resolveRealizedGmv,
  orderLifecycleStatus,
  buildOrderSearchQuery,
  dedupeOrdersById,
  applyPeriodFilters,
  resolveMarginPeriodScope,
  buildMarginExportWorkbook,
};
module.exports = FinanceiroMlService;
