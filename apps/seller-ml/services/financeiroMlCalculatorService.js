"use strict";

const TokenService = require("./tokenService");
const { prepareAuthState } = require("./prazoProducaoService");
const {
  calculatePricingSnapshot,
  decomposeMarketplaceFee,
  percentRate,
  round,
  solveTargetPrice,
} = require("./pricingEngine");

const _fetch = typeof fetch !== "undefined" ? fetch : require("node-fetch");
const fetchRef = (...args) => _fetch(...args);
const ML_API = "https://api.mercadolibre.com";
let listingPriceRequest = mlJson;

function getFinanceiroMlService() {
  return require("./financeiroMlService");
}

function text(value) {
  return String(value == null ? "" : value).trim();
}

function upper(value) {
  return text(value).toUpperCase();
}

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value, fallback = false) {
  if (typeof value === "boolean") return value;
  const normalized = text(value).toLowerCase();
  if (["1", "true", "yes", "sim", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "nao", "não", "off"].includes(normalized)) return false;
  return fallback;
}

function isMlb(value) {
  return /^MLB\d{6,}$/.test(upper(value));
}

function error(message, status = 400, details = null) {
  const err = new Error(message);
  err.status = status;
  err.payload = details;
  return err;
}

function requireAccountKey(context = {}) {
  if (text(context?.accountKey)) return;
  throw error("Conta Mercado Livre nao identificada para a calculadora.", 409);
}

function listingTypeLabel(value) {
  const id = text(value);
  if (id === "gold_pro") return "Premium";
  if (id === "gold_special") return "Clássico";
  return id || "Não informado";
}

function extractSku(attributes = [], direct = "") {
  const cleanDirect = text(direct);
  if (cleanDirect) return cleanDirect;
  const attr = (Array.isArray(attributes) ? attributes : []).find((row) =>
    ["SELLER_SKU", "SKU"].includes(upper(row?.id)) ||
    text(row?.name).toLowerCase().includes("sku"),
  );
  return text(
    attr?.value_name ||
      attr?.value_id ||
      (Array.isArray(attr?.values) ? attr.values[0]?.name || attr.values[0]?.id : ""),
  );
}

function variationLabel(variation = {}) {
  const combinations = Array.isArray(variation.attribute_combinations)
    ? variation.attribute_combinations
    : [];
  const label = combinations
    .map((row) => text(row?.value_name || row?.name || row?.value_id))
    .filter(Boolean)
    .join(" · ");
  return label || (variation?.id ? `Variação ${variation.id}` : "Variação");
}

async function renewAuthState(state) {
  if (!state?.creds || !Object.keys(state.creds).length) return false;
  const renewed = await TokenService.renovarToken(state.creds);
  const token = renewed?.access_token || state.token;
  if (!token) return false;
  state.token = token;
  state.creds.access_token = token;
  if (renewed?.refresh_token) state.creds.refresh_token = renewed.refresh_token;
  return true;
}

async function authFetch(state, pathOrUrl, init = {}) {
  const url = /^https?:\/\//i.test(text(pathOrUrl))
    ? text(pathOrUrl)
    : `${ML_API}${text(pathOrUrl)}`;
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

async function mlJson(state, pathOrUrl, init = {}) {
  const response = await authFetch(state, pathOrUrl, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw error(data?.message || data?.error || `Mercado Livre HTTP ${response.status}`, response.status, data);
  }
  return data;
}

async function sellerInfo(state, mlCreds = {}) {
  const sellerId =
    mlCreds?.meli_user_id || mlCreds?.user_id || state?.creds?.meli_user_id || state?.creds?.user_id;
  if (sellerId) return { id: String(sellerId), nickname: null };
  const me = await mlJson(state, "/users/me");
  if (!me?.id) throw error("Não foi possível identificar a conta Mercado Livre.", 409);
  return { id: String(me.id), nickname: me.nickname || null };
}

async function fetchItemBodies(state, ids = []) {
  const unique = Array.from(new Set(ids.map(upper).filter(isMlb)));
  const result = [];
  for (let i = 0; i < unique.length; i += 20) {
    const chunk = unique.slice(i, i + 20);
    const attrs = [
      "id", "title", "status", "available_quantity", "seller_custom_field", "seller_sku",
      "price", "original_price", "thumbnail", "secure_thumbnail", "permalink", "seller_id",
      "category_id", "listing_type_id", "inventory_id", "shipping", "attributes", "variations",
    ].join(",");
    const rows = await mlJson(
      state,
      `/items?ids=${encodeURIComponent(chunk.join(","))}&attributes=${encodeURIComponent(attrs)}`,
    );
    for (const entry of Array.isArray(rows) ? rows : []) {
      const body = entry?.body || entry;
      if (body?.id) result.push(body);
    }
  }
  return result;
}

async function findItemIds(state, sellerId, query) {
  const q = text(query);
  if (isMlb(q)) return [upper(q)];
  const ids = new Set();
  for (const status of ["active", "paused", "closed"]) {
    const url = new URL(`${ML_API}/users/${encodeURIComponent(String(sellerId))}/items/search`);
    url.searchParams.set("seller_sku", q);
    url.searchParams.set("status", status);
    url.searchParams.set("limit", "50");
    const payload = await mlJson(state, url.toString()).catch(() => null);
    (Array.isArray(payload?.results) ? payload.results : []).forEach((id) => ids.add(upper(id)));
    if (ids.size) break;
  }
  return Array.from(ids);
}

function candidatesFromItem(item = {}) {
  const common = {
    item_id: upper(item.id),
    title: text(item.title),
    status: text(item.status),
    category_id: text(item.category_id),
    listing_type_id: text(item.listing_type_id),
    listing_type_label: listingTypeLabel(item.listing_type_id),
    thumbnail: item.secure_thumbnail || item.thumbnail || null,
    permalink: item.permalink || null,
    free_shipping: !!item?.shipping?.free_shipping,
    shipping_mode: text(item?.shipping?.mode),
    logistic_type: text(item?.shipping?.logistic_type),
    shipping_dimensions: text(item?.shipping?.dimensions),
    shipping_weight: num(item?.shipping?.weight, 0),
    seller_id: item.seller_id || null,
    inventory_id: item.inventory_id || null,
  };
  const variations = Array.isArray(item.variations) ? item.variations : [];
  if (!variations.length) {
    return [{
      ...common,
      variation_id: "",
      variation_label: "Anúncio",
      reference_sku: extractSku(item.attributes, item.seller_custom_field || item.seller_sku),
      price: num(item.price),
      stock: num(item.available_quantity),
    }];
  }
  return variations.map((variation) => ({
    ...common,
    variation_id: text(variation.id),
    variation_label: variationLabel(variation),
    reference_sku: extractSku(variation.attributes, variation.seller_custom_field || variation.seller_sku),
    price: num(variation.price) || num(item.price),
    stock: num(variation.available_quantity),
  }));
}

function filterOwnedItems(items = [], sellerId) {
  const expected = text(sellerId);
  return (Array.isArray(items) ? items : []).filter((item) => {
    const owner = text(item?.seller_id);
    return Boolean(expected && owner && owner === expected);
  });
}

function buildCategoryDiscoveryUrl(query) {
  const url = new URL(`${ML_API}/sites/MLB/domain_discovery/search`);
  url.searchParams.set("q", text(query));
  url.searchParams.set("limit", "3");
  return url;
}

function normalizeCategorySuggestions(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    id: text(row?.category_id),
    name: text(row?.category_name),
    domain_id: text(row?.domain_id),
    domain_name: text(row?.domain_name),
  })).filter((row) => row.id && row.name).slice(0, 3);
}

function buildListingFeeUrl({ price, categoryId, listingTypeId, shippingMode, logisticType, dimensions, weight }) {
  const url = new URL(`${ML_API}/sites/MLB/listing_prices`);
  url.searchParams.set("price", Number(num(price).toFixed(2)));
  url.searchParams.set("category_id", text(categoryId));
  url.searchParams.set("listing_type_id", text(listingTypeId));
  if (text(shippingMode)) url.searchParams.set("shipping_mode", text(shippingMode));
  if (text(logisticType)) url.searchParams.set("logistic_type", text(logisticType));
  if (text(dimensions)) url.searchParams.set("dimensions", text(dimensions));
  if (num(weight) > 0) url.searchParams.set("weight", num(weight));
  return url;
}

async function fetchListingFee(state, context = {}) {
  const { price, categoryId, listingTypeId } = context;
  if (!(num(price) > 0) || !text(categoryId) || !text(listingTypeId)) {
    return {
      sale_fee: 0,
      listing_fee: 0,
      fixed_fee: 0,
      percentage_fee: null,
      listing_fixed_fee: 0,
      source: "manual",
    };
  }
  const url = buildListingFeeUrl(context);
  let payload;
  try {
    payload = await listingPriceRequest(state, url.toString());
  } catch (cause) {
    throw error("Tarifa do Mercado Livre indisponivel. Tente novamente ou use a comissao manual.", 502, cause?.payload || null);
  }
  const row = Array.isArray(payload?.listing_prices)
    ? payload.listing_prices[0]
    : Array.isArray(payload)
      ? payload[0]
      : payload;
  const saleDetails = row?.sale_fee_details && typeof row.sale_fee_details === "object"
    ? row.sale_fee_details
    : {};
  const listingDetails = row?.listing_fee_details && typeof row.listing_fee_details === "object"
    ? row.listing_fee_details
    : {};
  if (!row || !Number.isFinite(Number(row.sale_fee_amount)) && !Number.isFinite(Number(row.listing_fee_amount))) {
    throw error("Tarifa do Mercado Livre indisponivel. Tente novamente ou use a comissao manual.", 502);
  }
  return {
    sale_fee: num(row?.sale_fee_amount),
    listing_fee: num(row?.listing_fee_amount),
    fixed_fee: num(saleDetails?.fixed_fee),
    percentage_fee: saleDetails?.percentage_fee == null ? null : num(saleDetails.percentage_fee),
    listing_fixed_fee: listingDetails?.fixed_fee == null ? null : num(listingDetails.fixed_fee),
    source: row ? "listing_prices" : "unavailable",
  };
}

function collectShippingRows(payload) {
  const rows = [];
  const push = (value) => {
    if (!value) return;
    if (Array.isArray(value)) return value.forEach(push);
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
  return rows;
}

function preferredPositive(values) {
  const valid = values.map(Number).filter((value) => Number.isFinite(value) && value >= 0);
  const positive = valid.filter((value) => value > 0);
  return positive.length ? Math.min(...positive) : valid.length ? 0 : null;
}

async function fetchSellerShipping(state, item, sellerId, priceOverride = null) {
  if (!item?.shipping?.free_shipping) return { seller_cost: 0, source: "buyer_paid" };
  const price = num(priceOverride, num(item.price));
  const attempts = [];
  if (sellerId && text(item?.shipping?.mode) === "me2") {
    const url = new URL(`${ML_API}/users/${encodeURIComponent(String(sellerId))}/shipping_options/free`);
    url.searchParams.set("item_id", upper(item.id));
    url.searchParams.set("mode", "me2");
    url.searchParams.set("free_shipping", "true");
    url.searchParams.set("item_price", Number(price.toFixed(2)));
    if (item.listing_type_id) url.searchParams.set("listing_type_id", item.listing_type_id);
    if (item?.shipping?.logistic_type) url.searchParams.set("logistic_type", item.shipping.logistic_type);
    attempts.push({ url: url.toString(), source: "users_shipping_options_free" });
  }
  attempts.push({
    url: `${ML_API}/items/${encodeURIComponent(upper(item.id))}/shipping_options/free`,
    source: "items_shipping_options_free",
  });
  for (const attempt of attempts) {
    const payload = await mlJson(state, attempt.url).catch(() => null);
    if (!payload) continue;
    const costs = collectShippingRows(payload).flatMap((row) => [
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
    ]);
    const sellerCost = preferredPositive(costs);
    if (Number.isFinite(sellerCost)) return { seller_cost: sellerCost, source: attempt.source };
  }
  return { seller_cost: 0, source: "unavailable" };
}

async function savedCostForSku(context, sku) {
  const cleanSku = text(sku);
  if (!cleanSku) return 0;
  const payload = await getFinanceiroMlService().listCosts({
    q: cleanSku,
    lookup_type: "sku",
    status: "all",
    page: 1,
    pageSize: 25,
  }, context).catch(() => null);
  const exact = (Array.isArray(payload?.items) ? payload.items : []).find(
    (row) => upper(row?.reference_sku) === upper(cleanSku),
  );
  return Math.max(0, num(exact?.cost));
}

async function accountTax(context) {
  const payload = await getFinanceiroMlService().getTax({}, context).catch(() => null);
  return Math.max(0, num(payload?.config?.aliquota));
}

async function pricingForCandidate({ state, candidate, itemBody, seller, context }) {
  const [cost, taxPct, fee, shipping] = await Promise.all([
    savedCostForSku(context, candidate.reference_sku),
    accountTax(context),
    fetchListingFee(state, {
      price: candidate.price,
      categoryId: candidate.category_id,
      listingTypeId: candidate.listing_type_id,
      shippingMode: candidate.shipping_mode,
      logisticType: candidate.logistic_type,
      dimensions: candidate.shipping_dimensions,
      weight: candidate.shipping_weight,
    }),
    fetchSellerShipping(state, itemBody, seller.id, candidate.price),
  ]);
  const decomposition = decomposeMarketplaceFee({
    price: candidate.price,
    saleFee: fee.sale_fee,
    listingFee: fee.listing_fee,
    percentageFee: fee.percentage_fee,
    fixedFee: fee.fixed_fee,
    listingFixedFee: fee.listing_fixed_fee,
  });
  const snapshot = calculatePricingSnapshot({
    price: candidate.price,
    productCost: cost,
    commissionRate: decomposition.commission_rate,
    commissionFixed: decomposition.commission_fixed,
    commissionAmount: decomposition.commission,
    taxRate: percentRate(taxPct),
    sellerShipping: shipping.seller_cost,
    buyerShippingTaxable: 0,
  });
  return {
    ...candidate,
    product_cost: round(cost, 2),
    tax_rate_pct: round(taxPct, 4),
    commission: decomposition.commission,
    commission_rate_pct: decomposition.commission_rate_pct,
    commission_fixed: decomposition.commission_fixed,
    seller_shipping: round(shipping.seller_cost, 2),
    fee_source: fee.source,
    shipping_source: shipping.source,
    snapshot,
  };
}

class FinanceiroMlCalculatorService {
  static async categories(query = {}, context = {}) {
    requireAccountKey(context);
    const term = text(query.q || query.query);
    if (term.length < 3) return { success: true, categories: [] };
    const state = await prepareAuthState({
      accessToken: context?.mlCreds?.access_token || null,
      mlCreds: context.mlCreds || {},
    });
    const payload = await mlJson(state, buildCategoryDiscoveryUrl(term).toString());
    return { success: true, categories: normalizeCategorySuggestions(payload) };
  }

  static async lookup(query = {}, context = {}) {
    requireAccountKey(context);
    const term = text(query.q || query.query || query.identifier);
    if (!term) throw error("Informe um MLB ou SKU para carregar o anúncio.");
    const state = await prepareAuthState({
      accessToken: context?.mlCreds?.access_token || null,
      mlCreds: context.mlCreds || {},
    });
    const seller = await sellerInfo(state, context.mlCreds || {});
    const ids = await findItemIds(state, seller.id, term);
    if (!ids.length) throw error("Nenhum anúncio encontrado para o MLB/SKU informado.", 404);
    const allBodies = await fetchItemBodies(state, ids.slice(0, 20));
    const bodies = filterOwnedItems(allBodies, seller.id);
    if (!bodies.length) throw error("O MLB informado não pertence à conta ativa.", 404);
    let candidates = bodies.flatMap(candidatesFromItem);
    if (!isMlb(term)) {
      const exact = candidates.filter((row) => upper(row.reference_sku) === upper(term));
      if (exact.length) candidates = exact;
    }
    if (!candidates.length) throw error("O anúncio foi encontrado, mas não possui uma combinação utilizável para a calculadora.", 404);

    const wantedVariation = text(query.variation_id || query.variationId);
    const selected = candidates.find((row) => wantedVariation && text(row.variation_id) === wantedVariation) || candidates[0];
    const body = bodies.find((row) => upper(row.id) === upper(selected.item_id)) || bodies[0];
    const enriched = await pricingForCandidate({ state, candidate: selected, itemBody: body, seller, context });

    return {
      success: true,
      query: term,
      account: { seller_id: seller.id, nickname: seller.nickname || null },
      selected: enriched,
      candidates: candidates.map((row) => ({
        item_id: row.item_id,
        variation_id: row.variation_id,
        variation_label: row.variation_label,
        reference_sku: row.reference_sku,
        title: row.title,
        price: row.price,
        stock: row.stock,
        listing_type_id: row.listing_type_id,
        listing_type_label: row.listing_type_label,
      })),
      defaults: {
        tax_rate_pct: enriched.tax_rate_pct,
        buyer_shipping_taxable: 0,
        operation_cost: 0,
        other_costs: 0,
      },
      note: enriched.shipping_source === "unavailable" && enriched.free_shipping
        ? "O anúncio usa frete grátis, mas a tarifa do vendedor não pôde ser consultada agora. Revise o campo de frete antes de simular."
        : "Dados carregados da conta ativa. Você pode ajustar os valores antes de calcular.",
    };
  }

  static async calculate(body = {}, context = {}, options = {}) {
    requireAccountKey(context);
    const price = Math.max(0, num(body.price ?? body.sale_price));
    if (!(price > 0)) throw error("Informe um preço de venda maior que zero.");
    const productCost = Math.max(0, num(body.product_cost ?? body.cost));
    const taxPct = Math.max(0, num(body.tax_rate_pct ?? body.tax_pct ?? body.tax));
    const sellerShipping = Math.max(0, num(body.seller_shipping ?? body.shipping));
    const buyerShipping = Math.max(0, num(body.buyer_shipping_taxable ?? body.buyer_shipping));
    const operationCost = Math.max(0, num(body.operation_cost));
    const otherCosts = Math.max(0, num(body.other_costs));
    const targetMarginPct = text(body.target_margin_pct ?? body.target_margin) === ""
      ? null
      : Math.max(0, num(body.target_margin_pct ?? body.target_margin));
    if (targetMarginPct != null && targetMarginPct >= 95) {
      throw error("A margem desejada deve ser menor que 95%.");
    }

    const categoryId = text(body.category_id);
    const listingTypeId = text(body.listing_type_id);
    const mode = text(body.mode || "manual") || "manual";
    const requestedMlFee = bool(body.use_ml_fee, Boolean(categoryId && listingTypeId));
    const useMlFee = requestedMlFee && !options.estimatedFallback;
    if (useMlFee && (!categoryId || !listingTypeId)) {
      throw error("A categoria e o tipo de anuncio sao obrigatorios para consultar a tarifa do Mercado Livre.");
    }
    try {
    const state = useMlFee
      ? await prepareAuthState({
          accessToken: context?.mlCreds?.access_token || null,
          mlCreds: context.mlCreds || {},
        })
      : null;

    async function feeAt(targetPrice) {
      if (useMlFee && state && categoryId && listingTypeId) {
        const fee = await fetchListingFee(state, {
          price: targetPrice,
          categoryId,
          listingTypeId,
          shippingMode: body.shipping_mode,
          logisticType: body.logistic_type,
          dimensions: body.shipping_dimensions,
          weight: body.shipping_weight,
        });
        return decomposeMarketplaceFee({
          price: targetPrice,
          saleFee: fee.sale_fee,
          listingFee: fee.listing_fee,
          percentageFee: fee.percentage_fee,
          fixedFee: fee.fixed_fee,
          listingFixedFee: fee.listing_fixed_fee,
        });
      }
      const ratePct = Math.max(0, num(body.commission_rate_pct ?? body.commission_pct));
      const fixed = Math.max(0, num(body.commission_fixed));
      return {
        commission: round(targetPrice * percentRate(ratePct) + fixed, 2),
        commission_rate: percentRate(ratePct),
        commission_rate_pct: round(ratePct, 4),
        commission_fixed: round(fixed, 2),
      };
    }

    async function quote(targetPrice, targetMargin = null) {
      const fee = await feeAt(targetPrice);
      return calculatePricingSnapshot({
        price: targetPrice,
        productCost,
        commissionRate: fee.commission_rate,
        commissionFixed: fee.commission_fixed,
        commissionAmount: fee.commission,
        taxRate: percentRate(taxPct),
        sellerShipping,
        buyerShippingTaxable: buyerShipping,
        operationCost,
        otherCosts,
        targetMargin,
      });
    }

    const currentFee = await feeAt(price);
    const current = await quote(price, targetMarginPct == null ? null : percentRate(targetMarginPct));

    let equilibriumPrice = current.equilibrium_price;
    let equilibriumExact = false;
    if (useMlFee && state && categoryId && listingTypeId) {
      const equilibrium = await solveTargetPrice({
        targetMargin: 0,
        seedPrice: current.equilibrium_price || price,
        quote: (candidate) => quote(candidate, 0),
        maxIterations: 7,
      });
      if (equilibrium.price != null) {
        equilibriumPrice = equilibrium.price;
        equilibriumExact = equilibrium.converged;
      }
    }

    let targetPrice = targetMarginPct == null ? null : current.target_price;
    let targetExact = false;
    let targetSnapshot = null;
    if (targetMarginPct != null && useMlFee && state && categoryId && listingTypeId) {
      const solved = await solveTargetPrice({
        targetMargin: percentRate(targetMarginPct),
        seedPrice: targetPrice || price,
        quote: (candidate) => quote(candidate, percentRate(targetMarginPct)),
        maxIterations: 8,
      });
      if (solved.price != null) targetPrice = solved.price;
      targetExact = solved.converged;
      targetSnapshot = solved.snapshot || null;
    }

    const deltaToTarget = targetPrice == null ? null : round(targetPrice - price, 2);
    const targetStatus = targetMarginPct == null
      ? "sem_meta"
      : current.margin_pct + 0.05 < targetMarginPct
        ? "abaixo"
        : current.margin_pct - 0.05 > targetMarginPct
          ? "acima"
          : "na_meta";

    return {
      success: true,
      mode,
      fee_mode: useMlFee && categoryId && listingTypeId ? "mercado_livre" : mode === "manual" ? "estimativa" : "manual",
      listing: {
        item_id: text(body.item_id),
        variation_id: text(body.variation_id),
        reference_sku: text(body.reference_sku),
        category_id: categoryId,
        listing_type_id: listingTypeId,
        listing_type_label: listingTypeLabel(listingTypeId),
      },
      inputs: {
        price: round(price, 2),
        product_cost: round(productCost, 2),
        tax_rate_pct: round(taxPct, 4),
        seller_shipping: round(sellerShipping, 2),
        buyer_shipping_taxable: round(buyerShipping, 2),
        operation_cost: round(operationCost, 2),
        other_costs: round(otherCosts, 2),
        target_margin_pct: targetMarginPct == null ? null : round(targetMarginPct, 2),
      },
      commission: {
        amount: currentFee.commission,
        rate_pct: currentFee.commission_rate_pct,
        fixed: currentFee.commission_fixed,
      },
      result: {
        ...current,
        equilibrium_price: equilibriumPrice,
        target_price: targetPrice,
        target_delta: deltaToTarget,
        target_status: targetStatus,
        equilibrium_exact: equilibriumExact,
        target_exact: targetExact,
        target_margin_achieved_pct: targetSnapshot?.margin_pct ?? null,
      },
      note: useMlFee && categoryId && listingTypeId
        ? "A comissão foi consultada no Mercado Livre para o preço informado. O preço-alvo recalcula a tarifa por faixa durante a simulação."
        : options.estimatedFallback
          ? "Não foi possível consultar a comissão agora. A simulação usa a estimativa selecionada."
          : mode === "manual"
            ? "A simulação usa a comissão estimada até que categoria e preço permitam a consulta no Mercado Livre."
            : "A simulação usa a comissão percentual/fixa informada manualmente.",
    };
    } catch (cause) {
      if (mode === "manual" && requestedMlFee && !options.estimatedFallback && Number(cause?.status) === 502) {
        return FinanceiroMlCalculatorService.calculate({ ...body, use_ml_fee: false }, context, { estimatedFallback: true });
      }
      throw cause;
    }
  }
}

FinanceiroMlCalculatorService._test = {
  candidatesFromItem,
  extractSku,
  listingTypeLabel,
  buildCategoryDiscoveryUrl,
  normalizeCategorySuggestions,
  buildListingFeeUrl,
  filterOwnedItems,
  fetchListingFee,
  setListingPriceRequest(request) {
    listingPriceRequest = request;
  },
  resetListingPriceRequest() {
    listingPriceRequest = mlJson;
  },
};

module.exports = FinanceiroMlCalculatorService;
