"use strict";

const { querySku, queryMl, queryShopee } = require("./db");
const { metricsPorItens: mlAdsMetricsPorItens } = require("../../seller-ml/services/adsService");
const ShopeeProductService = require("../../seller-shopee/src/services/ShopeeProductService");
let mlTokenService = null;
let decryptMlToken = (value) => value;
let fetchFn = null;

try {
  mlTokenService = require("../../seller-ml/services/tokenService");
} catch {
  mlTokenService = null;
}

try {
  const tokenCrypto = require("../../seller-ml/services/tokenCrypto");
  if (typeof tokenCrypto.decryptToken === "function") {
    decryptMlToken = tokenCrypto.decryptToken;
  }
} catch {
  decryptMlToken = (value) => value;
}

try {
  if (typeof fetch === "function") {
    fetchFn = fetch;
  } else {
    // eslint-disable-next-line global-require
    const nodeFetch = require("node-fetch");
    fetchFn = nodeFetch.default || nodeFetch;
  }
} catch {
  fetchFn = null;
}

const ML_API_BASE = "https://api.mercadolibre.com";
const ML_LIVE_EAN_CACHE_TTL_MS = 1000 * 60 * 10;
const ML_LIVE_EAN_NEGATIVE_TTL_MS = 1000 * 60 * 3;
const ML_LIVE_EAN_MAX_MLBS_PER_CONTA = 200;
const ML_LIVE_EAN_BATCH_SIZE = 20;
const LIVE_SYNC_INTERVAL_MS = 1000 * 60 * 60 * 4;
const LIVE_SYNC_WINDOW_DAYS = 30;
const mlLiveEanCache = new Map();
const shopeeSchemaColumnCache = new Map();

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function pctChange(current, previous) {
  const c = numberOrZero(current);
  const p = numberOrZero(previous);
  if (p === 0 && c === 0) return 0;
  if (p === 0) return 100;
  return ((c - p) / Math.abs(p)) * 100;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function normalizeSku(value) {
  const raw = String(value || "").trim();
  if (!raw) return "sem-sku";
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "sem-sku";
}

function normalizeEan(value) {
  const digits = String(value == null ? "" : value).replace(/\D+/g, "");
  if (!digits) return null;
  if (digits === "00") return "00";
  if (digits.length < 8 || digits.length > 14) return null;
  return digits;
}

function eanKey(value) {
  const ean = normalizeEan(value);
  if (!ean || ean === "00") return null;
  return `ean:${ean}`;
}

function parseDate(value) {
  const raw = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const d = new Date(`${raw}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : raw;
}

function parseIntSafe(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseNumberSafe(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseWeekday(value) {
  const n = parseIntSafe(value, -1);
  if (n < 1 || n > 7) return null;
  return n;
}

function cleanText(value, maxLength = 200) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  return raw.slice(0, maxLength);
}

const PERIOD_TO_DAYS = {
  "3d": 3,
  "7d": 7,
  "15d": 15,
  "30d": 30,
  "45d": 45,
  "60d": 60,
};

function toIsoDate(d) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);
}

function shiftDate(dateStr, deltaDays) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + Number(deltaDays || 0));
  return toIsoDate(d);
}

function diffDaysInclusive(from, to) {
  const a = new Date(`${from}T00:00:00`);
  const b = new Date(`${to}T00:00:00`);
  return Math.max(1, Math.round((b.getTime() - a.getTime()) / 86400000) + 1);
}

function defaultRange() {
  const today = new Date();
  const end = new Date(today);
  end.setDate(end.getDate() - 1);
  const to = toIsoDate(end);
  const start = new Date(end);
  start.setDate(start.getDate() - 2);
  return { from: toIsoDate(start), to };
}

function resolveRange(query = {}) {
  const period = String(query.period || "").trim().toLowerCase();
  if (PERIOD_TO_DAYS[period]) {
    const today = new Date();
    const end = new Date(today);
    end.setDate(end.getDate() - 1);
    const to = toIsoDate(end);
    const start = new Date(end);
    start.setDate(start.getDate() - (PERIOD_TO_DAYS[period] - 1));
    return {
      from: toIsoDate(start),
      to,
      period,
      custom: false,
    };
  }

  const from = parseDate(query.from);
  const to = parseDate(query.to);

  if (from && to && from <= to) {
    return {
      from,
      to,
      period: "custom",
      custom: true,
    };
  }

  const fallback = defaultRange();
  return {
    from: fallback.from,
    to: fallback.to,
    period: "3d",
    custom: false,
  };
}

function resolveImpactWindow(query = {}) {
  const raw = Number(query.impact_window);
  if ([3, 7, 14, 15, 30, 45, 60].includes(raw)) return raw;
  return 7;
}

function buildPreviousRange(range) {
  const days = diffDaysInclusive(range.from, range.to);
  const prevTo = shiftDate(range.from, -1);
  const prevFrom = shiftDate(prevTo, -(days - 1));
  return { from: prevFrom, to: prevTo };
}

function resolveCompareMode(query = {}) {
  const raw = String(query.compare_mode || "previous_period")
    .trim()
    .toLowerCase();

  if (["none", "sem_comparacao", "off"].includes(raw)) {
    return "none";
  }
  return "previous_period";
}

function makeDaySeries(from, to) {
  const out = [];
  const days = diffDaysInclusive(from, to);
  for (let i = 0; i < days; i += 1) {
    out.push(shiftDate(from, i));
  }
  return out;
}

function inRange(day, range) {
  return day >= range.from && day <= range.to;
}

function parseUtcDay(dateValue) {
  if (!dateValue) return null;
  const d = new Date(dateValue);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function cleanString(value) {
  const text = String(value == null ? "" : value).trim();
  return text || "";
}

function identityUserKey(identity = {}) {
  const userGlobalId = cleanString(identity.userGlobalId);
  if (userGlobalId) return `gid:${userGlobalId}`;
  const email = cleanString(identity.userEmail).toLowerCase();
  if (email) return `email:${email}`;
  const userId = Number(identity.userId || 0);
  if (Number.isFinite(userId) && userId > 0) return `uid:${userId}`;
  return "anon";
}

function normalizeSkuLookup(value) {
  return cleanString(value).toUpperCase();
}

function parseMlItemId(value) {
  const raw = cleanString(value).toUpperCase();
  if (!raw.startsWith("ML")) return null;
  return raw;
}

function parseBigIntString(value) {
  const raw = cleanString(value);
  if (!/^\d+$/.test(raw)) return null;
  return raw;
}

function toIsoNow() {
  return new Date().toISOString();
}

function buildLiveSyncWindow(days = LIVE_SYNC_WINDOW_DAYS) {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - Math.max(1, Number(days) || LIVE_SYNC_WINDOW_DAYS));
  return {
    from: toIsoDate(start),
    to: toIsoDate(end),
  };
}

function toFixedPct(value) {
  if (!Number.isFinite(Number(value))) return 0;
  return Number(Number(value).toFixed(4));
}

async function hasShopeeColumn(tableName, columnName) {
  const cacheKey = `${tableName}.${columnName}`;
  if (shopeeSchemaColumnCache.has(cacheKey)) {
    return shopeeSchemaColumnCache.get(cacheKey);
  }
  try {
    const result = await queryShopee(
      `select 1
         from information_schema.columns
        where table_schema = 'public'
          and table_name = $1
          and column_name = $2
        limit 1`,
      [tableName, columnName],
    );
    const exists = Boolean(result.rows?.length);
    shopeeSchemaColumnCache.set(cacheKey, exists);
    return exists;
  } catch {
    shopeeSchemaColumnCache.set(cacheKey, false);
    return false;
  }
}

function safeDecryptMlToken(value) {
  const raw = cleanString(value);
  if (!raw) return null;
  try {
    return cleanString(decryptMlToken(raw));
  } catch {
    return raw;
  }
}

function isEanIdentifierAttr(attr = {}) {
  const id = cleanString(attr?.id).toUpperCase();
  const name = cleanString(attr?.name).toLowerCase();
  return (
    ["GTIN", "EAN", "UPC", "JAN", "ISBN", "ISBN10", "ISBN13", "GTIN14"].includes(id) ||
    ["gtin", "ean", "upc", "jan", "isbn"].includes(name) ||
    name.includes("codigo de barras") ||
    name.includes("código de barras")
  );
}

function collectMlAttrValues(attr = {}) {
  const values = [];
  [attr?.value_name, attr?.value_id].forEach((value) => {
    const text = cleanString(value);
    if (text) values.push(text);
  });
  if (Array.isArray(attr?.values)) {
    attr.values.forEach((entry) => {
      const byName = cleanString(entry?.name);
      const byId = cleanString(entry?.id);
      if (byName) values.push(byName);
      if (byId) values.push(byId);
    });
  }
  return values;
}

function extractMlItemEan(item = {}) {
  const directCandidates = [item?.gtin, item?.ean, item?.ean13, item?.gtin_code, item?.barcode];
  for (const candidate of directCandidates) {
    const normalized = normalizeEan(candidate);
    if (normalized && normalized !== "00") return normalized;
  }

  const attributes = Array.isArray(item?.attributes) ? item.attributes : [];
  for (const attr of attributes) {
    if (!isEanIdentifierAttr(attr)) continue;
    const values = collectMlAttrValues(attr);
    for (const value of values) {
      const normalized = normalizeEan(value);
      if (normalized && normalized !== "00") return normalized;
    }
  }

  const variations = Array.isArray(item?.variations) ? item.variations : [];
  for (const variation of variations) {
    const variationAttrs = Array.isArray(variation?.attributes) ? variation.attributes : [];
    for (const attr of variationAttrs) {
      if (!isEanIdentifierAttr(attr)) continue;
      const values = collectMlAttrValues(attr);
      for (const value of values) {
        const normalized = normalizeEan(value);
        if (normalized && normalized !== "00") return normalized;
      }
    }
  }

  return null;
}

function readMlLiveEanCache(contaId, mlb) {
  const key = `${Number(contaId)}|${cleanString(mlb).toUpperCase()}`;
  const entry = mlLiveEanCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    mlLiveEanCache.delete(key);
    return null;
  }
  return entry;
}

function writeMlLiveEanCache(contaId, mlb, ean) {
  const normalizedMlb = cleanString(mlb).toUpperCase();
  if (!normalizedMlb) return;
  const normalizedEan = normalizeEan(ean);
  const ttl =
    normalizedEan && normalizedEan !== "00"
      ? ML_LIVE_EAN_CACHE_TTL_MS
      : ML_LIVE_EAN_NEGATIVE_TTL_MS;
  const key = `${Number(contaId)}|${normalizedMlb}`;
  mlLiveEanCache.set(key, {
    ean: normalizedEan && normalizedEan !== "00" ? normalizedEan : null,
    expiresAt: Date.now() + ttl,
  });
}

async function loadMlTokenBundle(contaId) {
  const conta = Number(contaId || 0);
  if (!Number.isFinite(conta) || conta <= 0) return null;
  const tokenResult = await queryMl(
    `select
       mt.access_token,
       mt.access_expires_at,
       mt.refresh_token
     from ml.meli_tokens mt
     where mt.meli_conta_id = $1
     limit 1`,
    [conta],
  ).catch(() => ({ rows: [] }));
  const row = tokenResult.rows?.[0];
  if (!row) return null;

  return {
    access_token: safeDecryptMlToken(row.access_token),
    refresh_token: safeDecryptMlToken(row.refresh_token),
    access_expires_at: row.access_expires_at || null,
  };
}

async function resolveMlAccessToken(contaId) {
  const tokenBundle = await loadMlTokenBundle(contaId);
  if (!tokenBundle?.access_token) return null;

  if (!mlTokenService || typeof mlTokenService.renovarTokenSeNecessario !== "function") {
    return tokenBundle.access_token;
  }

  try {
    const renewed = await mlTokenService.renovarTokenSeNecessario({
      meli_conta_id: Number(contaId),
      account_key: String(Number(contaId)),
      access_token: tokenBundle.access_token,
      refresh_token: tokenBundle.refresh_token,
      access_expires_at: tokenBundle.access_expires_at,
    });

    if (typeof renewed === "string" && cleanString(renewed)) return renewed;
    if (renewed && typeof renewed === "object" && cleanString(renewed.access_token)) {
      return cleanString(renewed.access_token);
    }
  } catch {
    // fallback para token atual caso renovacao falhe.
  }

  return tokenBundle.access_token;
}

async function fetchMlItemsByMlbLive(contaId, mlbList = []) {
  if (!fetchFn) return new Map();
  const conta = Number(contaId || 0);
  if (!Number.isFinite(conta) || conta <= 0) return new Map();

  const candidates = Array.from(
    new Set(
      (Array.isArray(mlbList) ? mlbList : [])
        .map((value) => cleanString(value).toUpperCase())
        .filter((value) => /^MLB\d{6,}$/i.test(value)),
    ),
  ).slice(0, ML_LIVE_EAN_MAX_MLBS_PER_CONTA);

  if (!candidates.length) return new Map();

  const accessToken = await resolveMlAccessToken(conta);
  if (!accessToken) return new Map();

  const eanByMlb = new Map();
  for (let i = 0; i < candidates.length; i += ML_LIVE_EAN_BATCH_SIZE) {
    const batch = candidates.slice(i, i + ML_LIVE_EAN_BATCH_SIZE);
    const idsParam = batch.join(",");
    const endpoint = `${ML_API_BASE}/items?ids=${encodeURIComponent(idsParam)}`;
    try {
      const response = await fetchFn(endpoint, {
        method: "GET",
        headers: {
          accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
          "x-format-new": "true",
        },
      });
      if (!response.ok) continue;
      const payload = await response.json().catch(() => null);
      if (!Array.isArray(payload)) continue;
      payload.forEach((entry) => {
        const code = Number(entry?.code || 0);
        if (code !== 200) return;
        const body = entry?.body || {};
        const mlb = cleanString(body?.id || entry?.id).toUpperCase();
        if (!mlb) return;
        const ean = extractMlItemEan(body);
        if (ean) eanByMlb.set(mlb, ean);
      });
    } catch {
      // ignora falha desse lote e segue para o proximo.
    }
  }

  return eanByMlb;
}

async function enrichMlRowsWithLiveEan(rows = []) {
  if (!Array.isArray(rows) || !rows.length) return rows || [];

  const pendingByConta = new Map();
  rows.forEach((row) => {
    const currentEan = normalizeEan(row?.ean || row?.gtin_code || row?.gtin || null);
    const mlb = cleanString(row?.mlb).toUpperCase();
    const contaId = Number(row?.meli_conta_id || 0);
    if (currentEan && currentEan !== "00") return;
    if (!mlb || !/^MLB\d{6,}$/i.test(mlb)) return;
    if (!Number.isFinite(contaId) || contaId <= 0) return;

    const cached = readMlLiveEanCache(contaId, mlb);
    if (cached) return;

    if (!pendingByConta.has(contaId)) pendingByConta.set(contaId, new Set());
    pendingByConta.get(contaId).add(mlb);
  });

  for (const [contaId, mlbSet] of pendingByConta.entries()) {
    const mlbList = Array.from(mlbSet);
    const liveEans = await fetchMlItemsByMlbLive(contaId, mlbList).catch(() => new Map());
    mlbList.forEach((mlb) => {
      writeMlLiveEanCache(contaId, mlb, liveEans.get(mlb) || null);
    });
  }

  return rows.map((row) => {
    const currentEan = normalizeEan(row?.ean || row?.gtin_code || row?.gtin || null);
    if (currentEan && currentEan !== "00") return row;
    const contaId = Number(row?.meli_conta_id || 0);
    const mlb = cleanString(row?.mlb).toUpperCase();
    if (!Number.isFinite(contaId) || contaId <= 0 || !mlb) return row;
    const cached = readMlLiveEanCache(contaId, mlb);
    if (!cached?.ean) return row;
    return { ...row, ean: cached.ean };
  });
}

function extractShopeeAttributesEan(attributes) {
  if (!Array.isArray(attributes)) return null;
  for (const attr of attributes) {
    const name = cleanString(attr?.original_attribute_name || attr?.attribute_name || attr?.name).toLowerCase();
    const isEanAttr =
      name.includes("gtin") ||
      name.includes("ean") ||
      name.includes("código de barras") ||
      name.includes("codigo de barras");
    if (!isEanAttr) continue;

    const direct = [attr?.value_name, attr?.original_value_name, attr?.value_id];
    for (const value of direct) {
      const normalized = normalizeEan(value);
      if (normalized && normalized !== "00") return normalized;
    }

    const valueList = Array.isArray(attr?.attribute_value_list) ? attr.attribute_value_list : [];
    for (const entry of valueList) {
      const candidates = [entry?.original_value_name, entry?.value_name, entry?.value_id];
      for (const value of candidates) {
        const normalized = normalizeEan(value);
        if (normalized && normalized !== "00") return normalized;
      }
    }
  }
  return null;
}

async function enrichShopeeRowsWithEan(rows = []) {
  if (!Array.isArray(rows) || !rows.length) return rows || [];

  const targets = rows
    .map((row) => ({
      shopId: Number(row?.shop_id || 0),
      itemId: row?.item_id == null ? null : String(row.item_id),
      modelId: row?.model_id == null ? null : String(row.model_id),
    }))
    .filter((row) => Number.isFinite(row.shopId) && row.shopId > 0 && row.itemId);

  if (!targets.length) return rows;

  const shopIds = Array.from(new Set(targets.map((row) => row.shopId)));
  const itemIds = Array.from(new Set(targets.map((row) => row.itemId)));

  const productHasGtin = await hasShopeeColumn("Product", "gtinCode");
  const modelHasGtin = await hasShopeeColumn("ProductModel", "gtinCode");
  const productSelectGtin = productHasGtin ? `, p."gtinCode" as gtin_code` : `, null::text as gtin_code`;
  const modelSelectGtin = modelHasGtin ? `, pm."gtinCode" as gtin_code` : `, null::text as gtin_code`;

  const productRows = await queryShopee(
    `select
       p."shopId" as shop_id,
       p."itemId" as item_id,
       p.attributes
       ${productSelectGtin}
     from public."Product" p
     where p."shopId" = any($1::int[])
       and p."itemId"::text = any($2::text[])`,
    [shopIds, itemIds],
  ).catch(() => ({ rows: [] }));

  const productEanByItemKey = new Map();
  for (const row of productRows.rows || []) {
    const shopId = Number(row.shop_id || 0);
    const itemId = row.item_id == null ? null : String(row.item_id);
    if (!Number.isFinite(shopId) || shopId <= 0 || !itemId) continue;
    const direct = normalizeEan(row.gtin_code || null);
    const fromAttributes = extractShopeeAttributesEan(row.attributes);
    const ean = direct && direct !== "00" ? direct : fromAttributes;
    if (!ean) continue;
    const key = `${shopId}|${itemId}`;
    if (!productEanByItemKey.has(key)) productEanByItemKey.set(key, ean);
  }

  const modelTargets = targets.filter((row) => row.modelId);
  const modelEanByKey = new Map();
  if (modelTargets.length) {
    const modelIds = Array.from(new Set(modelTargets.map((row) => row.modelId)));
    const modelRows = await queryShopee(
      `select
         p."shopId" as shop_id,
         p."itemId" as item_id,
         pm."modelId" as model_id
         ${modelSelectGtin}
       from public."ProductModel" pm
       join public."Product" p on p.id = pm."productId"
       where p."shopId" = any($1::int[])
         and p."itemId"::text = any($2::text[])
         and pm."modelId"::text = any($3::text[])`,
      [shopIds, itemIds, modelIds],
    ).catch(() => ({ rows: [] }));

    for (const row of modelRows.rows || []) {
      const shopId = Number(row.shop_id || 0);
      const itemId = row.item_id == null ? null : String(row.item_id);
      const modelId = row.model_id == null ? null : String(row.model_id);
      const ean = normalizeEan(row.gtin_code || null);
      if (!Number.isFinite(shopId) || shopId <= 0 || !itemId || !modelId || !ean || ean === "00") {
        continue;
      }
      const key = `${shopId}|${itemId}|${modelId}`;
      if (!modelEanByKey.has(key)) modelEanByKey.set(key, ean);
    }
  }

  return rows.map((row) => {
    if (normalizeEan(row?.ean || null)) return row;
    const shopId = Number(row?.shop_id || 0);
    const itemId = row?.item_id == null ? null : String(row.item_id);
    const modelId = row?.model_id == null ? null : String(row.model_id);
    if (!Number.isFinite(shopId) || shopId <= 0 || !itemId) return row;

    const modelKey = modelId ? `${shopId}|${itemId}|${modelId}` : null;
    const itemKey = `${shopId}|${itemId}`;
    const ean = (modelKey ? modelEanByKey.get(modelKey) : null) || productEanByItemKey.get(itemKey) || null;
    if (!ean) return row;
    return { ...row, ean };
  });
}

function resolveMeliSkuRef(row = {}) {
  // Mantem a mesma prioridade usada na tela de busca/vinculo:
  // SKU interno -> MLB -> titulo.
  const sku = cleanString(row.sku);
  const mlb = cleanString(row.mlb);
  const title = cleanString(row.title);
  return sku || mlb || title || "SKU";
}

function isMissingColumnError(error) {
  return String(error?.code || "") === "42703";
}

function isMissingTableError(error) {
  return String(error?.code || "") === "42P01";
}

async function ensureModuleTables() {
  await querySku(`create schema if not exists skuleader`);
  await querySku(`
    create table if not exists skuleader.configs (
      id bigserial primary key,
      tenant_global_id text not null,
      sku_key text not null,
      sku_ref text,
      manual_leader_channel text not null default 'auto',
      strategy text not null default 'prioritario',
      notes text,
      updated_by bigint,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (tenant_global_id, sku_key)
    )
  `);

  await querySku(`
    create table if not exists skuleader.actions (
      id bigserial primary key,
      tenant_global_id text not null,
      sku_key text not null,
      channel text not null default 'geral',
      action_type text not null default 'checklist',
      title text not null,
      details text,
      due_date date,
      status text not null default 'todo',
      highlight_red boolean not null default false,
      metric_focus text,
      completed_at timestamptz,
      created_by bigint,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `);

  await querySku(`
    create table if not exists skuleader.routines (
      id bigserial primary key,
      tenant_global_id text not null,
      sku_key text,
      title text not null,
      details text,
      due_date date,
      weekday smallint,
      channel text not null default 'geral',
      priority text not null default 'media',
      status text not null default 'todo',
      is_alert boolean not null default true,
      created_by bigint,
      completed_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `);

  await querySku(`
    create table if not exists skuleader.admin_users (
      id bigserial primary key,
      tenant_global_id text not null,
      user_id bigint,
      nome text,
      email text,
      role text not null default 'analyst',
      status text not null default 'active',
      created_by bigint,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (tenant_global_id, email)
    )
  `);

  await querySku(`
    create table if not exists skuleader.company_settings (
      tenant_global_id text primary key,
      focus_sku_count integer not null default 5,
      recovery_sku_count integer not null default 5,
      monthly_growth_target numeric(10,2) not null default 12.00,
      min_roi_target numeric(10,2) not null default 3.00,
      min_conversion_target numeric(10,2) not null default 2.50,
      alerts_enabled boolean not null default true,
      updated_by bigint,
      updated_at timestamptz not null default now()
    )
  `);

  await querySku(`
    create table if not exists skuleader.sku_links (
      id bigserial primary key,
      tenant_global_id text not null,
      sku_key text not null,
      sku_ref text not null,
      meli_sku_ref text,
      meli_ean text,
      meli_title text,
      meli_mlb text,
      meli_conta_id bigint,
      shopee_sku_ref text,
      shopee_item_id bigint,
      shopee_shop_id bigint,
      shopee_ean text,
      shopee_title text,
      ean_key text,
      is_active boolean not null default true,
      updated_by bigint,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (tenant_global_id, sku_key)
    )
  `);

  await querySku(`alter table skuleader.sku_links add column if not exists meli_ean text`);
  await querySku(`alter table skuleader.sku_links add column if not exists shopee_ean text`);
  await querySku(`alter table skuleader.sku_links add column if not exists ean_key text`);
  await querySku(`alter table skuleader.sku_links add column if not exists meli_conta_id bigint`);
  await querySku(`alter table skuleader.sku_links add column if not exists shopee_item_id bigint`);
  await querySku(`alter table skuleader.sku_links add column if not exists shopee_shop_id bigint`);

  await querySku(`
    create table if not exists skuleader.meli_account_preferences (
      id bigserial primary key,
      tenant_global_id text not null,
      user_key text not null,
      meli_account_id bigint not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (tenant_global_id, user_key)
    )
  `);

  await querySku(`
    create table if not exists skuleader.sku_live_metrics (
      id bigserial primary key,
      tenant_global_id text not null,
      sku_key text not null,
      sku_ref text,
      range_from date,
      range_to date,
      meli_revenue numeric(14,2) not null default 0,
      meli_views integer not null default 0,
      meli_clicks integer not null default 0,
      meli_units integer not null default 0,
      meli_conversion_pct numeric(10,4) not null default 0,
      shopee_revenue numeric(14,2) not null default 0,
      shopee_views integer not null default 0,
      shopee_clicks integer not null default 0,
      shopee_units integer not null default 0,
      shopee_conversion_pct numeric(10,4) not null default 0,
      synced_at timestamptz not null default now(),
      source text not null default 'auto',
      unique (tenant_global_id, sku_key)
    )
  `);

  await querySku(`
    create table if not exists skuleader.live_sync_state (
      tenant_global_id text primary key,
      last_synced_at timestamptz,
      source text not null default 'auto',
      updated_at timestamptz not null default now()
    )
  `);
}

async function loadMlTenantContext(tenantGlobalId) {
  const result = await queryMl(
    `select id, nome
       from ml.empresas
      where tenant_global_id = $1
      limit 1`,
    [tenantGlobalId],
  );
  return result.rows[0] || null;
}

async function loadMlContaIds(identity) {
  const tenantGlobalId = String(identity?.tenantGlobalId || "").trim();
  const userEmail = String(identity?.userEmail || "").trim().toLowerCase();
  const userGlobalId = String(identity?.userGlobalId || "").trim();
  const empresaNome = String(identity?.empresaNome || "").trim();
  const preferredContaId = Number(
    identity?.selectedMeliAccountId || identity?.meliAccountId || 0,
  );

  const byTenant = await queryMl(
    `select distinct mc.id
       from ml.meli_contas mc
       join ml.empresas e on e.id = mc.empresa_id
      where lower(trim(coalesce(e.tenant_global_id, ''))) = lower(trim($1))`,
    [tenantGlobalId],
  ).catch(() => ({ rows: [] }));

  let ids = (byTenant.rows || [])
    .map((row) => Number(row.id))
    .filter(Number.isFinite);

  if (!ids.length && userEmail) {
    const byUser = await queryMl(
      `select distinct mc.id
         from ml.meli_contas mc
         join ml.empresas e on e.id = mc.empresa_id
         join ml.empresa_usuarios eu on eu.empresa_id = e.id
         join ml.usuarios u on u.id = eu.usuario_id
        where lower(trim(coalesce(u.email, ''))) = lower(trim($1))`,
      [userEmail],
    ).catch(() => ({ rows: [] }));

    ids = (byUser.rows || [])
      .map((row) => Number(row.id))
      .filter(Number.isFinite);
  }

  if (!ids.length && userGlobalId) {
    const byUserGlobalId = await queryMl(
      `select distinct mc.id
         from ml.meli_contas mc
         join ml.empresas e on e.id = mc.empresa_id
         join ml.empresa_usuarios eu on eu.empresa_id = e.id
         join ml.usuarios u on u.id = eu.usuario_id
        where trim(coalesce(u.user_global_id::text, '')) = trim($1)`,
      [userGlobalId],
    ).catch(() => ({ rows: [] }));

    ids = (byUserGlobalId.rows || [])
      .map((row) => Number(row.id))
      .filter(Number.isFinite);
  }

  if (!ids.length && empresaNome) {
    const byCompanyName = await queryMl(
      `select distinct mc.id
         from ml.meli_contas mc
         join ml.empresas e on e.id = mc.empresa_id
        where e.nome ilike $1
        limit 200`,
      [`%${empresaNome.replace(/\s*-\s*Acesso Global\s*$/i, "").trim()}%`],
    ).catch(() => ({ rows: [] }));

    ids = (byCompanyName.rows || [])
      .map((row) => Number(row.id))
      .filter(Number.isFinite);
  }

  if (Number.isFinite(preferredContaId) && preferredContaId > 0 && ids.includes(preferredContaId)) {
    return [preferredContaId];
  }

  return ids;
}

async function listMlAccounts(identity) {
  const tenantGlobalId = String(identity?.tenantGlobalId || "").trim();
  const userEmail = String(identity?.userEmail || "").trim().toLowerCase();
  const userGlobalId = String(identity?.userGlobalId || "").trim();
  const empresaNome = String(identity?.empresaNome || "").trim();

  let result = await queryMl(
    `select
       mc.id,
       mc.meli_user_id,
       mc.apelido,
       mc.site_id,
       mc.status,
       e.nome as empresa_nome
     from ml.meli_contas mc
     join ml.empresas e on e.id = mc.empresa_id
     where lower(trim(coalesce(e.tenant_global_id, ''))) = lower(trim($1))
     order by
       case mc.status when 'ativa' then 1 when 'erro' then 2 else 3 end,
       mc.apelido asc`,
    [tenantGlobalId],
  ).catch(() => ({ rows: [] }));

  if ((!result.rows || !result.rows.length) && userEmail) {
    result = await queryMl(
      `select
         mc.id,
         mc.meli_user_id,
         mc.apelido,
         mc.site_id,
         mc.status,
         e.nome as empresa_nome
       from ml.meli_contas mc
       join ml.empresas e on e.id = mc.empresa_id
       join ml.empresa_usuarios eu on eu.empresa_id = e.id
       join ml.usuarios u on u.id = eu.usuario_id
       where lower(trim(coalesce(u.email, ''))) = lower(trim($1))
       order by
         case mc.status when 'ativa' then 1 when 'erro' then 2 else 3 end,
         mc.apelido asc`,
      [userEmail],
    ).catch(() => ({ rows: [] }));
  }

  if ((!result.rows || !result.rows.length) && userGlobalId) {
    result = await queryMl(
      `select
         mc.id,
         mc.meli_user_id,
         mc.apelido,
         mc.site_id,
         mc.status,
         e.nome as empresa_nome
       from ml.meli_contas mc
       join ml.empresas e on e.id = mc.empresa_id
       join ml.empresa_usuarios eu on eu.empresa_id = e.id
       join ml.usuarios u on u.id = eu.usuario_id
       where trim(coalesce(u.user_global_id::text, '')) = trim($1)
       order by
         case mc.status when 'ativa' then 1 when 'erro' then 2 else 3 end,
         mc.apelido asc`,
      [userGlobalId],
    ).catch(() => ({ rows: [] }));
  }

  if ((!result.rows || !result.rows.length) && empresaNome) {
    result = await queryMl(
      `select
         mc.id,
         mc.meli_user_id,
         mc.apelido,
         mc.site_id,
         mc.status,
         e.nome as empresa_nome
       from ml.meli_contas mc
       join ml.empresas e on e.id = mc.empresa_id
       where e.nome ilike $1
       order by
         case mc.status when 'ativa' then 1 when 'erro' then 2 else 3 end,
         mc.apelido asc
       limit 200`,
      [`%${empresaNome.replace(/\s*-\s*Acesso Global\s*$/i, "").trim()}%`],
    ).catch(() => ({ rows: [] }));
  }

  return (result.rows || []).map((row) => ({
    id: Number(row.id),
    meli_user_id: row.meli_user_id == null ? null : Number(row.meli_user_id),
    apelido: row.apelido || `Conta ${row.id}`,
    site_id: row.site_id || "MLB",
    status: row.status || "ativa",
    empresa_nome: row.empresa_nome || null,
  }));
}

async function getStoredMeliAccountId(identity) {
  await ensureModuleTables();
  const tenantGlobalId = cleanString(identity?.tenantGlobalId);
  if (!tenantGlobalId) return null;
  const userKey = identityUserKey(identity);
  const result = await querySku(
    `select meli_account_id
       from skuleader.meli_account_preferences
      where tenant_global_id = $1
        and user_key = $2
      limit 1`,
    [tenantGlobalId, userKey],
  ).catch(() => ({ rows: [] }));
  const accountId = Number(result.rows?.[0]?.meli_account_id || 0);
  return Number.isFinite(accountId) && accountId > 0 ? accountId : null;
}

async function saveMeliAccountPreference(identity, meliAccountId) {
  await ensureModuleTables();
  const tenantGlobalId = cleanString(identity?.tenantGlobalId);
  const accountId = Number(meliAccountId || 0);
  if (!tenantGlobalId || !Number.isFinite(accountId) || accountId <= 0) return null;
  const userKey = identityUserKey(identity);
  const result = await querySku(
    `insert into skuleader.meli_account_preferences (
       tenant_global_id,
       user_key,
       meli_account_id,
       updated_at
     )
     values ($1, $2, $3, now())
     on conflict (tenant_global_id, user_key)
     do update set
       meli_account_id = excluded.meli_account_id,
       updated_at = now()
     returning meli_account_id`,
    [tenantGlobalId, userKey, accountId],
  ).catch(() => ({ rows: [] }));
  const saved = Number(result.rows?.[0]?.meli_account_id || 0);
  return Number.isFinite(saved) && saved > 0 ? saved : null;
}

async function resolveMeliAccountSelection(identity, cookieAccountId = null) {
  const accounts = await listMlAccounts(identity);
  const availableIds = new Set(
    (accounts || []).map((row) => Number(row.id)).filter((id) => Number.isFinite(id) && id > 0),
  );

  const cookieId = Number(cookieAccountId || 0);
  const storedId = await getStoredMeliAccountId(identity).catch(() => null);

  let selectedId = null;
  if (Number.isFinite(cookieId) && cookieId > 0 && availableIds.has(cookieId)) {
    selectedId = cookieId;
  } else if (Number.isFinite(storedId) && storedId > 0 && availableIds.has(storedId)) {
    selectedId = storedId;
  } else {
    selectedId = Number(accounts?.[0]?.id || 0) || null;
  }

  if (selectedId && selectedId !== storedId) {
    await saveMeliAccountPreference(identity, selectedId).catch(() => {});
  }

  return { accounts, selectedId };
}

async function loadMlCatalogEanIndex(contaIds = []) {
  const keys = Array.from(
    new Set(
      (Array.isArray(contaIds) ? contaIds : [])
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id > 0)
        .map((id) => String(id)),
    ),
  );

  if (!keys.length) {
    return {
      byContaAndMlb: new Map(),
      byContaAndSku: new Map(),
    };
  }

  const byContaAndMlb = new Map();
  const byContaAndSku = new Map();

  try {
    const itemsResult = await queryMl(
      `select
         ci.account_key,
         ci.reference_sku,
         ci.mlb,
         (
           select nullif(trim(ean_value), '')
           from jsonb_array_elements_text(coalesce(ci.eans, '[]'::jsonb)) e(ean_value)
           where nullif(trim(ean_value), '') is not null
           limit 1
         ) as ean
       from ml.mercadolivre_sku_catalog_items ci
       where ci.account_key = any($1::text[])`,
      [keys],
    );

    for (const row of itemsResult.rows || []) {
      const accountKey = cleanString(row.account_key);
      const mlb = cleanString(row.mlb).toUpperCase();
      const sku = normalizeSkuLookup(row.reference_sku);
      const ean = normalizeEan(row.ean);
      if (!ean || ean === "00") continue;
      if (accountKey && mlb) {
        const key = `${accountKey}|${mlb}`;
        if (!byContaAndMlb.has(key)) byContaAndMlb.set(key, ean);
      }
      if (accountKey && sku) {
        const key = `${accountKey}|${sku}`;
        if (!byContaAndSku.has(key)) byContaAndSku.set(key, ean);
      }
    }
  } catch (error) {
    if (!isMissingTableError(error)) throw error;
  }

  try {
    const catalogResult = await queryMl(
      `select
         cat.account_key,
         cat.reference_sku,
         (
           select nullif(trim(ean_value), '')
           from jsonb_array_elements_text(coalesce(cat.eans, '[]'::jsonb)) e(ean_value)
           where nullif(trim(ean_value), '') is not null
           limit 1
         ) as ean
       from ml.mercadolivre_sku_catalog cat
       where cat.account_key = any($1::text[])`,
      [keys],
    );

    for (const row of catalogResult.rows || []) {
      const accountKey = cleanString(row.account_key);
      const sku = normalizeSkuLookup(row.reference_sku);
      const ean = normalizeEan(row.ean);
      if (!ean || ean === "00" || !accountKey || !sku) continue;
      const key = `${accountKey}|${sku}`;
      if (!byContaAndSku.has(key)) byContaAndSku.set(key, ean);
    }
  } catch (error) {
    if (!isMissingTableError(error)) throw error;
  }

  return { byContaAndMlb, byContaAndSku };
}

function enrichMlRowsWithCatalogEan(rows = [], catalogIndex = null) {
  if (!Array.isArray(rows) || !rows.length || !catalogIndex) return rows || [];
  const byContaAndMlb = catalogIndex.byContaAndMlb || new Map();
  const byContaAndSku = catalogIndex.byContaAndSku || new Map();

  return rows.map((row) => {
    const existing = normalizeEan(row?.ean || row?.gtin_code || row?.gtin || null);
    if (existing && existing !== "00") return row;

    const contaId = Number(row?.meli_conta_id || 0);
    if (!Number.isFinite(contaId) || contaId <= 0) return row;

    const contaKey = String(contaId);
    const mlb = cleanString(row?.mlb).toUpperCase();
    const sku = normalizeSkuLookup(row?.sku);

    const eanFromMlb = mlb ? byContaAndMlb.get(`${contaKey}|${mlb}`) : null;
    const eanFromSku = sku ? byContaAndSku.get(`${contaKey}|${sku}`) : null;
    const fallbackEan = normalizeEan(eanFromMlb || eanFromSku || null);
    if (!fallbackEan || fallbackEan === "00") return row;

    return { ...row, ean: fallbackEan };
  });
}

async function loadMlListings(identity) {
  const ids = await loadMlContaIds(identity);
  const tenantGlobalId = String(identity?.tenantGlobalId || "").trim();
  const preferredContaId = Number(identity?.meliAccountId || 0);

  const listingTables = ["ml.anuncios_full", "public.anuncios_full", "anuncios_full"];

  async function enrichCatalogEan(rows) {
    const contaIds = Array.from(
      new Set(
        (Array.isArray(rows) ? rows : [])
          .map((row) => Number(row?.meli_conta_id || 0))
          .filter((id) => Number.isFinite(id) && id > 0),
      ),
    );
    if (!contaIds.length) return rows || [];
    const catalogIndex = await loadMlCatalogEanIndex(contaIds).catch(() => null);
    const enrichedByCatalog = enrichMlRowsWithCatalogEan(rows, catalogIndex);
    return enrichMlRowsWithLiveEan(enrichedByCatalog).catch(() => enrichedByCatalog);
  }

  async function fetchByContaIds(contaIds) {
    for (const tableName of listingTables) {
      try {
        const result = await queryMl(
          `select
             meli_conta_id,
             mlb,
             sku,
             title,
             null::text as ean,
             price,
             sold_40d,
             sales_series_40d,
             last_synced_at
           from ${tableName}
           where meli_conta_id = any($1::bigint[])`,
          [contaIds],
        );
        if ((result.rows || []).length) return result.rows || [];
      } catch (error) {
        if (isMissingTableError(error)) continue;
        throw error;
      }
    }
    return [];
  }

  async function fetchByTenant(tenantId) {
    const joins = [
      { listings: "ml.anuncios_full", contas: "ml.meli_contas", empresas: "ml.empresas" },
      { listings: "public.anuncios_full", contas: "ml.meli_contas", empresas: "ml.empresas" },
      { listings: "anuncios_full", contas: "ml.meli_contas", empresas: "ml.empresas" },
      { listings: "public.anuncios_full", contas: "public.meli_contas", empresas: "public.empresas" },
      { listings: "anuncios_full", contas: "meli_contas", empresas: "empresas" },
    ];

    for (const cfg of joins) {
      try {
        const result = await queryMl(
          `select
             a.meli_conta_id,
             a.mlb,
             a.sku,
             a.title,
             null::text as ean,
             a.price,
             a.sold_40d,
             a.sales_series_40d,
             a.last_synced_at
           from ${cfg.listings} a
           join ${cfg.contas} mc on mc.id = a.meli_conta_id
           join ${cfg.empresas} e on e.id = mc.empresa_id
           where lower(trim(coalesce(e.tenant_global_id, ''))) = lower(trim($1))
           order by a.last_synced_at desc nulls last`,
          [tenantId],
        );
        if ((result.rows || []).length) return result.rows || [];
      } catch (error) {
        if (isMissingTableError(error)) continue;
        throw error;
      }
    }
    return [];
  }

  async function fetchSnapshotByContaIds(contaIds) {
    try {
      const result = await queryMl(
        `select distinct on (i.meli_conta_id, i.mlb, i.periodo_inicio, i.periodo_fim)
           i.meli_conta_id,
           i.mlb,
           null::text as sku,
           i.titulo as title,
           nullif(trim(coalesce(
             i.payload_item->>'gtin',
             i.payload_item->>'ean',
             i.payload_item->>'ean13',
             i.payload_item->>'gtin_code',
             ''
           )), '') as ean,
           null::numeric as price,
           0::numeric as sold_40d,
           null::jsonb as sales_series_40d,
           coalesce(i.atualizado_em, i.criado_em, s.gerado_em) as last_synced_at,
           i.quantidade_vendas::numeric as units_snapshot,
           (i.vendas_brutas_cents::numeric / 100.0) as revenue_snapshot,
           i.periodo_inicio,
           i.periodo_fim,
           true as snapshot_mode
         from ml.ml_ranking_anuncios_snapshot_items i
         join ml.ml_ranking_anuncios_snapshots s on s.id = i.snapshot_id
         where i.meli_conta_id = any($1::bigint[])
           and coalesce(i.tipo_ranking, s.tipo_ranking, 'faturamento') = 'faturamento'
         order by
           i.meli_conta_id,
           i.mlb,
           i.periodo_inicio,
           i.periodo_fim,
           coalesce(i.atualizado_em, i.criado_em, s.gerado_em) desc`,
        [contaIds],
      );
      return result.rows || [];
    } catch (error) {
      if (isMissingTableError(error)) return [];
      return [];
    }
  }

  if (!ids.length) {
    if (!tenantGlobalId) return [];
    const byTenantRows = await fetchByTenant(tenantGlobalId).catch(() => []);
    if (Number.isFinite(preferredContaId) && preferredContaId > 0) {
      const onlySelected = byTenantRows.filter(
        (row) => Number(row.meli_conta_id) === preferredContaId,
      );
      if (onlySelected.length) return enrichCatalogEan(onlySelected);
      return enrichCatalogEan(
        await fetchSnapshotByContaIds([preferredContaId]).catch(() => []),
      );
    }
    if (byTenantRows.length) return enrichCatalogEan(byTenantRows);
    return enrichCatalogEan(await fetchSnapshotByContaIds(ids).catch(() => []));
  }

  if (
    Number.isFinite(preferredContaId) &&
    preferredContaId > 0 &&
    ids.includes(preferredContaId)
  ) {
    const selected = await fetchByContaIds([preferredContaId]).catch(() => []);
    if (selected.length) return enrichCatalogEan(selected);
    return enrichCatalogEan(
      await fetchSnapshotByContaIds([preferredContaId]).catch(() => []),
    );
  }

  const rows = await fetchByContaIds(ids).catch(() => []);
  if (rows.length) return enrichCatalogEan(rows);

  const snapshotRows = await fetchSnapshotByContaIds(ids).catch(() => []);
  if (snapshotRows.length) return enrichCatalogEan(snapshotRows);

  if (!tenantGlobalId) return [];
  return enrichCatalogEan(await fetchByTenant(tenantGlobalId).catch(() => []));
}

function parseMlSalesSeries(raw) {
  if (!raw) return null;
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return value;
}

function extractSold40d(item) {
  const direct = numberOrZero(item?.sold_40d);
  if (direct > 0) return direct;

  const parsed = parseMlSalesSeries(item?.sales_series_40d);
  if (!parsed) return direct;

  let total = 0;
  if (Array.isArray(parsed)) {
    parsed.forEach((entry) => {
      if (entry && typeof entry === "object") {
        total += numberOrZero(
          entry.units ?? entry.qty ?? entry.quantity ?? entry.sold ?? entry.sales,
        );
      } else {
        total += numberOrZero(entry);
      }
    });
  } else if (typeof parsed === "object") {
    Object.values(parsed).forEach((entry) => {
      if (entry && typeof entry === "object") {
        total += numberOrZero(
          entry.units ?? entry.qty ?? entry.quantity ?? entry.sold ?? entry.sales,
        );
      } else {
        total += numberOrZero(entry);
      }
    });
  }

  return total > 0 ? total : direct;
}

function estimateMlRangeMetrics(item, range) {
  const sold40d = extractSold40d(item);
  const price = numberOrZero(item.price);
  const dailyUnits = sold40d / 40;
  const dailyRevenue = dailyUnits * price;

  const syncDay = parseUtcDay(item.last_synced_at) || toIsoDate(new Date());
  const windowStart = shiftDate(syncDay, -39);

  const days = makeDaySeries(range.from, range.to);
  let units = 0;
  let revenue = 0;
  const timeline = [];

  for (const day of days) {
    if (day >= windowStart && day <= syncDay) {
      units += dailyUnits;
      revenue += dailyRevenue;
      timeline.push({ day, units: dailyUnits, revenue: dailyRevenue });
    } else {
      timeline.push({ day, units: 0, revenue: 0 });
    }
  }

  return {
    units,
    revenue,
    timeline,
  };
}

async function resolveShopeeAccountByTenant(tenantGlobalId, fallbackAccountId = null) {
  if (Number.isFinite(fallbackAccountId) && fallbackAccountId > 0) {
    return {
      id: fallbackAccountId,
      name: "Conta Shopee",
    };
  }

  try {
    const result = await queryShopee(
      `select id, name
         from public."Account"
        where lower(trim(coalesce("tenantGlobalId"::text, ''))) = lower(trim($1))
        limit 1`,
      [tenantGlobalId],
    );
    return result.rows[0] || null;
  } catch (error) {
    if (String(error?.code || "") === "42P01") return null;
    if (String(error?.message || "").includes("Conexao Shopee indisponivel")) {
      return null;
    }
    throw error;
  }
}

async function loadShopeeDaily(tenantGlobalId, fullRange, fallbackAccountId = null) {
  const account = await resolveShopeeAccountByTenant(
    tenantGlobalId,
    fallbackAccountId,
  );
  if (!account?.id) return [];

  try {
    const result = await queryShopee(
      `select
         oi."shopId" as shop_id,
         oi."itemId" as item_id,
         oi."modelId" as model_id,
         coalesce(o."shopeeCreateTime", o."createdAt")::date as day,
         coalesce(
           nullif(trim(oi."itemSku"), ''),
           nullif(trim(oi."modelSku"), ''),
           nullif(trim(oi."itemName"), ''),
           oi."itemId"::text
         ) as sku_ref,
         max(coalesce(oi."itemName", oi."modelName")) as title,
         null::text as ean,
         sum(coalesce(oi.quantity, 0))::numeric as units,
         sum(
           (
             coalesce(oi."dealPrice", oi."orderPrice", 0)::numeric
             * coalesce(oi.quantity, 1)::numeric
           )
         ) / 100.0 as revenue
       from public."OrderItem" oi
       join public."Order" o on o.id = oi."orderId"
       join public."Shop" s on s.id = oi."shopId"
       where s."accountId" = $1
         and coalesce(o."shopeeCreateTime", o."createdAt")::date between $2::date and $3::date
       group by 1, 2, 3, 4, 5`,
      [Number(account.id), fullRange.from, fullRange.to],
    );

    return enrichShopeeRowsWithEan(result.rows || []).catch(() => result.rows || []);
  } catch (error) {
    if (isMissingColumnError(error)) {
      const legacy = await queryShopee(
        `select
           oi."shopId" as shop_id,
           oi."itemId" as item_id,
           oi."modelId" as model_id,
           coalesce(o."shopeeCreateTime", o."createdAt")::date as day,
           coalesce(nullif(trim(oi.sku), ''), nullif(trim(oi.name), ''), oi."itemId"::text) as sku_ref,
           max(oi.name) as title,
           null::text as ean,
           sum(coalesce(oi.quantity, 0))::numeric as units,
           sum(coalesce(oi."gmvCents", 0))::numeric / 100.0 as revenue
         from public."OrderItem" oi
         join public."Order" o on o.id = oi."orderId"
         join public."Shop" s on s.id = oi."shopId"
         where s."accountId" = $1
           and coalesce(o."shopeeCreateTime", o."createdAt")::date between $2::date and $3::date
         group by 1, 2, 3, 4, 5`,
        [Number(account.id), fullRange.from, fullRange.to],
      ).catch(() => ({ rows: [] }));
      return enrichShopeeRowsWithEan(legacy.rows || []).catch(() => legacy.rows || []);
    }
    if (String(error?.code || "") === "42P01") return [];
    if (String(error?.message || "").includes("Conexao Shopee indisponivel")) return [];
    throw error;
  }
}

function upsertItem(map, skuKey, ref, title) {
  if (!map.has(skuKey)) {
    map.set(skuKey, {
      sku_key: skuKey,
      sku_ref: ref,
      title: title || ref || "SKU",
      meli: { units_current: 0, revenue_current: 0, units_previous: 0, revenue_previous: 0 },
      shopee: { units_current: 0, revenue_current: 0, units_previous: 0, revenue_previous: 0 },
      meli_ean: null,
      shopee_ean: null,
      has_meli_listing: false,
      has_shopee_listing: false,
      timeline: {},
    });
  }

  const item = map.get(skuKey);
  if (!item.sku_ref && ref) item.sku_ref = ref;
  if ((!item.title || item.title === "SKU") && title) item.title = title;
  return item;
}

function pushTimelinePoint(item, day, channel, units, revenue) {
  if (!item.timeline[day]) {
    item.timeline[day] = {
      day,
      meli_units: 0,
      meli_revenue: 0,
      shopee_units: 0,
      shopee_revenue: 0,
      flags: [],
    };
  }

  const row = item.timeline[day];
  if (channel === "meli") {
    row.meli_units += units;
    row.meli_revenue += revenue;
  } else {
    row.shopee_units += units;
    row.shopee_revenue += revenue;
  }
}

async function loadConfigs(tenantGlobalId) {
  const result = await querySku(
    `select id, sku_key, sku_ref, manual_leader_channel, strategy, notes
       from skuleader.configs
      where tenant_global_id = $1`,
    [tenantGlobalId],
  );

  const map = new Map();
  for (const row of result.rows) {
    map.set(String(row.sku_key), row);
  }
  return map;
}

async function loadActions(tenantGlobalId, skuKey = null) {
  const params = [tenantGlobalId];
  let sql = `select
      id,
      sku_key,
      channel,
      action_type,
      title,
      details,
      due_date,
      status,
      highlight_red,
      metric_focus,
      completed_at,
      created_at,
      updated_at
    from skuleader.actions
    where tenant_global_id = $1`;

  if (skuKey) {
    params.push(skuKey);
    sql += ` and sku_key = $2`;
  }

  sql += ` order by
    case status when 'todo' then 1 when 'doing' then 2 when 'done' then 3 else 4 end,
    coalesce(due_date, (now() + interval '365 days')::date),
    created_at desc`;

  const result = await querySku(sql, params);
  return result.rows || [];
}

async function loadRoutines(tenantGlobalId, skuKey = null) {
  const params = [tenantGlobalId];
  let sql = `select
      id,
      sku_key,
      title,
      details,
      due_date,
      weekday,
      channel,
      priority,
      status,
      is_alert,
      completed_at,
      created_at
    from skuleader.routines
    where tenant_global_id = $1`;

  if (skuKey) {
    params.push(skuKey);
    sql += ` and (sku_key = $2 or sku_key is null)`;
  }

  sql += ` order by
    case priority when 'alta' then 1 when 'media' then 2 else 3 end,
    coalesce(due_date, (now() + interval '365 days')::date),
    created_at desc`;

  const result = await querySku(sql, params);
  return result.rows || [];
}

async function loadCompanySettings(tenantGlobalId) {
  const result = await querySku(
    `select
       tenant_global_id,
       focus_sku_count,
       recovery_sku_count,
       monthly_growth_target,
       min_roi_target,
       min_conversion_target,
       alerts_enabled,
       updated_at
     from skuleader.company_settings
     where tenant_global_id = $1
     limit 1`,
    [tenantGlobalId],
  );

  return (
    result.rows[0] || {
      tenant_global_id: tenantGlobalId,
      focus_sku_count: 5,
      recovery_sku_count: 5,
      monthly_growth_target: 12,
      min_roi_target: 3,
      min_conversion_target: 2.5,
      alerts_enabled: true,
    }
  );
}

async function loadAdminUsers(tenantGlobalId) {
  const result = await querySku(
    `select
       id,
       user_id,
       nome,
       email,
       role,
       status,
       created_at,
       updated_at
     from skuleader.admin_users
     where tenant_global_id = $1
     order by
       case role when 'admin' then 1 when 'analyst' then 2 else 3 end,
       coalesce(nome, email, 'zz') asc`,
    [tenantGlobalId],
  );
  return result.rows || [];
}

async function loadSkuLinks(tenantGlobalId) {
  const result = await querySku(
    `select
       id,
       sku_key,
       sku_ref,
       meli_sku_ref,
       meli_ean,
       meli_title,
       meli_mlb,
       meli_conta_id,
       shopee_sku_ref,
       shopee_item_id,
       shopee_shop_id,
       shopee_ean,
       shopee_title,
       ean_key,
       is_active,
       updated_at
     from skuleader.sku_links
     where tenant_global_id = $1
     order by updated_at desc, id desc`,
    [tenantGlobalId],
  );
  return result.rows || [];
}

async function loadLiveMetricsMap(tenantGlobalId) {
  const result = await querySku(
    `select *
       from skuleader.sku_live_metrics
      where tenant_global_id = $1`,
    [tenantGlobalId],
  ).catch(() => ({ rows: [] }));

  const out = new Map();
  for (const row of result.rows || []) {
    out.set(String(row.sku_key || ""), row);
  }
  return out;
}

async function getLastLiveSyncState(tenantGlobalId) {
  const result = await querySku(
    `select last_synced_at
       from skuleader.live_sync_state
      where tenant_global_id = $1
      limit 1`,
    [tenantGlobalId],
  ).catch(() => ({ rows: [] }));
  return result.rows?.[0]?.last_synced_at || null;
}

async function setLastLiveSyncState(tenantGlobalId, source = "auto") {
  await querySku(
    `insert into skuleader.live_sync_state (
       tenant_global_id,
       last_synced_at,
       source,
       updated_at
     )
     values ($1, now(), $2, now())
     on conflict (tenant_global_id)
     do update set
       last_synced_at = excluded.last_synced_at,
       source = excluded.source,
       updated_at = now()`,
    [tenantGlobalId, cleanText(source, 32) || "auto"],
  ).catch(() => {});
}

function shouldRunLiveSync(lastSyncedAt) {
  if (!lastSyncedAt) return true;
  const ts = new Date(lastSyncedAt).getTime();
  if (!Number.isFinite(ts)) return true;
  return Date.now() - ts >= LIVE_SYNC_INTERVAL_MS;
}

async function upsertLiveMetricRow(tenantGlobalId, row) {
  const skuKey = cleanString(row?.sku_key);
  if (!skuKey) return;
  await querySku(
    `insert into skuleader.sku_live_metrics (
       tenant_global_id,
       sku_key,
       sku_ref,
       range_from,
       range_to,
       meli_revenue,
       meli_views,
       meli_clicks,
       meli_units,
       meli_conversion_pct,
       shopee_revenue,
       shopee_views,
       shopee_clicks,
       shopee_units,
       shopee_conversion_pct,
       synced_at,
       source
     )
     values (
       $1,$2,$3,$4,$5,
       $6,$7,$8,$9,$10,
       $11,$12,$13,$14,$15,
       now(),$16
     )
     on conflict (tenant_global_id, sku_key)
     do update set
       sku_ref = excluded.sku_ref,
       range_from = excluded.range_from,
       range_to = excluded.range_to,
       meli_revenue = excluded.meli_revenue,
       meli_views = excluded.meli_views,
       meli_clicks = excluded.meli_clicks,
       meli_units = excluded.meli_units,
       meli_conversion_pct = excluded.meli_conversion_pct,
       shopee_revenue = excluded.shopee_revenue,
       shopee_views = excluded.shopee_views,
       shopee_clicks = excluded.shopee_clicks,
       shopee_units = excluded.shopee_units,
       shopee_conversion_pct = excluded.shopee_conversion_pct,
       synced_at = now(),
       source = excluded.source`,
    [
      tenantGlobalId,
      skuKey,
      cleanText(row?.sku_ref, 200),
      parseDate(row?.range_from),
      parseDate(row?.range_to),
      numberOrZero(row?.meli_revenue).toFixed(2),
      Math.round(numberOrZero(row?.meli_views)),
      Math.round(numberOrZero(row?.meli_clicks)),
      Math.round(numberOrZero(row?.meli_units)),
      toFixedPct(row?.meli_conversion_pct),
      numberOrZero(row?.shopee_revenue).toFixed(2),
      Math.round(numberOrZero(row?.shopee_views)),
      Math.round(numberOrZero(row?.shopee_clicks)),
      Math.round(numberOrZero(row?.shopee_units)),
      toFixedPct(row?.shopee_conversion_pct),
      cleanText(row?.source, 32) || "auto",
    ],
  ).catch(() => {});
}

async function fetchMlSellerId(contaId) {
  const token = await resolveMlAccessToken(contaId).catch(() => null);
  if (!token || !fetchFn) return null;
  const response = await fetchFn(`${ML_API_BASE}/users/me`, {
    method: "GET",
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
  }).catch(() => null);
  if (!response?.ok) return null;
  const body = await response.json().catch(() => null);
  const sellerId = Number(body?.id || 0);
  return Number.isFinite(sellerId) && sellerId > 0 ? sellerId : null;
}

async function resolveMlMlbForLink(link, contaId) {
  const fromLink = parseMlItemId(link?.meli_mlb || link?.meli_sku_ref || null);
  if (fromLink) return fromLink;

  const q = cleanString(link?.meli_sku_ref || link?.sku_ref);
  if (!q || !fetchFn) return null;

  const token = await resolveMlAccessToken(contaId).catch(() => null);
  const sellerId = await fetchMlSellerId(contaId);
  if (!token || !sellerId) return null;

  const url = new URL(`${ML_API_BASE}/users/${sellerId}/items/search`);
  url.searchParams.set("q", q);
  url.searchParams.set("limit", "1");

  const response = await fetchFn(url.toString(), {
    method: "GET",
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
  }).catch(() => null);
  if (!response?.ok) return null;
  const body = await response.json().catch(() => null);
  const first = Array.isArray(body?.results) ? body.results[0] : null;
  return parseMlItemId(first || null);
}

async function fetchMlRealtimeCandidates(contaId, q, limit = 15) {
  const out = [];
  if (!fetchFn || !Number.isFinite(Number(contaId)) || Number(contaId) <= 0) return out;
  const token = await resolveMlAccessToken(contaId).catch(() => null);
  const sellerId = await fetchMlSellerId(contaId);
  if (!token || !sellerId) return out;

  const searchUrl = new URL(`${ML_API_BASE}/users/${sellerId}/items/search`);
  searchUrl.searchParams.set("q", cleanString(q));
  searchUrl.searchParams.set("limit", String(Math.max(1, Math.min(50, Number(limit) || 15))));

  const searchResponse = await fetchFn(searchUrl.toString(), {
    method: "GET",
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
  }).catch(() => null);
  if (!searchResponse?.ok) return out;
  const searchBody = await searchResponse.json().catch(() => null);
  const ids = Array.isArray(searchBody?.results)
    ? searchBody.results.map(parseMlItemId).filter(Boolean)
    : [];
  if (!ids.length) return out;

  for (let i = 0; i < ids.length; i += ML_LIVE_EAN_BATCH_SIZE) {
    const batch = ids.slice(i, i + ML_LIVE_EAN_BATCH_SIZE);
    const rows = await fetchMlItemsByMlbLive(contaId, batch).catch(() => []);
    rows.forEach((row) => {
      if (!parseMlItemId(row?.mlb)) return;
      out.push({
        meli_conta_id: Number(contaId),
        sku_ref: cleanString(row?.sku) || cleanString(row?.mlb) || cleanString(row?.title),
        title: cleanString(row?.title),
        mlb: parseMlItemId(row?.mlb),
        ean: normalizeEan(row?.ean || null),
        last_synced_at: toIsoNow(),
      });
    });
  }
  return out;
}

async function fetchMlViewsMap(contaId, mlbList, range) {
  const token = await resolveMlAccessToken(contaId).catch(() => null);
  if (!token || !fetchFn || !Array.isArray(mlbList) || !mlbList.length) return new Map();

  const map = new Map();
  const ids = Array.from(new Set(mlbList.map(parseMlItemId).filter(Boolean)));
  for (let i = 0; i < ids.length; i += 50) {
    const slice = ids.slice(i, i + 50);
    const url = new URL(`${ML_API_BASE}/items/visits`);
    url.searchParams.set("ids", slice.join(","));
    url.searchParams.set("date_from", range.from);
    url.searchParams.set("date_to", range.to);
    const response = await fetchFn(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    }).catch(() => null);
    if (!response?.ok) continue;
    const body = await response.json().catch(() => null);
    const rows = Array.isArray(body) ? body : Array.isArray(body?.results) ? body.results : [];
    rows.forEach((row) => {
      const id = parseMlItemId(row?.item_id || row?.id || null);
      if (!id) return;
      const total = numberOrZero(row?.total_visits ?? row?.visits ?? row?.total ?? 0);
      map.set(id, Math.round(total));
    });
  }
  return map;
}

async function fetchMlOrdersMetricsByConta(contaId, mlbList, range) {
  const ids = new Set((mlbList || []).map(parseMlItemId).filter(Boolean));
  const out = new Map();
  ids.forEach((id) => out.set(id, { units: 0, revenue: 0 }));
  if (!ids.size || !fetchFn) return out;

  const token = await resolveMlAccessToken(contaId).catch(() => null);
  const sellerId = await fetchMlSellerId(contaId);
  if (!token || !sellerId) return out;

  const fromIso = `${range.from}T00:00:00.000-00:00`;
  const toIso = `${range.to}T23:59:59.999-00:00`;

  const limit = 50;
  let offset = 0;
  let pages = 0;
  const maxPages = 40;

  while (pages < maxPages) {
    const url = new URL(`${ML_API_BASE}/orders/search`);
    url.searchParams.set("seller", String(sellerId));
    url.searchParams.set("order.status", "paid");
    url.searchParams.set("date_created.from", fromIso);
    url.searchParams.set("date_created.to", toIso);
    url.searchParams.set("sort", "date_desc");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));

    const response = await fetchFn(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    }).catch(() => null);
    if (!response?.ok) break;
    const body = await response.json().catch(() => null);
    const results = Array.isArray(body?.results) ? body.results : [];
    if (!results.length) break;

    for (const order of results) {
      const orderItems = Array.isArray(order?.order_items) ? order.order_items : [];
      for (const it of orderItems) {
        const itemId = parseMlItemId(it?.item?.id || it?.item_id || null);
        if (!itemId || !ids.has(itemId)) continue;
        const qty = numberOrZero(it?.quantity || 0);
        const unitPrice = numberOrZero(
          it?.unit_price ?? it?.full_unit_price ?? it?.sale_fee ?? it?.price ?? 0,
        );
        const prev = out.get(itemId) || { units: 0, revenue: 0 };
        prev.units += qty;
        prev.revenue += qty * unitPrice;
        out.set(itemId, prev);
      }
    }

    pages += 1;
    offset += limit;
    const pagingTotal = Number(body?.paging?.total || 0);
    if (!Number.isFinite(pagingTotal) || offset >= pagingTotal) break;
  }

  return out;
}

async function fetchShopeeLinkTargets(tenantGlobalId, links = []) {
  const targets = new Map();
  if (!Array.isArray(links) || !links.length) return targets;

  const hasProductGtin = await hasShopeeColumn("Product", "gtinCode");

  for (const link of links) {
    const skuKey = cleanString(link?.sku_key);
    if (!skuKey) continue;
    const rawItemId = parseBigIntString(link?.shopee_item_id || link?.shopee_sku_ref || null);
    const rawShopId = Number(link?.shopee_shop_id || 0);
    if (rawItemId && Number.isFinite(rawShopId) && rawShopId > 0) {
      targets.set(skuKey, {
        shopId: rawShopId,
        itemId: rawItemId,
      });
      continue;
    }

    const qSku = cleanString(link?.shopee_sku_ref);
    const qEan = normalizeEan(link?.shopee_ean || null);
    const qRef = cleanString(link?.sku_ref);
    if (!qSku && !qEan && !qRef) continue;

    const params = [tenantGlobalId];
    const clauses = [`lower(trim(coalesce(acc."tenantGlobalId"::text, ''))) = lower(trim($1))`];
    let idx = 2;
    if (qEan && hasProductGtin) {
      params.push(qEan);
      clauses.push(`coalesce(p."gtinCode", '') = $${idx}`);
      idx += 1;
    }
    if (qSku) {
      params.push(qSku);
      clauses.push(
        `(upper(coalesce(p."itemSku", '')) = upper($${idx}) or upper(coalesce(p.title, '')) like upper($${idx + 1}))`,
      );
      params.push(`%${qSku}%`);
      idx += 2;
    }
    if (qRef) {
      params.push(`%${qRef}%`);
      clauses.push(`upper(coalesce(p.title, '')) like upper($${idx})`);
      idx += 1;
    }

    const sql = `
      select p."shopId" as shop_id, p."itemId" as item_id
      from public."Product" p
      join public."Shop" s on s.id = p."shopId"
      join public."Account" acc on acc.id = s."accountId"
      where ${clauses.join(" and ")}
      order by p."updatedAt" desc nulls last
      limit 1`;
    const result = await queryShopee(sql, params).catch(() => ({ rows: [] }));
    const row = result.rows?.[0];
    const itemId = parseBigIntString(row?.item_id);
    const shopId = Number(row?.shop_id || 0);
    if (itemId && Number.isFinite(shopId) && shopId > 0) {
      targets.set(skuKey, { itemId, shopId });
    }
  }

  return targets;
}

function pickMetricFromPayload(payload, keys = []) {
  if (!payload || typeof payload !== "object") return null;
  const queue = [payload];
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== "object") continue;
    for (const key of keys) {
      if (current[key] != null) {
        const num = Number(current[key]);
        if (Number.isFinite(num)) return num;
      }
    }
    Object.values(current).forEach((value) => {
      if (value && typeof value === "object") queue.push(value);
    });
  }
  return null;
}

async function fetchShopeeViewsMap(targets = []) {
  const out = new Map();
  const concurrency = 4;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, targets.length) }, async () => {
    while (cursor < targets.length) {
      const current = cursor;
      cursor += 1;
      const row = targets[current];
      const key = `${row.shopId}|${row.itemId}`;
      try {
        const extra = await ShopeeProductService.getItemExtraInfo({
          shopId: String(row.shopId),
          itemId: String(row.itemId),
        });
        const views = pickMetricFromPayload(extra, ["view_count", "views", "view"]);
        out.set(key, Math.max(0, Math.round(numberOrZero(views))));
      } catch {
        out.set(key, 0);
      }
    }
  });
  await Promise.all(workers);
  return out;
}

async function fetchShopeeClicksMap(targets = [], range) {
  const out = new Map();
  if (!targets.length) return out;
  const pairs = targets
    .map((row) => ({
      shopId: Number(row.shopId || 0),
      itemId: parseBigIntString(row.itemId),
    }))
    .filter((row) => Number.isFinite(row.shopId) && row.shopId > 0 && row.itemId);
  if (!pairs.length) return out;

  const shopIds = Array.from(new Set(pairs.map((row) => row.shopId)));
  const itemIds = Array.from(new Set(pairs.map((row) => row.itemId)));
  const result = await queryShopee(
    `select
       "shopId" as shop_id,
       "itemId"::text as item_id,
       sum(coalesce(click, 0))::bigint as clicks
     from public."AdsHourlyMetric"
     where "shopId" = any($1::int[])
       and "itemId"::text = any($2::text[])
       and date between $3::date and $4::date
     group by 1,2`,
    [shopIds, itemIds, range.from, range.to],
  ).catch(() => ({ rows: [] }));

  (result.rows || []).forEach((row) => {
    out.set(`${row.shop_id}|${row.item_id}`, Math.round(numberOrZero(row.clicks)));
  });
  return out;
}

async function fetchShopeeSalesMap(targets = [], range) {
  const out = new Map();
  if (!targets.length) return out;
  const shopIds = Array.from(
    new Set(targets.map((row) => Number(row.shopId || 0)).filter((value) => value > 0)),
  );
  const itemIds = Array.from(
    new Set(targets.map((row) => parseBigIntString(row.itemId)).filter(Boolean)),
  );
  if (!shopIds.length || !itemIds.length) return out;

  const result = await queryShopee(
    `select
       oi."shopId" as shop_id,
       oi."itemId"::text as item_id,
       sum(coalesce(oi.quantity, 0))::numeric as units,
       sum((coalesce(oi."dealPrice", oi."orderPrice", 0)::numeric * coalesce(oi.quantity, 1)::numeric)) / 100.0 as revenue
     from public."OrderItem" oi
     join public."Order" o on o.id = oi."orderId"
     where oi."shopId" = any($1::int[])
       and oi."itemId"::text = any($2::text[])
       and coalesce(o."shopeeCreateTime", o."createdAt")::date between $3::date and $4::date
     group by 1,2`,
    [shopIds, itemIds, range.from, range.to],
  ).catch(async (error) => {
    if (!isMissingColumnError(error)) return { rows: [] };
    return queryShopee(
      `select
         oi."shopId" as shop_id,
         oi."itemId"::text as item_id,
         sum(coalesce(oi.quantity, 0))::numeric as units,
         sum(coalesce(oi."gmvCents", 0))::numeric / 100.0 as revenue
       from public."OrderItem" oi
       join public."Order" o on o.id = oi."orderId"
       where oi."shopId" = any($1::int[])
         and oi."itemId"::text = any($2::text[])
         and coalesce(o."shopeeCreateTime", o."createdAt")::date between $3::date and $4::date
       group by 1,2`,
      [shopIds, itemIds, range.from, range.to],
    ).catch(() => ({ rows: [] }));
  });

  (result.rows || []).forEach((row) => {
    out.set(`${row.shop_id}|${row.item_id}`, {
      units: Math.round(numberOrZero(row.units)),
      revenue: numberOrZero(row.revenue),
    });
  });
  return out;
}

async function syncControlledSkuMetrics(identity, options = {}) {
  await ensureModuleTables();
  const force = Boolean(options.force);
  const source = cleanText(options.source, 32) || (force ? "manual" : "auto");
  const tenantGlobalId = String(identity?.tenantGlobalId || "").trim();
  if (!tenantGlobalId) return { ok: false, updated: 0, skipped: true, reason: "missing_tenant" };

  const links = (await loadSkuLinks(tenantGlobalId)).filter((row) => row?.is_active);
  if (!links.length) {
    await setLastLiveSyncState(tenantGlobalId, source);
    return { ok: true, updated: 0, skipped: false, reason: "no_controlled_skus" };
  }

  const lastSync = await getLastLiveSyncState(tenantGlobalId);
  if (!force && !shouldRunLiveSync(lastSync)) {
    return { ok: true, updated: 0, skipped: true, last_synced_at: lastSync };
  }

  const window = buildLiveSyncWindow(LIVE_SYNC_WINDOW_DAYS);
  const metricsBySku = new Map();
  links.forEach((link) => {
    const skuKey = cleanString(link.sku_key);
    if (!skuKey) return;
    metricsBySku.set(skuKey, {
      sku_key: skuKey,
      sku_ref: link.sku_ref || link.sku_key,
      range_from: window.from,
      range_to: window.to,
      meli_revenue: 0,
      meli_views: 0,
      meli_clicks: 0,
      meli_units: 0,
      meli_conversion_pct: 0,
      shopee_revenue: 0,
      shopee_views: 0,
      shopee_clicks: 0,
      shopee_units: 0,
      shopee_conversion_pct: 0,
      source,
    });
  });

  const mlGroups = new Map();
  for (const link of links) {
    const skuKey = cleanString(link.sku_key);
    if (!skuKey) continue;
    const contaId = Number(link.meli_conta_id || identity?.meliAccountId || 0);
    if (!Number.isFinite(contaId) || contaId <= 0) continue;
    const mlb = await resolveMlMlbForLink(link, contaId);
    if (!mlb) continue;
    if (!mlGroups.has(contaId)) mlGroups.set(contaId, []);
    mlGroups.get(contaId).push({ skuKey, mlb });
  }

  for (const [contaId, rows] of mlGroups.entries()) {
    const mlbList = Array.from(new Set(rows.map((row) => row.mlb)));
    const [salesMap, viewsMap, adsMap] = await Promise.all([
      fetchMlOrdersMetricsByConta(contaId, mlbList, window),
      fetchMlViewsMap(contaId, mlbList, window),
      (async () => {
        const token = await resolveMlAccessToken(contaId).catch(() => null);
        if (!token) return {};
        return mlAdsMetricsPorItens({
          mlbIds: mlbList,
          date_from: window.from,
          date_to: window.to,
          access_token: token,
        }).catch(() => ({}));
      })(),
    ]);

    rows.forEach((row) => {
      const metric = metricsBySku.get(row.skuKey);
      if (!metric) return;
      const sales = salesMap.get(row.mlb) || { units: 0, revenue: 0 };
      const views = Math.round(numberOrZero(viewsMap.get(row.mlb)));
      const clicks = Math.round(numberOrZero(adsMap?.[row.mlb]?.clicks || 0));
      metric.meli_units += Math.round(numberOrZero(sales.units));
      metric.meli_revenue += numberOrZero(sales.revenue);
      metric.meli_views += views;
      metric.meli_clicks += clicks;
      const meliBase = clicks > 0 ? clicks : views;
      metric.meli_conversion_pct =
        meliBase > 0 ? toFixedPct((metric.meli_units / meliBase) * 100) : 0;
    });
  }

  const shopeeTargetsBySku = await fetchShopeeLinkTargets(tenantGlobalId, links);
  const shopeeTargets = Array.from(shopeeTargetsBySku.values());
  const [shopeeSales, shopeeViews, shopeeClicks] = await Promise.all([
    fetchShopeeSalesMap(shopeeTargets, window),
    fetchShopeeViewsMap(shopeeTargets),
    fetchShopeeClicksMap(shopeeTargets, window),
  ]);

  for (const [skuKey, target] of shopeeTargetsBySku.entries()) {
    const metric = metricsBySku.get(skuKey);
    if (!metric) continue;
    const key = `${target.shopId}|${target.itemId}`;
    const sales = shopeeSales.get(key) || { units: 0, revenue: 0 };
    const views = Math.round(numberOrZero(shopeeViews.get(key)));
    const clicks = Math.round(numberOrZero(shopeeClicks.get(key)));
    metric.shopee_units += Math.round(numberOrZero(sales.units));
    metric.shopee_revenue += numberOrZero(sales.revenue);
    metric.shopee_views += views;
    metric.shopee_clicks += clicks;
    const shopeeBase = clicks > 0 ? clicks : views;
    metric.shopee_conversion_pct =
      shopeeBase > 0 ? toFixedPct((metric.shopee_units / shopeeBase) * 100) : 0;
  }

  let updated = 0;
  for (const row of metricsBySku.values()) {
    await upsertLiveMetricRow(tenantGlobalId, row);
    updated += 1;
  }
  await setLastLiveSyncState(tenantGlobalId, source);

  return {
    ok: true,
    updated,
    skipped: false,
    range: window,
    synced_at: toIsoNow(),
  };
}

function mergeTimelineMaps(meliTimeline = {}, shopeeTimeline = {}) {
  const out = {};
  const days = new Set([
    ...Object.keys(meliTimeline || {}),
    ...Object.keys(shopeeTimeline || {}),
  ]);

  days.forEach((day) => {
    const m = meliTimeline?.[day] || null;
    const s = shopeeTimeline?.[day] || null;
    out[day] = {
      day,
      meli_units: numberOrZero(m?.meli_units),
      meli_revenue: numberOrZero(m?.meli_revenue),
      shopee_units: numberOrZero(s?.shopee_units),
      shopee_revenue: numberOrZero(s?.shopee_revenue),
      flags: [],
    };
  });
  return out;
}

function computeLeader(item, config) {
  const manual = String(config?.manual_leader_channel || "auto");
  if (manual === "meli" || manual === "shopee") return manual;

  const meliRevenue = numberOrZero(item.meli.revenue_current);
  const shopeeRevenue = numberOrZero(item.shopee.revenue_current);
  if (meliRevenue === 0 && shopeeRevenue === 0) return "indefinido";
  return meliRevenue >= shopeeRevenue ? "meli" : "shopee";
}

function computeStrategy(item, config, leader) {
  if (config?.strategy) return String(config.strategy);
  if (leader === "indefinido") return "secundario";

  const total =
    numberOrZero(item.meli.revenue_current) + numberOrZero(item.shopee.revenue_current);
  const leaderRevenue =
    leader === "meli"
      ? numberOrZero(item.meli.revenue_current)
      : numberOrZero(item.shopee.revenue_current);

  if (total <= 0) return "secundario";
  const share = leaderRevenue / total;

  if (share >= 0.7) return "prioritario";
  if (share >= 0.45) return "apoio";
  return "secundario";
}

function buildSuggestion(item, leader) {
  const meliRevenue = numberOrZero(item.meli.revenue_current);
  const shopeeRevenue = numberOrZero(item.shopee.revenue_current);
  const meliGrowth = pctChange(item.meli.revenue_current, item.meli.revenue_previous);
  const shopeeGrowth = pctChange(
    item.shopee.revenue_current,
    item.shopee.revenue_previous,
  );

  if (leader === "indefinido") {
    return "Produto sem tracao recente: testar nova variacao, revisar preco e validar competitividade antes de escalar Ads.";
  }

  const leaderRevenue = leader === "meli" ? meliRevenue : shopeeRevenue;
  const supportRevenue = leader === "meli" ? shopeeRevenue : meliRevenue;

  if (leaderRevenue > 0 && supportRevenue >= leaderRevenue * 0.85) {
    return "Conflito entre canais detectado: manter preco e investimento principal no canal lider e reduzir concorrencia direta no canal de apoio.";
  }

  if (leader === "meli" && meliGrowth < -8 && shopeeGrowth > 0) {
    return "Queda no canal lider (MeLi) com alta na Shopee: revisar titulo, imagem e oferta no MeLi antes de considerar troca de lideranca.";
  }

  if (leader === "shopee" && shopeeGrowth < -8 && meliGrowth > 0) {
    return "Queda no canal lider (Shopee) com alta no MeLi: ajustar anuncio lider e proteger margem para evitar migracao de performance.";
  }

  if (leaderRevenue > 0 && supportRevenue === 0) {
    return "Canal lider consolidado: manter defesa de posicionamento e usar o outro canal apenas para testes controlados (kit/combo/variacao).";
  }

  return "Cenario equilibrado: manter canal lider com prioridade de Ads e usar canal de apoio para variacoes sem competir em preco.";
}

function serializeTimeline(timelineMap, days) {
  return days.map((day) => {
    const row = timelineMap[day] || {
      day,
      meli_units: 0,
      meli_revenue: 0,
      shopee_units: 0,
      shopee_revenue: 0,
      flags: [],
    };

    return {
      day,
      meli_units: numberOrZero(row.meli_units),
      meli_revenue: numberOrZero(row.meli_revenue),
      shopee_units: numberOrZero(row.shopee_units),
      shopee_revenue: numberOrZero(row.shopee_revenue),
      total_revenue: numberOrZero(row.meli_revenue) + numberOrZero(row.shopee_revenue),
      total_units: numberOrZero(row.meli_units) + numberOrZero(row.shopee_units),
      flags: Array.isArray(row.flags) ? row.flags : [],
    };
  });
}

function applyActionFlags(itemMap, actions) {
  for (const action of actions) {
    const skuKey = String(action.sku_key || "").trim();
    if (!skuKey || !itemMap.has(skuKey)) continue;

    const day =
      parseUtcDay(action.due_date) ||
      parseDate(action.due_date) ||
      parseUtcDay(action.completed_at) ||
      parseUtcDay(action.created_at);
    if (!day) continue;

    const item = itemMap.get(skuKey);
    if (!item.timeline[day]) {
      item.timeline[day] = {
        day,
        meli_units: 0,
        meli_revenue: 0,
        shopee_units: 0,
        shopee_revenue: 0,
        flags: [],
      };
    }

    item.timeline[day].flags.push({
      id: Number(action.id),
      title: action.title,
      status: action.status,
      highlight_red: Boolean(action.highlight_red),
      channel: action.channel,
    });
  }
}

function computeActionImpact(item, action) {
  if (!action?.completed_at) return null;

  const completedDay = parseUtcDay(action.completed_at);
  if (!completedDay) return null;

  const windowDays = Number.isFinite(Number(action?.impact_window_days))
    ? Math.max(1, Number(action.impact_window_days))
    : 7;

  const beforeFrom = shiftDate(completedDay, -windowDays);
  const beforeTo = shiftDate(completedDay, -1);
  const afterFrom = completedDay;
  const afterTo = shiftDate(completedDay, windowDays - 1);

  let beforeRevenue = 0;
  let afterRevenue = 0;

  Object.values(item.timeline || {}).forEach((point) => {
    const day = point.day;
    let value = 0;

    if (action.channel === "meli") {
      value = numberOrZero(point.meli_revenue);
    } else if (action.channel === "shopee") {
      value = numberOrZero(point.shopee_revenue);
    } else {
      value = numberOrZero(point.meli_revenue) + numberOrZero(point.shopee_revenue);
    }

    if (day >= beforeFrom && day <= beforeTo) beforeRevenue += value;
    if (day >= afterFrom && day <= afterTo) afterRevenue += value;
  });

  return {
    window_days: windowDays,
    before_revenue: beforeRevenue,
    after_revenue: afterRevenue,
    growth_pct: pctChange(afterRevenue, beforeRevenue),
  };
}

function aggregateSummary(items, tab) {
  const summary = {
    revenue_current: 0,
    revenue_previous: 0,
    units_current: 0,
    units_previous: 0,
    conflicts: 0,
    sku_total: items.length,
  };

  items.forEach((item) => {
    const currentRevenue =
      tab === "meli"
        ? numberOrZero(item.meli.revenue_current)
        : tab === "shopee"
          ? numberOrZero(item.shopee.revenue_current)
          : numberOrZero(item.meli.revenue_current) + numberOrZero(item.shopee.revenue_current);

    const previousRevenue =
      tab === "meli"
        ? numberOrZero(item.meli.revenue_previous)
        : tab === "shopee"
          ? numberOrZero(item.shopee.revenue_previous)
          : numberOrZero(item.meli.revenue_previous) + numberOrZero(item.shopee.revenue_previous);

    const currentUnits =
      tab === "meli"
        ? numberOrZero(item.meli.units_current)
        : tab === "shopee"
          ? numberOrZero(item.shopee.units_current)
          : numberOrZero(item.meli.units_current) + numberOrZero(item.shopee.units_current);

    const previousUnits =
      tab === "meli"
        ? numberOrZero(item.meli.units_previous)
        : tab === "shopee"
          ? numberOrZero(item.shopee.units_previous)
          : numberOrZero(item.meli.units_previous) + numberOrZero(item.shopee.units_previous);

    summary.revenue_current += currentRevenue;
    summary.revenue_previous += previousRevenue;
    summary.units_current += currentUnits;
    summary.units_previous += previousUnits;

    const leaderRevenue =
      item.leader_channel === "meli"
        ? numberOrZero(item.meli.revenue_current)
        : numberOrZero(item.shopee.revenue_current);

    const supportRevenue =
      item.leader_channel === "meli"
        ? numberOrZero(item.shopee.revenue_current)
        : numberOrZero(item.meli.revenue_current);

    if (leaderRevenue > 0 && supportRevenue >= leaderRevenue * 0.85) {
      summary.conflicts += 1;
    }
  });

  summary.revenue_growth_pct = pctChange(summary.revenue_current, summary.revenue_previous);
  summary.units_growth_pct = pctChange(summary.units_current, summary.units_previous);
  return summary;
}

function buildTopMovementsForScope(items, tab) {
  const withGrowth = items.map((item) => {
    let current = numberOrZero(item.total_revenue_current);
    let previous = numberOrZero(item.total_revenue_previous);

    if (tab === "meli") {
      current = numberOrZero(item.meli.revenue_current);
      previous = numberOrZero(item.meli.revenue_previous);
    } else if (tab === "shopee") {
      current = numberOrZero(item.shopee.revenue_current);
      previous = numberOrZero(item.shopee.revenue_previous);
    }

    return {
      sku_key: item.sku_key,
      sku_ref: item.sku_ref,
      title: item.title,
      current_revenue: current,
      previous_revenue: previous,
      growth_pct: pctChange(current, previous),
    };
  });

  const gains = withGrowth
    .filter((item) => item.growth_pct > 0)
    .sort((a, b) => b.growth_pct - a.growth_pct)
    .slice(0, 5);

  const losses = withGrowth
    .filter((item) => item.growth_pct < 0)
    .sort((a, b) => a.growth_pct - b.growth_pct)
    .slice(0, 5);

  return {
    top_gains: gains,
    top_losses: losses,
  };
}

function buildTopMovements(items, tab) {
  return {
    scope: tab,
    overall: buildTopMovementsForScope(items, tab),
    by_channel: {
      geral: buildTopMovementsForScope(items, "geral"),
      meli: buildTopMovementsForScope(items, "meli"),
      shopee: buildTopMovementsForScope(items, "shopee"),
    },
  };
}

function hasChannelActivity(item, channel) {
  const block = channel === "meli" ? item?.meli : item?.shopee;
  const hasListing = channel === "meli"
    ? Boolean(item?.has_meli_listing)
    : Boolean(item?.has_shopee_listing);
  if (hasListing) return true;
  if (!block) return false;
  return (
    numberOrZero(block.units_current) > 0 ||
    numberOrZero(block.units_previous) > 0 ||
    numberOrZero(block.revenue_current) > 0 ||
    numberOrZero(block.revenue_previous) > 0
  );
}

function classifyCurveByRevenue(items) {
  if (!items.length) return { a: [], b: [], c: [] };

  const ranked = [...items].sort(
    (left, right) =>
      numberOrZero(right.total_revenue_current) -
      numberOrZero(left.total_revenue_current),
  );

  const size = ranked.length;
  const cutA = Math.max(1, Math.round(size * 0.2));
  const cutB = Math.max(cutA + 1, Math.round(size * 0.6));

  return {
    a: ranked.slice(0, cutA),
    b: ranked.slice(cutA, cutB),
    c: ranked.slice(cutB),
  };
}

function buildAdvancedMetrics(items, summary, actions, routines, settings) {
  const units = numberOrZero(summary.units_current);
  const revenue = numberOrZero(summary.revenue_current);
  const ticket = units > 0 ? revenue / units : 0;

  let leaderRevenue = 0;
  let supportRevenue = 0;
  items.forEach((item) => {
    const meliRevenue = numberOrZero(item.meli.revenue_current);
    const shopeeRevenue = numberOrZero(item.shopee.revenue_current);
    const leader = item.leader_channel === "shopee" ? shopeeRevenue : meliRevenue;
    const support = item.leader_channel === "shopee" ? meliRevenue : shopeeRevenue;
    leaderRevenue += leader;
    supportRevenue += support;
  });

  const leaderDependencyPct = revenue > 0 ? (leaderRevenue / revenue) * 100 : 0;
  const supportPressurePct = revenue > 0 ? (supportRevenue / revenue) * 100 : 0;

  const doneActions = actions.filter((action) => action.status === "done");
  const positiveDoneActions = doneActions.filter(
    (action) => {
      const growth = Number(action?.impact?.growth_pct);
      if (Number.isFinite(growth)) return growth > 0;
      return true;
    },
  );
  const effectiveActionsPct = doneActions.length
    ? (positiveDoneActions.length / doneActions.length) * 100
    : 0;

  const openAlerts = routines.filter(
    (routine) => routine.is_alert && !["done", "archived"].includes(routine.status),
  ).length;

  const curves = classifyCurveByRevenue(items);

  return {
    ticket_medio: ticket,
    leader_dependency_pct: leaderDependencyPct,
    support_pressure_pct: supportPressurePct,
    effective_actions_pct: effectiveActionsPct,
    open_alerts: openAlerts,
    curve_a_count: curves.a.length,
    curve_b_count: curves.b.length,
    curve_c_count: curves.c.length,
    focus_sku_count: parseIntSafe(settings.focus_sku_count, 5),
    recovery_sku_count: parseIntSafe(settings.recovery_sku_count, 5),
    monthly_growth_target: parseNumberSafe(settings.monthly_growth_target, 12),
    min_roi_target: parseNumberSafe(settings.min_roi_target, 3),
    min_conversion_target: parseNumberSafe(settings.min_conversion_target, 2.5),
  };
}

function buildAlerts(items, actions, routines, settings) {
  if (!settings?.alerts_enabled) return [];

  const alerts = [];
  const today = toIsoDate(new Date());

  routines.forEach((routine) => {
    const due = parseDate(routine.due_date);
    const isOpen = !["done", "archived"].includes(String(routine.status || "").toLowerCase());
    if (!isOpen) return;

    if (due && due < today) {
      alerts.push({
        type: "routine_overdue",
        severity: "alta",
        title: `Rotina vencida: ${routine.title}`,
        detail: `Vencimento em ${due}. Prioridade ${routine.priority || "media"}.`,
      });
    }
  });

  items.forEach((item) => {
    const growth = numberOrZero(item.growth_pct);
    if (growth <= -20) {
      alerts.push({
        type: "hard_drop",
        severity: "alta",
        title: `Queda forte no SKU ${item.sku_ref || item.sku_key}`,
        detail: `Queda de ${growth.toFixed(1)}% no periodo atual.`,
      });
    }

    const leaderRevenue =
      item.leader_channel === "shopee"
        ? numberOrZero(item.shopee.revenue_current)
        : numberOrZero(item.meli.revenue_current);
    const supportRevenue =
      item.leader_channel === "shopee"
        ? numberOrZero(item.meli.revenue_current)
        : numberOrZero(item.shopee.revenue_current);
    if (leaderRevenue > 0 && supportRevenue >= leaderRevenue * 0.85) {
      alerts.push({
        type: "channel_conflict",
        severity: "media",
        title: `Conflito entre canais no SKU ${item.sku_ref || item.sku_key}`,
        detail: "Canal de apoio muito proximo do lider; revisar preco/Ads para evitar canibalizacao.",
      });
    }
  });

  const hasRecentDone = actions.some((action) => {
    if (String(action.status) !== "done") return false;
    const day = parseUtcDay(action.completed_at);
    if (!day) return false;
    return day >= shiftDate(today, -30);
  });

  if (!hasRecentDone) {
    alerts.push({
      type: "no_recent_analysis",
      severity: "media",
      title: "Sem acoes concluidas com analise recente",
      detail: "Finalize ao menos uma acao nesta janela para medir impacto e manter o ciclo de melhoria.",
    });
  }

  return alerts.slice(0, 12);
}

async function buildOverview(identity, query = {}) {
  const tabRaw = String(query.tab || "geral").toLowerCase();
  const tab = ["geral", "meli", "shopee", "skus", "controlados", "config", "admin"].includes(tabRaw)
    ? tabRaw
    : "geral";
  const impactWindow = resolveImpactWindow(query);
  const compareMode = resolveCompareMode(query);
  const range = resolveRange(query);
  const previous =
    compareMode === "previous_period"
      ? buildPreviousRange(range)
      : { from: range.from, to: range.to };
  const fullRange = {
    from:
      shiftDate(range.from, -impactWindow) < previous.from
        ? shiftDate(range.from, -impactWindow)
        : previous.from,
    to: shiftDate(range.to, impactWindow),
  };

  await ensureModuleTables();

  const tenant = await loadMlTenantContext(identity.tenantGlobalId).catch(() => null);
  const actions = await loadActions(identity.tenantGlobalId);
  const configs = await loadConfigs(identity.tenantGlobalId);
  const routines = await loadRoutines(identity.tenantGlobalId);
  const companySettings = await loadCompanySettings(identity.tenantGlobalId);
  const moduleAdminUsers = await loadAdminUsers(identity.tenantGlobalId);
  const skuLinks = await loadSkuLinks(identity.tenantGlobalId);
  const shouldAutoLiveSync = ["geral", "meli", "shopee", "controlados", "skus"].includes(tab);
  if (shouldAutoLiveSync) {
    await syncControlledSkuMetrics(identity, { force: false, source: "auto" }).catch(() => null);
  }
  const liveMetricsMap = await loadLiveMetricsMap(identity.tenantGlobalId);

  const map = new Map();
  const meliByEan = new Map();
  const shopeeByEan = new Map();

  const mlListings = await loadMlListings(identity).catch(() => []);
  for (const row of mlListings) {
    const ref = resolveMeliSkuRef(row);
    const skuKey = normalizeSku(ref);
    const rowTitle = cleanString(row.title) || cleanString(row.sku) || cleanString(row.mlb);
    const item = upsertItem(map, skuKey, ref, rowTitle || ref);
    item.has_meli_listing = true;
    const mlEan = normalizeEan(row.ean || row.gtin_code || row.gtin || null);
    if (mlEan) {
      item.meli_ean = item.meli_ean || mlEan;
      const mlEanKey = eanKey(mlEan);
      if (mlEanKey && !meliByEan.has(mlEanKey)) meliByEan.set(mlEanKey, item);
    }

    if (row?.snapshot_mode) {
      const snapDay =
        parseDate(row.periodo_fim) ||
        parseUtcDay(row.periodo_fim) ||
        parseUtcDay(row.last_synced_at);
      if (!snapDay) continue;

      const snapUnits = numberOrZero(row.units_snapshot);
      const snapRevenue = numberOrZero(row.revenue_snapshot);

      if (inRange(snapDay, range)) {
        item.meli.units_current += snapUnits;
        item.meli.revenue_current += snapRevenue;
      } else if (inRange(snapDay, previous)) {
        item.meli.units_previous += snapUnits;
        item.meli.revenue_previous += snapRevenue;
      }

      pushTimelinePoint(item, snapDay, "meli", snapUnits, snapRevenue);
      continue;
    }

    const current = estimateMlRangeMetrics(row, range);
    const prev = estimateMlRangeMetrics(row, previous);

    item.meli.units_current += current.units;
    item.meli.revenue_current += current.revenue;
    item.meli.units_previous += prev.units;
    item.meli.revenue_previous += prev.revenue;

    const full = estimateMlRangeMetrics(row, fullRange);
    full.timeline.forEach((point) => {
      pushTimelinePoint(item, point.day, "meli", point.units, point.revenue);
    });
  }

  const shopeeRows = await loadShopeeDaily(
    identity.tenantGlobalId,
    fullRange,
    identity.shopeeAccountId,
  ).catch(() => []);

  for (const row of shopeeRows) {
    const day = parseUtcDay(row.day) || parseDate(row.day);
    if (!day) continue;

    const ref = row.sku_ref || row.title || "SKU";
    const skuKey = normalizeSku(ref);
    const item = upsertItem(map, skuKey, ref, row.title || ref);
    item.has_shopee_listing = true;
    const shopeeEan = normalizeEan(row.ean || row.gtin_code || row.gtin || null);
    if (shopeeEan) {
      item.shopee_ean = item.shopee_ean || shopeeEan;
      const shopeeEanKey = eanKey(shopeeEan);
      if (shopeeEanKey && !shopeeByEan.has(shopeeEanKey)) shopeeByEan.set(shopeeEanKey, item);
    }

    const units = numberOrZero(row.units);
    const revenue = numberOrZero(row.revenue);

    pushTimelinePoint(item, day, "shopee", units, revenue);

    if (inRange(day, range)) {
      item.shopee.units_current += units;
      item.shopee.revenue_current += revenue;
    } else if (inRange(day, previous)) {
      item.shopee.units_previous += units;
      item.shopee.revenue_previous += revenue;
    }
  }

  const consumedKeys = new Set();
  for (const link of skuLinks) {
    if (!link?.is_active) continue;
    const targetKey = String(link.sku_key || "").trim();
    if (!targetKey) continue;

    const meliKey = normalizeSku(link.meli_sku_ref || "");
    const shopeeKey = normalizeSku(link.shopee_sku_ref || "");
    const linkMeliEanKey = eanKey(link.meli_ean || link.ean_key || null);
    const linkShopeeEanKey = eanKey(link.shopee_ean || link.ean_key || null);
    const meliSource =
      (linkMeliEanKey ? meliByEan.get(linkMeliEanKey) || null : null) ||
      (meliKey && meliKey !== "sem-sku" ? map.get(meliKey) || null : null);
    const shopeeSource =
      (linkShopeeEanKey ? shopeeByEan.get(linkShopeeEanKey) || null : null) ||
      (shopeeKey && shopeeKey !== "sem-sku" ? map.get(shopeeKey) || null : null);

    const merged = upsertItem(
      map,
      targetKey,
      link.sku_ref || targetKey,
      link.sku_ref || link.meli_title || link.shopee_title || targetKey,
    );

    merged.meli = meliSource
      ? { ...meliSource.meli }
      : { units_current: 0, revenue_current: 0, units_previous: 0, revenue_previous: 0 };
    merged.shopee = shopeeSource
      ? { ...shopeeSource.shopee }
      : { units_current: 0, revenue_current: 0, units_previous: 0, revenue_previous: 0 };
    merged.has_meli_listing =
      Boolean(meliSource?.has_meli_listing) || Boolean(cleanString(link.meli_sku_ref));
    merged.has_shopee_listing =
      Boolean(shopeeSource?.has_shopee_listing) || Boolean(cleanString(link.shopee_sku_ref));
    merged.meli_ean = meliSource?.meli_ean || normalizeEan(link.meli_ean) || null;
    merged.shopee_ean = shopeeSource?.shopee_ean || normalizeEan(link.shopee_ean) || null;
    merged.timeline = mergeTimelineMaps(meliSource?.timeline || {}, shopeeSource?.timeline || {});

    if (meliSource && meliSource.sku_key !== targetKey) consumedKeys.add(meliSource.sku_key);
    if (shopeeSource && shopeeSource.sku_key !== targetKey) consumedKeys.add(shopeeSource.sku_key);
  }

  consumedKeys.forEach((key) => map.delete(key));

  applyActionFlags(map, actions);

  let items = Array.from(map.values()).map((item) => {
    const config = configs.get(item.sku_key);
    const leader = computeLeader(item, config);
    const strategy = computeStrategy(item, config, leader);

    const totalCurrent =
      numberOrZero(item.meli.revenue_current) + numberOrZero(item.shopee.revenue_current);
    const totalPrevious =
      numberOrZero(item.meli.revenue_previous) + numberOrZero(item.shopee.revenue_previous);

    return {
      ...item,
      leader_channel: leader,
      strategy,
      notes: config?.notes || null,
      suggestion: buildSuggestion(item, leader),
      total_revenue_current: totalCurrent,
      total_revenue_previous: totalPrevious,
      growth_pct: pctChange(totalCurrent, totalPrevious),
      live_metrics: liveMetricsMap.get(String(item.sku_key || "")) || null,
    };
  });

  const controlledKeySet = new Set(
    (skuLinks || [])
      .filter((link) => Boolean(link?.is_active))
      .map((link) => String(link.sku_key || "").trim())
      .filter(Boolean),
  );

  if (tab === "controlados") {
    items = items.filter((item) => controlledKeySet.has(String(item.sku_key || "").trim()));
  }

  const q = String(query.q || "").trim().toLowerCase();
  if (q) {
    items = items.filter((item) => {
      return (
        String(item.sku_ref || "").toLowerCase().includes(q) ||
        String(item.title || "").toLowerCase().includes(q)
      );
    });
  }

  if (tab === "meli") {
    items = items
      .filter((item) => hasChannelActivity(item, "meli"))
      .map((item) => {
        const current = numberOrZero(item?.meli?.revenue_current);
        const previous = numberOrZero(item?.meli?.revenue_previous);
        return {
          ...item,
          total_revenue_current: current,
          total_revenue_previous: previous,
          growth_pct: pctChange(current, previous),
        };
      });
  } else if (tab === "shopee") {
    items = items
      .filter((item) => hasChannelActivity(item, "shopee"))
      .map((item) => {
        const current = numberOrZero(item?.shopee?.revenue_current);
        const previous = numberOrZero(item?.shopee?.revenue_previous);
        return {
          ...item,
          total_revenue_current: current,
          total_revenue_previous: previous,
          growth_pct: pctChange(current, previous),
        };
      });
  }

  items.sort((a, b) => {
    const left =
      tab === "meli"
        ? numberOrZero(a.meli.revenue_current)
        : tab === "shopee"
          ? numberOrZero(a.shopee.revenue_current)
          : numberOrZero(a.total_revenue_current);

    const right =
      tab === "meli"
        ? numberOrZero(b.meli.revenue_current)
        : tab === "shopee"
          ? numberOrZero(b.shopee.revenue_current)
          : numberOrZero(b.total_revenue_current);

    return right - left;
  });

  const selectedSku = String(query.sku || items[0]?.sku_key || "").trim();
  const selectedItem = items.find((item) => item.sku_key === selectedSku) || null;

  const rangeDays = makeDaySeries(range.from, range.to);
  const timeline = selectedItem
    ? serializeTimeline(selectedItem.timeline, rangeDays)
    : rangeDays.map((day) => ({
        day,
        meli_units: 0,
        meli_revenue: 0,
        shopee_units: 0,
        shopee_revenue: 0,
        total_revenue: 0,
        total_units: 0,
        flags: [],
      }));

  const actionsBySku = selectedItem
    ? actions.filter((a) => String(a.sku_key) === selectedItem.sku_key)
    : [];

  const actionsWithImpact = actionsBySku.map((action) => {
    const impact = selectedItem
      ? computeActionImpact(selectedItem, {
          ...action,
          impact_window_days: impactWindow,
        })
      : null;
    return {
      ...action,
      impact,
    };
  });

  const impactRanking = actionsWithImpact
    .filter((action) => action?.impact)
    .sort((a, b) => numberOrZero(b.impact.growth_pct) - numberOrZero(a.impact.growth_pct))
    .map((action, idx) => ({
      rank: idx + 1,
      id: Number(action.id),
      title: action.title,
      channel: action.channel,
      status: action.status,
      growth_pct: numberOrZero(action.impact.growth_pct),
      before_revenue: numberOrZero(action.impact.before_revenue),
      after_revenue: numberOrZero(action.impact.after_revenue),
      window_days: impactWindow,
    }));

  const routinesBySku = selectedItem
    ? routines.filter((routine) => {
        const key = String(routine.sku_key || "").trim();
        return !key || key === selectedItem.sku_key;
      })
    : routines;

  const summary = aggregateSummary(items, tab === "admin" ? "geral" : tab);
  if (compareMode === "none") {
    summary.revenue_growth_pct = 0;
    summary.units_growth_pct = 0;
  }
  const movements = buildTopMovements(items, tab === "admin" ? "geral" : tab);
  const advancedMetrics = buildAdvancedMetrics(
    items,
    summary,
    actions,
    routines,
    companySettings,
  );
  const alerts = buildAlerts(items, actions, routines, companySettings);
  const liveLastSyncedAt = await getLastLiveSyncState(identity.tenantGlobalId);

  const users = await queryMl(
    `select
       u.id,
       coalesce(nullif(u.nome, ''), u.email) as nome,
       u.email,
       eu.papel,
       e.nome as empresa_nome,
       e.tenant_global_id
     from ml.empresa_usuarios eu
     join ml.usuarios u on u.id = eu.usuario_id
     join ml.empresas e on e.id = eu.empresa_id
     where e.tenant_global_id = $1
     order by
       case eu.papel when 'owner' then 1 when 'admin' then 2 else 3 end,
       nome asc`,
    [identity.tenantGlobalId],
  ).catch(() => ({ rows: [] }));

  const moduleByEmail = new Map();
  moduleAdminUsers.forEach((row) => {
    moduleByEmail.set(String(row.email || "").toLowerCase(), row);
  });

  const platformUsers = (users.rows || []).map((row) => {
    const key = String(row.email || "").toLowerCase();
    const module = moduleByEmail.get(key) || null;
    return {
      id: Number(row.id),
      nome: row.nome || null,
      email: row.email || null,
      papel: row.papel || null,
      empresa_nome: row.empresa_nome || null,
      module_role: module?.role || "viewer",
      module_status: module?.status || "active",
      module_user_id: module?.id ? Number(module.id) : null,
    };
  });

  return {
    ok: true,
    tab,
    compare_mode: compareMode,
    impact_window: impactWindow,
    range,
    previous,
    user: {
      id: identity.userId || null,
      name: identity.userName || identity.userEmail || "Usuario",
      email: identity.userEmail || null,
      source: identity.source || null,
    },
    tenant: {
      tenant_global_id: identity.tenantGlobalId,
      empresa_nome: tenant?.nome || identity.empresaNome || null,
    },
    summary,
    items,
    selected_sku: selectedItem?.sku_key || null,
    timeline,
    actions: actionsWithImpact,
    routines: routinesBySku,
    impact_ranking: impactRanking,
    movements,
    advanced_metrics: advancedMetrics,
    alerts,
    sku_links: skuLinks,
    live_sync: {
      last_synced_at: liveLastSyncedAt || null,
      interval_hours: 4,
      window_days: LIVE_SYNC_WINDOW_DAYS,
    },
    admin: {
      users: platformUsers,
      module_users: moduleAdminUsers,
      company_settings: companySettings,
    },
  };
}

function toCsvLine(values) {
  return values
    .map((value) => {
      const raw = value == null ? "" : String(value);
      const escaped = raw.replace(/"/g, '""');
      return `"${escaped}"`;
    })
    .join(",");
}

async function exportCsv(identity, query = {}) {
  const overview = await buildOverview(identity, query);
  const lines = [
    toCsvLine([
      "sku_key",
      "sku_ref",
      "titulo",
      "canal_lider",
      "estrategia",
      "faturamento_geral",
      "faturamento_meli",
      "faturamento_shopee",
      "crescimento_pct",
      "sugestao",
    ]),
  ];

  overview.items.forEach((item) => {
    lines.push(
      toCsvLine([
        item.sku_key,
        item.sku_ref,
        item.title,
        item.leader_channel,
        item.strategy,
        numberOrZero(item.total_revenue_current).toFixed(2),
        numberOrZero(item.meli.revenue_current).toFixed(2),
        numberOrZero(item.shopee.revenue_current).toFixed(2),
        clamp(pctChange(item.total_revenue_current, item.total_revenue_previous), -99999, 99999).toFixed(2),
        item.suggestion,
      ]),
    );
  });

  return lines.join("\n");
}

async function saveAction(identity, payload = {}) {
  await ensureModuleTables();

  const skuRef = String(payload.sku_ref || "").trim();
  const skuKey = normalizeSku(payload.sku_key || skuRef);
  if (!skuKey || skuKey === "sem-sku") {
    throw new Error("Informe o SKU/referencia da acao.");
  }

  const title = String(payload.title || "").trim();
  if (!title) {
    throw new Error("Informe o titulo da acao.");
  }

  const status = String(payload.status || "todo").toLowerCase();
  const channel = String(payload.channel || "geral").toLowerCase();
  const actionType = String(payload.action_type || "checklist").toLowerCase();

  const result = await querySku(
    `insert into skuleader.actions (
       tenant_global_id,
       sku_key,
       channel,
       action_type,
       title,
       details,
       due_date,
       status,
       highlight_red,
       metric_focus,
       completed_at,
       created_by
     )
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
       case when $8 = 'done' then now() else null end,
       $11)
     returning *`,
    [
      identity.tenantGlobalId,
      skuKey,
      channel,
      actionType,
      title,
      String(payload.details || "").trim() || null,
      parseDate(payload.due_date),
      ["todo", "doing", "done", "archived"].includes(status) ? status : "todo",
      Boolean(payload.highlight_red),
      String(payload.metric_focus || "").trim() || null,
      identity.userId || null,
    ],
  );

  return result.rows[0];
}

async function updateAction(identity, actionId, payload = {}) {
  await ensureModuleTables();
  const id = Number(actionId);
  if (!Number.isFinite(id) || id <= 0) throw new Error("Acao invalida.");

  const current = await querySku(
    `select * from skuleader.actions where id = $1 and tenant_global_id = $2 limit 1`,
    [id, identity.tenantGlobalId],
  );

  if (!current.rows[0]) {
    throw new Error("Acao nao encontrada.");
  }

  const nextStatus = String(payload.status || current.rows[0].status || "todo").toLowerCase();

  const result = await querySku(
    `update skuleader.actions
        set title = coalesce($3, title),
            details = coalesce($4, details),
            due_date = coalesce($5, due_date),
            status = $6,
            channel = coalesce($7, channel),
            action_type = coalesce($8, action_type),
            highlight_red = coalesce($9, highlight_red),
            metric_focus = coalesce($10, metric_focus),
            completed_at = case
              when $6 = 'done' and completed_at is null then now()
              when $6 <> 'done' then null
              else completed_at
            end,
            updated_at = now()
      where id = $1
        and tenant_global_id = $2
      returning *`,
    [
      id,
      identity.tenantGlobalId,
      payload.title ? String(payload.title).trim() : null,
      payload.details != null ? String(payload.details).trim() : null,
      payload.due_date ? parseDate(payload.due_date) : null,
      ["todo", "doing", "done", "archived"].includes(nextStatus)
        ? nextStatus
        : "todo",
      payload.channel ? String(payload.channel).toLowerCase() : null,
      payload.action_type ? String(payload.action_type).toLowerCase() : null,
      payload.highlight_red == null ? null : Boolean(payload.highlight_red),
      payload.metric_focus != null ? String(payload.metric_focus).trim() : null,
    ],
  );

  return result.rows[0] || null;
}

async function saveConfig(identity, payload = {}) {
  await ensureModuleTables();

  const skuRef = String(payload.sku_ref || "").trim();
  const skuKey = normalizeSku(payload.sku_key || skuRef);
  if (!skuKey || skuKey === "sem-sku") {
    throw new Error("Informe o SKU/referencia.");
  }

  const channel = String(payload.manual_leader_channel || "auto").toLowerCase();
  const strategy = String(payload.strategy || "prioritario").toLowerCase();

  const result = await querySku(
    `insert into skuleader.configs (
       tenant_global_id,
       sku_key,
       sku_ref,
       manual_leader_channel,
       strategy,
       notes,
       updated_by,
       updated_at
     )
     values ($1, $2, $3, $4, $5, $6, $7, now())
     on conflict (tenant_global_id, sku_key)
     do update set
       sku_ref = excluded.sku_ref,
       manual_leader_channel = excluded.manual_leader_channel,
       strategy = excluded.strategy,
       notes = excluded.notes,
       updated_by = excluded.updated_by,
       updated_at = now()
     returning *`,
    [
      identity.tenantGlobalId,
      skuKey,
      skuRef || null,
      ["auto", "meli", "shopee"].includes(channel) ? channel : "auto",
      ["prioritario", "apoio", "secundario"].includes(strategy)
        ? strategy
        : "prioritario",
      String(payload.notes || "").trim() || null,
      identity.userId || null,
    ],
  );

  return result.rows[0] || null;
}

async function searchSkuCandidates(identity, query = {}) {
  await ensureModuleTables();

  const q = cleanText(query.q, 120);
  if (!q || q.length < 2) {
    return { meli: [], shopee: [] };
  }

  const qLike = `%${q}%`;
  const contaIds = await loadMlContaIds(identity);

  let meliRows = [];
  if (contaIds.length) {
    const accountKeys = contaIds.map((id) => String(id));
    const catalogRows = await queryMl(
      `select
         case when ci.account_key ~ '^[0-9]+$' then ci.account_key::bigint else null end as meli_conta_id,
         coalesce(
           nullif(trim(ci.reference_sku), ''),
           nullif(trim(ci.mlb), ''),
           nullif(trim(ci.title), '')
         ) as sku_ref,
         max(ci.title) as title,
         max(ci.mlb) as mlb,
         max(
           (
             select nullif(trim(ean_value), '')
             from jsonb_array_elements_text(coalesce(ci.eans, '[]'::jsonb)) e(ean_value)
             where nullif(trim(ean_value), '') is not null
             limit 1
           )
         ) as ean,
         max(coalesce(ci.last_synced_at, ci.updated_at, ci.created_at)) as last_synced_at
       from ml.mercadolivre_sku_catalog_items ci
       where ci.account_key = any($1::text[])
         and (
           coalesce(ci.reference_sku, '') ilike $2
           or coalesce(ci.title, '') ilike $2
           or coalesce(ci.mlb, '') ilike $2
           or ci.eans::text ilike $2
         )
       group by 1, 2
       order by max(coalesce(ci.last_synced_at, ci.updated_at, ci.created_at)) desc nulls last
       limit 30`,
      [accountKeys, qLike],
    ).catch(() => ({ rows: [] }));
    meliRows = catalogRows.rows || [];

    if (!meliRows.length) {
    const listingTables = ["ml.anuncios_full", "public.anuncios_full", "anuncios_full"];
    for (const tableName of listingTables) {
      try {
      const result = await queryMl(
        `select
           a.meli_conta_id,
           coalesce(nullif(trim(a.sku), ''), a.mlb, a.title) as sku_ref,
           a.title,
           a.mlb,
           null::text as ean,
           max(a.last_synced_at) as last_synced_at
         from ${tableName} a
           where a.meli_conta_id = any($1::bigint[])
             and (
               coalesce(a.sku, '') ilike $2
               or coalesce(a.title, '') ilike $2
               or coalesce(a.mlb, '') ilike $2
             )
           group by 1,2,3,4
           order by max(a.last_synced_at) desc nulls last
           limit 30`,
          [contaIds, qLike],
        );
        if ((result.rows || []).length) {
          meliRows = result.rows;
          break;
        }
      } catch (error) {
        if (isMissingTableError(error)) continue;
      }
    }
    }

    if (!meliRows.length) {
      const snapshotResult = await queryMl(
        `select
           max(i.meli_conta_id)::bigint as meli_conta_id,
           coalesce(
             nullif(trim(coalesce(
               i.payload_item->>'sku',
               i.payload_item->>'seller_sku',
               i.payload_item->>'item_sku',
               i.payload_item->>'seller_custom_field',
               ''
             )), ''),
             nullif(trim(i.mlb), ''),
             nullif(trim(i.titulo), '')
           ) as sku_ref,
           max(i.titulo) as title,
           max(i.mlb) as mlb,
           max(
             nullif(trim(coalesce(
               i.payload_item->>'gtin',
               i.payload_item->>'ean',
               i.payload_item->>'ean13',
               i.payload_item->>'gtin_code',
               ''
             )), '')
           ) as ean,
           max(coalesce(i.atualizado_em, i.criado_em, s.gerado_em)) as last_synced_at
         from ml.ml_ranking_anuncios_snapshot_items i
         join ml.ml_ranking_anuncios_snapshots s on s.id = i.snapshot_id
         where i.meli_conta_id = any($1::bigint[])
           and coalesce(i.tipo_ranking, s.tipo_ranking, 'faturamento') = 'faturamento'
           and (
             coalesce(i.titulo, '') ilike $2
             or coalesce(i.mlb, '') ilike $2
             or coalesce(i.payload_item->>'sku', '') ilike $2
           or coalesce(i.payload_item->>'seller_sku', '') ilike $2
           or coalesce(i.payload_item->>'item_sku', '') ilike $2
           or coalesce(i.payload_item->>'seller_custom_field', '') ilike $2
           or coalesce(i.payload_item->>'gtin', '') ilike $2
           or coalesce(i.payload_item->>'ean', '') ilike $2
           or coalesce(i.payload_item->>'ean13', '') ilike $2
           or coalesce(i.payload_item->>'gtin_code', '') ilike $2
         )
         group by 2
         order by max(coalesce(i.atualizado_em, i.criado_em, s.gerado_em)) desc nulls last
         limit 30`,
        [contaIds, qLike],
      ).catch(() => ({ rows: [] }));
      meliRows = snapshotResult.rows || [];
    }

    if (meliRows.length) {
      meliRows = await enrichMlRowsWithLiveEan(meliRows).catch(() => meliRows);
    }

    const preferredContaId = Number(identity?.meliAccountId || contaIds[0] || 0);
    if (Number.isFinite(preferredContaId) && preferredContaId > 0) {
      const realtimeRows = await fetchMlRealtimeCandidates(preferredContaId, q, 20).catch(() => []);
      if (realtimeRows.length) {
        const merged = new Map();
        realtimeRows.forEach((row) => {
          const key = cleanString(row.mlb || row.sku_ref).toUpperCase();
          if (!key) return;
          merged.set(key, row);
        });
        (meliRows || []).forEach((row) => {
          const key = cleanString(row.mlb || row.sku_ref).toUpperCase();
          if (!key || merged.has(key)) return;
          merged.set(key, row);
        });
        meliRows = Array.from(merged.values()).slice(0, 30);
      }
    }
  }

  let shopeeResult;
  try {
    const tenant = String(identity.tenantGlobalId || "");
    const hasProductGtin = await hasShopeeColumn("Product", "gtinCode");
    const eanSelect = hasProductGtin
      ? `max(nullif(trim(p."gtinCode"), '')) as ean,`
      : `null::text as ean,`;
    shopeeResult = await queryShopee(
      `select
         max(oi."itemId")::text as item_id,
         max(oi."shopId")::int as shop_id,
         coalesce(
           nullif(trim(oi."itemSku"), ''),
           nullif(trim(oi."modelSku"), ''),
           nullif(trim(oi."itemName"), ''),
           oi."itemId"::text
         ) as sku_ref,
         max(coalesce(oi."itemName", oi."modelName")) as title,
         ${eanSelect}
         max(coalesce(o."shopeeCreateTime", o."createdAt")) as last_synced_at
       from public."OrderItem" oi
       join public."Order" o on o.id = oi."orderId"
       join public."Shop" s on s.id = oi."shopId"
       join public."Account" acc on acc.id = s."accountId"
       left join public."Product" p on p."shopId" = oi."shopId" and p."itemId" = oi."itemId"
       where acc."tenantGlobalId" = $1
         and (
           coalesce(oi."itemSku", '') ilike $2
           or coalesce(oi."modelSku", '') ilike $2
           or coalesce(oi."itemName", '') ilike $2
           or coalesce(oi."modelName", '') ilike $2
           or oi."itemId"::text ilike $2
         )
       group by 3
       order by max(coalesce(o."shopeeCreateTime", o."createdAt")) desc nulls last
       limit 30`,
      [tenant, qLike],
    );
  } catch (error) {
    if (isMissingColumnError(error)) {
      shopeeResult = await queryShopee(
        `select
           max(oi."itemId")::text as item_id,
           max(oi."shopId")::int as shop_id,
           coalesce(nullif(trim(oi.sku), ''), nullif(trim(oi.name), ''), oi."itemId"::text) as sku_ref,
           max(oi.name) as title,
           null::text as ean,
           max(coalesce(o."shopeeCreateTime", o."createdAt")) as last_synced_at
         from public."OrderItem" oi
         join public."Order" o on o.id = oi."orderId"
         join public."Shop" s on s.id = oi."shopId"
         join public."Account" acc on acc.id = s."accountId"
         where acc."tenantGlobalId" = $1
           and (
             coalesce(oi.sku, '') ilike $2
             or coalesce(oi.name, '') ilike $2
             or oi."itemId"::text ilike $2
           )
         group by 3
         order by max(coalesce(o."shopeeCreateTime", o."createdAt")) desc nulls last
         limit 30`,
        [tenant, qLike],
      ).catch(() => ({ rows: [] }));
    } else if (
      String(error?.code || "") === "42P01" ||
      String(error?.message || "").includes("Conexao Shopee indisponivel")
    ) {
      shopeeResult = { rows: [] };
    } else {
      throw error;
    }
  }

  return {
    meli: (meliRows || []).map((row, idx) => ({
      id: `meli-${idx + 1}`,
      sku_ref: row.sku_ref,
      title: row.title,
      mlb: row.mlb || null,
      meli_conta_id: Number(row.meli_conta_id || 0) || null,
      ean: normalizeEan(row.ean || null),
      last_synced_at: row.last_synced_at || null,
    })),
    shopee: (shopeeResult.rows || []).map((row, idx) => ({
      id: `shopee-${idx + 1}`,
      sku_ref: row.sku_ref,
      title: row.title,
      item_id: parseBigIntString(row.item_id),
      shop_id: Number(row.shop_id || 0) || null,
      ean: normalizeEan(row.ean || row.gtin_code || null),
      last_synced_at: row.last_synced_at || null,
    })),
  };
}

async function saveSkuLink(identity, payload = {}) {
  await ensureModuleTables();

  const meliEan = normalizeEan(payload.meli_ean);
  const shopeeEan = normalizeEan(payload.shopee_ean);
  const linkEanKey = eanKey(payload.ean_key || meliEan || shopeeEan || null);
  const skuRef =
    cleanText(payload.sku_ref, 160) ||
    cleanText(payload.sku_key, 160) ||
    cleanText(payload.meli_sku_ref, 160) ||
    cleanText(payload.shopee_sku_ref, 160) ||
    cleanText(linkEanKey || meliEan || shopeeEan, 160);

  const skuKey = normalizeSku(payload.sku_key || skuRef);
  const meliSkuRef = cleanText(payload.meli_sku_ref, 160);
  const shopeeSkuRef = cleanText(payload.shopee_sku_ref, 160);
  const meliContaId = Number(payload.meli_conta_id || identity?.meliAccountId || 0);
  const shopeeItemId = parseBigIntString(payload.shopee_item_id || null);
  const shopeeShopId = Number(payload.shopee_shop_id || 0);

  if (!skuRef || (!meliSkuRef && !shopeeSkuRef && !meliEan && !shopeeEan)) {
    throw new Error("Selecione ao menos um SKU de canal ou informe EAN para vincular.");
  }

  const result = await querySku(
    `insert into skuleader.sku_links (
       tenant_global_id,
       sku_key,
       sku_ref,
       meli_sku_ref,
       meli_ean,
       meli_title,
       meli_mlb,
       meli_conta_id,
       shopee_sku_ref,
       shopee_item_id,
       shopee_shop_id,
       shopee_ean,
       shopee_title,
       ean_key,
       is_active,
       updated_by,
       updated_at
     )
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now())
     on conflict (tenant_global_id, sku_key)
     do update set
       sku_ref = excluded.sku_ref,
       meli_sku_ref = excluded.meli_sku_ref,
       meli_ean = excluded.meli_ean,
       meli_title = excluded.meli_title,
       meli_mlb = excluded.meli_mlb,
       meli_conta_id = excluded.meli_conta_id,
       shopee_sku_ref = excluded.shopee_sku_ref,
       shopee_item_id = excluded.shopee_item_id,
       shopee_shop_id = excluded.shopee_shop_id,
       shopee_ean = excluded.shopee_ean,
       shopee_title = excluded.shopee_title,
       ean_key = excluded.ean_key,
       is_active = excluded.is_active,
       updated_by = excluded.updated_by,
       updated_at = now()
     returning *`,
    [
      identity.tenantGlobalId,
      skuKey,
      skuRef,
      meliSkuRef || null,
      meliEan,
      cleanText(payload.meli_title, 220),
      cleanText(payload.meli_mlb, 80),
      Number.isFinite(meliContaId) && meliContaId > 0 ? meliContaId : null,
      shopeeSkuRef || null,
      shopeeItemId || null,
      Number.isFinite(shopeeShopId) && shopeeShopId > 0 ? shopeeShopId : null,
      shopeeEan,
      cleanText(payload.shopee_title, 220),
      linkEanKey,
      payload.is_active == null ? true : Boolean(payload.is_active),
      identity.userId || null,
    ],
  );

  return result.rows[0] || null;
}

async function deleteSkuLink(identity, skuLinkId) {
  await ensureModuleTables();
  const id = Number(skuLinkId);
  if (!Number.isFinite(id) || id <= 0) throw new Error("Vinculo SKU invalido.");

  const result = await querySku(
    `delete from skuleader.sku_links
      where id = $1 and tenant_global_id = $2
      returning id`,
    [id, identity.tenantGlobalId],
  );

  return Boolean(result.rowCount);
}

async function saveRoutine(identity, payload = {}) {
  await ensureModuleTables();

  const title = cleanText(payload.title, 160);
  if (!title) throw new Error("Informe o titulo da rotina.");

  const skuKey = payload.sku_key ? normalizeSku(payload.sku_key) : null;
  const priority = String(payload.priority || "media").toLowerCase();
  const status = String(payload.status || "todo").toLowerCase();
  const channel = String(payload.channel || "geral").toLowerCase();

  const result = await querySku(
    `insert into skuleader.routines (
       tenant_global_id,
       sku_key,
       title,
       details,
       due_date,
       weekday,
       channel,
       priority,
       status,
       is_alert,
       created_by,
       completed_at
     )
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
       case when $9 = 'done' then now() else null end
     )
     returning *`,
    [
      identity.tenantGlobalId,
      skuKey && skuKey !== "sem-sku" ? skuKey : null,
      title,
      cleanText(payload.details, 500),
      parseDate(payload.due_date),
      parseWeekday(payload.weekday),
      ["geral", "meli", "shopee"].includes(channel) ? channel : "geral",
      ["alta", "media", "baixa"].includes(priority) ? priority : "media",
      ["todo", "doing", "done", "archived"].includes(status) ? status : "todo",
      payload.is_alert == null ? true : Boolean(payload.is_alert),
      identity.userId || null,
    ],
  );

  return result.rows[0] || null;
}

async function updateRoutine(identity, routineId, payload = {}) {
  await ensureModuleTables();
  const id = Number(routineId);
  if (!Number.isFinite(id) || id <= 0) throw new Error("Rotina invalida.");

  const current = await querySku(
    `select * from skuleader.routines where id = $1 and tenant_global_id = $2 limit 1`,
    [id, identity.tenantGlobalId],
  );
  if (!current.rows[0]) throw new Error("Rotina nao encontrada.");

  const nextStatus = String(payload.status || current.rows[0].status || "todo").toLowerCase();
  const nextPriority = String(payload.priority || current.rows[0].priority || "media").toLowerCase();
  const nextChannel = String(payload.channel || current.rows[0].channel || "geral").toLowerCase();

  const result = await querySku(
    `update skuleader.routines
        set title = coalesce($3, title),
            details = coalesce($4, details),
            due_date = coalesce($5, due_date),
            weekday = coalesce($6, weekday),
            channel = $7,
            priority = $8,
            status = $9,
            is_alert = coalesce($10, is_alert),
            completed_at = case
              when $9 = 'done' and completed_at is null then now()
              when $9 <> 'done' then null
              else completed_at
            end,
            updated_at = now()
      where id = $1 and tenant_global_id = $2
      returning *`,
    [
      id,
      identity.tenantGlobalId,
      payload.title != null ? cleanText(payload.title, 160) : null,
      payload.details != null ? cleanText(payload.details, 500) : null,
      payload.due_date ? parseDate(payload.due_date) : null,
      payload.weekday != null ? parseWeekday(payload.weekday) : null,
      ["geral", "meli", "shopee"].includes(nextChannel) ? nextChannel : "geral",
      ["alta", "media", "baixa"].includes(nextPriority) ? nextPriority : "media",
      ["todo", "doing", "done", "archived"].includes(nextStatus)
        ? nextStatus
        : "todo",
      payload.is_alert == null ? null : Boolean(payload.is_alert),
    ],
  );

  return result.rows[0] || null;
}

async function deleteRoutine(identity, routineId) {
  await ensureModuleTables();
  const id = Number(routineId);
  if (!Number.isFinite(id) || id <= 0) throw new Error("Rotina invalida.");

  const result = await querySku(
    `delete from skuleader.routines
      where id = $1 and tenant_global_id = $2
      returning id`,
    [id, identity.tenantGlobalId],
  );

  return Boolean(result.rowCount);
}

async function saveCompanySettings(identity, payload = {}) {
  await ensureModuleTables();

  const result = await querySku(
    `insert into skuleader.company_settings (
       tenant_global_id,
       focus_sku_count,
       recovery_sku_count,
       monthly_growth_target,
       min_roi_target,
       min_conversion_target,
       alerts_enabled,
       updated_by,
       updated_at
     )
     values ($1,$2,$3,$4,$5,$6,$7,$8,now())
     on conflict (tenant_global_id)
     do update set
       focus_sku_count = excluded.focus_sku_count,
       recovery_sku_count = excluded.recovery_sku_count,
       monthly_growth_target = excluded.monthly_growth_target,
       min_roi_target = excluded.min_roi_target,
       min_conversion_target = excluded.min_conversion_target,
       alerts_enabled = excluded.alerts_enabled,
       updated_by = excluded.updated_by,
       updated_at = now()
     returning *`,
    [
      identity.tenantGlobalId,
      Math.max(1, parseIntSafe(payload.focus_sku_count, 5)),
      Math.max(1, parseIntSafe(payload.recovery_sku_count, 5)),
      Math.max(0, parseNumberSafe(payload.monthly_growth_target, 12)),
      Math.max(0, parseNumberSafe(payload.min_roi_target, 3)),
      Math.max(0, parseNumberSafe(payload.min_conversion_target, 2.5)),
      payload.alerts_enabled == null ? true : Boolean(payload.alerts_enabled),
      identity.userId || null,
    ],
  );

  return result.rows[0] || null;
}

async function saveAdminUser(identity, payload = {}) {
  await ensureModuleTables();

  const email = cleanText(payload.email, 160);
  if (!email) throw new Error("Informe o e-mail do usuario.");

  const role = String(payload.role || "analyst").toLowerCase();
  const status = String(payload.status || "active").toLowerCase();

  const result = await querySku(
    `insert into skuleader.admin_users (
       tenant_global_id,
       user_id,
       nome,
       email,
       role,
       status,
       created_by,
       updated_at
     )
     values ($1,$2,$3,$4,$5,$6,$7,now())
     on conflict (tenant_global_id, email)
     do update set
       user_id = coalesce(excluded.user_id, skuleader.admin_users.user_id),
       nome = excluded.nome,
       role = excluded.role,
       status = excluded.status,
       updated_at = now()
     returning *`,
    [
      identity.tenantGlobalId,
      payload.user_id == null ? null : Number(payload.user_id),
      cleanText(payload.nome, 120),
      email.toLowerCase(),
      ["admin", "analyst", "viewer"].includes(role) ? role : "analyst",
      ["active", "inactive"].includes(status) ? status : "active",
      identity.userId || null,
    ],
  );

  return result.rows[0] || null;
}

async function updateAdminUser(identity, adminUserId, payload = {}) {
  await ensureModuleTables();
  const id = Number(adminUserId);
  if (!Number.isFinite(id) || id <= 0) throw new Error("Usuario admin invalido.");

  const current = await querySku(
    `select * from skuleader.admin_users where id = $1 and tenant_global_id = $2 limit 1`,
    [id, identity.tenantGlobalId],
  );
  if (!current.rows[0]) throw new Error("Usuario admin nao encontrado.");

  const role = String(payload.role || current.rows[0].role || "analyst").toLowerCase();
  const status = String(payload.status || current.rows[0].status || "active").toLowerCase();

  const result = await querySku(
    `update skuleader.admin_users
        set nome = coalesce($3, nome),
            email = coalesce($4, email),
            role = $5,
            status = $6,
            updated_at = now()
      where id = $1 and tenant_global_id = $2
      returning *`,
    [
      id,
      identity.tenantGlobalId,
      payload.nome != null ? cleanText(payload.nome, 120) : null,
      payload.email != null ? cleanText(payload.email, 160)?.toLowerCase() : null,
      ["admin", "analyst", "viewer"].includes(role) ? role : "analyst",
      ["active", "inactive"].includes(status) ? status : "active",
    ],
  );

  return result.rows[0] || null;
}

async function deleteAdminUser(identity, adminUserId) {
  await ensureModuleTables();
  const id = Number(adminUserId);
  if (!Number.isFinite(id) || id <= 0) throw new Error("Usuario admin invalido.");

  const result = await querySku(
    `delete from skuleader.admin_users
      where id = $1 and tenant_global_id = $2
      returning id`,
    [id, identity.tenantGlobalId],
  );

  return Boolean(result.rowCount);
}

async function syncLiveMetrics(identity, payload = {}) {
  await ensureModuleTables();
  const force = Boolean(payload?.force ?? true);
  return syncControlledSkuMetrics(identity, {
    force,
    source: force ? "manual" : "auto",
  });
}

module.exports = {
  buildOverview,
  exportCsv,
  saveAction,
  updateAction,
  saveConfig,
  saveRoutine,
  updateRoutine,
  deleteRoutine,
  saveCompanySettings,
  saveAdminUser,
  updateAdminUser,
  deleteAdminUser,
  searchSkuCandidates,
  listMlAccounts,
  saveMeliAccountPreference,
  resolveMeliAccountSelection,
  saveSkuLink,
  deleteSkuLink,
  syncLiveMetrics,
};
