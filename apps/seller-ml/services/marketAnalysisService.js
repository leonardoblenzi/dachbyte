"use strict";

const fetch = require("node-fetch");
const TokenService = require("./tokenService");

const ML_API = "https://api.mercadolibre.com";
const DEFAULT_SITE_ID = "MLB";
const DEFAULT_SAMPLE_LIMIT = 50;
const MAX_SAMPLE_LIMIT = 100;
const MAX_ANALYSIS_CATALOG_PRODUCTS = 16;
const MAX_CATALOG_SEARCH_LIMIT = 50;
const MAX_KEYWORD_CATALOG_PRODUCTS = 100;
const MAX_KEYWORD_RESULTS = 500;
const MAX_PDP_PRODUCTS = 10;
const MAX_USER_PRODUCT_SOURCES = 8;
const PDP_CONCURRENCY = 3;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toInt(value, fallback) {
  const n = parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeCategoryId(value) {
  return normalizeText(value).toUpperCase();
}

function normalizeDomainId(value) {
  return normalizeText(value).toUpperCase();
}

function normalizeSiteId(value) {
  const siteId = normalizeText(value || DEFAULT_SITE_ID).toUpperCase();
  return /^[A-Z]{3}$/.test(siteId) ? siteId : DEFAULT_SITE_ID;
}

function normalizePrice(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function median(values) {
  const nums = (values || []).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function average(values) {
  const nums = (values || []).filter((value) => Number.isFinite(value));
  if (!nums.length) return null;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function pct(count, total) {
  const c = Number(count || 0);
  const t = Number(total || 0);
  return t > 0 ? (c / t) * 100 : null;
}

function uniqBy(rows, getKey) {
  const out = [];
  const seen = new Set();
  for (const row of rows || []) {
    const key = getKey(row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

async function mapLimit(rows, concurrency, fn) {
  const list = Array.isArray(rows) ? rows : [];
  const limit = clamp(toInt(concurrency, 3), 1, 8);
  const results = new Array(list.length);
  let index = 0;

  async function worker() {
    while (true) {
      const current = index;
      index += 1;
      if (current >= list.length) return;
      results[current] = await fn(list[current], current);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, () => worker()));
  return results;
}

async function getAccessToken(mlCreds) {
  const token = await TokenService.renovarTokenSeNecessario(mlCreds || {});
  if (!token) {
    const error = new Error("Não foi possível obter o token da conta Mercado Livre.");
    error.code = "ML_TOKEN_UNAVAILABLE";
    throw error;
  }
  return token;
}

async function mlFetchJson(path, { token, query = {}, method = "GET", body = null } = {}) {
  const url = new URL(path.startsWith("http") ? path : `${ML_API}${path}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== null) headers["Content-Type"] = "application/json";

  const response = await fetch(url.toString(), {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!response.ok) {
    const detail = json?.message || json?.error || text || `HTTP ${response.status}`;
    const error = new Error(detail);
    error.status = response.status;
    error.payload = json;
    error.endpoint = `${url.pathname}${url.search}`;
    error.upstreamCode = json?.code || json?.error || null;
    error.blockedBy = json?.blocked_by || json?.cause?.[0]?.code || null;
    throw error;
  }

  return json;
}

function warningFromError(code, message, error, source) {
  return {
    code,
    source,
    message,
    detail: error?.message || null,
    upstream_status: Number.isFinite(Number(error?.status)) ? Number(error.status) : null,
    upstream_code: error?.upstreamCode || error?.payload?.code || error?.payload?.error || null,
    blocked_by: error?.blockedBy || error?.payload?.blocked_by || null,
    endpoint: error?.endpoint || null,
  };
}

function normalizeTrends(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row, index) => {
      const rank = index + 1;
      let segment = "popular";
      let segmentLabel = "Tendência popular";
      if (rank <= 10) {
        segment = "growth";
        segmentLabel = "Maior crescimento";
      } else if (rank <= 30) {
        segment = "desired";
        segmentLabel = "Mais desejada";
      }
      return {
        rank,
        keyword: normalizeText(row?.keyword),
        url: row?.url || null,
        segment,
        segment_label: segmentLabel,
      };
    })
    .filter((row) => row.keyword);
}

function normalizeCategory(row) {
  const categoryId = normalizeCategoryId(row?.category_id || row?.id);
  return {
    id: categoryId,
    name: normalizeText(row?.category_name || row?.name) || categoryId,
    domain_id: normalizeDomainId(row?.domain_id) || null,
    domain_name: normalizeText(row?.domain_name) || null,
    attributes: Array.isArray(row?.attributes) ? row.attributes : [],
  };
}

function normalizeCatalogProduct(product) {
  const pictures = Array.isArray(product?.pictures) ? product.pictures : [];
  const picture = pictures.find((row) => row?.url || row?.secure_url) || null;
  const winner = product?.buy_box_winner || null;
  const shipping = winner?.shipping || {};
  const logisticType = normalizeText(shipping?.logistic_type).toLowerCase();

  return {
    id: product?.id || null,
    title: normalizeText(product?.name || product?.family_name) || product?.id || "Produto de catálogo",
    family_name: normalizeText(product?.family_name) || null,
    domain_id: normalizeDomainId(product?.domain_id) || null,
    status: product?.status || null,
    permalink: product?.permalink || null,
    thumbnail: picture?.secure_url || picture?.url || product?.thumbnail || null,
    listing_strategy: product?.settings?.listing_strategy || null,
    price: normalizePrice(winner?.price),
    currency_id: winner?.currency_id || "BRL",
    winner_item_id: winner?.item_id || null,
    winner_seller_id: winner?.seller_id || null,
    free_shipping: Boolean(shipping?.free_shipping),
    logistic_type: logisticType || null,
    is_full: logisticType === "fulfillment",
    attributes: (Array.isArray(product?.attributes) ? product.attributes : []).map((attribute) => ({
      id: attribute?.id || null,
      name: normalizeText(attribute?.name) || null,
      value_name: normalizeText(attribute?.value_name) || null,
      values: Array.isArray(attribute?.values)
        ? attribute.values.map((value) => normalizeText(value?.name)).filter(Boolean)
        : [],
    })),
  };
}

function normalizeMarketplaceItem(item, extra = {}) {
  const shipping = item?.shipping || {};
  const tags = Array.isArray(item?.tags) ? item.tags : [];
  const logisticType = normalizeText(shipping?.logistic_type || item?.logistic_type).toLowerCase();

  return {
    id: item?.item_id || item?.id || null,
    title: normalizeText(item?.title || extra?.title) || item?.item_id || item?.id || "Oferta",
    price: normalizePrice(item?.price),
    currency_id: item?.currency_id || extra?.currency_id || "BRL",
    thumbnail: item?.thumbnail || item?.secure_thumbnail || extra?.thumbnail || null,
    permalink: item?.permalink || extra?.permalink || null,
    seller_id: item?.seller?.id || item?.seller_id || null,
    seller_nickname: item?.seller?.nickname || null,
    category_id: item?.category_id || extra?.category_id || null,
    listing_type_id: item?.listing_type_id || null,
    condition: item?.condition || null,
    available_quantity: Number.isFinite(Number(item?.available_quantity)) ? Number(item.available_quantity) : null,
    free_shipping: Boolean(shipping?.free_shipping),
    logistic_type: logisticType || null,
    is_full: logisticType === "fulfillment" || tags.includes("fulfillment"),
    is_catalog: Boolean(extra?.catalogProductId || item?.catalog_listing || item?.catalog_product_id || tags.includes("catalog")),
    catalog_product_id: extra?.catalogProductId || item?.catalog_product_id || null,
    source: extra?.source || "catalog_pdp",
    source_label: extra?.sourceLabel || "Página de produto",
    best_seller_position: extra?.bestSellerPosition || null,
  };
}


const KEYWORD_STOPWORDS = new Set([
  "a", "ao", "aos", "as", "o", "os", "de", "da", "das", "do", "dos", "e", "em", "na", "nas", "no", "nos",
  "para", "por", "com", "sem", "que", "um", "uma", "uns", "umas", "se", "ou", "mais", "menos", "muito", "muita",
  "muitos", "muitas", "novo", "nova", "novos", "novas", "original", "kit", "unidade", "unidades", "peca", "pecas",
  "produto", "produtos", "oferta", "promocao", "ml", "mercado", "livre", "brasil", "envio", "frete", "gratis",
]);

function foldKeywordText(value) {
  return normalizeText(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function displayKeywordText(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^0-9a-zA-ZÀ-ÿ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function keywordTokenRows(value) {
  const display = displayKeywordText(value).split(" ").filter(Boolean);
  return display.map((token) => ({ display: token, folded: foldKeywordText(token) }))
    .filter((row) => row.folded && row.folded.length >= 2);
}

function meaningfulKeywordTokens(value) {
  return keywordTokenRows(value)
    .map((row) => row.folded)
    .filter((token) => token.length >= 3 && !KEYWORD_STOPWORDS.has(token) && !/^\d+$/.test(token));
}

function containsKeyword(text, keyword) {
  const haystack = new Set(meaningfulKeywordTokens(text));
  const needles = meaningfulKeywordTokens(keyword);
  return needles.length > 0 && needles.every((token) => haystack.has(token));
}

function attributeSearchText(attributes) {
  return (Array.isArray(attributes) ? attributes : []).map((attribute) => {
    const values = [attribute?.value_name, ...(Array.isArray(attribute?.values) ? attribute.values : [])]
      .map((value) => typeof value === "string" ? value : value?.name)
      .filter(Boolean);
    return [attribute?.name, ...values].filter(Boolean).join(" ");
  }).filter(Boolean).join(" ");
}

function titleKeywordCandidates(titles, { minCount = 2, max = 60 } = {}) {
  const rows = Array.isArray(titles) ? titles.filter(Boolean) : [];
  const counts = new Map();
  const displays = new Map();

  for (const title of rows) {
    const tokens = keywordTokenRows(title);
    const seenInTitle = new Set();
    let chunk = [];
    const chunks = [];
    for (const token of tokens) {
      if (KEYWORD_STOPWORDS.has(token.folded) || token.folded.length < 3 || /^\d+$/.test(token.folded)) {
        if (chunk.length) chunks.push(chunk);
        chunk = [];
      } else {
        chunk.push(token);
      }
    }
    if (chunk.length) chunks.push(chunk);

    for (const part of chunks) {
      for (let size = 1; size <= 3; size += 1) {
        if (size > part.length) break;
        for (let start = 0; start + size <= part.length; start += 1) {
          const slice = part.slice(start, start + size);
          const key = slice.map((row) => row.folded).join(" ");
          if (key.length < 4 || seenInTitle.has(key)) continue;
          seenInTitle.add(key);
          counts.set(key, (counts.get(key) || 0) + 1);
          if (!displays.has(key)) displays.set(key, slice.map((row) => row.display).join(" "));
        }
      }
    }
  }

  const threshold = Math.max(1, toInt(minCount, 2));
  return [...counts.entries()]
    .filter(([, count]) => count >= threshold)
    .map(([key, count]) => ({ key, keyword: displays.get(key) || key, count }))
    .sort((a, b) => (b.count - a.count) || (b.key.split(" ").length - a.key.split(" ").length))
    .slice(0, max);
}

function trendWeight(trend) {
  const rank = Number(trend?.rank || 50);
  if (trend?.segment === "growth") return 58 + clamp(11 - rank, 0, 10) * 0.8;
  if (trend?.segment === "desired") return 50 + clamp(31 - rank, 0, 20) * 0.35;
  return 42 + clamp(51 - rank, 0, 20) * 0.25;
}

function itemKeywordView(item) {
  if (!item) return null;
  const attributes = Array.isArray(item?.attributes) ? item.attributes : [];
  const pictures = Array.isArray(item?.pictures) ? item.pictures : [];
  const picture = pictures.find((row) => row?.secure_url || row?.url) || null;
  return {
    id: item?.id || null,
    title: normalizeText(item?.title) || item?.id || "Anúncio",
    category_id: normalizeCategoryId(item?.category_id) || null,
    seller_id: item?.seller_id || null,
    catalog_product_id: item?.catalog_product_id || null,
    permalink: item?.permalink || null,
    thumbnail: item?.thumbnail || item?.secure_thumbnail || picture?.secure_url || picture?.url || null,
    attributes: attributes.map((attribute) => ({
      id: attribute?.id || null,
      name: normalizeText(attribute?.name) || null,
      value_name: normalizeText(attribute?.value_name) || null,
      values: Array.isArray(attribute?.values)
        ? attribute.values.map((value) => normalizeText(value?.name)).filter(Boolean)
        : [],
    })),
  };
}

function buildKeywordRanking({
  trends,
  parentTrends = [],
  bestSellers,
  catalogProducts,
  navigation = null,
  item = null,
  query = "",
}) {
  const trendRows = Array.isArray(trends) ? trends : [];
  const parentTrendRows = Array.isArray(parentTrends) ? parentTrends : [];
  const leaders = (Array.isArray(bestSellers) ? bestSellers : []).filter((row) => normalizeText(row?.title));
  const catalog = (Array.isArray(catalogProducts) ? catalogProducts : []).filter((row) => normalizeText(row?.title));
  const leaderTitles = leaders.map((row) => row.title);
  const catalogTexts = catalog.map((row) => `${row.title || ""} ${attributeSearchText(row.attributes)}`.trim());
  const candidates = new Map();

  const ensure = (keyword) => {
    const display = displayKeywordText(keyword);
    const key = foldKeywordText(display);
    if (!key || meaningfulKeywordTokens(display).length === 0) return null;
    if (!candidates.has(key)) {
      candidates.set(key, {
        key,
        keyword: display,
        trend: null,
        parent_trend: null,
        leader_seed_count: 0,
        catalog_seed_count: 0,
        category_seed_count: 0,
        related_seed_count: 0,
        query_seed: false,
      });
    }
    return candidates.get(key);
  };

  for (const trend of trendRows) {
    const row = ensure(trend.keyword);
    if (row) row.trend = trend;
  }

  for (const trend of parentTrendRows) {
    const row = ensure(trend.keyword);
    if (row && !row.trend) row.parent_trend = trend;
  }

  for (const candidate of titleKeywordCandidates(leaderTitles, { minCount: 1, max: 240 })) {
    const row = ensure(candidate.keyword);
    if (row) row.leader_seed_count = Math.max(row.leader_seed_count, candidate.count);
  }

  for (const candidate of titleKeywordCandidates(catalogTexts, { minCount: 1, max: 320 })) {
    const row = ensure(candidate.keyword);
    if (row) row.catalog_seed_count = Math.max(row.catalog_seed_count, candidate.count);
  }

  const categoryTexts = [];
  const relatedTexts = [];
  for (const row of Array.isArray(navigation?.path) ? navigation.path : []) {
    if (row?.name) categoryTexts.push(row.name);
  }
  if (navigation?.parent?.name) categoryTexts.push(navigation.parent.name);
  for (const row of Array.isArray(navigation?.children) ? navigation.children : []) {
    if (row?.name) relatedTexts.push(row.name);
  }
  for (const row of Array.isArray(navigation?.siblings) ? navigation.siblings : []) {
    if (row?.name) relatedTexts.push(row.name);
  }

  for (const candidate of titleKeywordCandidates(categoryTexts, { minCount: 1, max: 80 })) {
    const row = ensure(candidate.keyword);
    if (row) row.category_seed_count = Math.max(row.category_seed_count, candidate.count);
  }
  for (const candidate of titleKeywordCandidates(relatedTexts, { minCount: 1, max: 140 })) {
    const row = ensure(candidate.keyword);
    if (row) row.related_seed_count = Math.max(row.related_seed_count, candidate.count);
  }

  const queryText = displayKeywordText(query);
  if (queryText && !/^MLB\d+$/i.test(queryText.replace(/\s+/g, ""))) {
    const row = ensure(queryText);
    if (row) row.query_seed = true;
  }

  const itemTitle = item?.title || "";
  const itemAttributes = attributeSearchText(item?.attributes);
  const itemCombined = `${itemTitle} ${itemAttributes}`.trim();
  const totalLeaders = leaderTitles.length;
  const totalCatalog = catalogTexts.length;

  const ranked = [...candidates.values()].map((candidate) => {
    const leaderCount = leaderTitles.filter((title) => containsKeyword(title, candidate.keyword)).length;
    const catalogCount = catalogTexts.filter((text) => containsKeyword(text, candidate.keyword)).length;
    const leaderPct = totalLeaders ? (leaderCount / totalLeaders) * 100 : 0;
    const catalogPct = totalCatalog ? (catalogCount / totalCatalog) * 100 : 0;
    const tokenCount = meaningfulKeywordTokens(candidate.keyword).length;
    const trendScore = candidate.trend ? trendWeight(candidate.trend) : 0;
    const parentTrendScore = candidate.parent_trend ? clamp(trendWeight(candidate.parent_trend) * 0.28, 10, 20) : 0;
    const leaderScore = clamp(leaderPct * 0.30, 0, 30);
    const catalogScore = clamp(catalogPct * 0.14, 0, 14);
    const categoryScore = candidate.category_seed_count > 0 ? 8 : 0;
    const relatedScore = candidate.related_seed_count > 0 ? 4 : 0;
    const specificity = tokenCount >= 3 ? 7 : tokenCount >= 2 ? 5 : 1;
    const queryScore = candidate.query_seed ? 5 : 0;
    const multiSourceBonus = [
      Boolean(candidate.trend),
      Boolean(candidate.parent_trend),
      leaderCount > 0 || candidate.leader_seed_count > 0,
      catalogCount > 0 || candidate.catalog_seed_count > 0,
      candidate.category_seed_count > 0,
      candidate.related_seed_count > 0,
    ].filter(Boolean).length >= 3 ? 4 : 0;
    const score = Math.round(clamp(
      trendScore + parentTrendScore + leaderScore + catalogScore + categoryScore + relatedScore + specificity + queryScore + multiSourceBonus,
      0,
      100,
    ));
    const sources = [];
    if (candidate.trend) sources.push("trends");
    if (candidate.parent_trend) sources.push("parent_trends");
    if (leaderCount > 0 || candidate.leader_seed_count > 0) sources.push("leaders");
    if (catalogCount > 0 || candidate.catalog_seed_count > 0) sources.push("catalog");
    if (candidate.category_seed_count > 0) sources.push("category");
    if (candidate.related_seed_count > 0) sources.push("related_category");
    if (candidate.query_seed) sources.push("query");

    let presentInItem = null;
    let itemLocations = [];
    if (item) {
      const inTitle = containsKeyword(itemTitle, candidate.keyword);
      const inAttributes = containsKeyword(itemAttributes, candidate.keyword);
      presentInItem = containsKeyword(itemCombined, candidate.keyword);
      if (inTitle) itemLocations.push("Título");
      if (inAttributes) itemLocations.push("Atributos");
      if (presentInItem && !itemLocations.length) itemLocations.push("Título + atributos");
    }

    let opportunityLevel = null;
    if (item && !presentInItem && score >= 45) {
      opportunityLevel = score >= 72 ? "high" : score >= 58 ? "medium" : "low";
    }

    return {
      keyword: candidate.keyword,
      score,
      sources,
      source_count: sources.length,
      trend_rank: candidate.trend?.rank || null,
      trend_segment: candidate.trend?.segment || null,
      trend_segment_label: candidate.trend?.segment_label || null,
      trend_url: candidate.trend?.url || null,
      parent_trend_rank: candidate.parent_trend?.rank || null,
      parent_trend_segment: candidate.parent_trend?.segment || null,
      parent_trend_segment_label: candidate.parent_trend?.segment_label || null,
      parent_trend_url: candidate.parent_trend?.url || null,
      leader_count: leaderCount,
      leader_total: totalLeaders,
      leader_presence_pct: totalLeaders ? leaderPct : null,
      catalog_count: catalogCount,
      catalog_total: totalCatalog,
      catalog_presence_pct: totalCatalog ? catalogPct : null,
      present_in_item: presentInItem,
      item_locations: itemLocations,
      opportunity_level: opportunityLevel,
      recommendation: item
        ? presentInItem
          ? "Já utilizada"
          : opportunityLevel
            ? "Validar aderência"
            : "Baixa prioridade"
        : null,
    };
  }).filter((row) => row.score >= 8 || row.trend_rank || row.parent_trend_rank)
    .sort((a, b) => (b.score - a.score)
      || ((a.trend_rank || 999) - (b.trend_rank || 999))
      || (b.source_count - a.source_count)
      || (b.leader_count - a.leader_count)
      || String(a.keyword).localeCompare(String(b.keyword), "pt-BR"))
    .slice(0, MAX_KEYWORD_RESULTS)
    .map((row, index) => ({ rank: index + 1, ...row }));

  const coverageBase = ranked.slice(0, 20);
  const coveredCount = item ? coverageBase.filter((row) => row.present_in_item).length : null;
  const coveragePct = item && coverageBase.length ? (coveredCount / coverageBase.length) * 100 : null;
  const opportunities = item
    ? ranked.filter((row) => !row.present_in_item && row.opportunity_level).slice(0, 20)
    : [];
  const leaderTerms = ranked
    .filter((row) => row.leader_count > 0)
    .sort((a, b) => (b.leader_presence_pct - a.leader_presence_pct) || (b.score - a.score))
    .slice(0, 25);

  return {
    keywords: ranked,
    leader_terms: leaderTerms,
    opportunities,
    summary: {
      keyword_count: ranked.length,
      trend_count: ranked.filter((row) => row.trend_rank).length,
      parent_trend_count: ranked.filter((row) => row.parent_trend_rank).length,
      leader_term_count: ranked.filter((row) => row.leader_count > 0).length,
      catalog_term_count: ranked.filter((row) => row.catalog_count > 0).length,
      category_term_count: ranked.filter((row) => (row.sources || []).includes("category") || (row.sources || []).includes("related_category")).length,
      multi_source_count: ranked.filter((row) => Number(row.source_count || 0) >= 2).length,
      coverage_base_count: item ? coverageBase.length : null,
      covered_count: coveredCount,
      coverage_pct: coveragePct,
      opportunity_count: opportunities.length,
      high_opportunity_count: opportunities.filter((row) => row.opportunity_level === "high").length,
    },
  };
}

function summarizeOffers(offers, category) {
  const rows = Array.isArray(offers) ? offers : [];
  const prices = rows.map((item) => item.price).filter((value) => Number.isFinite(value));
  const sellers = new Set(rows.map((item) => item.seller_id).filter(Boolean));
  const sampleCount = rows.length;
  const categoryTotal = Number(category?.total_items_in_this_category);

  return {
    total_items_estimated: Number.isFinite(categoryTotal) ? categoryTotal : null,
    category_total_items: Number.isFinite(categoryTotal) ? categoryTotal : null,
    sample_count: sampleCount,
    sellers_in_sample: sellers.size,
    avg_price: average(prices),
    median_price: median(prices),
    min_price: prices.length ? Math.min(...prices) : null,
    max_price: prices.length ? Math.max(...prices) : null,
    free_shipping_pct: pct(rows.filter((item) => item.free_shipping).length, sampleCount),
    full_pct: pct(rows.filter((item) => item.is_full).length, sampleCount),
    catalog_pct: pct(rows.filter((item) => item.is_catalog).length, sampleCount),
  };
}

function opportunityScore({ trends, bestSellers, summary, catalogProducts }) {
  const totalItems = Number(summary?.category_total_items || 0);
  const sellersInSample = Number(summary?.sellers_in_sample || 0);
  const sampleCount = Number(summary?.sample_count || 0);
  const medianPrice = Number(summary?.median_price || 0);
  const trendCount = Number(trends?.length || 0);
  const bestSellerCount = Number(bestSellers?.length || 0);
  const catalogCount = Number(catalogProducts?.length || 0);

  const demand = clamp((trendCount / 50) * 24 + (bestSellerCount / 20) * 12, 0, 36);
  const ticket = medianPrice > 0 ? clamp(Math.log10(Math.max(1, medianPrice)) * 5, 0, 16) : 0;
  const volumePenalty = totalItems > 0 ? clamp(Math.log10(Math.max(1, totalItems)) * 7, 0, 32) : 10;
  const sellerDensityPenalty = sampleCount > 0 ? clamp((sellersInSample / sampleCount) * 18, 0, 18) : 8;
  const catalogSignal = clamp((catalogCount / MAX_ANALYSIS_CATALOG_PRODUCTS) * 5, 0, 5);
  const score = clamp(Math.round(57 + demand + ticket + catalogSignal - volumePenalty - sellerDensityPenalty), 0, 100);

  let label = "Cenário intermediário";
  if (score >= 72) label = "Cenário atrativo";
  if (score < 45) label = "Concorrência elevada";

  const demandSources = (trendCount > 0 ? 1 : 0) + (bestSellerCount > 0 ? 1 : 0);
  let confidence = "baixa";
  if (sampleCount >= 25 && demandSources >= 1) confidence = "média";
  if (sampleCount >= 45 && demandSources >= 2) confidence = "alta";

  return {
    score,
    label,
    confidence,
    methodology: "davanti_market_v2",
    drivers: {
      demand: Math.round(demand),
      ticket: Math.round(ticket),
      catalog_signal: Math.round(catalogSignal),
      competition_penalty: Math.round(volumePenalty + sellerDensityPenalty),
    },
  };
}

async function searchCategoriesWithToken({ token, siteId, q }) {
  const cleanQ = normalizeText(q);
  if (!cleanQ) return [];

  const payload = await mlFetchJson(`/sites/${siteId}/domain_discovery/search`, {
    token,
    query: { limit: 8, q: cleanQ },
  });

  const seen = new Set();
  return (Array.isArray(payload) ? payload : [])
    .map(normalizeCategory)
    .filter((category) => {
      if (!category.id || seen.has(category.id)) return false;
      seen.add(category.id);
      return true;
    });
}

async function searchCatalogProductsWithToken({ token, siteId, q, domainId = null, limit = 12, offset = 0 }) {
  const cleanQ = normalizeText(q);
  if (!cleanQ) return { paging: {}, products: [] };

  const safeLimit = clamp(toInt(limit, 12), 1, MAX_CATALOG_SEARCH_LIMIT);
  const payload = await mlFetchJson("/products/search", {
    token,
    query: {
      status: "active",
      site_id: siteId,
      q: cleanQ,
      domain_id: normalizeDomainId(domainId) || undefined,
      limit: safeLimit,
      offset: Math.max(0, toInt(offset, 0)),
    },
  });

  return {
    paging: payload?.paging || {},
    products: (Array.isArray(payload?.results) ? payload.results : []).map(normalizeCatalogProduct),
  };
}

async function getCategoryInfoWithToken({ token, categoryId }) {
  const id = normalizeCategoryId(categoryId);
  if (!id) throw new Error("Categoria obrigatória.");

  const payload = await mlFetchJson(`/categories/${encodeURIComponent(id)}`, { token });
  return {
    id: payload?.id || id,
    name: payload?.name || id,
    path_from_root: Array.isArray(payload?.path_from_root) ? payload.path_from_root : [],
    children_categories: Array.isArray(payload?.children_categories) ? payload.children_categories : [],
    total_items_in_this_category: payload?.total_items_in_this_category ?? null,
    settings: payload?.settings || {},
  };
}

function normalizeCategoryTreeRow(row) {
  const id = normalizeCategoryId(row?.id || row?.category_id);
  if (!id) return null;
  const rawTotal = row?.total_items_in_this_category;
  return {
    id,
    name: normalizeText(row?.name || row?.category_name) || id,
    total_items_in_this_category: rawTotal !== null && rawTotal !== undefined && rawTotal !== "" && Number.isFinite(Number(rawTotal))
      ? Number(rawTotal)
      : null,
  };
}

async function getCategoryNavigationWithToken({ token, category }) {
  const current = category || {};
  const path = (Array.isArray(current.path_from_root) ? current.path_from_root : [])
    .map(normalizeCategoryTreeRow)
    .filter(Boolean);
  const children = (Array.isArray(current.children_categories) ? current.children_categories : [])
    .map(normalizeCategoryTreeRow)
    .filter(Boolean)
    .sort((a, b) => Number(b.total_items_in_this_category || 0) - Number(a.total_items_in_this_category || 0));

  const currentIndex = path.findIndex((row) => row.id === normalizeCategoryId(current.id));
  const parentRef = currentIndex > 0
    ? path[currentIndex - 1]
    : path.length > 1
      ? path[path.length - 2]
      : null;

  let parent = parentRef;
  let siblings = [];
  if (parentRef?.id) {
    try {
      const parentInfo = await getCategoryInfoWithToken({ token, categoryId: parentRef.id });
      parent = normalizeCategoryTreeRow(parentInfo) || parentRef;
      siblings = (Array.isArray(parentInfo.children_categories) ? parentInfo.children_categories : [])
        .map(normalizeCategoryTreeRow)
        .filter((row) => row && row.id !== normalizeCategoryId(current.id))
        .sort((a, b) => Number(b.total_items_in_this_category || 0) - Number(a.total_items_in_this_category || 0))
        .slice(0, 18);
    } catch {
      siblings = [];
    }
  }

  return {
    path,
    parent,
    children: children.slice(0, 24),
    siblings,
    mode: children.length ? "children" : siblings.length ? "siblings" : "none",
  };
}

async function searchKeywordCatalogPoolWithToken({ token, siteId, queries, domainId = null }) {
  const cleanQueries = uniqBy((Array.isArray(queries) ? queries : [])
    .map(normalizeText)
    .filter(Boolean), (value) => foldKeywordText(value));
  if (!cleanQueries.length) return { paging: {}, products: [] };

  const collected = [];
  let lastPaging = {};

  const fetchFirstPage = async (query, scopedDomainId) => {
    let lastError = null;
    for (const pageSize of [MAX_CATALOG_SEARCH_LIMIT, 20, 10]) {
      try {
        const page = await searchCatalogProductsWithToken({
          token,
          siteId,
          q: query,
          domainId: scopedDomainId,
          limit: pageSize,
          offset: 0,
        });
        return { page, pageSize: Number(page?.paging?.limit || pageSize) || pageSize };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("Falha ao consultar produtos de catálogo.");
  };

  const runQuery = async (query, scopedDomainId) => {
    const firstResult = await fetchFirstPage(query, scopedDomainId);
    const first = firstResult.page;
    const pageSize = Math.max(1, Number(firstResult.pageSize || 10));
    lastPaging = first.paging || lastPaging;
    collected.push(...first.products);

    const total = Number(first?.paging?.total || first.products.length || 0);
    let offset = pageSize;
    while (offset < total && collected.length < MAX_KEYWORD_CATALOG_PRODUCTS) {
      const page = await searchCatalogProductsWithToken({
        token,
        siteId,
        q: query,
        domainId: scopedDomainId,
        limit: pageSize,
        offset,
      });
      collected.push(...page.products);
      lastPaging = page.paging || lastPaging;
      if (!page.products.length) break;
      offset += pageSize;
    }
  };

  for (const query of cleanQueries) {
    await runQuery(query, domainId);
    if (collected.length >= MAX_KEYWORD_CATALOG_PRODUCTS) break;
  }

  if (!collected.length && domainId) {
    for (const query of cleanQueries) {
      await runQuery(query, null);
      if (collected.length >= MAX_KEYWORD_CATALOG_PRODUCTS) break;
    }
  }

  return {
    paging: lastPaging,
    products: uniqBy(collected, (row) => row?.id).slice(0, MAX_KEYWORD_CATALOG_PRODUCTS),
  };
}

async function getTrendsWithToken({ token, siteId, categoryId = null }) {
  const path = categoryId
    ? `/trends/${siteId}/${encodeURIComponent(normalizeCategoryId(categoryId))}`
    : `/trends/${siteId}`;
  const payload = await mlFetchJson(path, { token });
  return normalizeTrends(Array.isArray(payload) ? payload : []);
}

async function getHighlightsWithToken({ token, siteId, categoryId }) {
  const id = normalizeCategoryId(categoryId);
  const payload = await mlFetchJson(`/highlights/${siteId}/category/${encodeURIComponent(id)}`, { token });
  return (Array.isArray(payload?.content) ? payload.content : [])
    .map((row) => ({
      id: normalizeText(row?.id),
      position: Number.isFinite(Number(row?.position)) ? Number(row.position) : null,
      type: normalizeText(row?.type).toUpperCase() || "UNKNOWN",
    }))
    .filter((row) => row.id)
    .sort((a, b) => Number(a.position || 999) - Number(b.position || 999));
}

async function getCatalogProductDetailWithToken({ token, productId }) {
  const payload = await mlFetchJson(`/products/${encodeURIComponent(productId)}`, { token });
  return normalizeCatalogProduct(payload);
}

async function getUserProductDetailWithToken({ token, userProductId }) {
  const payload = await mlFetchJson(`/user-products/${encodeURIComponent(userProductId)}`, { token });
  const pictures = Array.isArray(payload?.pictures) ? payload.pictures : [];
  const picture = pictures.find((row) => row?.url || row?.secure_url) || null;
  return {
    id: payload?.id || userProductId,
    title: normalizeText(payload?.name) || payload?.id || userProductId,
    domain_id: normalizeDomainId(payload?.domain_id) || null,
    status: payload?.status || null,
    thumbnail: picture?.secure_url || picture?.url || null,
    seller_id: payload?.user_id || null,
  };
}

async function getItemsByIdsWithToken({ token, itemIds }) {
  const ids = uniqBy((itemIds || []).map(normalizeText).filter(Boolean), (id) => id);
  if (!ids.length) return [];

  const output = [];
  for (let start = 0; start < ids.length; start += 20) {
    const batch = ids.slice(start, start + 20);
    const payload = await mlFetchJson("/items", {
      token,
      query: { ids: batch.join(",") },
    });
    const rows = Array.isArray(payload) ? payload : [];
    for (const row of rows) {
      const body = row?.body || row;
      if (body?.id) output.push(body);
    }
  }
  return output;
}

async function getItemDetailWithToken({ token, itemId }) {
  const id = normalizeText(itemId).replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (!/^MLB\d+$/.test(id)) throw new Error("MLB inválido.");
  return mlFetchJson(`/items/${encodeURIComponent(id)}`, {
    token,
    query: { include_attributes: "all" },
  });
}

async function enrichHighlights({ token, highlights }) {
  const itemRows = highlights.filter((row) => row.type === "ITEM");
  const productRows = highlights.filter((row) => row.type === "PRODUCT");
  const userProductRows = highlights.filter((row) => row.type === "USER_PRODUCT");

  const itemDetails = await getItemsByIdsWithToken({
    token,
    itemIds: itemRows.map((row) => row.id),
  }).catch(() => []);
  const itemMap = new Map(itemDetails.map((row) => [row.id, row]));

  const productDetails = await mapLimit(productRows, 4, async (row) => {
    try {
      return await getCatalogProductDetailWithToken({ token, productId: row.id });
    } catch {
      return null;
    }
  });
  const productMap = new Map(productDetails.filter(Boolean).map((row) => [row.id, row]));

  const userProductDetails = await mapLimit(userProductRows, 4, async (row) => {
    try {
      return await getUserProductDetailWithToken({ token, userProductId: row.id });
    } catch {
      return null;
    }
  });
  const userProductMap = new Map(userProductDetails.filter(Boolean).map((row) => [row.id, row]));

  return highlights.map((row) => {
    if (row.type === "ITEM") {
      const item = itemMap.get(row.id) || {};
      const normalized = normalizeMarketplaceItem(item, {
        source: "best_seller_item",
        sourceLabel: "Mais vendido",
        bestSellerPosition: row.position,
      });
      return {
        ...row,
        type_label: "Anúncio",
        title: normalized.title || row.id,
        price: normalized.price,
        currency_id: normalized.currency_id,
        thumbnail: normalized.thumbnail,
        permalink: normalized.permalink,
        seller_id: normalized.seller_id,
        free_shipping: normalized.free_shipping,
        logistic_type: normalized.logistic_type,
      };
    }

    if (row.type === "PRODUCT") {
      const product = productMap.get(row.id) || {};
      return {
        ...row,
        type_label: "Produto de catálogo",
        title: product.title || row.id,
        price: product.price ?? null,
        currency_id: product.currency_id || "BRL",
        thumbnail: product.thumbnail || null,
        permalink: product.permalink || null,
        seller_id: product.winner_seller_id || null,
        free_shipping: Boolean(product.free_shipping),
        logistic_type: product.logistic_type || null,
      };
    }

    if (row.type === "USER_PRODUCT") {
      const product = userProductMap.get(row.id) || {};
      return {
        ...row,
        type_label: "User Product",
        title: product.title || row.id,
        price: null,
        currency_id: "BRL",
        thumbnail: product.thumbnail || null,
        permalink: null,
        seller_id: product.seller_id || null,
        free_shipping: false,
        logistic_type: null,
      };
    }

    return {
      ...row,
      type_label: row.type || "Outro",
      title: row.id,
      price: null,
      currency_id: "BRL",
      thumbnail: null,
      permalink: null,
      seller_id: null,
      free_shipping: false,
      logistic_type: null,
    };
  });
}

async function getPdpOffersWithToken({ token, product, limit }) {
  const payload = await mlFetchJson(`/products/${encodeURIComponent(product.id)}/items`, {
    token,
    query: { limit: clamp(toInt(limit, 10), 1, 100), offset: 0 },
  });
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.results) ? payload.results : [];
  return rows.map((item) => normalizeMarketplaceItem(item, {
    title: product.title,
    thumbnail: product.thumbnail,
    permalink: product.permalink,
    currency_id: product.currency_id,
    catalogProductId: product.id,
    source: "catalog_pdp",
    sourceLabel: "Página de produto",
  }));
}


async function getUserProductOffersWithToken({ token, row, limit = 3 }) {
  if (!row?.id || !row?.seller_id) return [];
  const search = await mlFetchJson(`/users/${encodeURIComponent(row.seller_id)}/items/search`, {
    token,
    query: {
      user_product_id: row.id,
      limit: clamp(toInt(limit, 3), 1, 20),
      offset: 0,
    },
  });
  const itemIds = (Array.isArray(search?.results) ? search.results : []).map(normalizeText).filter(Boolean);
  if (!itemIds.length) return [];
  const details = await getItemsByIdsWithToken({ token, itemIds });
  return details.map((item) => normalizeMarketplaceItem(item, {
    title: row.title,
    thumbnail: row.thumbnail,
    source: "user_product",
    sourceLabel: "User Product",
    bestSellerPosition: row.position,
  }));
}

function directOffersFromHighlights(bestSellers) {
  return (bestSellers || [])
    .filter((row) => row.type === "ITEM")
    .map((row) => normalizeMarketplaceItem({
      id: row.id,
      title: row.title,
      price: row.price,
      currency_id: row.currency_id,
      thumbnail: row.thumbnail,
      permalink: row.permalink,
      seller_id: row.seller_id,
      shipping: {
        free_shipping: row.free_shipping,
        logistic_type: row.logistic_type,
      },
    }, {
      source: "best_seller_item",
      sourceLabel: "Mais vendido",
      bestSellerPosition: row.position,
    }));
}

async function buildCompetitorSample({ token, bestSellers, catalogProducts, sampleLimit, warnings }) {
  const directOffers = directOffersFromHighlights(bestSellers);
  const userProductSources = (bestSellers || [])
    .filter((row) => row.type === "USER_PRODUCT" && row.seller_id)
    .slice(0, MAX_USER_PRODUCT_SOURCES);

  let userProductFailed = 0;
  const userProductChunks = await mapLimit(userProductSources, PDP_CONCURRENCY, async (row) => {
    try {
      return await getUserProductOffersWithToken({ token, row, limit: 3 });
    } catch {
      userProductFailed += 1;
      return [];
    }
  });
  const userProductOffers = userProductChunks.flat();

  if (userProductFailed > 0) {
    warnings.push({
      code: "USER_PRODUCT_OFFERS_PARTIAL",
      source: "user_products",
      message: `${userProductFailed} User Product(s) do ranking não puderam ter suas condições de venda carregadas.`,
      detail: null,
      upstream_status: null,
      upstream_code: null,
      blocked_by: null,
      endpoint: "/users/{SELLER_ID}/items/search?user_product_id={USER_PRODUCT_ID}",
    });
  }

  const highlightProductIds = bestSellers.filter((row) => row.type === "PRODUCT").map((row) => row.id);
  const catalogProductIds = (catalogProducts || []).map((row) => row.id);
  const productIds = uniqBy([...highlightProductIds, ...catalogProductIds].filter(Boolean), (id) => id)
    .slice(0, MAX_PDP_PRODUCTS);

  const productMeta = new Map();
  for (const row of catalogProducts || []) productMeta.set(row.id, row);
  for (const row of bestSellers || []) {
    if (row.type !== "PRODUCT") continue;
    productMeta.set(row.id, {
      id: row.id,
      title: row.title,
      thumbnail: row.thumbnail,
      permalink: row.permalink,
      currency_id: row.currency_id,
    });
  }

  if (!productIds.length) {
    return {
      offers: uniqBy([...directOffers, ...userProductOffers], (row) => row.id).slice(0, sampleLimit),
      pdp_products_analyzed: 0,
      pdp_products_failed: 0,
      user_products_analyzed: userProductSources.length - userProductFailed,
      user_products_failed: userProductFailed,
    };
  }

  const remaining = Math.max(1, sampleLimit - directOffers.length - userProductOffers.length);
  const perProduct = clamp(Math.ceil(remaining / productIds.length), 3, 25);
  let failed = 0;

  const chunks = await mapLimit(productIds, PDP_CONCURRENCY, async (productId) => {
    const meta = productMeta.get(productId) || { id: productId, title: productId, currency_id: "BRL" };
    try {
      return await getPdpOffersWithToken({ token, product: meta, limit: perProduct });
    } catch {
      failed += 1;
      return [];
    }
  });

  if (failed > 0) {
    warnings.push({
      code: "PDP_OFFERS_PARTIAL",
      source: "catalog_competition",
      message: `${failed} página(s) de produto não puderam ser lidas; a amostra foi montada com as demais fontes disponíveis.`,
      detail: null,
      upstream_status: null,
      upstream_code: null,
      blocked_by: null,
      endpoint: "/products/{PRODUCT_ID}/items",
    });
  }

  const offers = uniqBy([
    ...directOffers,
    ...userProductOffers,
    ...chunks.flat(),
  ], (row) => row.id).slice(0, sampleLimit);

  return {
    offers,
    pdp_products_analyzed: productIds.length - failed,
    pdp_products_failed: failed,
    user_products_analyzed: userProductSources.length - userProductFailed,
    user_products_failed: userProductFailed,
  };
}

async function safeSource({ warnings, code, source, message, run, fallback }) {
  try {
    return await run();
  } catch (error) {
    warnings.push(warningFromError(code, message, error, source));
    return fallback;
  }
}

async function search({ mlCreds, q }) {
  const cleanQ = normalizeText(q);
  if (!cleanQ) throw new Error("Informe um termo para pesquisar o mercado.");

  const token = await getAccessToken(mlCreds);
  const siteId = normalizeSiteId(mlCreds?.site_id);
  const warnings = [];

  const categories = await safeSource({
    warnings,
    code: "CATEGORY_PREDICTOR_UNAVAILABLE",
    source: "category_predictor",
    message: "O preditor de categorias do Mercado Livre não ficou disponível nesta consulta.",
    run: () => searchCategoriesWithToken({ token, siteId, q: cleanQ }),
    fallback: [],
  });

  const primaryDomainId = categories?.[0]?.domain_id || null;
  const catalog = await safeSource({
    warnings,
    code: "CATALOG_SEARCH_UNAVAILABLE",
    source: "catalog_search",
    message: "A busca de produtos de catálogo não ficou disponível nesta consulta.",
    run: async () => {
      const scoped = await searchCatalogProductsWithToken({
        token,
        siteId,
        q: cleanQ,
        domainId: primaryDomainId,
        limit: 12,
      });
      if (scoped.products.length || !primaryDomainId) return scoped;
      return searchCatalogProductsWithToken({
        token,
        siteId,
        q: cleanQ,
        limit: 12,
      });
    },
    fallback: { paging: {}, products: [] },
  });

  return {
    success: true,
    query: cleanQ,
    site_id: siteId,
    categories,
    catalog_products: catalog.products,
    catalog_paging: catalog.paging,
    warnings,
    methodology: {
      version: 2,
      search: "category_predictor + catalog_product_search",
      note: "A busca geral /sites/{site}/search não é usada nesta análise.",
    },
  };
}

async function categorySuggestions({ mlCreds, q }) {
  const cleanQ = normalizeText(q);
  if (!cleanQ) return { success: true, query: "", categories: [], warnings: [] };

  const token = await getAccessToken(mlCreds);
  const siteId = normalizeSiteId(mlCreds?.site_id);
  const warnings = [];
  const categories = await safeSource({
    warnings,
    code: "CATEGORY_PREDICTOR_UNAVAILABLE",
    source: "category_predictor",
    message: "O preditor de categorias não ficou disponível neste momento.",
    run: () => searchCategoriesWithToken({ token, siteId, q: cleanQ }),
    fallback: [],
  });

  return {
    success: true,
    query: cleanQ,
    categories,
    warnings,
  };
}

async function analyzeCategory({ mlCreds, categoryId, sampleLimit = DEFAULT_SAMPLE_LIMIT, q = "", domainId = null }) {
  const limit = clamp(toInt(sampleLimit, DEFAULT_SAMPLE_LIMIT), 10, MAX_SAMPLE_LIMIT);
  const token = await getAccessToken(mlCreds);
  const siteId = normalizeSiteId(mlCreds?.site_id);
  const cleanQ = normalizeText(q);
  const cleanDomainId = normalizeDomainId(domainId) || null;
  const warnings = [];

  const category = await getCategoryInfoWithToken({ token, categoryId });
  const navigation = await getCategoryNavigationWithToken({ token, category });

  const [trends, highlightRows, catalog] = await Promise.all([
    safeSource({
      warnings,
      code: "TRENDS_UNAVAILABLE",
      source: "trends",
      message: "As tendências semanais desta categoria não ficaram disponíveis.",
      run: () => getTrendsWithToken({ token, siteId, categoryId: category.id }),
      fallback: [],
    }),
    safeSource({
      warnings,
      code: "HIGHLIGHTS_UNAVAILABLE",
      source: "highlights",
      message: "O ranking de mais vendidos desta categoria não ficou disponível.",
      run: () => getHighlightsWithToken({ token, siteId, categoryId: category.id }),
      fallback: [],
    }),
    cleanQ
      ? safeSource({
        warnings,
        code: "CATALOG_SEARCH_UNAVAILABLE",
        source: "catalog_search",
        message: "Os produtos de catálogo relacionados ao termo não ficaram disponíveis.",
        run: () => searchCatalogProductsWithToken({
          token,
          siteId,
          q: cleanQ,
          domainId: cleanDomainId,
          limit: MAX_ANALYSIS_CATALOG_PRODUCTS,
        }),
        fallback: { paging: {}, products: [] },
      })
      : Promise.resolve({ paging: {}, products: [] }),
  ]);

  const bestSellers = await safeSource({
    warnings,
    code: "HIGHLIGHTS_DETAIL_PARTIAL",
    source: "highlights_detail",
    message: "Parte dos detalhes do ranking de mais vendidos não pôde ser enriquecida.",
    run: () => enrichHighlights({ token, highlights: highlightRows }),
    fallback: highlightRows.map((row) => ({
      ...row,
      type_label: row.type,
      title: row.id,
      price: null,
      currency_id: "BRL",
      thumbnail: null,
      permalink: null,
      seller_id: null,
      free_shipping: false,
      logistic_type: null,
    })),
  });

  const competitorSample = await buildCompetitorSample({
    token,
    bestSellers,
    catalogProducts: catalog.products,
    sampleLimit: limit,
    warnings,
  });
  const market = summarizeOffers(competitorSample.offers, category);

  return {
    success: true,
    site_id: siteId,
    query: cleanQ || null,
    domain_id: cleanDomainId,
    category,
    navigation,
    trends,
    best_sellers: bestSellers,
    catalog_products: catalog.products,
    market: {
      ...market,
      best_sellers_count: bestSellers.length,
      catalog_products_found: catalog.products.length,
      pdp_products_analyzed: competitorSample.pdp_products_analyzed,
      pdp_products_failed: competitorSample.pdp_products_failed,
      user_products_analyzed: competitorSample.user_products_analyzed || 0,
      user_products_failed: competitorSample.user_products_failed || 0,
    },
    products: competitorSample.offers,
    opportunity: opportunityScore({
      trends,
      bestSellers,
      summary: market,
      catalogProducts: catalog.products,
    }),
    warnings,
    methodology: {
      version: 2,
      score_name: "Score Davantti",
      category_total_source: "/categories/{CATEGORY_ID}.total_items_in_this_category",
      demand_sources: ["/trends/{SITE_ID}/{CATEGORY_ID}", "/highlights/{SITE_ID}/category/{CATEGORY_ID}"],
      competition_source: "/products/{PRODUCT_ID}/items",
      user_product_source: "/users/{SELLER_ID}/items/search?user_product_id={USER_PRODUCT_ID}",
      catalog_source: "/products/search",
      limitations: [
        "A amostra de concorrência é formada por ofertas ligadas a páginas de catálogo e itens presentes no ranking de mais vendidos.",
        "Sellers e preços da amostra não representam necessariamente todos os anúncios da categoria.",
        "O Score Davantti é uma heurística interna e não é uma métrica oficial do Mercado Livre.",
      ],
    },
  };
}


async function resolveKeywordContext({ token, siteId, input, warnings }) {
  const raw = normalizeText(input);
  if (!raw) throw new Error("Informe um termo, categoria ou MLB para analisar palavras-chave.");
  const compact = raw.replace(/[^A-Za-z0-9]/g, "").toUpperCase();

  if (/^MLB\d+$/.test(compact)) {
    let itemError = null;
    try {
      const rawItem = await getItemDetailWithToken({ token, itemId: compact });
      if (rawItem?.id && rawItem?.category_id) {
        const item = itemKeywordView(rawItem);
        const category = await getCategoryInfoWithToken({ token, categoryId: item.category_id });
        let domainId = null;
        const predicted = await safeSource({
          warnings,
          code: "ITEM_DOMAIN_PREDICTOR_UNAVAILABLE",
          source: "item_category_predictor",
          message: "Não foi possível identificar o domínio do MLB; a análise seguirá pela categoria do anúncio.",
          run: () => searchCategoriesWithToken({ token, siteId, q: item.title }),
          fallback: [],
        });
        const exactPrediction = predicted.find((row) => row.id === category.id) || predicted[0] || null;
        domainId = exactPrediction?.domain_id || null;
        return {
          type: "item",
          input: raw,
          resolved_query: item.title,
          category,
          domain_id: domainId,
          item,
        };
      }
    } catch (error) {
      itemError = error;
    }

    try {
      const category = await getCategoryInfoWithToken({ token, categoryId: compact });
      let domainId = null;
      const predicted = await safeSource({
        warnings,
        code: "CATEGORY_DOMAIN_PREDICTOR_UNAVAILABLE",
        source: "category_predictor",
        message: "A categoria foi encontrada, mas seu domínio não pôde ser inferido nesta consulta.",
        run: () => searchCategoriesWithToken({ token, siteId, q: category.name }),
        fallback: [],
      });
      const exactPrediction = predicted.find((row) => row.id === category.id) || predicted[0] || null;
      domainId = exactPrediction?.domain_id || null;
      return {
        type: "category",
        input: raw,
        resolved_query: category.name,
        category,
        domain_id: domainId,
        item: null,
      };
    } catch (categoryError) {
      throw itemError || categoryError;
    }
  }

  const categories = await searchCategoriesWithToken({ token, siteId, q: raw });
  const predicted = categories[0];
  if (!predicted?.id) {
    const error = new Error("Nenhuma categoria foi encontrada para esse termo.");
    error.code = "KEYWORD_CATEGORY_NOT_FOUND";
    throw error;
  }
  const category = await getCategoryInfoWithToken({ token, categoryId: predicted.id });
  return {
    type: "term",
    input: raw,
    resolved_query: raw,
    category,
    domain_id: predicted.domain_id || null,
    item: null,
  };
}

async function keywords({ mlCreds, q }) {
  const token = await getAccessToken(mlCreds);
  const siteId = normalizeSiteId(mlCreds?.site_id);
  const warnings = [];
  const context = await resolveKeywordContext({ token, siteId, input: q, warnings });
  const searchTerm = context.resolved_query || context.category?.name || normalizeText(q);
  const navigation = await safeSource({
    warnings,
    code: "KEYWORD_CATEGORY_TREE_UNAVAILABLE",
    source: "category_tree",
    message: "A árvore da categoria não pôde ser carregada por completo; o ranking seguirá com as demais fontes.",
    run: () => getCategoryNavigationWithToken({ token, category: context.category }),
    fallback: { path: [], parent: null, children: [], siblings: [], mode: "none" },
  });

  const [trends, parentTrends, highlightRows, catalog] = await Promise.all([
    safeSource({
      warnings,
      code: "KEYWORD_TRENDS_UNAVAILABLE",
      source: "trends",
      message: "As tendências da categoria não ficaram disponíveis; o ranking de palavras-chave seguirá com os demais sinais.",
      run: () => getTrendsWithToken({ token, siteId, categoryId: context.category.id }),
      fallback: [],
    }),
    navigation?.parent?.id
      ? getTrendsWithToken({ token, siteId, categoryId: navigation.parent.id }).catch(() => [])
      : Promise.resolve([]),
    safeSource({
      warnings,
      code: "KEYWORD_HIGHLIGHTS_UNAVAILABLE",
      source: "highlights",
      message: "Os mais vendidos da categoria não ficaram disponíveis; o ranking de palavras-chave seguirá com as demais fontes.",
      run: () => getHighlightsWithToken({ token, siteId, categoryId: context.category.id }),
      fallback: [],
    }),
    safeSource({
      warnings,
      code: "KEYWORD_CATALOG_UNAVAILABLE",
      source: "catalog_search",
      message: "Os produtos de catálogo relacionados não ficaram disponíveis nesta análise de palavras-chave.",
      run: () => searchKeywordCatalogPoolWithToken({
        token,
        siteId,
        queries: [searchTerm, context.category?.name],
        domainId: context.domain_id,
      }),
      fallback: { paging: {}, products: [] },
    }),
  ]);

  const bestSellers = await safeSource({
    warnings,
    code: "KEYWORD_HIGHLIGHTS_DETAIL_PARTIAL",
    source: "highlights_detail",
    message: "Parte dos títulos dos mais vendidos não pôde ser carregada; as palavras-chave foram calculadas com a amostra disponível.",
    run: () => enrichHighlights({ token, highlights: highlightRows }),
    fallback: [],
  });

  const ranking = buildKeywordRanking({
    trends,
    parentTrends,
    bestSellers,
    catalogProducts: catalog.products,
    navigation,
    item: context.item,
    query: context.type === "term" ? context.input : searchTerm,
  });

  return {
    success: true,
    site_id: siteId,
    query: normalizeText(q),
    input: {
      type: context.type,
      value: context.input,
      resolved_query: context.resolved_query,
    },
    item: context.item,
    category: context.category,
    navigation,
    domain_id: context.domain_id,
    keywords: ranking.keywords,
    leader_terms: ranking.leader_terms,
    opportunities: ranking.opportunities,
    summary: {
      ...ranking.summary,
      leaders_analyzed: bestSellers.filter((row) => normalizeText(row?.title)).length,
      catalog_products_analyzed: catalog.products.length,
      official_trends_analyzed: trends.length,
      parent_trends_analyzed: parentTrends.length,
    },
    warnings,
    methodology: {
      version: 2,
      score_name: "Score de palavra-chave Davantti",
      sources: [
        `/trends/${siteId}/${context.category.id}`,
        navigation?.parent?.id ? `/trends/${siteId}/${navigation.parent.id}` : null,
        `/highlights/${siteId}/category/${context.category.id}`,
        "/products/search",
        "/categories/{CATEGORY_ID}",
      ].filter(Boolean),
      item_source: context.type === "item" ? `/items/${context.item?.id}` : null,
      note: "Tendência oficial é somente o sinal retornado por /trends da categoria analisada. Categoria pai, árvore, líderes e catálogo aparecem como fontes separadas e não são apresentados como volume de busca.",
      item_note: context.type === "item"
        ? "Palavras ausentes são oportunidades para revisão, não recomendações automáticas. Valide se o termo descreve de fato o produto antes de alterar o anúncio."
        : null,
    },
  };
}

async function categoryTrends({ mlCreds, categoryId }) {
  const token = await getAccessToken(mlCreds);
  const siteId = normalizeSiteId(mlCreds?.site_id);
  const warnings = [];
  const category = await getCategoryInfoWithToken({ token, categoryId });
  const navigation = await safeSource({
    warnings,
    code: "TREND_CATEGORY_TREE_UNAVAILABLE",
    source: "category_tree",
    message: "A árvore desta categoria não pôde ser carregada por completo.",
    run: () => getCategoryNavigationWithToken({ token, category }),
    fallback: { path: [], parent: null, children: [], siblings: [], mode: "none" },
  });
  const trends = await safeSource({
    warnings,
    code: "CATEGORY_TRENDS_UNAVAILABLE",
    source: "trends",
    message: "O Mercado Livre não retornou tendências oficiais para esta categoria nesta consulta.",
    run: () => getTrendsWithToken({ token, siteId, categoryId: category.id }),
    fallback: [],
  });

  return {
    success: true,
    site_id: siteId,
    category,
    navigation,
    trends,
    summary: {
      official_trends: trends.length,
      children: navigation.children.length,
      siblings: navigation.siblings.length,
    },
    warnings,
    methodology: {
      source: `/trends/${siteId}/${category.id}`,
      category_source: `/categories/${category.id}`,
      note: "Os termos desta lista são exclusivamente as tendências oficiais retornadas para a categoria. A navegação por categorias serve para aprofundar o mercado, não para fabricar tendências.",
    },
  };
}

async function generalTrends({ mlCreds }) {
  const token = await getAccessToken(mlCreds);
  const siteId = normalizeSiteId(mlCreds?.site_id);
  const trends = await getTrendsWithToken({ token, siteId });
  return {
    success: true,
    site_id: siteId,
    trends,
    methodology: {
      source: `/trends/${siteId}`,
      note: "Os resultados são exibidos nos grupos documentados pelo Mercado Livre: maior crescimento, mais desejadas e tendências populares.",
    },
  };
}

module.exports = {
  search,
  categorySuggestions,
  analyzeCategory,
  keywords,
  categoryTrends,
  generalTrends,
};
