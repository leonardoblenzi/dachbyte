"use strict";

const _fetch = typeof fetch !== "undefined" ? fetch : require("node-fetch");
const fetchRef = (...args) => _fetch(...args);
const ML_API = "https://api.mercadolibre.com";
const MAX_CHANGES = 5000;
const VERIFY_ATTEMPTS = 4;
const VERIFY_DELAYS_MS = [0, 350, 700, 1100];

function getPrazoService() {
  return require("./prazoProducaoService");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function normMlb(value) {
  const text = String(value || "").trim().toUpperCase();
  return /^MLB\d{6,}$/.test(text) ? text : null;
}

function normalizeSku(value) {
  return String(value || "").trim().toUpperCase();
}

function toStock(value, fallback = null) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const stock = Math.trunc(n);
  return stock >= 0 ? stock : fallback;
}

function rowKey(mlb, variationId = null) {
  const id = normMlb(mlb);
  if (!id) return null;
  const variation = String(variationId || "").trim();
  return `${id}:${variation || "item"}`;
}

function normalizeRequestedChange(change = {}) {
  const mlb = normMlb(change.mlb || change.item_id);
  const variationId = String(change.variation_id || "").trim() || null;
  return {
    row_key: rowKey(mlb, variationId),
    mlb,
    variation_id: variationId,
    expected_current_stock: toStock(
      change.expected_current_stock ?? change.current_stock ?? change.currentStock,
      null,
    ),
    new_stock: toStock(change.new_stock ?? change.newStock, null),
  };
}

function extractSkuFromAttributes(attributes = []) {
  const row = (Array.isArray(attributes) ? attributes : []).find(
    (attr) => String(attr?.id || "").toUpperCase() === "SELLER_SKU",
  );
  return normalizeSku(row?.value_name || row?.value_id || "");
}

function extractItemSku(item = {}) {
  return normalizeSku(
    item.seller_custom_field ||
      item.seller_sku ||
      item.sku ||
      extractSkuFromAttributes(item.attributes) ||
      "",
  );
}

function extractVariationSku(variation = {}, item = {}) {
  return normalizeSku(
    variation.seller_custom_field ||
      variation.seller_sku ||
      variation.sku ||
      extractSkuFromAttributes(variation.attributes) ||
      extractItemSku(item) ||
      "",
  );
}

function variationLabel(variation = {}) {
  const values = (Array.isArray(variation.attribute_combinations)
    ? variation.attribute_combinations
    : [])
    .map((attr) => attr?.value_name || attr?.value_id || attr?.name)
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return values.join(" · ") || null;
}

function flattenItem(item = {}) {
  const mlb = normMlb(item.id);
  if (!mlb) return [];
  const variations = Array.isArray(item.variations) ? item.variations : [];
  const common = {
    mlb,
    title: String(item.title || mlb),
    item_status: String(item.status || "unknown"),
    permalink: item.permalink || null,
    logistic_type: item?.shipping?.logistic_type || null,
    user_product_id: item.user_product_id || null,
    inventory_id: item.inventory_id || null,
  };

  if (!variations.length) {
    return [{
      ...common,
      row_key: rowKey(mlb),
      target_type: "item",
      variation_id: null,
      variation_label: null,
      sku: extractItemSku(item) || null,
      current_stock: toStock(item.available_quantity, 0),
    }];
  }

  return variations.map((variation) => ({
    ...common,
    row_key: rowKey(mlb, variation?.id),
    target_type: "variation",
    variation_id: String(variation?.id || "").trim() || null,
    variation_label: variationLabel(variation),
    sku: extractVariationSku(variation, item) || null,
    current_stock: toStock(variation?.available_quantity, 0),
    inventory_id: variation?.inventory_id || item.inventory_id || null,
    user_product_id: variation?.user_product_id || item.user_product_id || null,
  }));
}

async function renewAuthState(state) {
  if (!state?.creds || !Object.keys(state.creds).length) return false;
  const TokenService = require("./tokenService");
  const renewed = await TokenService.renovarToken(state.creds);
  const token = renewed?.access_token || state.token;
  if (!token) return false;
  state.token = token;
  state.creds.access_token = token;
  if (renewed?.refresh_token) state.creds.refresh_token = renewed.refresh_token;
  return true;
}

async function authFetch(state, pathOrUrl, init = {}) {
  const url = /^https?:\/\//i.test(String(pathOrUrl || ""))
    ? String(pathOrUrl)
    : `${ML_API}${String(pathOrUrl || "")}`;
  const call = (token) => fetchRef(url, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });

  let response = await call(state.token);
  if (response.status !== 401) return response;
  if (!(await renewAuthState(state))) return response;
  return call(state.token);
}

async function requestJson(state, pathOrUrl, init = {}, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await authFetch(state, pathOrUrl, init);
    const raw = await response.text();
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = {};
    }
    if (response.ok) return { data, status: response.status, headers: response.headers };

    const retryable = response.status === 429 || response.status >= 500;
    const error = new Error(
      data?.message || data?.error || `Mercado Livre HTTP ${response.status}`,
    );
    error.statusCode = response.status;
    error.details = data;
    lastError = error;
    if (retryable && attempt < attempts) {
      await sleep(450 * attempt);
      continue;
    }
    break;
  }
  throw lastError || new Error("Falha ao consultar Mercado Livre.");
}

async function getSellerContext(state, mlCreds = {}) {
  let sellerId = String(
    mlCreds?.meli_user_id ||
      mlCreds?.user_id ||
      state?.creds?.meli_user_id ||
      state?.creds?.user_id ||
      "",
  ).trim();
  if (!sellerId) {
    const me = await requestJson(state, "/users/me");
    sellerId = String(me?.data?.id || "").trim();
  }
  if (!sellerId) throw new Error("Nao foi possivel identificar o seller da conta ativa.");

  const user = (await requestJson(
    state,
    `/users/${encodeURIComponent(sellerId)}`,
    { method: "GET" },
    3,
  )).data || {};
  const tags = new Set((Array.isArray(user?.tags) ? user.tags : []).map((tag) => String(tag)));
  return {
    sellerId,
    tags: [...tags],
    multiOrigin: tags.has("warehouse_management"),
    multiWarehouse: tags.has("multiwarehouse"),
  };
}

async function getItem(state, mlb) {
  const attrs = [
    "id",
    "title",
    "status",
    "available_quantity",
    "seller_custom_field",
    "seller_id",
    "shipping",
    "variations",
    "attributes",
    "permalink",
    "user_product_id",
    "inventory_id",
  ].join(",");
  const response = await requestJson(
    state,
    `/items/${encodeURIComponent(mlb)}?attributes=${encodeURIComponent(attrs)}`,
    { method: "GET" },
  );
  return response.data || {};
}

async function fetchItemsByIds(state, ids = []) {
  const unique = Array.from(new Set((ids || []).map(normMlb).filter(Boolean)));
  if (!unique.length) return [];
  const attrs = [
    "id",
    "title",
    "status",
    "available_quantity",
    "seller_custom_field",
    "seller_id",
    "shipping",
    "variations",
    "attributes",
    "permalink",
    "user_product_id",
    "inventory_id",
  ].join(",");
  const output = [];
  for (let index = 0; index < unique.length; index += 20) {
    const chunk = unique.slice(index, index + 20);
    const response = await requestJson(
      state,
      `/items?ids=${encodeURIComponent(chunk.join(","))}&attributes=${encodeURIComponent(attrs)}`,
      { method: "GET" },
    );
    for (const entry of Array.isArray(response.data) ? response.data : []) {
      const item = entry?.body || entry;
      if (item?.id) output.push(item);
    }
  }
  return output;
}

async function findUserProductConflictKeys(state, changes, sellerId) {
  const items = await fetchItemsByIds(
    state,
    Array.from(new Set((changes || []).map((change) => change.mlb).filter(Boolean))),
  );
  const rowMap = new Map();
  for (const item of items) {
    if (!ownershipMatches(item, sellerId)) continue;
    for (const row of flattenItem(item)) rowMap.set(row.row_key, row);
  }

  const byUserProduct = new Map();
  for (const change of changes || []) {
    const current = change.row_key ? rowMap.get(change.row_key) : null;
    const up = String(current?.user_product_id || "").trim();
    if (!up || change.new_stock == null) continue;
    if (!byUserProduct.has(up)) byUserProduct.set(up, new Map());
    const stockKey = String(change.new_stock);
    if (!byUserProduct.get(up).has(stockKey)) byUserProduct.get(up).set(stockKey, []);
    byUserProduct.get(up).get(stockKey).push(change.row_key);
  }

  const conflicts = new Set();
  for (const byStock of byUserProduct.values()) {
    if (byStock.size <= 1) continue;
    for (const keys of byStock.values()) for (const key of keys) conflicts.add(key);
  }
  return conflicts;
}

function ownershipMatches(item, sellerId) {
  const owner = String(item?.seller_id || item?.seller?.id || "").trim();
  return !owner || owner === String(sellerId);
}

function buildBaseResult(change, currentRow = null) {
  return {
    row_key: change.row_key,
    mlb: change.mlb,
    variation_id: change.variation_id,
    title: currentRow?.title || change.mlb || null,
    sku: currentRow?.sku || null,
    variation_label: currentRow?.variation_label || null,
    target_type: currentRow?.target_type || (change.variation_id ? "variation" : "item"),
    logistic_type: currentRow?.logistic_type || null,
    user_product_id: currentRow?.user_product_id || null,
    inventory_id: currentRow?.inventory_id || null,
    expected_current_stock: change.expected_current_stock,
    actual_current_stock: currentRow ? toStock(currentRow.current_stock, 0) : null,
    requested_stock: change.new_stock,
    confirmed_stock: null,
    write_applied: false,
    retryable: false,
    status: "pending",
    message: "",
    updated_at: new Date().toISOString(),
  };
}

function preflightChange(change, currentRow, sellerContext) {
  const base = buildBaseResult(change, currentRow);
  if (!change.mlb || change.new_stock == null) {
    return { ...base, status: "invalid", message: "MLB ou estoque informado e invalido." };
  }
  if (!currentRow) {
    return { ...base, status: "not_found", message: "Anuncio ou variacao nao localizado na conta ativa." };
  }
  if (sellerContext.multiOrigin) {
    return {
      ...base,
      status: "blocked_multi_origin",
      message: "Conta com estoque multi-origem. A atualizacao por available_quantity foi bloqueada para evitar sobrescrever depositos.",
    };
  }
  if (String(currentRow.logistic_type || "").toLowerCase() === "fulfillment") {
    return {
      ...base,
      status: "blocked_fulfillment",
      message: "Estoque Full e gerenciado pelo Mercado Livre e nao pode ser alterado por esta operacao.",
    };
  }
  if (String(currentRow.item_status || "") !== "active") {
    return {
      ...base,
      status: "blocked",
      message: `Anuncio com status ${currentRow.item_status || "desconhecido"}; somente ativos sao atualizados em massa.`,
    };
  }
  if (change.new_stock === base.actual_current_stock) {
    return { ...base, status: "unchanged", message: "Estoque ja esta no valor solicitado." };
  }
  if (
    change.expected_current_stock != null &&
    change.expected_current_stock !== base.actual_current_stock
  ) {
    return {
      ...base,
      status: "stale",
      message: `O estoque mudou de ${change.expected_current_stock} para ${base.actual_current_stock} antes do envio.`,
    };
  }
  return { ...base, status: "ready", message: "Pronto para atualizar." };
}

function variationIdPayload(value) {
  const text = String(value || "").trim();
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    if (Number.isSafeInteger(n)) return n;
  }
  return text;
}

function buildPutPayload(readyResults = []) {
  if (!readyResults.length) return null;
  const variationRows = readyResults.filter((row) => row.target_type === "variation");
  if (variationRows.length) {
    return {
      variations: variationRows.map((row) => ({
        id: variationIdPayload(row.variation_id),
        available_quantity: row.requested_stock,
      })),
    };
  }
  return { available_quantity: readyResults[0].requested_stock };
}

async function putStock(state, mlb, payload) {
  return requestJson(
    state,
    `/items/${encodeURIComponent(mlb)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    3,
  );
}

async function verifyAppliedRows(state, mlb, rows) {
  let latestMap = new Map();
  for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt += 1) {
    const delay = VERIFY_DELAYS_MS[attempt] || 0;
    if (delay) await sleep(delay);
    const item = await getItem(state, mlb);
    latestMap = new Map(flattenItem(item).map((row) => [row.row_key, row]));
    const allConfirmed = rows.every((row) => {
      const current = latestMap.get(row.row_key);
      return current && toStock(current.current_stock, null) === row.requested_stock;
    });
    if (allConfirmed) break;
  }
  return latestMap;
}

function summarizeResults(results = []) {
  const list = Array.isArray(results) ? results : [];
  const count = (status) => list.filter((row) => row.status === status).length;
  const blockedStatuses = new Set([
    "blocked",
    "blocked_fulfillment",
    "blocked_multi_origin",
    "blocked_up_conflict",
    "invalid",
    "not_found",
  ]);
  return {
    total: list.length,
    processed: list.filter((row) => row.status !== "canceled").length,
    applied: count("applied"),
    unchanged: count("unchanged"),
    stale: count("stale"),
    divergent: count("divergent"),
    errors: count("error"),
    canceled: count("canceled"),
    blocked: list.filter((row) => blockedStatuses.has(row.status)).length,
    retryable: list.filter((row) => row.retryable === true).length,
  };
}

function groupChanges(changes = []) {
  const groups = new Map();
  for (const change of changes) {
    const key = change.mlb || `invalid:${groups.size}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(change);
  }
  return [...groups.entries()].map(([mlb, rows]) => ({ mlb, rows }));
}

async function processGroup({ state, sellerContext, mlb, changes, conflictKeys = new Set() }) {
  if (!normMlb(mlb)) {
    return changes.map((change) => ({
      ...buildBaseResult(change),
      status: "invalid",
      message: "MLB invalido.",
    }));
  }

  let item;
  try {
    item = await getItem(state, mlb);
  } catch (error) {
    return changes.map((change) => ({
      ...buildBaseResult(change),
      status: "error",
      retryable: Number(error?.statusCode || 0) === 429 || Number(error?.statusCode || 0) >= 500,
      message: error?.message || "Falha ao consultar o anuncio antes da escrita.",
      http_status: error?.statusCode || null,
    }));
  }

  if (!ownershipMatches(item, sellerContext.sellerId)) {
    return changes.map((change) => ({
      ...buildBaseResult(change),
      status: "not_found",
      message: "Anuncio nao pertence ao seller da conta ativa.",
    }));
  }

  const currentRows = new Map(flattenItem(item).map((row) => [row.row_key, row]));
  const results = changes.map((change) => preflightChange(
    change,
    change.row_key ? currentRows.get(change.row_key) || null : null,
    sellerContext,
  ));
  for (const row of results) {
    if (row.status === "ready" && conflictKeys.has(row.row_key)) {
      row.status = "blocked_up_conflict";
      row.message = "O mesmo User Product recebeu quantidades diferentes no lote. Nenhuma escrita foi feita para esta linha.";
    }
  }
  const ready = results.filter((row) => row.status === "ready");
  if (!ready.length) return results;

  try {
    const payload = buildPutPayload(ready);
    await putStock(state, mlb, payload);
    ready.forEach((row) => {
      row.write_applied = true;
      row.retryable = false;
    });
  } catch (error) {
    const status = Number(error?.statusCode || 0);
    const retryable = status === 429 || status >= 500;
    ready.forEach((row) => {
      row.status = "error";
      row.retryable = retryable;
      row.write_applied = false;
      row.message = error?.message || "Falha ao atualizar estoque no Mercado Livre.";
      row.http_status = status || null;
      row.error_details = error?.details || null;
    });
    return results;
  }

  try {
    const verified = await verifyAppliedRows(state, mlb, ready);
    ready.forEach((row) => {
      const current = verified.get(row.row_key);
      const confirmed = current ? toStock(current.current_stock, null) : null;
      row.confirmed_stock = confirmed;
      row.updated_at = new Date().toISOString();
      if (confirmed === row.requested_stock) {
        row.status = "applied";
        row.message = "Estoque atualizado e confirmado no Mercado Livre.";
      } else {
        row.status = "divergent";
        row.message = confirmed == null
          ? "A escrita foi aceita, mas a variacao nao foi localizada na verificacao final. Nao reenviar automaticamente."
          : `A escrita foi aceita, mas a verificacao retornou ${confirmed} em vez de ${row.requested_stock}. Nao reenviar automaticamente.`;
      }
    });
  } catch (error) {
    ready.forEach((row) => {
      row.status = "divergent";
      row.confirmed_stock = null;
      row.message = `A escrita foi aceita, mas nao foi possivel confirmar o estoque final: ${error?.message || error}`;
      row.retryable = false;
    });
  }

  return results;
}

async function processStockChanges({
  accessToken,
  mlCreds = {},
  changes = [],
  onProgress = null,
  shouldCancel = null,
} = {}) {
  const input = Array.isArray(changes) ? changes : [];
  if (!input.length) {
    const error = new Error("Nenhuma alteracao de estoque foi enviada.");
    error.statusCode = 400;
    throw error;
  }
  if (input.length > MAX_CHANGES) {
    const error = new Error(`A atualizacao esta limitada a ${MAX_CHANGES} linhas por job.`);
    error.statusCode = 400;
    throw error;
  }

  const normalized = input.map(normalizeRequestedChange);
  const { prepareAuthState } = getPrazoService();
  const state = await prepareAuthState({ accessToken, mlCreds });
  const sellerContext = await getSellerContext(state, mlCreds);
  const conflictKeys = sellerContext.multiOrigin
    ? new Set()
    : await findUserProductConflictKeys(state, normalized, sellerContext.sellerId);
  const groups = groupChanges(normalized);
  const results = [];
  let processed = 0;

  if (typeof onProgress === "function") {
    await onProgress({ phase: "starting", processed: 0, total: normalized.length, sellerContext });
  }

  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    if (typeof shouldCancel === "function" && await shouldCancel()) {
      for (const pendingGroup of groups.slice(index)) {
        for (const change of pendingGroup.rows) {
          results.push({
            ...buildBaseResult(change),
            status: "canceled",
            message: "Item nao processado porque o cancelamento do job foi solicitado.",
          });
        }
      }
      break;
    }

    const groupResults = await processGroup({
      state,
      sellerContext,
      mlb: group.mlb,
      changes: group.rows,
      conflictKeys,
    });
    results.push(...groupResults);
    processed += group.rows.length;
    if (typeof onProgress === "function") {
      await onProgress({
        phase: "updating",
        processed,
        total: normalized.length,
        current_mlb: group.mlb,
        summary: summarizeResults(results),
      });
    }
  }

  const summary = summarizeResults(results);
  return {
    success: summary.errors === 0 && summary.divergent === 0,
    seller_id: sellerContext.sellerId,
    seller_tags: sellerContext.tags,
    multi_origin: sellerContext.multiOrigin,
    total: normalized.length,
    processed: summary.processed,
    summary,
    rows: results,
    canceled: summary.canceled > 0,
  };
}

function buildCsvRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => [
    row.mlb || "",
    row.variation_id || "",
    row.sku || "",
    row.title || "",
    row.variation_label || "",
    row.target_type || "",
    row.actual_current_stock ?? row.expected_current_stock ?? "",
    row.requested_stock ?? "",
    row.confirmed_stock ?? "",
    row.status || "",
    row.write_applied === true ? "sim" : "nao",
    row.retryable === true ? "sim" : "nao",
    row.message || "",
    row.http_status || "",
    row.user_product_id || "",
    row.inventory_id || "",
    row.logistic_type || "",
    row.updated_at || "",
  ]);
}

const CSV_HEADER = [
  "MLB",
  "Variacao ID",
  "SKU",
  "Titulo",
  "Variacao",
  "Tipo alvo",
  "Estoque antes",
  "Estoque solicitado",
  "Estoque confirmado",
  "Status",
  "Escrita aplicada",
  "Pode tentar novamente",
  "Mensagem",
  "HTTP",
  "User Product ID",
  "Inventory ID",
  "Logistica",
  "Atualizado em",
];

module.exports = {
  processStockChanges,
  summarizeResults,
  buildCsvRows,
  CSV_HEADER,
  _test: {
    normMlb,
    rowKey,
    normalizeRequestedChange,
    flattenItem,
    preflightChange,
    buildPutPayload,
    summarizeResults,
    variationIdPayload,
  },
};
