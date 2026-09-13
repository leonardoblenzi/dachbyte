"use strict";

const fetch = require("node-fetch");
const TokenService = require("./tokenService");
const {
  extractSalePriceInfo,
  resolvePromotionSnapshot,
} = require("./mlPromotionPricing");

const API_BASE = "https://api.mercadolibre.com";
const DEFAULT_CONTEXT = "channel_marketplace";
const DEFAULT_BUSINESS_CONTEXTS = ["channel_marketplace", "user_type_business"];

function round2(value) {
  const num = Number(value || 0);
  return Math.round((num + Number.EPSILON) * 100) / 100;
}

function asPositiveNumber(value, fallback = null) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

function asNonNegativeInteger(value, fallback = 0) {
  const num = Number(value);
  return Number.isInteger(num) && num >= 0 ? num : fallback;
}

function normalizeItemId(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function parseJsonSafe(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

function normalizeTierConfigs(values, fallbackFirstUnit = 2, fallbackDiscountPercent = 1) {
  const source = Array.isArray(values) && values.length
    ? values
    : [{
        min_purchase_unit: fallbackFirstUnit,
        discount_percent: fallbackDiscountPercent,
      }];

  const configs = source.slice(0, 5).map((value, index) => {
    const minUnit = asNonNegativeInteger(
      value?.min_purchase_unit,
      index === 0 ? fallbackFirstUnit : 0,
    );
    const discountPercent = asPositiveNumber(
      value?.discount_percent,
      fallbackDiscountPercent,
    );

    return {
      min_purchase_unit: minUnit,
      discount_percent: discountPercent,
    };
  });

  if (!configs.length || configs[0].min_purchase_unit <= 0) {
    throw new Error("A faixa 1 do atacado precisa ter quantidade minima valida.");
  }

  for (let index = 0; index < configs.length; index += 1) {
    if (!(configs[index].discount_percent > 0)) {
      throw new Error("Todas as faixas de atacado precisam ter desconto valido.");
    }
  }

  for (let index = 1; index < configs.length; index += 1) {
    if (configs[index].min_purchase_unit <= configs[index - 1].min_purchase_unit) {
      throw new Error("As faixas de atacado precisam ter quantidades minimas em ordem crescente.");
    }
    if (configs[index].discount_percent <= configs[index - 1].discount_percent) {
      throw new Error("As faixas de atacado precisam ter descontos em ordem crescente.");
    }
  }

  return configs;
}

function buildWholesalePrices(baseAmount, tierConfigs, currencyId) {
  const amount = Number(baseAmount || 0);

  if (!(amount > 0)) {
    throw new Error("Nao foi possivel calcular o preco base do atacado.");
  }

  return tierConfigs.map((config) => ({
      amount: round2(amount * (1 - Number(config.discount_percent || 0) / 100)),
      currency_id: currencyId || "BRL",
      conditions: {
        context_restrictions: DEFAULT_BUSINESS_CONTEXTS,
        min_purchase_unit: config.min_purchase_unit,
      },
    }));
}

function buildRow(item, salePriceAmount, extraDiscountPercent) {
  const itemPrice = Number(item?.price || 0) || null;
  const originalPrice = Number(item?.original_price || 0) || null;
  const promo = resolvePromotionSnapshot({
    itemPrice,
    itemOriginalPrice: originalPrice,
    salePriceInfo: { amount: salePriceAmount },
  });
  const displayPrice = Number(promo.original_price || itemPrice || 0) || null;
  const effectivePrice = Number(promo.current_price || itemPrice || 0) || null;
  const suggestedWholesalePrice =
    Number.isFinite(effectivePrice) && effectivePrice > 0
      ? round2(effectivePrice * (1 - Number(extraDiscountPercent || 0) / 100))
      : null;

  return {
    id: normalizeItemId(item?.id),
    title: item?.title || "",
    status: item?.status || "",
    available_quantity: Number(item?.available_quantity || 0),
    seller_custom_field: item?.seller_custom_field || "",
    currency_id: item?.currency_id || "BRL",
    thumbnail: item?.thumbnail || "",
    permalink: item?.permalink || "",
    item_price: displayPrice,
    original_price: promo.original_price,
    sale_price: effectivePrice,
    promo_active: !!promo.promo_active,
    promo_percent: promo.promo_pct ?? null,
    suggested_wholesale_price: suggestedWholesalePrice,
  };
}

async function mapLimit(items, limit, mapper) {
  const out = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const current = index++;
      out[current] = await mapper(items[current], current);
    }
  }

  const workers = [];
  const size = Math.max(1, Math.min(limit, items.length || 1));
  for (let i = 0; i < size; i += 1) workers.push(worker());
  await Promise.all(workers);
  return out;
}

class AtacadoService {
  static chunk(array, size) {
    const out = [];
    for (let index = 0; index < array.length; index += size) {
      out.push(array.slice(index, index + size));
    }
    return out;
  }

  static async prepareState(mlCreds = {}) {
    const token = await TokenService.renovarTokenSeNecessario(mlCreds);
    return { token, creds: mlCreds };
  }

  static async authFetch(state, url, init = {}) {
    const call = async (token) => {
      const headers = {
        Accept: "application/json",
        ...(init.headers || {}),
        Authorization: `Bearer ${token}`,
      };
      return fetch(url, { ...init, headers });
    };

    let response = await call(state.token);
    if (response.status !== 401) return response;

    const renewed = await TokenService.renovarToken(state.creds);
    state.token = renewed?.access_token || state.token;
    return call(state.token);
  }

  static async getSellerId(state) {
    if (state?.sellerId) return state.sellerId;
    const response = await this.authFetch(state, `${API_BASE}/users/me`);
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Falha ao consultar seller atual: HTTP ${response.status} ${body}`);
    }
    const me = await response.json();
    state.sellerId = me?.id || null;
    return state.sellerId;
  }

  static async listActiveItemIds(state, { cursor, limit }) {
    const sellerId = await this.getSellerId(state);
    const url = new URL(`${API_BASE}/users/${sellerId}/items/search`);
    url.searchParams.set("status", "active");
    url.searchParams.set("search_type", "scan");
    url.searchParams.set("limit", String(limit));
    if (cursor) url.searchParams.set("scroll_id", String(cursor));

    const response = await this.authFetch(state, url.toString());
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Falha ao listar anúncios ativos: HTTP ${response.status} ${body}`);
    }

    const payload = await response.json();
    const ids = Array.isArray(payload?.results)
      ? payload.results.map(normalizeItemId).filter(Boolean)
      : [];

    return {
      ids,
      total: Number(payload?.paging?.total || 0) || null,
      next_cursor: payload?.scroll_id || null,
    };
  }

  static async fetchItemsDetails(state, ids) {
    if (!ids.length) return [];

    const details = [];
    const chunks = this.chunk(ids, 20);

    for (const slice of chunks) {
      const url =
        `${API_BASE}/items?ids=${slice.join(",")}` +
        "&attributes=id,title,status,price,original_price,currency_id,available_quantity,seller_custom_field,thumbnail,permalink";

      const response = await this.authFetch(state, url);
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Falha ao carregar detalhes dos itens: HTTP ${response.status} ${body}`);
      }

      const payload = await response.json();
      const rows = Array.isArray(payload) ? payload : [];
      details.push(
        ...rows
          .filter((row) => row && row.code === 200 && row.body?.id)
          .map((row) => row.body),
      );
    }

    return details;
  }

  static async fetchSalePrice(state, itemId) {
    const url = new URL(`${API_BASE}/items/${encodeURIComponent(itemId)}/sale_price`);
    url.searchParams.set("context", DEFAULT_CONTEXT);
    url.searchParams.set("quantity", "1");

    try {
      const response = await this.authFetch(state, url.toString());
      if (!response.ok) return null;
      const payload = await response.json().catch(() => ({}));
      return extractSalePriceInfo(payload).amount;
    } catch {
      return null;
    }
  }

  static async listActiveItems(mlCreds, options = {}) {
    const state = await this.prepareState(mlCreds);
    const limit = Math.min(asNonNegativeInteger(options.limit, 50) || 50, 50);
    const cursor = String(options.cursor || "").trim() || null;
    const extraDiscountPercent = asPositiveNumber(
      options.extra_discount_percent,
      1,
    );

    const { ids, total, next_cursor } = await this.listActiveItemIds(state, {
      cursor,
      limit,
    });
    const items = await this.fetchItemsDetails(state, ids);

    const salePrices = await mapLimit(items, 5, async (item) => {
      return this.fetchSalePrice(state, item.id);
    });

    const rows = items.map((item, index) =>
      buildRow(item, salePrices[index], extraDiscountPercent),
    );

    return {
      items: rows,
      paging: {
        limit,
        total,
        cursor,
        has_more: !!next_cursor && rows.length > 0,
        next_cursor,
      },
    };
  }

  static async listSpecificItems(mlCreds, options = {}) {
    const state = await this.prepareState(mlCreds);
    const extraDiscountPercent = asPositiveNumber(
      options.extra_discount_percent,
      1,
    );
    const rawIds = Array.isArray(options.item_ids) ? options.item_ids : [];
    const requestedIds = rawIds.map(normalizeItemId).filter(Boolean);
    const ids = Array.from(new Set(requestedIds));

    if (!ids.length) {
      throw new Error("Nenhum MLB informado para carregamento especifico.");
    }

    if (ids.length > 2000) {
      throw new Error("Limite maximo de 2000 MLBs por carregamento especifico.");
    }

    const items = await this.fetchItemsDetails(state, ids);
    const itemsById = new Map(
      items.map((item) => [normalizeItemId(item?.id), item]),
    );

    const salePrices = await mapLimit(ids, 5, async (itemId) =>
      this.fetchSalePrice(state, itemId),
    );
    const salePricesById = new Map(
      ids.map((itemId, index) => [itemId, salePrices[index]]),
    );

    const foundIds = new Set(itemsById.keys());
    const missing_ids = ids.filter((itemId) => !foundIds.has(itemId));
    const rows = ids
      .filter((itemId) => foundIds.has(itemId))
      .map((itemId, index) =>
        buildRow(
          itemsById.get(itemId),
          salePricesById.get(itemId),
          extraDiscountPercent,
        ),
      );

    return {
      items: rows,
      requested_ids: ids,
      found_ids: rows.map((row) => row.id),
      missing_ids,
      paging: {
        total: rows.length,
        has_more: false,
        cursor: null,
        next_cursor: null,
      },
    };
  }

  static async fetchSingleItem(state, itemId) {
    const response = await this.authFetch(
      state,
      `${API_BASE}/items/${encodeURIComponent(itemId)}`,
    );
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Falha ao consultar ${itemId}: HTTP ${response.status} ${body}`);
    }
    return response.json();
  }

  static async applyWholesaleForItem(state, itemId, options) {
    const liveItem = await this.fetchSingleItem(state, itemId);
    const liveSalePrice = await this.fetchSalePrice(state, itemId);
    const tierConfigs = normalizeTierConfigs(
      options.tier_configs,
      asNonNegativeInteger(options.min_purchase_unit, 2) || 2,
      asPositiveNumber(options.extra_discount_percent, 1),
    );

    const row = buildRow(
      liveItem,
      liveSalePrice,
      Number(options.extra_discount_percent || 0),
    );

    if (String(liveItem?.status || "").toLowerCase() !== "active") {
      return {
        id: itemId,
        status: "skipped",
        reason: "Anúncio não está ativo no momento da aplicação.",
        row,
      };
    }

    if (options.promo_only && !row.promo_active) {
      return {
        id: itemId,
        status: "skipped",
        reason: "Anúncio sem promoção ativa no momento da aplicação.",
        row,
      };
    }

    const amount = row.sale_price;
    if (!(Number(amount) > 0)) {
      return {
        id: itemId,
        status: "error",
        reason: "Não foi possível calcular o preço de atacado.",
        row,
      };
    }

    const payload = {
      prices: buildWholesalePrices(
        amount,
        tierConfigs,
        row.currency_id,
      ),
    };

    if (options.dry_run) {
      return {
        id: itemId,
        status: "dry_run",
        reason: "Simulação concluída.",
        row,
        payload,
      };
    }

    const response = await this.authFetch(
      state,
      `${API_BASE}/items/${encodeURIComponent(itemId)}/prices/standard/quantity`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );

    const text = await response.text().catch(() => "");
    const parsed = parseJsonSafe(text);

    if (!response.ok) {
      return {
        id: itemId,
        status: "error",
        reason:
          parsed?.message ||
          parsed?.error ||
          `Falha ao aplicar atacado: HTTP ${response.status}`,
        row,
        payload,
      };
    }

    return {
      id: itemId,
      status: "applied",
      reason: "Atacado aplicado com sucesso.",
      row,
      payload,
      response: parsed,
    };
  }

  static async applyWholesale(mlCreds, options = {}) {
    const state = await this.prepareState(mlCreds);
    const ids = Array.from(
      new Set((options.item_ids || []).map(normalizeItemId).filter(Boolean)),
    );

    if (!ids.length) {
      throw new Error("Nenhum anúncio informado para aplicação do atacado.");
    }

    const applyOptions = {
      extra_discount_percent: asPositiveNumber(options.extra_discount_percent, 1),
      min_purchase_unit: asNonNegativeInteger(options.min_purchase_unit, 2) || 2,
      tier_configs: normalizeTierConfigs(
        options.tier_configs,
        asNonNegativeInteger(options.min_purchase_unit, 2) || 2,
        asPositiveNumber(options.extra_discount_percent, 1),
      ),
      promo_only: options.promo_only !== false,
      dry_run: options.dry_run === true,
    };

    const results = await mapLimit(ids, 4, async (itemId) => {
      try {
        return await this.applyWholesaleForItem(state, itemId, applyOptions);
      } catch (error) {
        return {
          id: itemId,
          status: "error",
          reason: error?.message || "Erro inesperado na aplicação.",
        };
      }
    });

    const summary = {
      total: results.length,
      applied: results.filter((item) => item.status === "applied").length,
      skipped: results.filter((item) => item.status === "skipped").length,
      errors: results.filter((item) => item.status === "error").length,
      dry_run: results.filter((item) => item.status === "dry_run").length,
    };

    return {
      summary,
      results,
      options: applyOptions,
    };
  }
}

module.exports = AtacadoService;
