"use strict";

const fetch = require("node-fetch");
const TokenService = require("./tokenService");

const ML_API_BASE = "https://api.mercadolibre.com";
const MONITOR_STORE = new Map();
const BILLING_COOLDOWN_UNTIL = new Map();
const DEFAULT_BILLING_RATE_WAIT_MS = 13000;
const RESPONSE_CACHE = new Map();
const RESPONSE_INFLIGHT = new Map();
const RESPONSE_CACHE_MAX_ENTRIES = 500;

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function maybeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isTruthy(value) {
  if (value === true || value === false) return value;
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (["1", "true", "sim", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "nao", "no", "off"].includes(normalized))
    return false;
  return false;
}

function parseDateOnly(value) {
  const raw = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const d = new Date(`${raw}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : raw;
}

function toIsoDate(date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);
}

function defaultDateRange(days = 30) {
  const today = new Date();
  const toDate = new Date(today);
  const to = toIsoDate(toDate);
  const fromDate = new Date(toDate);
  fromDate.setDate(fromDate.getDate() - Math.max(0, days - 1));
  return {
    date_from: toIsoDate(fromDate),
    date_to: to,
  };
}

function normalizeDateRange(input = {}, fallbackDays = 30) {
  const defaults = defaultDateRange(fallbackDays);
  const dateFrom = parseDateOnly(input.date_from) || defaults.date_from;
  const dateTo = parseDateOnly(input.date_to) || defaults.date_to;
  if (dateFrom <= dateTo) return { date_from: dateFrom, date_to: dateTo };
  return { date_from: dateTo, date_to: dateFrom };
}

function firstDayOfCurrentMonth() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-01`;
}

function normalizePeriodKey(key) {
  return parseDateOnly(key) || firstDayOfCurrentMonth();
}

function sanitizeQuery(query = {}) {
  const clean = {};
  for (const [key, value] of Object.entries(query)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      const filtered = value
        .map((entry) => String(entry || "").trim())
        .filter(Boolean);
      if (filtered.length) clean[key] = filtered.join(",");
      continue;
    }
    const trimmed = String(value).trim();
    if (!trimmed) continue;
    clean[key] = trimmed;
  }
  return clean;
}

function buildUrl(path, query = {}) {
  const normalizedPath = String(path || "").startsWith("/")
    ? String(path)
    : `/${String(path || "")}`;
  const url = new URL(`${ML_API_BASE}${normalizedPath}`);
  const sanitized = sanitizeQuery(query);
  Object.entries(sanitized).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });
  return url.toString();
}

function parseIds(value) {
  if (!value) return [];
  const source = Array.isArray(value) ? value : String(value).split(",");
  return Array.from(
    new Set(
      source
        .map((entry) => String(entry || "").trim())
        .filter(Boolean),
    ),
  );
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const list = Array.isArray(items) ? items : [];
  const limit = Math.max(1, Number(concurrency) || 1);
  const output = new Array(list.length);
  let pointer = 0;

  const workers = Array.from(
    { length: Math.min(limit, list.length || 1) },
    async () => {
      while (pointer < list.length) {
        const current = pointer;
        pointer += 1;
        output[current] = await mapper(list[current], current);
      }
    },
  );

  await Promise.all(workers);
  return output;
}

function pick(obj, ...paths) {
  for (const path of paths) {
    let current = obj;
    let valid = true;
    for (const key of String(path || "").split(".")) {
      if (!key) continue;
      if (current == null || !(key in current)) {
        valid = false;
        break;
      }
      current = current[key];
    }
    if (valid && current != null) return current;
  }
  return null;
}

function extractRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.details)) return payload.details;
  if (Array.isArray(payload?.rows)) return payload.rows;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function extractDocuments(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.documents)) return payload.documents;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function extractOrderIdFromDetail(detail) {
  const direct = pick(
    detail,
    "shipping_info.order.order_id",
    "shipping_info.order_id",
    "sale_info.order_id",
    "order_info.order_id",
    "order.order_id",
    "order.id",
  );
  if (direct != null && String(direct).trim()) return String(direct).trim();

  const referenceId = pick(detail, "operation_info.reference_id");
  if (referenceId != null && String(referenceId).trim()) {
    const normalized = String(referenceId).trim();
    if (/^\d+$/.test(normalized)) return normalized;
  }
  return null;
}

function extractDetailAmount(detail) {
  const amount = maybeNumber(
    pick(
      detail,
      "charge_info.detail_amount",
      "charge_info.amount",
      "amount",
      "detail_amount",
      "detail.amount",
    ),
  );
  return amount == null ? 0 : amount;
}

function extractDocumentId(detail) {
  const raw = pick(detail, "document_info.document_id", "document_id");
  if (raw == null) return null;
  return String(raw).trim() || null;
}

function extractLegalStatus(detail) {
  const raw = pick(
    detail,
    "charge_info.legal_document_status",
    "legal_document_status",
    "status",
  );
  return String(raw || "").trim().toUpperCase();
}

function hasDivergenceSignal(detail) {
  const legalStatus = extractLegalStatus(detail);
  if (
    ["ERROR", "FAILED", "REJECTED", "INCONSISTENT", "BONUS_PART_ON"].some(
      (flag) => legalStatus.includes(flag),
    )
  ) {
    return true;
  }

  const status = String(
    pick(detail, "charge_info.status", "status", "detail_status") || "",
  ).toUpperCase();
  if (["PART", "ERROR", "FAILED", "REJECTED", "INCONSISTENT"].some((flag) =>
    status.includes(flag)
  )) {
    return true;
  }

  if (Array.isArray(detail?.errors) && detail.errors.length > 0) return true;
  if (Array.isArray(detail?.warnings) && detail.warnings.length > 0) return true;
  return false;
}

function isPendingLegalDocument(detail) {
  const legalStatus = extractLegalStatus(detail);
  if (!legalStatus) return false;
  return ["PROCESSING", "PENDING", "QUEUE"].some((flag) =>
    legalStatus.includes(flag)
  );
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseFileNameFromDisposition(contentDisposition) {
  const header = String(contentDisposition || "");
  if (!header) return null;
  const utf8Match = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }
  const plainMatch = header.match(/filename="?([^"]+)"?/i);
  if (plainMatch?.[1]) return plainMatch[1];
  return null;
}

function createHttpError(status, message, url, payload = null) {
  const error = new Error(message || "Mercado Livre API error");
  error.status = status;
  error.url = url;
  error.payload = payload;
  return error;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function isBillingPath(path) {
  const normalized = String(path || "");
  return normalized.startsWith("/billing/integration/");
}

function getBillingCooldownKey(state) {
  const account =
    state?.creds?.meli_conta_id ||
    state?.creds?.account_key ||
    state?.creds?.accountKey ||
    "default";
  return String(account);
}

async function waitBillingCooldown(state, path) {
  if (!isBillingPath(path)) return;
  const key = getBillingCooldownKey(state);
  const until = Number(BILLING_COOLDOWN_UNTIL.get(key) || 0);
  const now = Date.now();
  if (until > now) {
    await sleep(until - now);
  }
}

function parseRetryAfterMs(response) {
  const retryAfterHeader = String(response?.headers?.get("retry-after") || "").trim();
  if (!retryAfterHeader) return null;

  if (/^\d+$/.test(retryAfterHeader)) {
    return Number(retryAfterHeader) * 1000;
  }

  const parsedDate = Date.parse(retryAfterHeader);
  if (Number.isFinite(parsedDate)) {
    return Math.max(0, parsedDate - Date.now());
  }

  return null;
}

function parseRateLimitMessageWaitMs(parsed, text) {
  const fromPayload =
    maybeNumber(parsed?.retry_after_ms) ||
    (maybeNumber(parsed?.retry_after) != null
      ? maybeNumber(parsed?.retry_after) * 1000
      : null);
  if (fromPayload != null) return fromPayload;

  const message = String(
    parsed?.message ||
      parsed?.error_description ||
      parsed?.error ||
      text ||
      "",
  );
  const perMinuteMatch = message.match(/(\d+)\s*requests?\s*per\s*minute/i);
  if (perMinuteMatch?.[1]) {
    const perMinute = Number(perMinuteMatch[1]);
    if (Number.isFinite(perMinute) && perMinute > 0) {
      return Math.ceil(60000 / perMinute) + 1000;
    }
  }

  return null;
}

function resolveRateLimitWaitMs(response, parsed, text) {
  const fromHeader = parseRetryAfterMs(response);
  if (fromHeader != null) return Math.max(1000, fromHeader);

  const fromMessage = parseRateLimitMessageWaitMs(parsed, text);
  if (fromMessage != null) return Math.max(1000, fromMessage);

  return DEFAULT_BILLING_RATE_WAIT_MS;
}

function setBillingCooldown(state, path, waitMs) {
  if (!isBillingPath(path)) return;
  const key = getBillingCooldownKey(state);
  const cooldown = Date.now() + Math.max(1000, Number(waitMs) || DEFAULT_BILLING_RATE_WAIT_MS);
  BILLING_COOLDOWN_UNTIL.set(key, cooldown);
}

function cloneCachedPayload(payload) {
  if (payload == null) return payload;
  if (typeof globalThis.structuredClone === "function") {
    return globalThis.structuredClone(payload);
  }
  return JSON.parse(JSON.stringify(payload));
}

function resolveResponseCacheTtlMs(path, explicitTtlMs = null) {
  if (explicitTtlMs != null) {
    const parsed = Number(explicitTtlMs);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }

  const normalizedPath = String(path || "");
  if (normalizedPath.startsWith("/billing/integration/monthly/periods")) {
    return 1000 * 60 * 10;
  }
  if (
    normalizedPath.startsWith("/billing/integration/reports/") &&
    normalizedPath.endsWith("/status")
  ) {
    return 1000 * 15;
  }
  if (normalizedPath.startsWith("/billing/integration/periods/key/")) {
    return 1000 * 60 * 2;
  }
  if (normalizedPath.startsWith("/billing/integration/group/")) {
    return 1000 * 60 * 2;
  }
  if (normalizedPath.startsWith("/orders/search")) {
    return 1000 * 45;
  }
  if (normalizedPath.startsWith("/orders/")) {
    return 1000 * 60;
  }
  if (normalizedPath.startsWith("/shipments/")) {
    return 1000 * 60;
  }
  if (normalizedPath === "/users/me") {
    return 1000 * 60 * 2;
  }
  return 1000 * 45;
}

function getResponseCacheAccountKey(state) {
  return getBillingCooldownKey(state);
}

function buildResponseCacheKey(state, method, url) {
  const account = getResponseCacheAccountKey(state);
  return `${account}|${method}|${url}`;
}

function pruneResponseCache() {
  if (RESPONSE_CACHE.size <= RESPONSE_CACHE_MAX_ENTRIES) return;

  const entries = Array.from(RESPONSE_CACHE.entries()).sort((a, b) => {
    return Number(a[1]?.createdAt || 0) - Number(b[1]?.createdAt || 0);
  });

  const toDelete = Math.max(0, RESPONSE_CACHE.size - RESPONSE_CACHE_MAX_ENTRIES);
  for (let i = 0; i < toDelete; i += 1) {
    RESPONSE_CACHE.delete(entries[i][0]);
  }
}

function getCachedResponse(cacheKey) {
  const cached = RESPONSE_CACHE.get(cacheKey);
  if (!cached) return null;
  if (Date.now() > Number(cached.expiresAt || 0)) {
    RESPONSE_CACHE.delete(cacheKey);
    return null;
  }
  return cloneCachedPayload(cached.payload);
}

function setCachedResponse(cacheKey, payload, ttlMs) {
  const ttl = Math.max(0, Number(ttlMs) || 0);
  if (ttl <= 0) return;

  RESPONSE_CACHE.set(cacheKey, {
    createdAt: Date.now(),
    expiresAt: Date.now() + ttl,
    payload: cloneCachedPayload(payload),
  });
  pruneResponseCache();
}

function clearResponseCacheForAccount(state) {
  const account = getResponseCacheAccountKey(state);
  const prefix = `${account}|`;
  for (const key of RESPONSE_CACHE.keys()) {
    if (key.startsWith(prefix)) RESPONSE_CACHE.delete(key);
  }
}

async function buildHttpError(response, url) {
  const text = await response.text().catch(() => "");
  const parsed = parseJsonSafe(text);
  const message =
    parsed?.message ||
    parsed?.error_description ||
    parsed?.error ||
    text ||
    `Mercado Livre API returned ${response.status}`;
  return createHttpError(response.status, message, url, parsed || text || null);
}

async function prepareAuth(context = {}) {
  const creds =
    context?.mlCreds && typeof context.mlCreds === "object"
      ? { ...context.mlCreds }
      : {};

  if (!creds.account_key && context.accountKey) {
    creds.account_key = context.accountKey;
  }

  const token = await TokenService.renovarTokenSeNecessario(creds);
  return { token, creds };
}

async function requestMl(state, path, options = {}) {
  const {
    method = "GET",
    query = {},
    body = null,
    headers = {},
    expectBinary = false,
    retry401 = true,
    retry429 = 2,
    useCache = true,
    cacheTtlMs = null,
  } = options;

  const normalizedMethod = String(method || "GET").trim().toUpperCase();
  await waitBillingCooldown(state, path);

  const url = buildUrl(path, query);
  const isCacheableGet =
    useCache &&
    normalizedMethod === "GET" &&
    !expectBinary &&
    body == null;
  const ttlMs = isCacheableGet
    ? resolveResponseCacheTtlMs(path, cacheTtlMs)
    : 0;
  const cacheKey =
    isCacheableGet && ttlMs > 0
      ? buildResponseCacheKey(state, normalizedMethod, url)
      : null;

  if (cacheKey) {
    const cached = getCachedResponse(cacheKey);
    if (cached != null) return cached;

    const inflight = RESPONSE_INFLIGHT.get(cacheKey);
    if (inflight) {
      const shared = await inflight;
      return cloneCachedPayload(shared);
    }
  }

  const mergedHeaders = {
    accept: "application/json",
    "x-format-new": "true",
    Authorization: `Bearer ${state.token}`,
    ...headers,
  };

  let payloadBody = body;
  if (
    body != null &&
    typeof body === "object" &&
    !Buffer.isBuffer(body) &&
    typeof body.pipe !== "function"
  ) {
    payloadBody = JSON.stringify(body);
    if (!mergedHeaders["content-type"] && !mergedHeaders["Content-Type"]) {
      mergedHeaders["content-type"] = "application/json";
    }
  }

  const execute = async () => {
    const response = await fetch(url, {
      method: normalizedMethod,
      headers: mergedHeaders,
      body: payloadBody,
    });

    if (response.status === 401 && retry401) {
      const refreshed = await TokenService.renovarToken(state.creds);
      state.token = refreshed.access_token;
      return requestMl(state, path, {
        ...options,
        retry401: false,
        useCache: false,
      });
    }

    if (response.status === 429) {
      const text = await response.text().catch(() => "");
      const parsed = parseJsonSafe(text);
      const waitMs = resolveRateLimitWaitMs(response, parsed, text);
      setBillingCooldown(state, path, waitMs);

      if (retry429 > 0) {
        await sleep(waitMs);
        return requestMl(state, path, {
          ...options,
          retry429: retry429 - 1,
          useCache: false,
        });
      }

      const message =
        parsed?.message ||
        parsed?.error_description ||
        parsed?.error ||
        text ||
        "Rate limit exceeded.";
      throw createHttpError(429, message, url, parsed || text || null);
    }

    if (!response.ok) {
      throw await buildHttpError(response, url);
    }

    if (expectBinary) {
      const contentType =
        response.headers.get("content-type") || "application/octet-stream";
      const contentDisposition = response.headers.get("content-disposition") || "";
      const filename = parseFileNameFromDisposition(contentDisposition);
      const buffer = Buffer.from(await response.arrayBuffer());

      if (String(contentType).toLowerCase().includes("application/json")) {
        const decoded = buffer.toString("utf8");
        return {
          isJson: true,
          data: parseJsonSafe(decoded) || { raw: decoded },
          contentType,
          filename,
        };
      }

      return {
        isJson: false,
        buffer,
        contentType,
        filename,
        contentDisposition,
      };
    }

    const text = await response.text();
    if (!text) return {};
    return parseJsonSafe(text) || { raw: text };
  };

  if (!cacheKey) {
    const payload = await execute();
    if (normalizedMethod !== "GET") {
      clearResponseCacheForAccount(state);
    }
    return payload;
  }

  const task = execute();
  RESPONSE_INFLIGHT.set(cacheKey, task);
  try {
    const payload = await task;
    setCachedResponse(cacheKey, payload, ttlMs);
    return cloneCachedPayload(payload);
  } finally {
    if (RESPONSE_INFLIGHT.get(cacheKey) === task) {
      RESPONSE_INFLIGHT.delete(cacheKey);
    }
  }
}

async function fetchSeller(state) {
  const payload = await requestMl(state, "/users/me");
  return {
    user_id: maybeNumber(payload?.id),
    nickname: payload?.nickname || null,
    site_id: payload?.site_id || "MLB",
  };
}

async function resolveUserId(state, context = {}, explicitUserId = null) {
  const byParam = maybeNumber(explicitUserId);
  if (byParam) return byParam;

  const byCreds = maybeNumber(context?.mlCreds?.meli_user_id);
  if (byCreds) return byCreds;

  const seller = await fetchSeller(state);
  if (!seller.user_id) {
    throw createHttpError(
      400,
      "Nao foi possivel identificar o user_id da conta ativa.",
      "/users/me",
    );
  }
  return seller.user_id;
}

async function fetchOrderById(state, orderId) {
  if (!orderId) return null;
  try {
    const order = await requestMl(state, `/orders/${orderId}`);
    return order?.id ? order : null;
  } catch {
    return null;
  }
}

async function fetchOrdersByIds(state, orderIds = [], concurrency = 6) {
  const normalized = parseIds(orderIds);
  if (!normalized.length) return [];

  const fetched = await mapWithConcurrency(normalized, concurrency, async (id) =>
    fetchOrderById(state, id)
  );
  return fetched.filter(Boolean);
}

function orderTotalAmount(order) {
  return toNumber(
    pick(
      order,
      "total_amount",
      "payments_summary.total_paid_amount",
      "payments_summary.total_amount",
    ),
  );
}

function getShipmentId(order) {
  const shipmentId = pick(order, "shipping.id", "shipping.shipment_id");
  if (shipmentId == null) return null;
  const normalized = String(shipmentId).trim();
  return normalized || null;
}

function normalizeShippingMode(detail = {}) {
  const candidates = [
    pick(detail, "logistic.mode"),
    pick(detail, "mode"),
    pick(detail, "shipping_mode"),
    pick(detail, "shipping.mode"),
  ];

  for (const candidate of candidates) {
    const normalized = String(candidate || "")
      .trim()
      .toLowerCase();
    if (normalized) return normalized;
  }
  return "";
}

function extractOrderItemIds(order = {}) {
  const items = Array.isArray(order?.order_items) ? order.order_items : [];
  const ids = [];

  for (const entry of items) {
    const id = String(pick(entry, "item.id") || "")
      .trim()
      .toUpperCase();
    if (id) ids.push(id);
  }

  return Array.from(new Set(ids));
}

function extractBuyerName(order = {}) {
  const first = String(pick(order, "buyer.first_name") || "").trim();
  const last = String(pick(order, "buyer.last_name") || "").trim();
  const nickname = String(pick(order, "buyer.nickname") || "").trim();

  const full = `${first} ${last}`.trim();
  if (full) return full;
  if (nickname) return nickname;

  const buyerId = String(pick(order, "buyer.id") || "").trim();
  if (buyerId) return `Comprador ${buyerId}`;
  return "Nao identificado";
}

function normalizeDateField(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  return parsed.toISOString();
}

function normalizeLogisticType(detail = {}) {
  const candidates = [
    pick(detail, "logistic.type"),
    pick(detail, "logistic_type"),
    pick(detail, "shipping_option.logistic_type"),
    pick(detail, "shipping_mode"),
  ];

  for (const candidate of candidates) {
    const normalized = String(candidate || "")
      .trim()
      .toLowerCase();
    if (normalized) return normalized;
  }
  return "";
}

function summarizeDocuments(documents = []) {
  return documents.map((document) => ({
    document_id: String(
      document?.document_id ?? document?.id ?? document?.file_id ?? "",
    ).trim(),
    type: document?.type || document?.document_type || null,
    status: document?.status || document?.document_status || null,
    date_created:
      document?.date_created ||
      document?.creation_date ||
      document?.created_at ||
      null,
    amount: maybeNumber(document?.amount),
    currency_id: document?.currency_id || null,
    raw: document,
  }));
}

function totalAmountFromSummary(summaryPayload) {
  const candidates = [
    maybeNumber(summaryPayload?.bill_includes?.total_amount),
    maybeNumber(summaryPayload?.total_amount),
    maybeNumber(summaryPayload?.summary?.total_amount),
    maybeNumber(summaryPayload?.data?.total_amount),
  ].filter((value) => value != null);

  if (candidates.length) return candidates[0];

  const charges = Array.isArray(summaryPayload?.bill_includes?.charges)
    ? summaryPayload.bill_includes.charges
    : [];
  if (charges.length) {
    return charges.reduce((sum, charge) => sum + toNumber(charge?.amount), 0);
  }

  const rows = extractRows(summaryPayload);
  if (rows.length) {
    return rows.reduce((sum, row) => sum + extractDetailAmount(row), 0);
  }

  return 0;
}

function ensureMonitorBag(accountKey = "default") {
  const key = String(accountKey || "default");
  if (!MONITOR_STORE.has(key)) {
    MONITOR_STORE.set(key, {
      reports: new Map(),
      invoices: new Map(),
    });
  }
  return MONITOR_STORE.get(key);
}

function trackReport(accountKey, fileId, metadata = {}) {
  if (!fileId) return;
  const bag = ensureMonitorBag(accountKey);
  bag.reports.set(String(fileId), {
    file_id: String(fileId),
    tracked_at: new Date().toISOString(),
    ...metadata,
  });
}

function trackInvoice(accountKey, invoiceId, metadata = {}) {
  if (!invoiceId) return;
  const bag = ensureMonitorBag(accountKey);
  bag.invoices.set(String(invoiceId), {
    invoice_id: String(invoiceId),
    tracked_at: new Date().toISOString(),
    ...metadata,
  });
}

function listTrackedIds(accountKey, kind) {
  const bag = ensureMonitorBag(accountKey);
  if (kind === "reports") return Array.from(bag.reports.keys());
  if (kind === "invoices") return Array.from(bag.invoices.keys());
  return [];
}

async function fetchOrdersSearchPaid(state, params = {}) {
  const sellerId = maybeNumber(params.seller_id);
  if (!sellerId) {
    throw createHttpError(
      400,
      "seller_id nao informado para consulta de pedidos.",
      "/orders/search",
    );
  }

  const range = normalizeDateRange(params, 30);
  const dateField =
    String(params.date_field || "closed").trim().toLowerCase() === "created"
      ? "created"
      : "closed";

  const maxOrders = Math.max(
    1,
    Math.min(1000, Number(params.max_orders) || 250),
  );
  const pageSize = 50;
  const output = [];
  let offset = 0;
  let totalPaidAvailable = 0;

  while (output.length < maxOrders) {
    const query = {
      seller: String(sellerId),
      "order.status": "paid",
      sort: "date_desc",
      limit: String(pageSize),
      offset: String(offset),
      [dateField === "created"
        ? "order.date_created.from"
        : "order.date_closed.from"]: `${range.date_from}T00:00:00.000-03:00`,
      [dateField === "created"
        ? "order.date_created.to"
        : "order.date_closed.to"]: `${range.date_to}T23:59:59.999-03:00`,
    };

    const payload = await requestMl(state, "/orders/search", { query });
    const rows = Array.isArray(payload?.results) ? payload.results : [];
    totalPaidAvailable = Math.max(
      totalPaidAvailable,
      toNumber(payload?.paging?.total, 0),
    );
    output.push(...rows);

    offset += rows.length;
    const total = toNumber(payload?.paging?.total, 0);
    if (!rows.length || rows.length < pageSize || offset >= total) break;
  }

  const normalizedTotal =
    totalPaidAvailable > 0 ? totalPaidAvailable : output.length;
  const limitedOrders = output.slice(0, maxOrders);
  return {
    orders: limitedOrders,
    total_paid_available: normalizedTotal,
    capped_by_max_orders: normalizedTotal > limitedOrders.length,
  };
}

class FiscalService {
  static async dashboard(params = {}, context = {}) {
    const state = await prepareAuth(context);
    const limit = Math.max(1, Math.min(12, Number(params.limit) || 6));
    const keyInput = parseDateOnly(params.key);
    const documentType =
      String(params.document_type || "BILL").trim().toUpperCase() || "BILL";
    const includeDetails = isTruthy(params.include_details ?? false);
    const forcePeriods = isTruthy(params.force_periods ?? false);
    const periodGroup = String(params.period_group || "ML").trim().toUpperCase();
    const normalizedPeriodGroup = ["ML", "MP"].includes(periodGroup)
      ? periodGroup
      : null;

    let periods = [];
    if (!keyInput || forcePeriods) {
      const periodsPayload = await requestMl(
        state,
        "/billing/integration/monthly/periods",
        {
          query: {
            limit: String(limit),
            document_type: documentType,
            group: normalizedPeriodGroup,
          },
        },
      );
      periods = extractRows(periodsPayload);
    }

    const detectedKey =
      keyInput ||
      periods.find((period) => parseDateOnly(period?.key))?.key ||
      firstDayOfCurrentMonth();

    const key = normalizePeriodKey(detectedKey);
    const summaryML = await requestMl(
      state,
      `/billing/integration/periods/key/${encodeURIComponent(key)}/summary/details`,
      { query: { group: "ML", document_type: documentType } },
    );
    const summaryMP = await requestMl(
      state,
      `/billing/integration/periods/key/${encodeURIComponent(key)}/summary/details`,
      { query: { group: "MP", document_type: documentType } },
    );
    const documentsML = await requestMl(
      state,
      `/billing/integration/periods/key/${encodeURIComponent(key)}/documents`,
      { query: { group: "ML", limit: "200", document_type: documentType } },
    );
    const documentsMP = await requestMl(
      state,
      `/billing/integration/periods/key/${encodeURIComponent(key)}/documents`,
      { query: { group: "MP", limit: "200", document_type: documentType } },
    );

    let rowsML = [];
    let rowsMP = [];
    if (includeDetails) {
      const detailsML = await requestMl(
        state,
        `/billing/integration/periods/key/${encodeURIComponent(key)}/group/ML/details`,
        { query: { limit: "500", document_type: documentType } },
      );
      const detailsMP = await requestMl(
        state,
        `/billing/integration/periods/key/${encodeURIComponent(key)}/group/MP/details`,
        { query: { limit: "500", document_type: documentType } },
      );
      rowsML = extractRows(detailsML);
      rowsMP = extractRows(detailsMP);
    }

    const docsML = summarizeDocuments(extractDocuments(documentsML));
    const docsMP = summarizeDocuments(extractDocuments(documentsMP));

    const pendingDetailsCount = includeDetails
      ? (
      rowsML.filter(isPendingLegalDocument).length +
      rowsMP.filter(isPendingLegalDocument).length
      )
      : 0;
    const pendingDocsCount =
      docsML.filter((doc) => String(doc.status || "").toUpperCase().includes("PENDING"))
        .length +
      docsMP.filter((doc) => String(doc.status || "").toUpperCase().includes("PENDING"))
        .length;

    const divergenceCount = includeDetails
      ? (
      rowsML.filter(hasDivergenceSignal).length +
      rowsMP.filter(hasDivergenceSignal).length
      )
      : 0;

    return {
      success: true,
      key,
      periods,
      document_type: documentType,
      include_details: includeDetails,
      cards: {
        total_ml: totalAmountFromSummary(summaryML),
        total_mp: totalAmountFromSummary(summaryMP),
        documentos_gerados: docsML.length + docsMP.length,
        pendencias: pendingDetailsCount + pendingDocsCount,
        divergencias: divergenceCount,
      },
      summary: {
        ML: summaryML,
        MP: summaryMP,
      },
      details: {
        ML: rowsML,
        MP: rowsMP,
      },
      documents: {
        ML: docsML,
        MP: docsMP,
      },
    };
  }

  static async reconcilePeriod(params = {}, context = {}) {
    const state = await prepareAuth(context);
    const key = normalizePeriodKey(params.key);
    const group =
      String(params.group || "ML").trim().toUpperCase() === "MP" ? "MP" : "ML";
    const includeOrders = isTruthy(params.include_orders ?? true);
    const tolerance = Math.max(0, Number(params.tolerance) || 0.05);
    const limit = Math.max(1, Math.min(1000, Number(params.limit) || 500));
    const offset = Math.max(0, Number(params.offset) || 0);
    const documentType =
      String(params.document_type || "BILL").trim().toUpperCase() || "BILL";

    const documentsPayload = await requestMl(
      state,
      `/billing/integration/periods/key/${encodeURIComponent(key)}/documents`,
      {
        query: {
          group,
          limit: String(Math.min(limit, 200)),
          offset: String(offset),
          document_type: documentType,
        },
      },
    );

    const detailsPayload = await requestMl(
      state,
      `/billing/integration/periods/key/${encodeURIComponent(key)}/group/${group}/details`,
      {
        query: {
          limit: String(limit),
          offset: String(offset),
          document_type: documentType,
          from_id: params.from_id,
          sort_by: params.sort_by,
          order_by: params.order_by,
          date_sort: params.date_sort,
          detail_type: params.detail_type,
          detail_sub_types: params.detail_sub_types,
          marketplace_type: params.marketplace_type,
          order_ids: params.order_ids,
          item_ids: params.item_ids,
          document_ids: params.document_ids,
          detail_ids: params.detail_ids,
        },
      },
    );

    const details = extractRows(detailsPayload);
    const documents = summarizeDocuments(extractDocuments(documentsPayload));

    const agg = new Map();
    for (const detail of details) {
      const orderId = extractOrderIdFromDetail(detail);
      const keyId = orderId || `sem_order_${extractDocumentId(detail) || Math.random()}`;

      if (!agg.has(keyId)) {
        agg.set(keyId, {
          order_id: orderId,
          billing_amount: 0,
          detail_count: 0,
          document_ids: new Set(),
          pending_legal_document: false,
          divergence_signal: false,
          sample_detail: detail,
        });
      }

      const current = agg.get(keyId);
      current.billing_amount += extractDetailAmount(detail);
      current.detail_count += 1;
      const docId = extractDocumentId(detail);
      if (docId) current.document_ids.add(docId);
      current.pending_legal_document =
        current.pending_legal_document || isPendingLegalDocument(detail);
      current.divergence_signal =
        current.divergence_signal || hasDivergenceSignal(detail);
    }

    const orderIds = Array.from(agg.values())
      .map((entry) => entry.order_id)
      .filter(Boolean);

    let ordersMap = new Map();
    if (includeOrders && orderIds.length) {
      const fetchedOrders = await fetchOrdersByIds(state, orderIds, 6);
      ordersMap = new Map(fetchedOrders.map((order) => [String(order.id), order]));
    }

    const rows = Array.from(agg.values()).map((entry) => {
      const order = entry.order_id ? ordersMap.get(String(entry.order_id)) : null;
      const orderAmount = order ? orderTotalAmount(order) : null;
      const delta =
        orderAmount == null ? null : Number((entry.billing_amount - orderAmount).toFixed(2));
      const isDivergent = delta != null ? Math.abs(delta) > tolerance : false;

      let status = "ok";
      if (!entry.order_id) status = "sem_order_id";
      else if (includeOrders && !order) status = "pedido_nao_encontrado";
      else if (isDivergent) status = "valor_divergente";
      else if (entry.pending_legal_document) status = "pendente";
      else if (entry.divergence_signal) status = "sinal_divergencia";

      return {
        order_id: entry.order_id,
        billing_amount: Number(entry.billing_amount.toFixed(2)),
        order_amount: orderAmount == null ? null : Number(orderAmount.toFixed(2)),
        delta,
        detail_count: entry.detail_count,
        document_ids: Array.from(entry.document_ids),
        pending_legal_document: entry.pending_legal_document,
        divergence_signal: entry.divergence_signal,
        status,
        order_status: order?.status || null,
        order_date_created: order?.date_created || null,
        order_date_closed: order?.date_closed || null,
      };
    });

    rows.sort((a, b) => {
      const deltaA = Math.abs(toNumber(a.delta));
      const deltaB = Math.abs(toNumber(b.delta));
      if (deltaB !== deltaA) return deltaB - deltaA;
      return String(a.order_id || "").localeCompare(String(b.order_id || ""));
    });

    const summary = {
      total_details: details.length,
      total_rows: rows.length,
      total_documents: documents.length,
      total_billing_amount: Number(
        rows.reduce((sum, row) => sum + toNumber(row.billing_amount), 0).toFixed(2),
      ),
      pedidos_sem_nota: rows.filter((row) => row.status === "pedido_nao_encontrado")
        .length,
      pendencias: rows.filter((row) => row.status === "pendente").length,
      divergencias: rows.filter((row) =>
        ["valor_divergente", "sinal_divergencia"].includes(row.status)
      ).length,
    };

    return {
      success: true,
      key,
      group,
      include_orders: includeOrders,
      tolerance,
      summary,
      documents,
      rows,
    };
  }

  static async listDocuments(params = {}, context = {}) {
    const state = await prepareAuth(context);
    const key = normalizePeriodKey(params.key);
    const group = String(params.group || "ML").trim().toUpperCase() || "ML";
    const limit = Math.max(1, Math.min(200, Number(params.limit) || 100));
    const offset = Math.max(0, Number(params.offset) || 0);
    const documentType =
      String(params.document_type || "BILL").trim().toUpperCase() || "BILL";

    const payload = await requestMl(
      state,
      `/billing/integration/periods/key/${encodeURIComponent(key)}/documents`,
      {
        query: {
          group,
          limit: String(limit),
          offset: String(offset),
          document_type: documentType,
          document_id: params.document_id,
          from_id: params.from_id,
        },
      },
    );

    const documents = summarizeDocuments(extractDocuments(payload));
    return {
      success: true,
      key,
      group,
      documents,
      paging: payload?.paging || null,
      raw: payload,
    };
  }

  static async perceptionsDetails(params = {}, context = {}) {
    const state = await prepareAuth(context);
    const group = String(params.group || "MP").trim().toUpperCase() === "ML" ? "ML" : "MP";
    const limit = Math.max(1, Math.min(1000, Number(params.limit) || 150));
    const offset = Math.max(0, Number(params.offset) || 0);

    const payload = await requestMl(
      state,
      `/billing/integration/group/${group}/perceptions/details`,
      {
        query: {
          document_id: params.document_id,
          tax_type: params.tax_type,
          tax_id: params.tax_id,
          currency: params.currency,
          offset: String(offset),
          limit: String(limit),
        },
      },
    );

    return {
      success: true,
      group,
      offset,
      limit,
      total: toNumber(payload?.total, extractRows(payload).length),
      rows: extractRows(payload),
      errors: Array.isArray(payload?.errors) ? payload.errors : [],
      raw: payload,
    };
  }

  static async downloadLegalDocument(fileId, context = {}) {
    const state = await prepareAuth(context);
    if (!String(fileId || "").trim()) {
      throw createHttpError(400, "file_id e obrigatorio.", "/billing/integration/legal_document");
    }

    return requestMl(
      state,
      `/billing/integration/legal_document/${encodeURIComponent(String(fileId))}`,
      { expectBinary: true, headers: { accept: "*/*" } },
    );
  }

  static async downloadOrderPdf(orderId, context = {}) {
    const state = await prepareAuth(context);
    if (!String(orderId || "").trim()) {
      throw createHttpError(
        400,
        "order_id e obrigatorio.",
        "/invoices/io/documents/stream/order",
      );
    }

    return requestMl(
      state,
      `/invoices/io/documents/stream/order/${encodeURIComponent(String(orderId))}/pdf`,
      { expectBinary: true, headers: { accept: "*/*" } },
    );
  }

  static async orderBillingInfo(orderId, context = {}) {
    const state = await prepareAuth(context);
    if (!String(orderId || "").trim()) {
      throw createHttpError(
        400,
        "order_id e obrigatorio.",
        "/orders/{order_id}/billing_info",
      );
    }

    const payload = await requestMl(
      state,
      `/orders/${encodeURIComponent(String(orderId))}/billing_info`,
      {
        headers: {
          "x-version": "2",
        },
      },
    );

    return {
      success: true,
      order_id: String(orderId),
      billing_info: payload,
    };
  }

  static async issueManualInvoice(params = {}, context = {}) {
    const state = await prepareAuth(context);
    const userId = await resolveUserId(state, context, params.user_id);
    const payloadBody = params.body && typeof params.body === "object" ? params.body : {};

    const payload = await requestMl(
      state,
      `/users/${encodeURIComponent(String(userId))}/invoices/orders`,
      {
        method: "POST",
        body: payloadBody,
      },
    );

    const invoiceId = String(
      payload?.id || payload?.invoice_id || payload?.invoice?.id || "",
    ).trim();
    trackInvoice(context?.accountKey, invoiceId, {
      source: "manual_issue",
      user_id: userId,
    });

    return {
      success: true,
      user_id: userId,
      invoice_id: invoiceId || null,
      payload,
    };
  }

  static async getInvoiceById(params = {}, context = {}) {
    const state = await prepareAuth(context);
    const invoiceId = String(params.invoice_id || "").trim();
    if (!invoiceId) {
      throw createHttpError(
        400,
        "invoice_id e obrigatorio.",
        "/users/{user_id}/invoices/{invoice_id}",
      );
    }

    const userId = await resolveUserId(state, context, params.user_id);
    const payload = await requestMl(
      state,
      `/users/${encodeURIComponent(String(userId))}/invoices/${encodeURIComponent(invoiceId)}`,
    );

    return {
      success: true,
      user_id: userId,
      invoice_id: invoiceId,
      payload,
    };
  }

  static async getInvoiceByOrder(params = {}, context = {}) {
    const state = await prepareAuth(context);
    const orderId = String(params.order_id || "").trim();
    if (!orderId) {
      throw createHttpError(
        400,
        "order_id e obrigatorio.",
        "/users/{user_id}/invoices/orders/{order_id}",
      );
    }

    const userId = await resolveUserId(state, context, params.user_id);
    const payload = await requestMl(
      state,
      `/users/${encodeURIComponent(String(userId))}/invoices/orders/${encodeURIComponent(orderId)}`,
    );

    const invoiceId = String(
      payload?.id || payload?.invoice_id || payload?.invoice?.id || "",
    ).trim();
    trackInvoice(context?.accountKey, invoiceId, {
      source: "order_lookup",
      order_id: orderId,
      user_id: userId,
    });

    return {
      success: true,
      user_id: userId,
      order_id: orderId,
      payload,
    };
  }

  static async getInvoiceByShipment(params = {}, context = {}) {
    const state = await prepareAuth(context);
    const shipmentId = String(params.shipment_id || "").trim();
    if (!shipmentId) {
      throw createHttpError(
        400,
        "shipment_id e obrigatorio.",
        "/users/{user_id}/invoices/shipments/{shipment_id}",
      );
    }

    const userId = await resolveUserId(state, context, params.user_id);
    const payload = await requestMl(
      state,
      `/users/${encodeURIComponent(String(userId))}/invoices/shipments/${encodeURIComponent(shipmentId)}`,
    );

    return {
      success: true,
      user_id: userId,
      shipment_id: shipmentId,
      payload,
    };
  }

  static async createReconciliationReport(params = {}, context = {}) {
    const state = await prepareAuth(context);
    const key = normalizePeriodKey(params.key);
    const group = String(params.group || "").trim().toUpperCase() || null;
    const body = params.body && typeof params.body === "object" ? params.body : {};

    const payload = await requestMl(
      state,
      `/billing/integration/periods/key/${encodeURIComponent(key)}/reports`,
      {
        method: "POST",
        query: { group },
        body,
      },
    );

    const fileId = String(
      payload?.file_id || payload?.id || payload?.report_id || "",
    ).trim();
    trackReport(context?.accountKey, fileId, {
      key,
      group: group || null,
      source: "report_create",
    });

    return {
      success: true,
      key,
      group,
      file_id: fileId || null,
      payload,
    };
  }

  static async reportStatus(fileId, context = {}) {
    const state = await prepareAuth(context);
    const normalized = String(fileId || "").trim();
    if (!normalized) {
      throw createHttpError(
        400,
        "file_id e obrigatorio.",
        "/billing/integration/reports/{file_id}/status",
      );
    }

    const payload = await requestMl(
      state,
      `/billing/integration/reports/${encodeURIComponent(normalized)}/status`,
    );

    trackReport(context?.accountKey, normalized, {
      source: "status_poll",
      last_status: payload?.status || payload?.state || null,
    });

    return {
      success: true,
      file_id: normalized,
      payload,
    };
  }

  static async downloadReport(fileId, context = {}) {
    const state = await prepareAuth(context);
    const normalized = String(fileId || "").trim();
    if (!normalized) {
      throw createHttpError(
        400,
        "file_id e obrigatorio.",
        "/billing/integration/reports/{file_id}",
      );
    }

    return requestMl(
      state,
      `/billing/integration/reports/${encodeURIComponent(normalized)}`,
      {
        expectBinary: true,
        headers: { accept: "*/*" },
      },
    );
  }

  static async monitor(params = {}, context = {}) {
    const state = await prepareAuth(context);
    const accountKey = String(context?.accountKey || "default");
    const reportIds = Array.from(
      new Set([
        ...listTrackedIds(accountKey, "reports"),
        ...parseIds(params.report_ids),
      ]),
    );
    const invoiceIds = Array.from(
      new Set([
        ...listTrackedIds(accountKey, "invoices"),
        ...parseIds(params.invoice_ids),
      ]),
    );

    const userId = await resolveUserId(state, context, params.user_id).catch(
      () => null,
    );

    const reports = await mapWithConcurrency(reportIds, 4, async (fileId) => {
      try {
        const status = await this.reportStatus(fileId, context);
        return {
          file_id: fileId,
          success: true,
          status: status?.payload?.status || status?.payload?.state || "unknown",
          payload: status.payload,
        };
      } catch (error) {
        return {
          file_id: fileId,
          success: false,
          error: error?.message || "Falha ao consultar status do relatorio.",
        };
      }
    });

    const invoices = await mapWithConcurrency(invoiceIds, 4, async (invoiceId) => {
      try {
        if (!userId) throw new Error("user_id nao disponivel para consultar invoices.");
        const payload = await requestMl(
          state,
          `/users/${encodeURIComponent(String(userId))}/invoices/${encodeURIComponent(invoiceId)}`,
        );

        return {
          invoice_id: invoiceId,
          success: true,
          status: payload?.status || payload?.state || "unknown",
          payload,
        };
      } catch (error) {
        return {
          invoice_id: invoiceId,
          success: false,
          error: error?.message || "Falha ao consultar invoice.",
        };
      }
    });

    return {
      success: true,
      summary: {
        reports_total: reports.length,
        reports_error: reports.filter((entry) => !entry.success).length,
        invoices_total: invoices.length,
        invoices_error: invoices.filter((entry) => !entry.success).length,
      },
      reports,
      invoices,
    };
  }

  static async sales(params = {}, context = {}) {
    const state = await prepareAuth(context);
    const range = normalizeDateRange(params, 30);
    const maxOrders = Math.max(1, Math.min(1000, Number(params.max_orders) || 250));

    const seller = await fetchSeller(state);
    const ordersPayload = await fetchOrdersSearchPaid(state, {
      seller_id: seller.user_id,
      date_from: range.date_from,
      date_to: range.date_to,
      max_orders: maxOrders,
      date_field: params.date_field,
    });

    const orders = Array.isArray(ordersPayload?.orders) ? ordersPayload.orders : [];
    const totalPaidAvailable = toNumber(
      ordersPayload?.total_paid_available,
      orders.length,
    );
    const cappedByMaxOrders = !!ordersPayload?.capped_by_max_orders;

    const rows = await mapWithConcurrency(orders, 5, async (order) => {
      const orderId = String(order?.id || "").trim() || null;
      let shipmentId = getShipmentId(order);
      let shippingMode = normalizeShippingMode(order);
      let logisticType = normalizeLogisticType(order);
      const buyerName = extractBuyerName(order);
      const mlbList = extractOrderItemIds(order);
      const dataHoraVenda = normalizeDateField(
        pick(order, "date_closed", "date_created", "last_updated"),
      );

      let cepOrigem = null;
      let cepDestino = null;
      let prazoPrometidoVenda = null;
      let prazoFabricacao = normalizeDateField(
        pick(order, "manufacturing_ending_date"),
      );
      let prazoDespacho = null;
      let statusSlaDespacho = null;
      let servicoSlaDespacho = null;
      let slaLastUpdated = null;
      let fontePrazoDespacho = null;
      let prazoTransportadoraMe1 = null;
      let prazoColetasMe2 = null;

      if (!shipmentId && orderId) {
        const orderShipment = await requestMl(
          state,
          `/orders/${encodeURIComponent(orderId)}/shipments`,
          { headers: { "x-format-new": "true" } },
        ).catch(() => null);

        if (orderShipment) {
          const fallbackShipmentId = String(orderShipment?.id || "").trim();
          if (fallbackShipmentId) shipmentId = fallbackShipmentId;
          shippingMode = normalizeShippingMode(orderShipment) || shippingMode;
          logisticType = normalizeLogisticType(orderShipment) || logisticType;
        }
      }

      if (shipmentId) {
        const shipment = await requestMl(
          state,
          `/shipments/${encodeURIComponent(shipmentId)}`,
          { headers: { "x-format-new": "true" } },
        ).catch(() => null);

        if (shipment) {
          shippingMode = normalizeShippingMode(shipment) || shippingMode;
          logisticType = normalizeLogisticType(shipment) || logisticType;
          cepOrigem = String(
            pick(
              shipment,
              "origin.shipping_address.zip_code",
              "sender_address.zip_code",
            ) || "",
          ).trim() || null;
          cepDestino = String(
            pick(
              shipment,
              "destination.shipping_address.zip_code",
              "receiver_address.zip_code",
            ) || "",
          ).trim() || null;
        }

        const shouldConsultSla =
          String(shipment?.status || "").toLowerCase() !== "cancelled" &&
          String(logisticType || "").toLowerCase() !== "fulfillment";

        const sla = shouldConsultSla
          ? await requestMl(
              state,
              `/shipments/${encodeURIComponent(shipmentId)}/sla`,
              { headers: { "x-format-new": "true" } },
            ).catch(() => null)
          : null;

        if (sla && typeof sla === "object") {
          prazoDespacho = normalizeDateField(pick(sla, "expected_date"));
          statusSlaDespacho = String(pick(sla, "status") || "").trim() || null;
          servicoSlaDespacho = String(pick(sla, "service") || "").trim() || null;
          slaLastUpdated = normalizeDateField(pick(sla, "last_updated"));
          if (prazoDespacho) fontePrazoDespacho = "sla";
        }

        let leadTime =
          shipment?.lead_time && typeof shipment.lead_time === "object"
            ? shipment.lead_time
            : null;
        if (!leadTime) {
          leadTime = await requestMl(
            state,
            `/shipments/${encodeURIComponent(shipmentId)}/lead_time`,
            { headers: { "x-format-new": "true" } },
          ).catch(() => null);
        }

        if (leadTime && typeof leadTime === "object") {
          prazoPrometidoVenda = normalizeDateField(
            pick(
              leadTime,
              "estimated_delivery_time.date",
              "estimated_delivery_final.date",
              "estimated_delivery_extended.date",
            ),
          );

          const handlingLimit = normalizeDateField(
            pick(leadTime, "estimated_handling_limit.date"),
          );
          if (!prazoFabricacao) prazoFabricacao = handlingLimit;
          if (!prazoDespacho && handlingLimit) {
            prazoDespacho = handlingLimit;
            fontePrazoDespacho = "lead_time_fallback";
          }

          const prazoEntregaTransportadora = normalizeDateField(
            pick(
              leadTime,
              "estimated_delivery_final.date",
              "estimated_delivery_extended.date",
              "estimated_delivery_limit.date",
              "estimated_delivery_time.date",
            ),
          );
          const prazoColeta = handlingLimit || normalizeDateField(
            pick(leadTime, "estimated_delivery_time.offset.date"),
          );

          if (shippingMode === "me1") {
            prazoTransportadoraMe1 =
              prazoEntregaTransportadora || prazoPrometidoVenda;
          } else if (shippingMode === "me2") {
            prazoColetasMe2 = prazoColeta || prazoPrometidoVenda;
          }
        }
      }

      if (!prazoDespacho && prazoFabricacao) {
        prazoDespacho = prazoFabricacao;
        fontePrazoDespacho = "pedido_fallback";
      }
      if (!prazoDespacho) {
        fontePrazoDespacho = "indisponivel";
      }

      if (!shippingMode && logisticType) {
        const me2Types = new Set(["cross_docking", "xd_drop_off", "drop_off", "fulfillment"]);
        if (me2Types.has(logisticType)) shippingMode = "me2";
      }

      if (shippingMode === "me1" && !prazoTransportadoraMe1) {
        prazoTransportadoraMe1 = prazoPrometidoVenda;
      }
      if (shippingMode === "me2" && !prazoColetasMe2) {
        prazoColetasMe2 = prazoFabricacao || prazoPrometidoVenda;
      }

      return {
        data_hora_venda: dataHoraVenda,
        nome_cliente: buyerName,
        numero_pedido: orderId,
        mlb: mlbList.join(", "),
        modelo_envio: shippingMode || null,
        cep_origem: cepOrigem,
        cep_destino: cepDestino,
        prazo_despacho: prazoDespacho,
        status_sla_despacho: statusSlaDespacho,
        servico_sla_despacho: servicoSlaDespacho,
        sla_last_updated: slaLastUpdated,
        fonte_prazo_despacho: fontePrazoDespacho,
        prazo_prometido_venda: prazoPrometidoVenda,
        prazo_fabricacao: prazoFabricacao,
        prazo_transportadora_me1: shippingMode === "me1" ? prazoTransportadoraMe1 : null,
        prazo_coletas_me2: shippingMode === "me2" ? prazoColetasMe2 : null,
        shipment_id: shipmentId || null,
        logistic_type: logisticType || null,
      };
    });

    const sortedRows = rows
      .filter(Boolean)
      .sort((a, b) => String(b.numero_pedido || "").localeCompare(String(a.numero_pedido || "")));

    const summary = {
      seller_id: seller.user_id,
      seller_nickname: seller.nickname,
      date_from: range.date_from,
      date_to: range.date_to,
      total_orders_paid_considered: orders.length,
      total_orders_paid_available: totalPaidAvailable,
      max_orders_applied: maxOrders,
      amostra_parcial: cappedByMaxOrders,
      total_linhas: sortedRows.length,
      total_me1: sortedRows.filter((row) => row.modelo_envio === "me1").length,
      total_me2: sortedRows.filter((row) => row.modelo_envio === "me2").length,
      total_sem_envio: sortedRows.filter((row) => !row.modelo_envio).length,
      total_sem_sla_despacho: sortedRows.filter(
        (row) => row.fonte_prazo_despacho === "indisponivel",
      ).length,
    };

    return {
      success: true,
      summary,
      rows: sortedRows,
    };
  }

}

module.exports = FiscalService;

