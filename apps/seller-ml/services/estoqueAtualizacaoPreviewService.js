"use strict";

const _fetch = typeof fetch !== "undefined" ? fetch : require("node-fetch");
const fetchRef = (...args) => _fetch(...args);
const ML_API = "https://api.mercadolibre.com";
const MAX_PREVIEW_ROWS = 5000;
const MAX_REQUEST_TOKENS = 5000;

function normMlb(value) {
  const text = String(value || "").trim().toUpperCase();
  return /^MLB\d{6,}$/.test(text) ? text : null;
}

function getPrazoService() {
  return require("./prazoProducaoService");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function uniq(values = []) {
  return Array.from(new Set((Array.isArray(values) ? values : []).filter(Boolean)));
}

function clampInt(value, min, max, fallback = null) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function normalizeSku(value) {
  return String(value || "").trim().toUpperCase();
}

function parseTokens(input) {
  return String(input || "")
    .split(/[\s,;\n\r\t]+/)
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .slice(0, MAX_REQUEST_TOKENS);
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
  const direct = normalizeSku(
    variation.seller_custom_field ||
      variation.seller_sku ||
      variation.sku ||
      extractSkuFromAttributes(variation.attributes) ||
      "",
  );
  if (direct) return direct;

  // Em anúncios sem SKU individual por variação, preservar o SKU do item ajuda
  // na identificação visual, mas a variation_id continua sendo a chave real.
  return extractItemSku(item);
}

function variationLabel(variation = {}) {
  const combinations = Array.isArray(variation.attribute_combinations)
    ? variation.attribute_combinations
    : [];
  const labels = combinations
    .map((attr) => attr?.value_name || attr?.value_id || attr?.name)
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return labels.join(" · ") || null;
}

function rowKey(mlb, variationId = null) {
  const id = normMlb(mlb);
  if (!id) return null;
  const variation = String(variationId || "").trim();
  return `${id}:${variation || "item"}`;
}

function itemOwnershipMatches(item = {}, sellerId) {
  if (!sellerId) return true;
  const itemSeller = String(item.seller_id || item?.seller?.id || "").trim();
  return !itemSeller || itemSeller === String(sellerId);
}

function flattenItem(item = {}) {
  const mlb = normMlb(item.id);
  if (!mlb) return [];

  const variations = Array.isArray(item.variations) ? item.variations : [];
  const common = {
    mlb,
    title: String(item.title || mlb),
    item_status: String(item.status || "unknown"),
    price: Number(item.price || 0),
    thumbnail: item.secure_thumbnail || item.thumbnail || null,
    permalink: item.permalink || null,
    listing_type_id: item.listing_type_id || null,
    catalog_listing: item.catalog_listing === true,
    logistic_type: item?.shipping?.logistic_type || null,
    user_product_id: item.user_product_id || null,
    inventory_id: item.inventory_id || null,
    item_stock: Math.max(0, Math.trunc(Number(item.available_quantity || 0))),
  };

  if (!variations.length) {
    const stock = common.item_stock;
    return [
      {
        ...common,
        row_key: rowKey(mlb),
        target_type: "item",
        variation_id: null,
        variation_label: null,
        sku: extractItemSku(item) || null,
        current_stock: stock,
        editable_candidate: common.item_status === "active",
        capability_hint: item.inventory_id || item.user_product_id
          ? "requires_inventory_validation"
          : "item",
      },
    ];
  }

  return variations.map((variation) => {
    const variationId = String(variation?.id || "").trim();
    const variationStock = Math.max(
      0,
      Math.trunc(Number(variation?.available_quantity || 0)),
    );
    return {
      ...common,
      row_key: rowKey(mlb, variationId),
      target_type: "variation",
      variation_id: variationId || null,
      variation_label: variationLabel(variation),
      sku: extractVariationSku(variation, item) || null,
      current_stock: variationStock,
      inventory_id: variation?.inventory_id || item.inventory_id || null,
      editable_candidate: common.item_status === "active",
      capability_hint:
        variation?.inventory_id || item.inventory_id || item.user_product_id
          ? "requires_inventory_validation"
          : "variation",
    };
  });
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
  const call = (token) =>
    fetchRef(url, {
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
  response = await call(state.token);
  return response;
}

async function mlJson(state, pathOrUrl, init = {}, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await authFetch(state, pathOrUrl, init);
    const data = await response.json().catch(() => ({}));
    if (response.ok) return data;
    if (response.status === 429 && attempt < attempts) {
      await sleep(350 * attempt);
      continue;
    }
    const error = new Error(
      data?.message || data?.error || `Mercado Livre HTTP ${response.status}`,
    );
    error.statusCode = response.status;
    error.details = data;
    lastError = error;
    break;
  }
  throw lastError || new Error("Falha ao consultar Mercado Livre.");
}

async function getSellerId(state, mlCreds = {}) {
  const fromCreds =
    mlCreds?.meli_user_id ||
    mlCreds?.user_id ||
    state?.creds?.meli_user_id ||
    state?.creds?.user_id;
  if (fromCreds) return String(fromCreds);
  const me = await mlJson(state, "/users/me");
  if (!me?.id) throw new Error("Nao foi possivel identificar o seller da conta ativa.");
  return String(me.id);
}

async function fetchItemDetails(state, ids = []) {
  const uniqueIds = uniq(ids.map(normMlb));
  if (!uniqueIds.length) return [];

  const attrs = [
    "id",
    "title",
    "status",
    "available_quantity",
    "seller_custom_field",
    "price",
    "thumbnail",
    "secure_thumbnail",
    "permalink",
    "seller_id",
    "shipping",
    "variations",
    "attributes",
    "listing_type_id",
    "catalog_listing",
    "user_product_id",
    "inventory_id",
  ].join(",");

  const chunks = [];
  for (let i = 0; i < uniqueIds.length; i += 20) {
    chunks.push(uniqueIds.slice(i, i + 20));
  }

  const output = new Array(chunks.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(4, Math.max(1, chunks.length)) },
    async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= chunks.length) return;
        const chunk = chunks[index];
        const data = await mlJson(
          state,
          `/items?ids=${encodeURIComponent(chunk.join(","))}&attributes=${encodeURIComponent(attrs)}`,
        );
        output[index] = (Array.isArray(data) ? data : [])
          .map((entry) => entry?.body || entry)
          .filter((body) => body?.id);
      }
    },
  );
  await Promise.all(workers);
  return output.flat();
}

function itemMatchesSku(item = {}, requestedSkus = new Set()) {
  if (!requestedSkus.size) return false;
  if (requestedSkus.has(extractItemSku(item))) return true;
  return (Array.isArray(item.variations) ? item.variations : []).some((variation) =>
    requestedSkus.has(extractVariationSku(variation, item)),
  );
}

async function resolveManualIds({ state, mlCreds, query, maxItems = null }) {
  const tokens = parseTokens(query);
  if (!tokens.length) {
    const error = new Error("Informe ao menos um MLB ou SKU.");
    error.statusCode = 400;
    throw error;
  }

  const sellerId = await getSellerId(state, mlCreds);
  const mlbTokens = uniq(tokens.map(normMlb));
  const skuTokens = uniq(
    tokens.filter((token) => !normMlb(token)).map(normalizeSku).filter(Boolean),
  );

  const skuMatchedIds = [];
  let scannedForSku = 0;
  if (skuTokens.length) {
    const { listActiveSellerItemIds } = getPrazoService();
    const listing = await listActiveSellerItemIds({
      authState: state,
      mlCreds,
      maxItems: null,
    });
    const activeDetails = await fetchItemDetails(state, listing.ids);
    const skuSet = new Set(skuTokens);
    for (const item of activeDetails) {
      if (!itemOwnershipMatches(item, sellerId)) continue;
      scannedForSku += 1;
      if (itemMatchesSku(item, skuSet)) {
        const id = normMlb(item.id);
        if (id) skuMatchedIds.push(id);
      }
    }
  }

  const combined = uniq([...mlbTokens, ...skuMatchedIds]);
  const max = maxItems == null || maxItems === ""
    ? null
    : clampInt(maxItems, 1, 50000, null);
  const ids = max ? combined.slice(0, max) : combined;

  if (!ids.length) {
    const error = new Error("Nenhum anuncio da conta foi localizado para a lista informada.");
    error.statusCode = 404;
    throw error;
  }

  return {
    sellerId,
    ids,
    requestedTokens: tokens,
    requestedSkus: skuTokens,
    requestedMlbs: mlbTokens,
    skuMatchedIds: uniq(skuMatchedIds),
    scannedForSku,
    truncated: Boolean(max && combined.length > ids.length),
  };
}

function summarizeLoadedRows(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  return {
    rows: list.length,
    items: new Set(list.map((row) => row.mlb).filter(Boolean)).size,
    variations: list.filter((row) => row.target_type === "variation").length,
    zero_stock: list.filter((row) => Number(row.current_stock || 0) <= 0).length,
    low_stock: list.filter((row) => {
      const stock = Number(row.current_stock || 0);
      return stock > 0 && stock <= 5;
    }).length,
    inactive: list.filter((row) => row.item_status !== "active").length,
  };
}

async function loadStockRows({
  accessToken,
  mlCreds = {},
  source = "active",
  query = "",
  maxItems = null,
} = {}) {
  const { prepareAuthState } = getPrazoService();
  const state = await prepareAuthState({ accessToken, mlCreds });
  const normalizedSource = String(source || "active").toLowerCase();
  let sellerId = null;
  let ids = [];
  let sourceMeta = {};

  if (normalizedSource === "active") {
    const { listActiveSellerItemIds } = getPrazoService();
    const listing = await listActiveSellerItemIds({
      authState: state,
      mlCreds,
      maxItems,
    });
    sellerId = String(listing.sellerId || "");
    ids = listing.ids || [];
    sourceMeta = {
      listing_source: listing.source || null,
      total_available: listing.totalAvailable || null,
      truncated: listing.truncated === true,
      scan_error: listing.scanError || null,
    };
  } else if (["manual", "specific", "list"].includes(normalizedSource)) {
    const resolved = await resolveManualIds({
      state,
      mlCreds,
      query,
      maxItems,
    });
    sellerId = resolved.sellerId;
    ids = resolved.ids;
    sourceMeta = {
      requested_tokens: resolved.requestedTokens,
      requested_skus: resolved.requestedSkus,
      requested_mlbs: resolved.requestedMlbs,
      sku_matched_items: resolved.skuMatchedIds.length,
      scanned_for_sku: resolved.scannedForSku,
      truncated: resolved.truncated,
    };
  } else {
    const error = new Error("Origem de carregamento de estoque invalida.");
    error.statusCode = 400;
    throw error;
  }

  if (!ids.length) {
    return {
      success: true,
      source: normalizedSource,
      seller_id: sellerId,
      total: 0,
      rows: [],
      summary: summarizeLoadedRows([]),
      meta: { ...sourceMeta, read_only: true },
    };
  }

  const details = await fetchItemDetails(state, ids);
  const owned = details.filter((item) => itemOwnershipMatches(item, sellerId));
  const foreignOrUnavailable = details.length - owned.length;
  const foundIds = new Set(owned.map((item) => normMlb(item.id)).filter(Boolean));
  const missingIds = ids.filter((id) => !foundIds.has(id));
  const rows = owned
    .flatMap(flattenItem)
    .sort((a, b) => {
      const title = String(a.title || "").localeCompare(String(b.title || ""), "pt-BR");
      if (title) return title;
      const mlb = String(a.mlb || "").localeCompare(String(b.mlb || ""));
      if (mlb) return mlb;
      return String(a.variation_id || "").localeCompare(String(b.variation_id || ""));
    });

  return {
    success: true,
    source: normalizedSource,
    seller_id: sellerId,
    total: rows.length,
    rows,
    summary: summarizeLoadedRows(rows),
    meta: {
      ...sourceMeta,
      requested_items: ids.length,
      resolved_items: foundIds.size,
      missing_or_foreign_items: uniq(missingIds).length + foreignOrUnavailable,
      missing_ids: uniq(missingIds).slice(0, 100),
      read_only: true,
      preview_required: true,
    },
  };
}

function normalizeRequestedChange(change = {}) {
  const mlb = normMlb(change.mlb || change.item_id);
  const variationId = String(change.variation_id || "").trim() || null;
  const newStockRaw = Number(change.new_stock ?? change.newStock);
  const expectedRaw = Number(
    change.expected_current_stock ?? change.current_stock ?? change.currentStock,
  );

  return {
    row_key: rowKey(mlb, variationId),
    mlb,
    variation_id: variationId,
    expected_current_stock: Number.isFinite(expectedRaw)
      ? Math.max(0, Math.trunc(expectedRaw))
      : null,
    new_stock: Number.isFinite(newStockRaw) ? Math.trunc(newStockRaw) : null,
  };
}

function evaluatePreviewChange(change = {}, currentRow = null, options = {}) {
  const normalized = normalizeRequestedChange(change);
  if (!normalized.mlb || normalized.new_stock == null || normalized.new_stock < 0) {
    return {
      ...normalized,
      status: "invalid",
      can_apply_later: false,
      message: "Informe um MLB valido e estoque inteiro maior ou igual a zero.",
    };
  }
  if (!currentRow) {
    return {
      ...normalized,
      status: "not_found",
      can_apply_later: false,
      message: "Anuncio ou variacao nao foi localizado na conta ativa.",
    };
  }

  const actual = Math.max(0, Math.trunc(Number(currentRow.current_stock || 0)));
  const base = {
    ...normalized,
    title: currentRow.title || normalized.mlb,
    sku: currentRow.sku || null,
    variation_label: currentRow.variation_label || null,
    item_status: currentRow.item_status || "unknown",
    target_type: currentRow.target_type || (normalized.variation_id ? "variation" : "item"),
    capability_hint: currentRow.capability_hint || null,
    logistic_type: currentRow.logistic_type || null,
    user_product_id: currentRow.user_product_id || null,
    inventory_id: currentRow.inventory_id || null,
    actual_current_stock: actual,
    difference: normalized.new_stock - actual,
  };

  if (options?.capabilityUnknown === true) {
    return {
      ...base,
      status: "blocked_capability",
      can_apply_later: false,
      message: "Nao foi possivel validar o modo de estoque da conta. Tente revisar novamente antes de enviar.",
    };
  }

  if (options?.multiOrigin === true) {
    return {
      ...base,
      status: "blocked_multi_origin",
      can_apply_later: false,
      message: "Conta com estoque multi-origem. A atualizacao por available_quantity foi bloqueada para preservar os depositos.",
    };
  }

  if (String(currentRow.logistic_type || "").toLowerCase() === "fulfillment") {
    return {
      ...base,
      status: "blocked_fulfillment",
      can_apply_later: false,
      message: "Estoque Full e gerenciado pelo Mercado Livre e nao pode ser alterado por esta operacao.",
    };
  }

  if (currentRow.item_status !== "active") {
    return {
      ...base,
      status: "blocked",
      can_apply_later: false,
      message: `Anuncio com status ${currentRow.item_status || "desconhecido"}; somente ativos poderao ser alterados.`,
    };
  }

  if (normalized.new_stock === actual) {
    return {
      ...base,
      status: "unchanged",
      can_apply_later: false,
      message: "Nenhuma alteracao de estoque necessaria.",
    };
  }

  if (
    normalized.expected_current_stock != null &&
    normalized.expected_current_stock !== actual
  ) {
    return {
      ...base,
      status: "stale",
      can_apply_later: false,
      message: `O estoque mudou de ${normalized.expected_current_stock} para ${actual} desde o carregamento.`,
    };
  }

  return {
    ...base,
    status: "ready",
    can_apply_later: true,
    message:
      currentRow.capability_hint === "requires_inventory_validation"
        ? "Pronto para revisao. O modo de estoque sera validado novamente antes da escrita."
        : "Pronto para revisao final antes da escrita.",
  };
}

function summarizePreview(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  const count = (status) => list.filter((row) => row.status === status).length;
  const blocked = list.filter((row) => String(row.status || "").startsWith("blocked")).length;
  return {
    total: list.length,
    ready: count("ready"),
    unchanged: count("unchanged"),
    stale: count("stale"),
    blocked,
    blocked_multi_origin: count("blocked_multi_origin"),
    blocked_fulfillment: count("blocked_fulfillment"),
    blocked_capability: count("blocked_capability"),
    blocked_up_conflict: count("blocked_up_conflict"),
    invalid: count("invalid"),
    not_found: count("not_found"),
  };
}

async function previewStockChanges({ accessToken, mlCreds = {}, changes = [] } = {}) {
  const input = Array.isArray(changes) ? changes : [];
  if (!input.length) {
    const error = new Error("Selecione ao menos uma alteracao de estoque para revisar.");
    error.statusCode = 400;
    throw error;
  }
  if (input.length > MAX_PREVIEW_ROWS) {
    const error = new Error(`A revisao esta limitada a ${MAX_PREVIEW_ROWS} linhas por vez.`);
    error.statusCode = 400;
    throw error;
  }

  const { prepareAuthState } = getPrazoService();
  const state = await prepareAuthState({ accessToken, mlCreds });
  const sellerId = await getSellerId(state, mlCreds);
  let sellerTags = [];
  let sellerTagsKnown = true;
  try {
    const seller = await mlJson(state, `/users/${encodeURIComponent(sellerId)}`);
    sellerTags = Array.isArray(seller?.tags) ? seller.tags.map((tag) => String(tag)) : [];
  } catch {
    sellerTags = [];
    sellerTagsKnown = false;
  }
  const multiOrigin = sellerTagsKnown && sellerTags.includes("warehouse_management");
  const normalized = input.map(normalizeRequestedChange);
  const validIds = uniq(normalized.map((change) => change.mlb).filter(Boolean));
  const details = validIds.length ? await fetchItemDetails(state, validIds) : [];
  const currentRows = details
    .filter((item) => itemOwnershipMatches(item, sellerId))
    .flatMap(flattenItem);
  const rowMap = new Map(currentRows.map((row) => [row.row_key, row]));

  const rows = input.map((change) => {
    const normalizedChange = normalizeRequestedChange(change);
    return evaluatePreviewChange(
      change,
      normalizedChange.row_key ? rowMap.get(normalizedChange.row_key) || null : null,
      { multiOrigin, capabilityUnknown: !sellerTagsKnown },
    );
  });

  // Um mesmo User Product representa o mesmo estoque fisico entre diferentes
  // condicoes de venda. Se o mesmo UP receber quantidades diferentes no mesmo
  // lote, nenhuma delas e enviada para evitar a regra "ultimo PUT vence".
  const upStocks = new Map();
  for (const row of rows) {
    if (row.status !== "ready" || !row.user_product_id) continue;
    const key = String(row.user_product_id);
    if (!upStocks.has(key)) upStocks.set(key, new Map());
    const stockKey = String(row.new_stock);
    if (!upStocks.get(key).has(stockKey)) upStocks.get(key).set(stockKey, []);
    upStocks.get(key).get(stockKey).push(row);
  }
  for (const [userProductId, byStock] of upStocks.entries()) {
    if (byStock.size <= 1) continue;
    for (const groupedRows of byStock.values()) {
      for (const row of groupedRows) {
        row.status = "blocked_up_conflict";
        row.can_apply_later = false;
        row.message = `O User Product ${userProductId} recebeu estoques diferentes no mesmo lote. Use uma unica quantidade para todas as condicoes vinculadas.`;
      }
    }
  }

  return {
    success: true,
    seller_id: sellerId,
    seller_tags: sellerTags,
    multi_origin: multiOrigin,
    write_enabled: sellerTagsKnown && !multiOrigin,
    mode: "preview_then_queue",
    summary: summarizePreview(rows),
    rows,
    note: !sellerTagsKnown
      ? "Nao foi possivel validar o modo de estoque da conta; o envio foi bloqueado por seguranca."
      : multiOrigin
        ? "A conta usa estoque multi-origem; as linhas ficam bloqueadas nesta versao para evitar sobrescrever depositos."
        : "As linhas prontas podem ser confirmadas. O worker revalida o estoque imediatamente antes da escrita.",
  };
}

module.exports = {
  loadStockRows,
  previewStockChanges,
  _test: {
    parseTokens,
    extractItemSku,
    extractVariationSku,
    variationLabel,
    rowKey,
    flattenItem,
    normalizeRequestedChange,
    evaluatePreviewChange,
    summarizePreview,
  },
};
