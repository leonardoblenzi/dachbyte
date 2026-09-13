"use strict";

const db = require("../db/db");

const ML_BASE = "https://api.mercadolibre.com";

function asInt(value, fallback = 0) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeMlb(value) {
  return String(value || "").trim().toUpperCase();
}

function moneyToCents(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfDay(date) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

function parseDate(value) {
  const raw = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const date = new Date(`${raw}T00:00:00`);
  return Number.isFinite(date.getTime()) ? date : null;
}

function resolveRange(input = {}) {
  const mode = String(input.period || input.periodo || "30d").toLowerCase();
  const today = startOfDay(new Date());
  if (mode === "custom" || mode === "personalizado") {
    const from = parseDate(input.date_from || input.from);
    const to = parseDate(input.date_to || input.to);
    if (!from || !to || from > to) {
      const err = new Error("Periodo personalizado invalido.");
      err.statusCode = 400;
      throw err;
    }
    return { from, to, days: Math.max(1, Math.round((to - from) / 86400000) + 1), label: "Personalizado" };
  }
  const days = mode === "7d" ? 7 : mode === "15d" ? 15 : 30;
  return { from: addDays(today, -(days - 1)), to: today, days, label: `Ultimos ${days} dias` };
}

function currentMeliContaId(res) {
  const id = Number(res?.locals?.mlCreds?.meli_conta_id || 0);
  return Number.isFinite(id) && id > 0 ? id : null;
}

async function getAccessToken(req, res, meliContaId) {
  const direct =
    req?.ml?.accessToken ||
    res?.locals?.mlCreds?.access_token ||
    res?.locals?.access_token ||
    null;
  if (direct && String(direct).trim()) return String(direct).trim();

  const adapter = req?.app?.get?.("getAccessTokenForAccount");
  if (typeof adapter === "function" && meliContaId) {
    const out = await adapter(meliContaId);
    const token = typeof out === "string" ? out : out?.access_token || out?.token;
    if (token && String(token).trim()) return String(token).trim();
  }

  const err = new Error("Token Mercado Livre indisponivel para a conta selecionada.");
  err.statusCode = 401;
  throw err;
}

async function mlGet(path, token, opts = {}) {
  const maxAttempts = asInt(opts.maxAttempts, 3);
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetch(`${ML_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }

    if (response.ok) return json;
    lastError = new Error(json?.message || `Mercado Livre HTTP ${response.status}`);
    lastError.statusCode = response.status;
    lastError.details = json;
    if (response.status !== 429 && response.status < 500) break;
    await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
  }

  throw lastError || new Error("Falha ao consultar Mercado Livre.");
}

async function ensureTables() {
  await db.query(`
    ALTER TABLE anuncios_full
      ADD COLUMN IF NOT EXISTS sold_7d INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS sold_15d INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS sold_30d INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS revenue_7d_cents BIGINT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS revenue_15d_cents BIGINT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS revenue_30d_cents BIGINT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS coverage_days NUMERIC(12,2),
      ADD COLUMN IF NOT EXISTS suggested_restock_30d INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS full_synced_payload JSONB;
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS full_plans (
      id BIGSERIAL PRIMARY KEY,
      meli_conta_id BIGINT NOT NULL REFERENCES meli_contas (id) ON DELETE CASCADE,
      usuario_id BIGINT REFERENCES usuarios (id) ON DELETE SET NULL,
      nome TEXT NOT NULL,
      observacao TEXT,
      periodo_inicio DATE NOT NULL,
      periodo_fim DATE NOT NULL,
      periodo_dias INTEGER NOT NULL DEFAULT 30,
      cobertura_dias INTEGER NOT NULL DEFAULT 30,
      fator_seguranca NUMERIC(8,4) NOT NULL DEFAULT 0,
      total_sugerido INTEGER NOT NULL DEFAULT 0,
      total_valor_cents BIGINT NOT NULL DEFAULT 0,
      frete_cents BIGINT NOT NULL DEFAULT 0,
      total_volume_m3 NUMERIC(14,5) NOT NULL DEFAULT 0,
      item_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    ALTER TABLE full_plans
      ADD COLUMN IF NOT EXISTS frete_cents BIGINT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS total_volume_m3 NUMERIC(14,5) NOT NULL DEFAULT 0;
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS full_plan_items (
      id BIGSERIAL PRIMARY KEY,
      plan_id BIGINT NOT NULL REFERENCES full_plans (id) ON DELETE CASCADE,
      meli_conta_id BIGINT NOT NULL REFERENCES meli_contas (id) ON DELETE CASCADE,
      mlb TEXT NOT NULL,
      sku TEXT,
      title TEXT,
      image_url TEXT,
      price_cents BIGINT NOT NULL DEFAULT 0,
      stock_full INTEGER NOT NULL DEFAULT 0,
      units_sold INTEGER NOT NULL DEFAULT 0,
      revenue_cents BIGINT NOT NULL DEFAULT 0,
      daily_velocity NUMERIC(12,4) NOT NULL DEFAULT 0,
      coverage_days NUMERIC(12,2),
      suggested_restock INTEGER NOT NULL DEFAULT 0,
      priority TEXT NOT NULL DEFAULT 'low',
      payload JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

function pickSku(item) {
  if (item?.seller_custom_field) return String(item.seller_custom_field);
  const attrs = Array.isArray(item?.attributes) ? item.attributes : [];
  const sku = attrs.find((attr) => attr?.id === "SELLER_SKU" || /sku/i.test(String(attr?.name || "")));
  return sku?.value_name || sku?.value_id || null;
}

function pickImage(item) {
  return item?.secure_thumbnail || item?.thumbnail || item?.pictures?.[0]?.secure_url || item?.pictures?.[0]?.url || null;
}

function isFullItem(item) {
  const logisticType = String(item?.shipping?.logistic_type || "").toLowerCase();
  const tags = Array.isArray(item?.tags) ? item.tags.map((tag) => String(tag).toLowerCase()) : [];
  return logisticType === "fulfillment" || tags.some((tag) => tag.includes("fulfillment"));
}

async function getSellerId(token) {
  const me = await mlGet("/users/me", token);
  return me?.id;
}

async function fetchSellerItems({ token, sellerId, onlyFull = false }) {
  try {
    const ids = [];
    let scrollId = "";
    let guard = 0;

    for (;;) {
      const qs = new URLSearchParams();
      qs.set("status", "active");
      qs.set("search_type", "scan");
      if (onlyFull) qs.set("logistic_type", "fulfillment");
      qs.set("limit", "50");
      if (scrollId) qs.set("scroll_id", scrollId);

      const data = await mlGet(`/users/${encodeURIComponent(sellerId)}/items/search?${qs.toString()}`, token);
      const results = Array.isArray(data?.results) ? data.results : [];
      ids.push(...results.map(normalizeMlb).filter(Boolean));
      scrollId = String(data?.scroll_id || "").trim();
      guard += 1;

      if (!scrollId || !results.length || guard >= 1000) break;
    }

    const unique = Array.from(new Set(ids));
    if (unique.length) return unique;
  } catch (error) {
    console.warn("[Full] items/search scan falhou, usando fallback por offset:", error?.message || error);
  }

  const ids = [];
  let offset = 0;
  const limit = 50;
  for (;;) {
    const qs = new URLSearchParams();
    qs.set("status", "active");
    if (onlyFull) qs.set("logistic_type", "fulfillment");
    qs.set("limit", String(limit));
    qs.set("offset", String(offset));
    const data = await mlGet(`/users/${encodeURIComponent(sellerId)}/items/search?${qs.toString()}`, token);
    const results = Array.isArray(data?.results) ? data.results : [];
    ids.push(...results.map(normalizeMlb).filter(Boolean));
    const total = asInt(data?.paging?.total, ids.length);
    offset += limit;
    if (!results.length || offset >= total || offset >= 1000) break;
  }
  return Array.from(new Set(ids));
}

async function enrichItems(token, ids) {
  const out = [];
  const attrs = [
    "id",
    "title",
    "thumbnail",
    "secure_thumbnail",
    "price",
    "base_price",
    "status",
    "sold_quantity",
    "available_quantity",
    "inventory_id",
    "shipping",
    "tags",
    "seller_custom_field",
    "attributes",
    "variations",
  ].join(",");

  for (let index = 0; index < ids.length; index += 20) {
    const chunk = ids.slice(index, index + 20);
    const payload = await mlGet(`/items?ids=${encodeURIComponent(chunk.join(","))}&attributes=${encodeURIComponent(attrs)}`, token);
    for (const row of Array.isArray(payload) ? payload : []) {
      if (row?.code && row.code >= 400) continue;
      const item = row?.body || row;
      if (item?.id) out.push(item);
    }
  }
  return out;
}

function toFixedNumber(value, digits = 2) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(digits));
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, Number(value || 0)));
}

function computeTrendScore({ sold7d, sold15d, sold30d }) {
  const d7 = Number(sold7d || 0) / 7;
  const d15 = Number(sold15d || 0) / 15;
  const d30 = Number(sold30d || 0) / 30;

  const growth7vs30 = d30 > 0 ? (d7 - d30) / d30 : d7 > 0 ? 1 : 0;
  const growth15vs30 = d30 > 0 ? (d15 - d30) / d30 : d15 > 0 ? 0.6 : 0;
  const volume = Math.log1p(Number(sold30d || 0));
  const consistency = sold7d > 0 && sold15d > 0 && sold30d > 0 ? 1 : 0;

  const score =
    volume * 2 +
    clampNumber(growth7vs30, -0.9, 2.5) * 2 +
    clampNumber(growth15vs30, -0.9, 2.5) +
    consistency;

  return {
    score: toFixedNumber(score, 4),
    growth_7_vs_30_pct: toFixedNumber(growth7vs30 * 100, 2),
    growth_15_vs_30_pct: toFixedNumber(growth15vs30 * 100, 2),
    daily_7d: toFixedNumber(d7, 4),
    daily_15d: toFixedNumber(d15, 4),
    daily_30d: toFixedNumber(d30, 4),
  };
}

function diagnoseSelectionTrend({ sold7d, sold15d, sold30d }) {
  const d7 = Number(sold7d || 0) / 7;
  const d15 = Number(sold15d || 0) / 15;
  const d30 = Number(sold30d || 0) / 30;
  if (Number(sold30d || 0) <= 0) return { key: "idle", label: "Sem base", detail: "sem venda 30d" };
  if (Number(sold7d || 0) <= 0) return { key: "drop", label: "Queda", detail: "sem venda 7d" };

  const ratio15 = d30 > 0 ? d15 / d30 : 0;
  const ratio7 = d15 > 0 ? d7 / d15 : d30 > 0 ? d7 / d30 : 0;

  if (ratio15 >= 1.15 && ratio7 >= 0.9) return { key: "accelerating", label: "Acelerando", detail: "15d acima e 7d firme" };
  if (ratio15 >= 0.85 && ratio7 >= 0.85) return { key: "strong", label: "Forte", detail: "30d bom e 7d estavel" };
  if (ratio15 >= 0.7 && ratio7 >= 0.7) return { key: "stable", label: "Estavel", detail: "ritmo aceitavel" };
  if (ratio7 < 0.55 || ratio15 < 0.55) return { key: "drop", label: "Queda", detail: "ritmo caiu" };
  return { key: "attention", label: "Atencao", detail: "validar antes da carga" };
}

function parseManualMlbs(value) {
  if (Array.isArray(value)) {
    return Array.from(new Set(value.map(normalizeMlb).filter(Boolean)));
  }
  return Array.from(
    new Set(
      String(value || "")
        .split(/[\s,;]+/)
        .map(normalizeMlb)
        .filter(Boolean),
    ),
  );
}

function computePlannerPriorityScore({
  mode = "replenishment",
  sizeGroup = "small_medium",
  sold30d = 0,
  revenueCents = 0,
  trendScore = 0,
  coverageDays = null,
  suggestedRestock = 0,
}) {
  const volume = Math.log1p(Number(sold30d || 0));
  const revenue = Math.log1p(Number(revenueCents || 0) / 100);
  const trend = Number(trendScore || 0);
  const urgency = coverageDays === null ? 0 : clampNumber((30 - Number(coverageDays || 0)) / 30, -1, 1.5);
  const suggested = Math.log1p(Number(suggestedRestock || 0));

  if (mode === "selection") {
    if (sizeGroup === "large_xlarge") {
      return toFixedNumber(revenue * 2.4 + trend * 0.7 + volume * 0.5 + suggested * 0.25, 4);
    }
    return toFixedNumber(volume * 2.4 + trend * 0.8 + revenue * 0.25 + suggested * 0.35, 4);
  }
  return toFixedNumber(volume * 1.6 + urgency * 1.1 + trend * 0.9 + suggested * 0.7, 4);
}

function parseNumberFromText(value) {
  const raw = String(value || "").replace(",", ".").match(/-?\d+(\.\d+)?/);
  if (!raw) return null;
  const n = Number(raw[0]);
  return Number.isFinite(n) ? n : null;
}

function attrValueText(attr = {}) {
  if (!attr || typeof attr !== "object") return "";
  return String(
    attr.value_struct?.number !== undefined
      ? `${attr.value_struct.number} ${attr.value_struct.unit || ""}`
      : attr.value_name || attr.value_id || "",
  ).trim();
}

function normalizeLengthToCm(value, unit = "") {
  const n = Number(String(value ?? "").replace(",", "."));
  if (!Number.isFinite(n) || n <= 0) return null;
  const u = String(unit || "").toLowerCase();
  const cm = u.includes("mm") || u.includes("milimet")
    ? n / 10
    : u === "m" || u.includes("metro")
      ? n * 100
      : n;
  return cm > 0 && cm <= 500 ? cm : null;
}

function dimensionFromAttribute(attrs = [], aliases = []) {
  const aliasSet = new Set(aliases.map((value) => String(value || "").toUpperCase()));
  for (const attr of attrs) {
    const id = String(attr?.id || "").toUpperCase();
    const name = String(attr?.name || "").toUpperCase();
    if (![id, name].some((key) => aliasSet.has(key))) continue;
    if (attr?.value_struct?.number !== undefined) {
      return normalizeLengthToCm(attr.value_struct.number, attr.value_struct.unit);
    }
    const text = attrValueText(attr);
    const match = text.match(/(\d+(?:[.,]\d+)?)\s*(mm|cm|m|milimetros?|centimetros?|metros?)?/i);
    if (match) return normalizeLengthToCm(match[1], match[2] || "cm");
  }
  return null;
}

function volumeFromDimensionText(value) {
  const raw = String(value || "").toLowerCase();
  const matches = [...raw.matchAll(/(\d+(?:[.,]\d+)?)\s*(mm|cm|m|milimetros?|centimetros?|metros?)?/gi)];
  if (matches.length < 3) return 0;
  const dims = matches
    .slice(0, 3)
    .map((match) => normalizeLengthToCm(match[1], match[2] || "cm"));
  if (!dims.every((n) => Number.isFinite(n) && n > 0)) return 0;
  const volume = (dims[0] * dims[1] * dims[2]) / 1000000;
  return volume > 0 && volume <= 20 ? toFixedNumber(volume, 5) : 0;
}

function isDimensionAttribute(attr = {}) {
  const key = `${attr?.id || ""} ${attr?.name || ""}`
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  return /(dimension|dimensao|dimensoes|medida|medidas|embalagem|pacote|package|altura|height|largura|width|comprimento|length|profundidade)/.test(key);
}

function parseItemVolumeM3(item = {}) {
  const shipping = item?.shipping || {};
  const dimensionTexts = [
    shipping.dimensions,
    shipping.shipping_option?.dimensions,
    shipping.shipping_option?.estimated_dimensions,
    shipping.shipping_option?.estimated_delivery_time?.shipping,
  ].filter(Boolean);
  for (const text of dimensionTexts) {
    const volume = volumeFromDimensionText(text);
    if (volume > 0) return volume;
  }

  const attrs = [
    ...(Array.isArray(item?.attributes) ? item.attributes : []),
    ...((Array.isArray(item?.variations) ? item.variations : []).flatMap((variation) => [
      ...(Array.isArray(variation?.attributes) ? variation.attributes : []),
      ...(Array.isArray(variation?.attribute_combinations) ? variation.attribute_combinations : []),
    ])),
  ];
  const height = dimensionFromAttribute(attrs, [
    "PACKAGE_HEIGHT", "PACKAGE_LENGTH_HEIGHT", "HEIGHT", "ALTO", "ALTURA", "ALTURA DEL PAQUETE", "ALTURA DA EMBALAGEM",
  ]);
  const width = dimensionFromAttribute(attrs, [
    "PACKAGE_WIDTH", "WIDTH", "ANCHO", "LARGURA", "LARGURA DO PACOTE", "LARGURA DA EMBALAGEM",
  ]);
  const length = dimensionFromAttribute(attrs, [
    "PACKAGE_LENGTH", "LENGTH", "LARGO", "COMPRIMENTO", "PROFUNDIDADE", "COMPRIMENTO DO PACOTE", "COMPRIMENTO DA EMBALAGEM",
  ]);
  if ([height, width, length].every((n) => Number.isFinite(n) && n > 0)) {
    return toFixedNumber((height * width * length) / 1000000, 5);
  }

  const dimensionalText = attrs.filter(isDimensionAttribute).map(attrValueText).join(" ");
  return volumeFromDimensionText(dimensionalText);
}

function resolveSizeGroup(item = {}) {
  const shipping = item?.shipping || {};
  const tags = Array.isArray(item?.tags) ? item.tags.map((tag) => String(tag || "").toLowerCase()) : [];
  const haystack = [
    item?.title,
    shipping.size,
    shipping.size_type,
    shipping.shipping_option?.size,
    shipping.shipping_option?.size_type,
    ...tags,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  if (/(^|\s)(pe|pes|pezinho|pezinhos|palito|sapata|sapatas|sousplat|prato|pratos|bandeja|bandejas)(\s|$)/.test(haystack)) return "small_medium";
  if (/(^|\s)(poltrona|poltronas|cadeira|cadeiras|banqueta|banquetas|sofa|sofas|mesa|mesas|rack|painel)(\s|$)/.test(haystack)) return "large_xlarge";
  if (/(xlarge|extra[\s_-]*grande|extra[\s_-]*large|extragrande|xxl|xl)/.test(haystack)) return "large_xlarge";
  if (/(large|grande)/.test(haystack)) return "large_xlarge";
  if (/(small|medium|pequeno|medio)/.test(haystack)) return "small_medium";

  const dimText = String(shipping.dimensions || "").toLowerCase();
  const weightText = String(shipping.weight || shipping.shipping_option?.weight || "").toLowerCase();
  const dimNumbers = dimText.match(/\d+(\.\d+)?/g);
  const weightKg = parseNumberFromText(weightText) || (dimNumbers && dimNumbers.length >= 4 ? Number(dimNumbers[3]) / 1000 : null);
  const height = dimNumbers && dimNumbers[0] ? Number(dimNumbers[0]) : null;
  const width = dimNumbers && dimNumbers[1] ? Number(dimNumbers[1]) : null;
  const length = dimNumbers && dimNumbers[2] ? Number(dimNumbers[2]) : null;

  if (
    (Number.isFinite(weightKg) && weightKg >= 15) ||
    (Number.isFinite(height) && height >= 70) ||
    (Number.isFinite(width) && width >= 70) ||
    (Number.isFinite(length) && length >= 70)
  ) {
    return "large_xlarge";
  }
  return "small_medium";
}

function allocateWithCapacity(items, { storageCapacity = 0, maxItems = 25 }) {
  const cap = Math.max(0, asInt(storageCapacity, 0));
  const max = clamp(asInt(maxItems, 25), 1, 25);
  const ranked = [...items]
    .filter((row) => Number(row.suggested_restock || 0) > 0)
    .sort((a, b) => Number(b.planner_priority_score || 0) - Number(a.planner_priority_score || 0) || Number(b.sold_30d || 0) - Number(a.sold_30d || 0))
    .slice(0, max);

  if (!ranked.length) return [];
  if (cap <= 0) return ranked.map((row) => ({ ...row }));

  const totalSuggested = ranked.reduce((sum, row) => sum + Number(row.suggested_restock || 0), 0);
  if (totalSuggested <= cap) return ranked.map((row) => ({ ...row }));

  const withIdeal = ranked.map((row) => {
    const suggested = Number(row.suggested_restock || 0);
    const ideal = (suggested / totalSuggested) * cap;
    const floor = Math.min(suggested, Math.floor(ideal));
    return {
      row,
      suggested,
      ideal,
      floor,
      frac: ideal - floor,
    };
  });

  let allocated = withIdeal.reduce((sum, x) => sum + x.floor, 0);
  let remaining = Math.max(0, cap - allocated);
  withIdeal.sort((a, b) => b.frac - a.frac);

  for (const slot of withIdeal) {
    if (remaining <= 0) break;
    if (slot.floor >= slot.suggested) continue;
    slot.floor += 1;
    remaining -= 1;
    allocated += 1;
  }

  return withIdeal
    .map((slot) => ({
      ...slot.row,
      suggested_restock: slot.floor,
    }))
    .filter((row) => Number(row.suggested_restock || 0) > 0);
}

function computeManualSuggestion({ unitsSold40d = 0, coverageDays = 30, safety = 0 }) {
  const daily = Number(unitsSold40d || 0) / 40;
  const target = daily * Number(coverageDays || 30) * (1 + Number(safety || 0));
  return Math.max(0, Math.floor(target));
}

async function fetchStock(token, inventoryId) {
  if (!inventoryId) return 0;
  try {
    const stock = await mlGet(`/inventories/${encodeURIComponent(inventoryId)}/stock/fulfillment`, token, { maxAttempts: 2 });
    return Math.max(0, asInt(stock?.available_quantity, 0));
  } catch {
    return 0;
  }
}

async function aggregateOrders({ token, sellerId, range }) {
  const byMlb = new Map();
  const bySku = new Map();
  const now = endOfDay(range.to);
  const d7 = addDays(startOfDay(now), -6);
  const d15 = addDays(startOfDay(now), -14);
  const d30 = addDays(startOfDay(now), -29);
  const limit = 50;
  let offset = 0;

  for (;;) {
    const qs = new URLSearchParams();
    qs.set("seller", String(sellerId));
    qs.set("order.status", "paid");
    qs.set("order.date_created.from", startOfDay(range.from).toISOString());
    qs.set("order.date_created.to", endOfDay(range.to).toISOString());
    qs.set("sort", "date_desc");
    qs.set("limit", String(limit));
    qs.set("offset", String(offset));

    const data = await mlGet(`/orders/search?${qs.toString()}`, token, { maxAttempts: 5 });
    const results = Array.isArray(data?.results) ? data.results : [];
    for (const order of results) {
      const created = new Date(order?.date_created || order?.date_closed || 0);
      const isFull = String(order?.shipping?.logistic_type || "").toLowerCase() === "fulfillment";
      for (const orderItem of order?.order_items || []) {
        const mlb = normalizeMlb(orderItem?.item?.id);
        const skuRaw =
          orderItem?.item?.seller_sku ||
          orderItem?.item?.seller_custom_field ||
          orderItem?.item?.id_variation ||
          null;
        const sku = String(skuRaw || "").trim().toUpperCase();
        if (!mlb) continue;
        const units = Math.max(0, asInt(orderItem?.quantity, 0));
        if (!units) continue;
        const revenueCents = moneyToCents(Number(orderItem?.unit_price || 0) * units);
        const row = byMlb.get(mlb) || {
          mlb,
          units: 0,
          revenue_cents: 0,
          sold_7d: 0,
          sold_15d: 0,
          sold_30d: 0,
          revenue_7d_cents: 0,
          revenue_15d_cents: 0,
          revenue_30d_cents: 0,
          is_full_order: false,
        };
        row.units += units;
        row.revenue_cents += revenueCents;
        row.is_full_order = row.is_full_order || isFull;
        if (created >= d30) {
          row.sold_30d += units;
          row.revenue_30d_cents += revenueCents;
        }
        if (created >= d15) {
          row.sold_15d += units;
          row.revenue_15d_cents += revenueCents;
        }
        if (created >= d7) {
          row.sold_7d += units;
          row.revenue_7d_cents += revenueCents;
        }
        byMlb.set(mlb, row);

        if (sku) {
          const skuRow = bySku.get(sku) || {
            sku,
            units: 0,
            revenue_cents: 0,
            sold_7d: 0,
            sold_15d: 0,
            sold_30d: 0,
            revenue_7d_cents: 0,
            revenue_15d_cents: 0,
            revenue_30d_cents: 0,
          };
          skuRow.units += units;
          skuRow.revenue_cents += revenueCents;
          if (created >= d30) {
            skuRow.sold_30d += units;
            skuRow.revenue_30d_cents += revenueCents;
          }
          if (created >= d15) {
            skuRow.sold_15d += units;
            skuRow.revenue_15d_cents += revenueCents;
          }
          if (created >= d7) {
            skuRow.sold_7d += units;
            skuRow.revenue_7d_cents += revenueCents;
          }
          bySku.set(sku, skuRow);
        }
      }
    }

    const total = asInt(data?.paging?.total, 0);
    offset += limit;
    if (!results.length || offset >= total || offset >= 10000) break;
  }

  return { byMlb, bySku };
}

function computeSuggestion({ stockFull, unitsSold, days, coverageDays = 30, safety = 0 }) {
  const daily = days > 0 ? Number(unitsSold || 0) / days : 0;
  const target = daily * Number(coverageDays || 30) * (1 + Number(safety || 0));
  const suggested = Math.max(0, Math.ceil(target - Number(stockFull || 0)));
  const coverage = daily > 0 ? Number(stockFull || 0) / daily : null;
  return {
    daily_velocity: Number(daily.toFixed(4)),
    coverage_days: coverage === null ? null : Number(coverage.toFixed(2)),
    suggested_restock: suggested,
  };
}

function priorityFor({ suggestedRestock, coverageDays, unitsSold }) {
  if (Number(unitsSold || 0) <= 0) return "idle";
  if (Number(suggestedRestock || 0) <= 0) return "ok";
  if (coverageDays !== null && Number(coverageDays) <= 7) return "high";
  if (coverageDays !== null && Number(coverageDays) <= 15) return "medium";
  return "low";
}

async function upsertProduct(row) {
  const query = `
    INSERT INTO anuncios_full
      (meli_conta_id, mlb, sku, title, image_url, inventory_id, price, stock_full,
       sold_total, sold_40d, sold_7d, sold_15d, sold_30d,
       revenue_7d_cents, revenue_15d_cents, revenue_30d_cents,
       listing_status, status, coverage_days, suggested_restock_30d,
       full_synced_payload, last_synced_at, created_at, updated_at)
    VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,NOW(),NOW(),NOW())
    ON CONFLICT (meli_conta_id, mlb)
    DO UPDATE SET
      sku = EXCLUDED.sku,
      title = EXCLUDED.title,
      image_url = EXCLUDED.image_url,
      inventory_id = EXCLUDED.inventory_id,
      price = EXCLUDED.price,
      stock_full = EXCLUDED.stock_full,
      sold_total = EXCLUDED.sold_total,
      sold_40d = EXCLUDED.sold_40d,
      sold_7d = EXCLUDED.sold_7d,
      sold_15d = EXCLUDED.sold_15d,
      sold_30d = EXCLUDED.sold_30d,
      revenue_7d_cents = EXCLUDED.revenue_7d_cents,
      revenue_15d_cents = EXCLUDED.revenue_15d_cents,
      revenue_30d_cents = EXCLUDED.revenue_30d_cents,
      listing_status = EXCLUDED.listing_status,
      status = EXCLUDED.status,
      coverage_days = EXCLUDED.coverage_days,
      suggested_restock_30d = EXCLUDED.suggested_restock_30d,
      full_synced_payload = EXCLUDED.full_synced_payload,
      last_synced_at = NOW(),
      updated_at = NOW()
    RETURNING *;
  `;

  const params = [
    row.meli_conta_id,
    row.mlb,
    row.sku,
    row.title,
    row.image_url,
    row.inventory_id,
    row.price,
    row.stock_full,
    row.sold_total,
    row.sold_30d,
    row.sold_7d,
    row.sold_15d,
    row.sold_30d,
    row.revenue_7d_cents,
    row.revenue_15d_cents,
    row.revenue_30d_cents,
    row.listing_status,
    row.status,
    row.coverage_days,
    row.suggested_restock_30d,
    row.payload || null,
  ];
  const result = await db.query(query, params);
  return result.rows[0];
}

function productRow(row) {
  const suggestion = computeSuggestion({
    stockFull: row.stock_full,
    unitsSold: row.sold_30d,
    days: 30,
    coverageDays: 30,
  });
  const priority = priorityFor({
    suggestedRestock: row.suggested_restock_30d,
    coverageDays: row.coverage_days,
    unitsSold: row.sold_30d,
  });
  return {
    id: row.id,
    mlb: row.mlb,
    sku: row.sku,
    title: row.title,
    image_url: row.image_url,
    inventory_id: row.inventory_id,
    price_cents: moneyToCents(row.price),
    stock_full: asInt(row.stock_full, 0),
    sold_total: asInt(row.sold_total, 0),
    sold_7d: asInt(row.sold_7d, 0),
    sold_15d: asInt(row.sold_15d, 0),
    sold_30d: asInt(row.sold_30d || row.sold_40d, 0),
    revenue_7d_cents: Number(row.revenue_7d_cents || 0),
    revenue_15d_cents: Number(row.revenue_15d_cents || 0),
    revenue_30d_cents: Number(row.revenue_30d_cents || 0),
    coverage_days: row.coverage_days === null ? suggestion.coverage_days : Number(row.coverage_days),
    suggested_restock_30d: asInt(row.suggested_restock_30d, suggestion.suggested_restock),
    priority,
    listing_status: row.listing_status,
    status: row.status,
    last_synced_at: row.last_synced_at,
    updated_at: row.updated_at,
  };
}

async function listProducts({ meliContaId, q = "", status = "all", sort = "suggested", limit = 200 }) {
  await ensureTables();
  const params = [meliContaId];
  const where = ["meli_conta_id = $1"];
  const search = String(q || "").trim();
  if (search) {
    params.push(`%${search}%`);
    where.push(`(mlb ILIKE $${params.length} OR COALESCE(sku,'') ILIKE $${params.length} OR COALESCE(title,'') ILIKE $${params.length})`);
  }
  if (status && status !== "all") {
    params.push(status);
    where.push(`status = $${params.length}`);
  }

  const orderBy = {
    suggested: "suggested_restock_30d DESC, sold_30d DESC, updated_at DESC",
    sold: "sold_30d DESC, revenue_30d_cents DESC",
    coverage: "coverage_days ASC NULLS LAST, sold_30d DESC",
    stock: "stock_full ASC, sold_30d DESC",
  }[sort] || "suggested_restock_30d DESC, sold_30d DESC";

  params.push(clamp(asInt(limit, 200), 20, 500));
  const result = await db.query(
    `SELECT * FROM anuncios_full WHERE ${where.join(" AND ")} ORDER BY ${orderBy} LIMIT $${params.length}`,
    params,
  );
  const sync = await db.query(
    `SELECT MAX(last_synced_at) AS last_synced_at, COUNT(*)::int AS total FROM anuncios_full WHERE meli_conta_id = $1`,
    [meliContaId],
  );
  const rows = result.rows.map(productRow);
  return {
    ok: true,
    last_synced_at: sync.rows[0]?.last_synced_at || null,
    total_cached: sync.rows[0]?.total || 0,
    items: rows,
    kpis: summarizeRows(rows),
  };
}

function summarizeRows(rows) {
  const totalSuggested = rows.reduce((sum, row) => sum + asInt(row.suggested_restock_30d, 0), 0);
  const lowCoverage = rows.filter((row) => row.coverage_days !== null && Number(row.coverage_days) <= 15).length;
  const noStock = rows.filter((row) => asInt(row.stock_full, 0) <= 0).length;
  const revenue30 = rows.reduce((sum, row) => sum + Number(row.revenue_30d_cents || 0), 0);
  return {
    products: rows.length,
    total_suggested_30d: totalSuggested,
    low_coverage: lowCoverage,
    no_stock: noStock,
    revenue_30d_cents: revenue30,
  };
}

async function syncProducts({ req, res }) {
  await ensureTables();
  const meliContaId = currentMeliContaId(res);
  if (!meliContaId) {
    const err = new Error("Conta Mercado Livre nao identificada.");
    err.statusCode = 400;
    throw err;
  }

  const token = await getAccessToken(req, res, meliContaId);
  const sellerId = await getSellerId(token);
  const ids = await fetchSellerItems({ token, sellerId, onlyFull: true });
  const items = (await enrichItems(token, ids)).filter(isFullItem);
  const orders = await aggregateOrders({
    token,
    sellerId,
    range: { from: addDays(startOfDay(new Date()), -29), to: startOfDay(new Date()) },
  });

  const seen = [];
  const saved = [];
  for (const item of items) {
    const mlb = normalizeMlb(item.id);
    if (!mlb) continue;
    seen.push(mlb);
    const itemSku = String(pickSku(item) || "").trim().toUpperCase();
    const aggByMlb = orders.byMlb.get(mlb) || {};
    const aggBySku = itemSku ? orders.bySku.get(itemSku) || {} : {};
    const mlbUnits = Number(aggByMlb.sold_30d || 0);
    const skuUnits = Number(aggBySku.sold_30d || 0);
    // Fallback por SKU somente quando MLB vem zerado para reduzir divergencia com o painel Full do ML.
    const agg = mlbUnits > 0 ? aggByMlb : skuUnits > 0 ? aggBySku : aggByMlb;
    const stockFull = await fetchStock(token, item.inventory_id);
    const suggestion = computeSuggestion({
      stockFull,
      unitsSold: agg.sold_30d || 0,
      days: 30,
      coverageDays: 30,
    });
    const status = stockFull <= 0 ? "no_stock" : suggestion.coverage_days !== null && suggestion.coverage_days <= 15 ? "low_coverage" : "active";
    const row = await upsertProduct({
      meli_conta_id: meliContaId,
      mlb,
      sku: itemSku || pickSku(item),
      title: item.title || mlb,
      image_url: pickImage(item),
      inventory_id: item.inventory_id || null,
      price: item.price ?? item.base_price ?? null,
      stock_full: stockFull,
      sold_total: asInt(item.sold_quantity, 0),
      sold_7d: Number(agg.sold_7d || 0),
      sold_15d: Number(agg.sold_15d || 0),
      sold_30d: Number(agg.sold_30d || 0),
      revenue_7d_cents: Number(agg.revenue_7d_cents || 0),
      revenue_15d_cents: Number(agg.revenue_15d_cents || 0),
      revenue_30d_cents: Number(agg.revenue_30d_cents || 0),
      listing_status: item.status || null,
      status,
      coverage_days: suggestion.coverage_days,
      suggested_restock_30d: suggestion.suggested_restock,
      payload: { shipping: item.shipping || null, tags: item.tags || [] },
    });
    saved.push(productRow(row));
  }

  if (seen.length) {
    await db.query(
      `DELETE FROM anuncios_full WHERE meli_conta_id = $1 AND NOT (mlb = ANY($2::text[]))`,
      [meliContaId, seen],
    );
  } else {
    await db.query(`DELETE FROM anuncios_full WHERE meli_conta_id = $1`, [meliContaId]);
  }

  return {
    ok: true,
    synced_at: new Date().toISOString(),
    seller_id: sellerId,
    found_full: saved.length,
    items: saved,
    kpis: summarizeRows(saved),
  };
}

async function buildPlanner({ req, res, input = {} }) {
  await ensureTables();
  const meliContaId = currentMeliContaId(res);
  if (!meliContaId) {
    const err = new Error("Conta Mercado Livre nao identificada.");
    err.statusCode = 400;
    throw err;
  }

  const range = resolveRange(input);
  const coverageDays = clamp(asInt(input.coverage_days, 30), 1, 180);
  const safety = clamp(Number(input.safety_factor || 0), 0, 1);
  const includeIdle = String(input.include_idle ?? "true") !== "false";
  const minSuggestion = Math.max(0, asInt(input.min_suggestion, 0));
  const storageCapacity = Math.max(0, asInt(input.storage_capacity, 0));
  const capacitySmallMedium = Math.max(0, asInt(input.storage_capacity_small_medium, 0));
  const capacityLargeXlarge = Math.max(0, asInt(input.storage_capacity_large_xlarge, 0));
  const selectedGroupInput = String(input.selection_group || "all").toLowerCase();
  const selectionGroup = selectedGroupInput === "small_medium" || selectedGroupInput === "large_xlarge" ? selectedGroupInput : "all";
  const maxItems = clamp(asInt(input.max_items, 25), 1, 100);
  const plannerModeInput = String(input.planner_mode || "replenishment").toLowerCase();
  const plannerMode = ["selection", "manual"].includes(plannerModeInput) ? plannerModeInput : "replenishment";
  const manualMlbs = parseManualMlbs(input.manual_mlbs || input.manual_mlb);

  const token = await getAccessToken(req, res, meliContaId);
  const sellerId = await getSellerId(token);
  const trendRange = { from: addDays(startOfDay(new Date()), -29), to: startOfDay(new Date()) };
  const manualRange = { from: addDays(startOfDay(new Date()), -39), to: startOfDay(new Date()), days: 40, label: "Ultimos 40 dias" };
  const trendAgg = await aggregateOrders({ token, sellerId, range: trendRange });
  const baseAgg = plannerMode === "manual"
    ? await aggregateOrders({ token, sellerId, range: manualRange })
    : range.days === 30 && ymd(range.to) === ymd(trendRange.to)
    ? trendAgg
    : await aggregateOrders({ token, sellerId, range });

  const fullCacheR = await db.query(
    `SELECT mlb, sku, title, image_url, stock_full FROM anuncios_full WHERE meli_conta_id = $1`,
    [meliContaId],
  );
  const fullCache = new Map((fullCacheR.rows || []).map((row) => [normalizeMlb(row.mlb), row]));

  const activeIds = plannerMode === "manual" ? [] : await fetchSellerItems({ token, sellerId, onlyFull: false });
  const idsToLoad = plannerMode === "manual"
    ? manualMlbs
    : activeIds.length
      ? activeIds
      : Array.from(new Set([...trendAgg.byMlb.keys(), ...baseAgg.byMlb.keys(), ...fullCache.keys()]));
  const itemDetails = await enrichItems(token, idsToLoad);
  const itemMap = new Map(itemDetails.map((item) => [normalizeMlb(item.id), item]));

  const candidateIds = plannerMode === "manual"
    ? manualMlbs
    : Array.from(
      new Set([...trendAgg.byMlb.keys(), ...baseAgg.byMlb.keys(), ...fullCache.keys()].filter(Boolean)),
    );

  const baseRows = candidateIds
    .map((mlb) => {
      const item = itemMap.get(mlb) || {};
      const cache = fullCache.get(mlb) || {};
      const skuKey = String(cache?.sku || pickSku(item) || "").trim().toUpperCase();
      const trendByMlb = trendAgg.byMlb.get(mlb) || {};
      const trendBySku = skuKey ? trendAgg.bySku.get(skuKey) || {} : {};
      const baseByMlb = baseAgg.byMlb.get(mlb) || {};
      const baseBySku = skuKey ? baseAgg.bySku.get(skuKey) || {} : {};

      const trend = Number(trendByMlb.sold_30d || 0) > 0
        ? trendByMlb
        : Number(trendBySku.sold_30d || 0) > 0
          ? trendBySku
          : trendByMlb;
      const base = Number(baseByMlb.units || 0) > 0
        ? baseByMlb
        : Number(baseBySku.units || 0) > 0
          ? baseBySku
          : baseByMlb;

      const sold30d = Number(trend.sold_30d || 0);
      const sold15d = Number(trend.sold_15d || 0);
      const sold7d = Number(trend.sold_7d || 0);
      const soldBase = Number(base.units || 0);
      const revenueBase = Number(base.revenue_cents || 0);

      const stockFull = Math.max(
        0,
        asInt(cache?.stock_full, 0),
      );

      const suggestion = plannerMode === "manual"
        ? {
          daily_velocity: toFixedNumber(soldBase / 40, 4),
          coverage_days: soldBase > 0 ? toFixedNumber(stockFull / (soldBase / 40), 1) : null,
          suggested_restock: computeManualSuggestion({ unitsSold40d: soldBase, coverageDays, safety }),
        }
        : computeSuggestion({
          stockFull,
          unitsSold: soldBase,
          days: range.days,
          coverageDays,
          safety,
        });
      const trendScore = computeTrendScore({ sold7d, sold15d, sold30d });
      const trendDiagnosis = diagnoseSelectionTrend({ sold7d, sold15d, sold30d });
      const logisticType = String(item?.shipping?.logistic_type || "").toLowerCase();
      const tags = Array.isArray(item?.tags) ? item.tags.map((tag) => String(tag || "").toLowerCase()) : [];
      const isFull = logisticType === "fulfillment" || tags.some((tag) => tag.includes("fulfillment"));
      const priceCents = moneyToCents(item?.price ?? item?.base_price ?? 0);
      const sizeGroup = resolveSizeGroup(item);
      const volumeM3Unit = parseItemVolumeM3(item);

      const plannerPriority = computePlannerPriorityScore({
        mode: plannerMode,
        sizeGroup,
        sold30d,
        revenueCents: revenueBase,
        trendScore: trendScore.score,
        coverageDays: suggestion.coverage_days,
        suggestedRestock: suggestion.suggested_restock,
      });

      return {
        mlb,
        sku: cache?.sku || pickSku(item),
        title: item?.title || cache?.title || mlb,
        image_url: pickImage(item) || cache?.image_url || null,
        stock_full: stockFull,
        is_full: isFull,
        size_group: sizeGroup,
        sold_7d: sold7d,
        sold_15d: sold15d,
        sold_30d: sold30d,
        units_sold: soldBase,
        revenue_cents: revenueBase,
        price_cents: priceCents,
        volume_m3_unit: volumeM3Unit,
        volume_m3_total: toFixedNumber(volumeM3Unit * suggestion.suggested_restock, 5),
        daily_velocity: suggestion.daily_velocity,
        coverage_days: suggestion.coverage_days,
        coverage_after_send_days: suggestion.daily_velocity > 0 ? toFixedNumber((stockFull + suggestion.suggested_restock) / suggestion.daily_velocity, 1) : null,
        system_suggested_restock: suggestion.suggested_restock,
        suggested_restock: suggestion.suggested_restock,
        suggested_value_cents: suggestion.suggested_restock * priceCents,
        formula_basis: plannerMode === "manual" ? "manual_40d" : "planner",
        trend_score: trendScore.score,
        planner_priority_score: plannerPriority,
        trend: trendScore,
        trend_diagnosis: trendDiagnosis,
        priority: priorityFor({
          suggestedRestock: suggestion.suggested_restock,
          coverageDays: suggestion.coverage_days,
          unitsSold: soldBase,
        }),
      };
    })
    .filter((row) => (plannerMode === "replenishment" ? row.is_full : true))
    .filter((row) => includeIdle || row.units_sold > 0);

  const plannerRows = baseRows
    .filter((row) => (plannerMode === "replenishment" ? row.is_full : true))
    .filter((row) => includeIdle || row.units_sold > 0);

  let items = [];
  if (plannerMode === "selection") {
    const selectionBase = plannerRows.filter((row) => row.suggested_restock >= minSuggestion);
    const filteredBase = selectionGroup === "all"
      ? selectionBase
      : selectionBase.filter((row) => row.size_group === selectionGroup);
    items = filteredBase
      .sort((a, b) => Number(b.planner_priority_score || 0) - Number(a.planner_priority_score || 0)
        || Number(b.revenue_cents || 0) - Number(a.revenue_cents || 0)
        || Number(b.units_sold || 0) - Number(a.units_sold || 0))
      .slice(0, maxItems);
  } else if (plannerMode === "manual") {
    items = plannerRows
      .filter((row) => row.suggested_restock >= minSuggestion)
      .slice(0, maxItems);
  } else {
    const mustRestock = allocateWithCapacity(
      plannerRows.filter((row) => row.suggested_restock > 0 && row.suggested_restock >= minSuggestion),
      { storageCapacity, maxItems },
    );
    const picked = new Set(mustRestock.map((row) => row.mlb));
    const noRestock = plannerRows
      .filter((row) => !picked.has(row.mlb))
      .map((row) => ({ ...row, suggested_restock: 0, suggested_value_cents: 0, priority: "ok" }));
    items = [...mustRestock, ...noRestock];
  }

  items = items
    .map((row) => ({
      ...row,
      suggested_value_cents: Number(row.suggested_restock || 0) * Number(row.price_cents || 0),
      volume_m3_total: toFixedNumber(Number(row.volume_m3_unit || 0) * Number(row.suggested_restock || 0), 5),
      coverage_after_send_days: Number(row.daily_velocity || 0) > 0
        ? toFixedNumber((Number(row.stock_full || 0) + Number(row.suggested_restock || 0)) / Number(row.daily_velocity || 0), 1)
        : null,
    }))
    .sort((a, b) => {
      if (plannerMode === "manual") {
        return Number(b.suggested_restock || 0) - Number(a.suggested_restock || 0)
          || Number(b.units_sold || 0) - Number(a.units_sold || 0);
      }
      if (plannerMode === "selection") {
        return Number(b.planner_priority_score || 0) - Number(a.planner_priority_score || 0)
          || Number(b.revenue_cents || 0) - Number(a.revenue_cents || 0)
          || Number(b.units_sold || 0) - Number(a.units_sold || 0);
      }
      return Number(b.suggested_restock || 0) - Number(a.suggested_restock || 0)
        || Number(b.planner_priority_score || 0) - Number(a.planner_priority_score || 0);
    });

  const poolTotals = {
    small_medium: {
      capacity: capacitySmallMedium,
      used: items.filter((row) => row.size_group === "small_medium").reduce((sum, row) => sum + Number(row.suggested_restock || 0), 0),
    },
    large_xlarge: {
      capacity: capacityLargeXlarge,
      used: items.filter((row) => row.size_group === "large_xlarge").reduce((sum, row) => sum + Number(row.suggested_restock || 0), 0),
    },
  };
  const outputRange = plannerMode === "manual" ? manualRange : range;

  return {
    ok: true,
    range: { from: ymd(outputRange.from), to: ymd(outputRange.to), days: outputRange.days, label: outputRange.label },
    settings: {
      coverage_days: coverageDays,
      safety_factor: safety,
      min_suggestion: minSuggestion,
      include_idle: includeIdle,
      storage_capacity: storageCapacity,
      storage_capacity_small_medium: capacitySmallMedium,
      storage_capacity_large_xlarge: capacityLargeXlarge,
      selection_group: selectionGroup,
      max_items: maxItems,
      trend_window_days: 30,
      manual_mlbs: manualMlbs,
      planner_mode: plannerMode,
    },
    pools: poolTotals,
    items,
    totals: {
      item_count: items.length,
      total_suggested: items.reduce((sum, row) => sum + row.suggested_restock, 0),
      total_value_cents: items.reduce((sum, row) => sum + row.suggested_value_cents, 0),
      total_volume_m3: toFixedNumber(items.reduce((sum, row) => sum + Number(row.volume_m3_total || 0), 0), 5),
    },
  };
}

async function savePlan({ req, res, input = {} }) {
  const planner = await buildPlanner({ req, res, input });
  if (Array.isArray(input.override_items)) {
    const allowed = new Set((planner.items || []).map((item) => normalizeMlb(item.mlb)));
    const byMlb = new Map((planner.items || []).map((item) => [normalizeMlb(item.mlb), item]));
    planner.items = input.override_items
      .map((raw) => {
        const mlb = normalizeMlb(raw?.mlb);
        if (!allowed.has(mlb)) return null;
        const base = byMlb.get(mlb) || {};
        const suggested = Math.max(0, asInt(raw?.suggested_restock, base.suggested_restock || 0));
        const priceCents = Number(base.price_cents || raw?.price_cents || 0);
        const volumeUnit = Number(base.volume_m3_unit || raw?.volume_m3_unit || 0);
        const velocity = Number(base.daily_velocity || raw?.daily_velocity || 0);
        return {
          ...base,
          system_suggested_restock: asInt(raw?.system_suggested_restock, base.system_suggested_restock || base.suggested_restock || suggested),
          suggested_restock: suggested,
          suggested_value_cents: suggested * priceCents,
          volume_m3_unit: volumeUnit,
          volume_m3_total: toFixedNumber(suggested * volumeUnit, 5),
          coverage_after_send_days: velocity > 0 ? toFixedNumber((Number(base.stock_full || raw?.stock_full || 0) + suggested) / velocity, 1) : null,
        };
      })
      .filter(Boolean);
    planner.totals = {
      item_count: planner.items.length,
      total_suggested: planner.items.reduce((sum, row) => sum + Number(row.suggested_restock || 0), 0),
      total_value_cents: planner.items.reduce((sum, row) => sum + Number(row.suggested_value_cents || 0), 0),
      total_volume_m3: toFixedNumber(planner.items.reduce((sum, row) => sum + Number(row.volume_m3_total || 0), 0), 5),
    };
  }
  const meliContaId = currentMeliContaId(res);
  const userId = Number(req?.user?.uid || req?.user?.id || 0) || null;
  const name = String(input.name || input.nome || "").trim() || `Planejamento Full ${planner.range.from} a ${planner.range.to}`;
  const observation = String(input.observation || input.observacao || "").trim() || null;
  const freightCents = Math.max(0, asInt(input.freight_cents || input.frete_cents, 0));

  return db.withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const planResult = await client.query(
        `INSERT INTO full_plans
          (meli_conta_id, usuario_id, nome, observacao, periodo_inicio, periodo_fim, periodo_dias,
           cobertura_dias, fator_seguranca, total_sugerido, total_valor_cents, frete_cents,
           total_volume_m3, item_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING *`,
        [
          meliContaId,
          userId,
          name,
          observation,
          planner.range.from,
          planner.range.to,
          planner.range.days,
          planner.settings.coverage_days,
          planner.settings.safety_factor,
          planner.totals.total_suggested,
          planner.totals.total_value_cents,
          freightCents,
          planner.totals.total_volume_m3 || 0,
          planner.totals.item_count,
        ],
      );
      const plan = planResult.rows[0];
      for (const item of planner.items) {
        await client.query(
          `INSERT INTO full_plan_items
            (plan_id, meli_conta_id, mlb, sku, title, image_url, price_cents, stock_full,
             units_sold, revenue_cents, daily_velocity, coverage_days, suggested_restock,
             priority, payload)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [
            plan.id,
            meliContaId,
            item.mlb,
            item.sku,
            item.title,
            item.image_url,
            item.price_cents,
            item.stock_full,
            item.units_sold,
            item.revenue_cents,
            item.daily_velocity,
            item.coverage_days,
            item.suggested_restock,
            item.priority,
            item,
          ],
        );
      }
      await client.query("COMMIT");
      return { ok: true, plan: normalizePlan(plan), items: planner.items };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

function normalizePlan(row) {
  return {
    id: Number(row.id),
    name: row.nome,
    observation: row.observacao,
    date_from: row.periodo_inicio,
    date_to: row.periodo_fim,
    period_days: asInt(row.periodo_dias, 0),
    coverage_days: asInt(row.cobertura_dias, 30),
    safety_factor: Number(row.fator_seguranca || 0),
    total_suggested: asInt(row.total_sugerido, 0),
    total_value_cents: Number(row.total_valor_cents || 0),
    freight_cents: Number(row.frete_cents || 0),
    freight_pct: Number(row.total_valor_cents || 0) > 0 ? Number(((Number(row.frete_cents || 0) / Number(row.total_valor_cents || 0)) * 100).toFixed(2)) : 0,
    total_volume_m3: Number(row.total_volume_m3 || 0),
    item_count: asInt(row.item_count, 0),
    small_medium_units: asInt(row.small_medium_units, 0),
    small_medium_count: asInt(row.small_medium_count, 0),
    large_xlarge_units: asInt(row.large_xlarge_units, 0),
    large_xlarge_count: asInt(row.large_xlarge_count, 0),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function listPlans({ meliContaId }) {
  await ensureTables();
  const result = await db.query(
    `SELECT
        p.*,
        COALESCE(SUM((i.payload->>'volume_m3_total')::numeric), 0) AS total_volume_m3,
        COALESCE(SUM(CASE WHEN i.payload->>'size_group' = 'small_medium' THEN i.suggested_restock ELSE 0 END), 0)::int AS small_medium_units,
        COALESCE(COUNT(*) FILTER (WHERE i.payload->>'size_group' = 'small_medium'), 0)::int AS small_medium_count,
        COALESCE(SUM(CASE WHEN i.payload->>'size_group' = 'large_xlarge' THEN i.suggested_restock ELSE 0 END), 0)::int AS large_xlarge_units,
        COALESCE(COUNT(*) FILTER (WHERE i.payload->>'size_group' = 'large_xlarge'), 0)::int AS large_xlarge_count
      FROM full_plans p
      LEFT JOIN full_plan_items i ON i.plan_id = p.id AND i.meli_conta_id = p.meli_conta_id
      WHERE p.meli_conta_id = $1
      GROUP BY p.id
      ORDER BY p.updated_at DESC
      LIMIT 80`,
    [meliContaId],
  );
  return { ok: true, plans: result.rows.map(normalizePlan) };
}

async function getPlan({ meliContaId, planId }) {
  await ensureTables();
  const planResult = await db.query(
    `SELECT * FROM full_plans WHERE meli_conta_id = $1 AND id = $2 LIMIT 1`,
    [meliContaId, planId],
  );
  if (!planResult.rowCount) {
    const err = new Error("Planejamento nao encontrado.");
    err.statusCode = 404;
    throw err;
  }
  const itemsResult = await db.query(
    `SELECT * FROM full_plan_items WHERE meli_conta_id = $1 AND plan_id = $2 ORDER BY suggested_restock DESC, units_sold DESC`,
    [meliContaId, planId],
  );
  return {
    ok: true,
    plan: normalizePlan(planResult.rows[0]),
    items: itemsResult.rows.map((row) => {
      const payload = row.payload && typeof row.payload === "object" ? row.payload : {};
      return {
        ...payload,
        mlb: row.mlb,
        sku: row.sku,
        title: row.title,
        image_url: row.image_url,
        price_cents: Number(row.price_cents || payload.price_cents || 0),
        stock_full: asInt(row.stock_full, payload.stock_full || 0),
        units_sold: asInt(row.units_sold, payload.units_sold || 0),
        revenue_cents: Number(row.revenue_cents || payload.revenue_cents || 0),
        daily_velocity: Number(row.daily_velocity || payload.daily_velocity || 0),
        coverage_days: row.coverage_days === null ? payload.coverage_days ?? null : Number(row.coverage_days),
        coverage_after_send_days: payload.coverage_after_send_days ?? null,
        system_suggested_restock: asInt(payload.system_suggested_restock, row.suggested_restock || payload.suggested_restock || 0),
        suggested_restock: asInt(row.suggested_restock, payload.suggested_restock || 0),
        priority: row.priority || payload.priority,
      };
    }),
  };
}

async function updatePlan({ meliContaId, planId, input = {} }) {
  await ensureTables();
  const name = String(input.name || input.nome || "").trim();
  const observation = String(input.observation || input.observacao || "").trim();
  const freightCents = input.freight_cents !== undefined || input.frete_cents !== undefined
    ? Math.max(0, asInt(input.freight_cents || input.frete_cents, 0))
    : null;
  return db.withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const items = Array.isArray(input.override_items) ? input.override_items : null;
      const totals = items
        ? {
          totalSuggested: items.reduce((sum, row) => sum + asInt(row?.suggested_restock, 0), 0),
          totalValueCents: items.reduce((sum, row) => sum + Number(row?.suggested_value_cents || (asInt(row?.suggested_restock, 0) * Number(row?.price_cents || 0))), 0),
          totalVolumeM3: toFixedNumber(items.reduce((sum, row) => sum + Number(row?.volume_m3_total || 0), 0), 5),
          itemCount: items.length,
        }
        : null;
      const result = await client.query(
        `UPDATE full_plans
            SET nome = COALESCE(NULLIF($3,''), nome),
                observacao = $4,
                total_sugerido = COALESCE($5, total_sugerido),
                total_valor_cents = COALESCE($6, total_valor_cents),
                item_count = COALESCE($7, item_count),
                frete_cents = COALESCE($8, frete_cents),
                total_volume_m3 = COALESCE($9, total_volume_m3),
                updated_at = NOW()
          WHERE meli_conta_id = $1 AND id = $2
          RETURNING *`,
        [
          meliContaId,
          planId,
          name,
          observation || null,
          totals ? totals.totalSuggested : null,
          totals ? totals.totalValueCents : null,
          totals ? totals.itemCount : null,
          freightCents,
          totals ? totals.totalVolumeM3 : null,
        ],
      );
      if (!result.rowCount) {
        const err = new Error("Planejamento nao encontrado.");
        err.statusCode = 404;
        throw err;
      }

      if (items) {
        await client.query(`DELETE FROM full_plan_items WHERE meli_conta_id = $1 AND plan_id = $2`, [meliContaId, planId]);
        for (const raw of items) {
          const suggested = asInt(raw?.suggested_restock, 0);
          const priceCents = Number(raw?.price_cents || 0);
          const velocity = Number(raw?.daily_velocity || 0);
          const item = {
            ...raw,
            system_suggested_restock: asInt(raw?.system_suggested_restock, raw?.suggested_restock || 0),
            suggested_restock: suggested,
            suggested_value_cents: Number(raw?.suggested_value_cents || suggested * priceCents),
            coverage_after_send_days: velocity > 0 ? toFixedNumber((Number(raw?.stock_full || 0) + suggested) / velocity, 1) : null,
          };
          await client.query(
            `INSERT INTO full_plan_items
              (plan_id, meli_conta_id, mlb, sku, title, image_url, price_cents, stock_full,
               units_sold, revenue_cents, daily_velocity, coverage_days, suggested_restock,
               priority, payload)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
            [
              planId,
              meliContaId,
              normalizeMlb(item.mlb),
              item.sku || null,
              item.title || item.mlb || "-",
              item.image_url || null,
              priceCents,
              asInt(item.stock_full, 0),
              asInt(item.units_sold, 0),
              Number(item.revenue_cents || 0),
              Number(item.daily_velocity || 0),
              item.coverage_days === null || item.coverage_days === undefined ? null : Number(item.coverage_days),
              suggested,
              item.priority || null,
              item,
            ],
          );
        }
      }

      await client.query("COMMIT");
      return { ok: true, plan: normalizePlan(result.rows[0]), items: items || undefined };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

async function deletePlan({ meliContaId, planId }) {
  await ensureTables();
  const result = await db.query(`DELETE FROM full_plans WHERE meli_conta_id = $1 AND id = $2`, [meliContaId, planId]);
  return { ok: true, deleted: result.rowCount > 0 };
}

module.exports = {
  currentMeliContaId,
  listProducts,
  syncProducts,
  buildPlanner,
  savePlan,
  listPlans,
  getPlan,
  updatePlan,
  deletePlan,
};
