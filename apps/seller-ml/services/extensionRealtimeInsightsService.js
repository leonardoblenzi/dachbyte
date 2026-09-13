"use strict";

const ML_API = "https://api.mercadolibre.com";

function text(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function tokenize(input) {
  const stopwords = new Set([
    "de", "da", "do", "dos", "das", "e", "em", "com", "para", "por", "um", "uma", "no", "na", "nos", "nas", "o", "a", "os", "as",
  ]);
  return String(input || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !stopwords.has(token));
}

function unique(arr) {
  return Array.from(new Set(arr.filter(Boolean)));
}

function levelFromCount(total) {
  const n = Number(total || 0);
  if (!Number.isFinite(n)) return { level: "unknown", label: "Concorrencia indefinida" };
  if (n <= 300) return { level: "low", label: "Concorrencia baixa" };
  if (n <= 2500) return { level: "medium", label: "Concorrencia media" };
  return { level: "high", label: "Concorrencia alta" };
}

function safeUrl(url) {
  try {
    return new URL(String(url || ""));
  } catch {
    return null;
  }
}

function parseMarketplace(value, url) {
  const direct = String(value || "").toLowerCase();
  if (direct === "ml" || direct === "shopee") return direct;
  const host = safeUrl(url)?.hostname?.toLowerCase() || "";
  if (host.includes("mercadolivre") || host.includes("mercadolibre")) return "ml";
  if (host.includes("shopee")) return "shopee";
  return "unknown";
}

function parseMlItemId(url) {
  const raw = String(url || "").toUpperCase();
  const productId = parseMlProductId(url);
  const direct = extractMlItemIdFromText(raw);
  if (direct && direct !== productId) return direct;
  const matches = Array.from(raw.matchAll(/\b(MLB)-?(\d{6,})\b/g)).map((match) => `${match[1]}${match[2]}`);
  const match = matches.find((id) => id !== productId) || (!productId ? matches[0] : "");
  return match || "";
}

function parseMlProductId(url) {
  const raw = String(url || "").toUpperCase();
  const match = raw.match(/\/P\/(MLB-?\d{6,})/);
  return match ? normalizeMlItemId(match[1]) : "";
}

function parseMlUserProductId(url) {
  const raw = String(url || "").toUpperCase();
  const match = raw.match(/\/UP\/(MLBU\d{6,})/);
  return match ? match[1] : "";
}

function decodeLoose(value) {
  let current = String(value || "");
  for (let i = 0; i < 3; i += 1) {
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      current = decoded;
    } catch {
      break;
    }
  }
  return current;
}

function normalizeMlItemId(value) {
  const match = String(value || "").toUpperCase().match(/\b(MLB)-?(\d{6,})\b/);
  return match ? `${match[1]}${match[2]}` : "";
}

function extractMlItemIdFromText(value) {
  const raw = decodeLoose(value).toUpperCase();
  const patterns = [
    /(?:ITEM_ID|ITEMID)["'=:\s%]+["']?(MLB-?\d{6,})/i,
    /["'](?:ITEM_ID|ITEMID|ITEMIDRAW|ITEM_ID_RAW)["']\s*:\s*["'](MLB-?\d{6,})["']/i,
    /ITEM_ID:?(MLB-?\d{6,})/i,
    /\/ITEMS\/(MLB-?\d{6,})/i,
    /\/REVIEWS\/(MLB-?\d{6,})/i,
    /\/VISITS\/ITEMS\?IDS=(MLB-?\d{6,})/i,
    /\/(MLB-\d{6,})[-_/]/i,
    /"ITEM_INFO"\s*:\s*\{[^}]*"ID"\s*:\s*"(MLB-?\d{6,})"/i,
    /"ITEM"\s*:\s*\{[^}]*"ID"\s*:\s*"(MLB-?\d{6,})"/i,
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match?.[1]) return normalizeMlItemId(match[1]);
  }
  return "";
}

function parseJsonLoose(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function networkRows(networkEntries = []) {
  return Array.isArray(networkEntries) ? networkEntries : [];
}

function normalizeJsonKey(key) {
  return String(key || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function looseNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean" || value == null) return null;
  if (typeof value === "object") {
    for (const key of ["amount", "value", "price", "fraction", "total", "count", "rate"]) {
      const parsed = looseNumber(value?.[key]);
      if (parsed != null) return parsed;
    }
    return null;
  }
  let raw = text(value);
  if (!raw) return null;
  raw = raw.replace(/[^\d,.-]/g, "");
  if (!raw || raw === "-" || raw === "." || raw === ",") return null;
  if (raw.includes(",") && raw.includes(".")) {
    raw = raw.replace(/\./g, "").replace(",", ".");
  } else if (raw.includes(",")) {
    raw = raw.replace(",", ".");
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function walkJson(value, visitor, depth = 0, seen = new Set()) {
  if (depth > 12 || value == null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((row) => walkJson(row, visitor, depth + 1, seen));
    return;
  }
  Object.entries(value).forEach(([key, child]) => {
    visitor(key, child, value, depth);
    walkJson(child, visitor, depth + 1, seen);
  });
}

function collectNetworkPayloads(entries = []) {
  const payloads = [];
  for (const entry of networkRows(entries)) {
    const payload = parseJsonLoose(entry?.body);
    if (payload && typeof payload === "object") payloads.push(payload);
  }
  return payloads;
}

function collectDeepValues(payloads = [], keys = []) {
  const wanted = new Set(keys.map(normalizeJsonKey));
  const values = [];
  payloads.forEach((payload) => {
    walkJson(payload, (key, value) => {
      if (wanted.has(normalizeJsonKey(key)) && value !== undefined && value !== null && value !== "") {
        values.push(value);
      }
    });
  });
  return values;
}

function firstDeepValue(payloads = [], keys = []) {
  return collectDeepValues(payloads, keys)[0] ?? null;
}

function firstDeepText(payloads = [], keys = []) {
  for (const value of collectDeepValues(payloads, keys)) {
    const parsed = text(value?.name || value?.label || value?.value_name || value?.value || value);
    if (parsed) return parsed;
  }
  return "";
}

function firstDeepNumber(payloads = [], keys = []) {
  for (const value of collectDeepValues(payloads, keys)) {
    const parsed = looseNumber(value);
    if (parsed != null) return parsed;
  }
  return null;
}

function firstObjectDate(value, keys = []) {
  if (!value || typeof value !== "object") return "";
  for (const key of keys) {
    const direct = text(value?.[key]);
    if (direct && normalizeDateSignal(direct)) return direct;
  }
  const wanted = new Set(keys.map(normalizeJsonKey));
  let found = "";
  walkJson(value, (key, child) => {
    if (found || !wanted.has(normalizeJsonKey(key))) return;
    const candidate = text(child);
    if (candidate && normalizeDateSignal(candidate)) found = candidate;
  });
  return found;
}

function pickCreatedAt(value) {
  return firstObjectDate(value, ["meliCreatedAt", "date_created", "dateCreated", "created_date", "createdDate", "created_at", "createdAt", "start_time", "startTime"]);
}

function pickUpdatedAt(value) {
  return firstObjectDate(value, ["last_updated", "lastUpdated", "updated_at", "updatedAt", "stop_time", "stopTime"]);
}

function firstRegexNumber(value, patterns = []) {
  const raw = String(value || "");
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (!match?.[1]) continue;
    const parsed = looseNumber(match[1]);
    if (parsed != null) return parsed;
  }
  return null;
}

function scopedNetworkEntries(networkEntries = [], itemId = "") {
  const rows = networkRows(networkEntries);
  const mlb = String(itemId || "").toUpperCase();
  if (!/^MLB\d{6,}$/.test(mlb)) return rows;
  const scoped = rows.filter((entry) => `${entry?.url || ""}\n${entry?.body || ""}`.toUpperCase().includes(mlb));
  return scoped.length ? scoped : rows;
}

function firstEntryParam(networkEntries = [], names = []) {
  for (const entry of networkRows(networkEntries)) {
    const parsed = safeUrl(entry?.url || "");
    if (!parsed) continue;
    for (const name of names) {
      const value = parsed.searchParams.get(name);
      if (value) return text(value);
    }
  }
  return "";
}

function collectReviewSignals(payloads = []) {
  const candidates = [];
  payloads.forEach((payload) => {
    walkJson(payload, (key, value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      if (/review|rating|opinion/i.test(key) || value.rate != null || value.rating != null) candidates.push(value);
    });
  });
  const reviews = candidates.find((row) => looseNumber(row?.count ?? row?.total ?? row?.reviews_count) != null || looseNumber(row?.rate ?? row?.rating) != null) || {};
  return {
    rate: firstDeepNumber([reviews], ["rate", "rating", "average_rating"]) ?? firstDeepNumber(payloads, ["review_rate", "reviews_rate", "rating_average"]),
    count: firstDeepNumber([reviews], ["count", "total", "reviews_count", "total_reviews"]) ?? firstDeepNumber(payloads, ["reviews_count", "total_reviews"]),
    with_comment: firstDeepNumber([reviews], ["reviews_with_comment", "with_comment", "comments_count"]) ?? firstDeepNumber(payloads, ["reviews_with_comment"]),
    pictures_quantity: firstDeepNumber([reviews], ["pictures_quantity", "with_pictures", "reviews_with_pictures"]) ?? firstDeepNumber(payloads, ["reviews_pictures_quantity", "pictures_quantity"]),
  };
}

function collectSellerSignals(payloads = []) {
  const candidates = [];
  payloads.forEach((payload) => {
    walkJson(payload, (key, value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      if (/seller|vendor|officialstore/i.test(key) || value.seller_id != null || value.sellerId != null || value.nickname != null) candidates.push(value);
    });
  });
  const seller = candidates.find((row) => row.seller_id != null || row.sellerId != null || row.id != null || row.nickname || row.name) || {};
  return {
    id: text(seller.seller_id || seller.sellerId || seller.id || ""),
    name: text(seller.seller_name || seller.sellerName || seller.nickname || seller.name || seller.official_store_name || seller.officialStoreName || ""),
    reputation_level: text(seller.reputation_level || seller.level_id || seller.levelId || seller?.seller_reputation?.level_id || ""),
    power_seller_status: text(seller.power_seller_status || seller.powerSellerStatus || seller?.seller_reputation?.power_seller_status || ""),
    official_store_id: seller.official_store_id || seller.officialStoreId || null,
  };
}

function collectPictureCount(payloads = []) {
  const count = firstDeepNumber(payloads, ["pictures_count", "photos_count", "images_count", "gallery_count"]) || 0;
  return count || null;
}

function collectPromotions(payloads = []) {
  for (const value of collectDeepValues(payloads, ["available_promotions", "promotions", "discounts"])) {
    if (Array.isArray(value) && value.filter(Boolean).length) return value.filter(Boolean).slice(0, 4);
  }
  return [];
}

function collectSeoKeywords(payloads = []) {
  const value = firstDeepValue(payloads, ["seo_top_keywords", "seo_keywords", "keywords"]);
  if (Array.isArray(value)) {
    return value.map((row) => text(row?.keyword || row?.name || row)).filter(Boolean).slice(0, 12);
  }
  return [];
}

function collectMelidataEvents(networkEntries = []) {
  const events = [];
  for (const entry of networkRows(networkEntries)) {
    const url = String(entry?.url || "");
    const body = String(entry?.body || "");
    if (!/api\.mercadolibre\.com\/melidata\/tracks/i.test(url) || !body) continue;
    const payload = parseJsonLoose(body);
    const tracks = Array.isArray(payload?.tracks) ? payload.tracks : [];
    tracks.forEach((track) => {
      if (track && typeof track === "object") events.push(track);
    });
  }
  return events;
}

function collectItemDateSignals(payloads = [], itemId = "") {
  const target = String(itemId || "").toUpperCase();
  let dateCreated = "";
  let lastUpdated = "";
  payloads.forEach((payload) => {
    walkJson(payload, (_key, value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      const candidateId = String(value.item_id || value.itemId || value.id || "").toUpperCase();
      const matchesItem = target ? candidateId === target : /^MLB\d{6,}$/.test(candidateId);
      const hasItemShape = value.title || value.price != null || value.category_id || value.categoryId || value.seller_id || value.sellerId;
      if (!matchesItem || !hasItemShape) return;
      if (!dateCreated) dateCreated = text(value.date_created || value.dateCreated || value.start_time || value.startTime);
      if (!lastUpdated) lastUpdated = text(value.last_updated || value.lastUpdated || value.stop_time || value.stopTime);
    });
  });
  return { date_created: dateCreated, last_updated: lastUpdated };
}

function normalizeDateSignal(value) {
  const raw = text(value);
  if (!raw) return "";
  const timestamp = new Date(raw).getTime();
  return Number.isFinite(timestamp) ? raw : "";
}

function normalizePageSignals(pageSignals = {}) {
  if (!pageSignals || typeof pageSignals !== "object" || Array.isArray(pageSignals)) return {};
  const itemId = String(pageSignals.item_id || pageSignals.itemId || "").toUpperCase();
  const sellerId = pageSignals.seller_id || pageSignals.sellerId;
  const reviews = pageSignals.reviews && typeof pageSignals.reviews === "object" ? pageSignals.reviews : {};
  return {
    item_id: /^MLB\d{6,}$/.test(itemId) ? itemId : "",
    date_created: normalizeDateSignal(pageSignals.date_created || pageSignals.dateCreated || pageSignals.start_time || pageSignals.startTime),
    last_updated: normalizeDateSignal(pageSignals.last_updated || pageSignals.lastUpdated || pageSignals.stop_time || pageSignals.stopTime),
    price: looseNumber(pageSignals.price),
    original_price: looseNumber(pageSignals.original_price || pageSignals.originalPrice),
    seller_id: sellerId != null ? text(sellerId) : "",
    pictures_count: looseNumber(pageSignals.pictures_count || pageSignals.picturesCount),
    category_id: text(pageSignals.category_id || pageSignals.categoryId),
    domain_id: text(pageSignals.domain_id || pageSignals.domainId),
    listing_type_id: text(pageSignals.listing_type_id || pageSignals.listingTypeId),
    item_condition: text(pageSignals.condition || pageSignals.item_condition),
    site_id: text(pageSignals.site_id || pageSignals.siteId),
    review_rate: looseNumber(reviews.rate || pageSignals.review_rate),
    reviews_count: looseNumber(reviews.count || pageSignals.reviews_count),
  };
}

function firstEventDataValue(events, keys = []) {
  for (const event of events) {
    const data = event?.event_data || {};
    for (const key of keys) {
      const value = data?.[key];
      if (value !== undefined && value !== null && value !== "") return value;
    }
  }
  return null;
}

function extractMlSignalsFromNetwork(networkEntries = []) {
  const events = collectMelidataEvents(networkEntries);
  const allText = networkRows(networkEntries).map((entry) => `${entry?.url || ""}\n${entry?.body || ""}`).join("\n");
  const eventItemId = String(firstEventDataValue(events, ["item_id"]) || "").toUpperCase();
  const paramItemId = String(firstEntryParam(networkEntries, ["item_id", "itemId"]) || "").toUpperCase();
  const regexItemId = extractMlItemIdFromText(allText);
  const itemId = /^MLB\d{6,}$/.test(eventItemId) ? eventItemId : /^MLB\d{6,}$/.test(paramItemId) ? paramItemId : regexItemId;
  const entries = scopedNetworkEntries(networkEntries, itemId);
  const payloads = collectNetworkPayloads(entries);
  const eventCatalogProductId = String(firstEventDataValue(events, ["catalog_product_id"]) || "").toUpperCase();
  const deepCatalogProductId = String(firstDeepText(payloads, ["catalog_product_id", "catalogProductId", "product_id"]) || "").toUpperCase();
  const catalogProductId = /^MLB\d{6,}$/.test(eventCatalogProductId) ? eventCatalogProductId : deepCatalogProductId;
  const deepSeller = collectSellerSignals(payloads);
  const reviews = firstEventDataValue(events, ["reviews"]) || {};
  const deepReviews = collectReviewSignals(payloads);
  const seo = firstEventDataValue(events, ["seo"]) || {};
  const seoTopKeywords = seo?.seo_top_keywords || firstEventDataValue(events, ["seo_top_keywords"]);
  const eventPromotions = firstEventDataValue(events, ["available_promotions"]);
  const promotions = Array.isArray(eventPromotions) && eventPromotions.length ? eventPromotions : collectPromotions(payloads);
  const soldQuantity = firstDeepNumber(payloads, ["sold_quantity", "soldQuantity", "total_sold", "sold_total", "units_sold"])
    ?? firstRegexNumber(allText, [/"sold_quantity"\s*:\s*(\d+)/i, /"soldQuantity"\s*:\s*(\d+)/i]);
  const visits30d = firstDeepNumber(payloads, ["visits_30d", "total_visits", "visits", "visit_count", "views", "view_count"])
    ?? firstRegexNumber(allText, [/"visits_30d"\s*:\s*(\d+)/i, /"total_visits"\s*:\s*(\d+)/i]);
  const sellerId = firstEventDataValue(events, ["seller_id"]) || firstEntryParam(entries, ["seller_id", "sellerId"]) || firstDeepValue(payloads, ["seller_id", "sellerId", "sellerID"]) || deepSeller.id;
  const dateSignals = collectItemDateSignals(payloads, itemId);

  return {
    events: events.length,
    item_id: /^MLB\d{6,}$/.test(itemId) ? itemId : "",
    catalog_product_id: /^MLB\d{6,}$/.test(catalogProductId) ? catalogProductId : "",
    seller_id: sellerId != null ? String(sellerId) : "",
    seller_name: text(firstEventDataValue(events, ["seller_name"])) || deepSeller.name,
    reputation_level: text(firstEventDataValue(events, ["reputation_level"])) || deepSeller.reputation_level,
    power_seller_status: text(firstEventDataValue(events, ["power_seller_status"])) || deepSeller.power_seller_status,
    official_store_id: firstEventDataValue(events, ["official_store_id"]) || deepSeller.official_store_id,
    free_shipping: firstEventDataValue(events, ["free_shipping"]) ?? firstDeepValue(payloads, ["free_shipping", "freeShipping"]),
    shipping_mode: text(firstEventDataValue(events, ["shipping_mode"])) || firstDeepText(payloads, ["shipping_mode", "mode"]),
    logistic_type: text(firstEventDataValue(events, ["logistic_type"])) || firstDeepText(payloads, ["logistic_type", "logisticType"]),
    price: looseNumber(firstEventDataValue(events, ["price"])) ?? firstDeepNumber(payloads, ["price", "current_price", "price_to_pay", "discounted_price"]),
    original_price: looseNumber(firstEventDataValue(events, ["original_price"])) ?? firstDeepNumber(payloads, ["original_price", "regular_price", "old_price", "list_price"]),
    sold_quantity: soldQuantity,
    available_quantity: firstDeepNumber(payloads, ["available_quantity", "availableQuantity", "stock", "quantity"]),
    pictures_count: collectPictureCount(payloads),
    visits_30d: visits30d,
    category_id: text(firstEventDataValue(events, ["category_id"])) || firstEntryParam(entries, ["category_id", "categoryId"]) || firstDeepText(payloads, ["category_id", "categoryId"]),
    domain_id: text(firstEventDataValue(events, ["domain_id"])) || firstDeepText(payloads, ["domain_id", "domainId"]),
    listing_type_id: text(firstEventDataValue(events, ["listing_type_id"])) || firstDeepText(payloads, ["listing_type_id", "listingTypeId"]),
    item_condition: text(firstEventDataValue(events, ["item_condition"])) || firstDeepText(payloads, ["condition", "item_condition"]),
    site_id: firstEntryParam(entries, ["site_id", "siteId"]) || firstDeepText(payloads, ["site_id", "siteId"]),
    date_created: text(firstEventDataValue(events, ["date_created", "start_time"])) || dateSignals.date_created,
    last_updated: text(firstEventDataValue(events, ["last_updated", "stop_time"])) || dateSignals.last_updated,
    review_rate: looseNumber(firstEventDataValue(events, ["review_rate"]) || reviews?.rate) ?? deepReviews.rate,
    reviews_count: looseNumber(reviews?.count) ?? deepReviews.count,
    reviews_with_comment: looseNumber(reviews?.reviews_with_comment) ?? deepReviews.with_comment,
    reviews_pictures_quantity: looseNumber(reviews?.pictures_quantity) ?? deepReviews.pictures_quantity,
    promotions: Array.isArray(promotions) ? promotions.slice(0, 4) : [],
    seo_keywords: Array.isArray(seoTopKeywords)
      ? seoTopKeywords.map((row) => text(row?.keyword || row)).filter(Boolean).slice(0, 12)
      : collectSeoKeywords(payloads),
  };
}

function resolveMlItemId({ url = "", itemId = "", productId = "", networkEntries = [] } = {}) {
  const product = String(productId || parseMlProductId(url) || "").toUpperCase();
  const direct = String(itemId || "").toUpperCase();
  if (/^MLB\d{6,}$/.test(direct) && direct !== product) return direct;

  const networkSignals = extractMlSignalsFromNetwork(networkEntries);
  if (networkSignals.item_id && networkSignals.item_id !== product) return networkSignals.item_id;

  const fromUrl = extractMlItemIdFromText(url);
  if (fromUrl && fromUrl !== product) return fromUrl;

  const networkText = (Array.isArray(networkEntries) ? networkEntries : [])
    .map((entry) => `${entry?.url || ""}\n${entry?.body || ""}`)
    .join("\n");
  const fromNetwork = extractMlItemIdFromText(networkText);
  if (fromNetwork && fromNetwork !== product) return fromNetwork;

  const fallback = parseMlItemId(url);
  return fallback && fallback !== product ? fallback : "";
}

function parseMlQuery(url) {
  const u = safeUrl(url);
  if (!u) return "";
  return text(u.searchParams.get("as_word") || u.searchParams.get("q") || "");
}

function parseShopeeIds(url) {
  const raw = String(url || "");
  const match1 = raw.match(/-i\.(\d+)\.(\d+)/i);
  if (match1) return { shopId: match1[1], itemId: match1[2] };
  const match2 = raw.match(/\/product\/(\d+)\/(\d+)/i);
  if (match2) return { shopId: match2[1], itemId: match2[2] };
  return { shopId: "", itemId: "" };
}

function parseShopeeQuery(url) {
  const u = safeUrl(url);
  if (!u) return "";
  return text(u.searchParams.get("keyword") || u.searchParams.get("q") || "");
}

async function fetchJson(url, { headers = {}, retries = 2 } = {}) {
  let lastError = null;
  for (let i = 0; i < retries; i += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: "application/json",
          "user-agent": "DavanttiRealtimeInsights/1.0",
          ...headers,
        },
      });
      const body = await response.text();
      if (!response.ok) {
        lastError = new Error(`GET ${url} -> ${response.status}`);
        lastError.status = response.status;
        lastError.url = url;
        if (response.status === 429 || response.status >= 500) {
          await new Promise((resolve) => setTimeout(resolve, 300 * (i + 1)));
          continue;
        }
        break;
      }
      return body ? JSON.parse(body) : null;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 220 * (i + 1)));
    }
  }
  if (lastError) throw lastError;
  return null;
}

function authHeaders(mlCreds = null) {
  const token = String(mlCreds?.access_token || "").trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function withoutAuthHeaders(headers = {}) {
  const next = { ...(headers || {}) };
  delete next.Authorization;
  delete next.authorization;
  return next;
}

async function mlSearchCount({ siteId = "MLB", term, categoryId = "", headers = {} }) {
  const url = new URL(`${ML_API}/sites/${encodeURIComponent(siteId)}/search`);
  url.searchParams.set("q", term);
  url.searchParams.set("limit", "1");
  if (categoryId) url.searchParams.set("category", categoryId);
  const payload = await fetchJson(url.toString(), { headers, retries: 2 });
  return Number(payload?.paging?.total || 0);
}

function levelFromCoverage(coverage) {
  const n = Number(coverage || 0);
  if (!Number.isFinite(n)) return { level: "unknown", label: "Concorrencia indefinida" };
  if (n >= 0.45) return { level: "high", label: "Muito usada pelos concorrentes" };
  if (n >= 0.22) return { level: "medium", label: "Uso recorrente" };
  return { level: "low", label: "Uso pontual" };
}

function buildRepeatedKeywordRows(results = []) {
  const titleRows = (Array.isArray(results) ? results : [])
    .map((row) => ({ id: text(row?.id || row?.item_id || ""), title: text(row?.title || row?.name || "") }))
    .filter((row) => row.title);
  const sampleSize = titleRows.length;
  if (!sampleSize) return [];

  const counts = new Map();
  for (const row of titleRows) {
    const tokens = unique(tokenize(row.title)).slice(0, 12);
    const terms = new Set(tokens);
    for (let size = 2; size <= 3; size += 1) {
      for (let i = 0; i <= tokens.length - size; i += 1) {
        const term = tokens.slice(i, i + size).join(" ");
        if (term.length >= 7) terms.add(term);
      }
    }
    terms.forEach((term) => counts.set(term, (counts.get(term) || 0) + 1));
  }

  const ranked = Array.from(counts.entries())
    .map(([term, total]) => {
      const coverage = total / sampleSize;
      const rank = levelFromCoverage(coverage);
      return {
        term,
        total,
        sample_size: sampleSize,
        coverage_pct: Number((coverage * 100).toFixed(1)),
        level: rank.level,
        label: rank.label,
        source: "ml_search_titles",
      };
    })
    .sort((a, b) => (b.total - a.total) || (b.term.split(" ").length - a.term.split(" ").length) || a.term.localeCompare(b.term))
    .slice(0, 30);
  const maxTotal = ranked[0]?.total || 1;
  return ranked.map((row) => ({
    ...row,
    score: Math.max(1, Math.round((row.total / maxTotal) * 100)),
  }));
}

function keywordSearchQueries(query = "") {
  const clean = text(query);
  const tokens = tokenize(clean);
  const compact = tokens.slice(0, 7).join(" ");
  const core = tokens.filter((token) => !/^\d+$/.test(token)).slice(0, 5).join(" ");
  return unique([clean, compact, core].filter((value) => text(value).length >= 3));
}

async function fetchMlSearchPayload(url, headers = {}) {
  try {
    return await fetchJson(url, { headers, retries: 2 });
  } catch (error) {
    if ((error?.status === 401 || error?.status === 403) && (headers?.Authorization || headers?.authorization)) {
      return fetchJson(url, { headers: withoutAuthHeaders(headers), retries: 2 });
    }
    throw error;
  }
}

async function mlRepeatedKeywordsFromSearch({
  siteId = "MLB",
  query = "",
  categoryId = "",
  excludeItemId = "",
  headers = {},
  maxPages = 5,
} = {}) {
  const searchQuery = text(query);
  if (!searchQuery) return [];
  const limit = 50;
  const pages = Math.max(1, Math.min(5, Number(maxPages) || 5));
  const rows = [];
  const seen = new Set();
  const queries = keywordSearchQueries(searchQuery);
  const categoryModes = categoryId ? [categoryId, ""] : [""];
  const diagnostics = {
    requested_pages: pages,
    fetched_pages: 0,
    sampled_titles: 0,
    queries,
    category_id: categoryId || null,
  };

  for (const currentQuery of queries) {
    for (const currentCategoryId of categoryModes) {
      for (let page = 0; page < pages; page += 1) {
        const url = new URL(`${ML_API}/sites/${encodeURIComponent(siteId || "MLB")}/search`);
        url.searchParams.set("q", currentQuery);
        url.searchParams.set("limit", String(limit));
        url.searchParams.set("offset", String(page * limit));
        if (currentCategoryId) url.searchParams.set("category", currentCategoryId);
        let payload = null;
        try {
          payload = await fetchMlSearchPayload(url.toString(), headers);
        } catch (error) {
          diagnostics.last_error = error?.message || "Falha ao consultar busca do Mercado Livre";
          diagnostics.failed_pages = Number(diagnostics.failed_pages || 0) + 1;
          break;
        }
        const results = Array.isArray(payload?.results) ? payload.results : [];
        if (!results.length) break;
        diagnostics.fetched_pages += 1;
        for (const row of results) {
          const id = text(row?.id || row?.item_id || "").toUpperCase();
          if (excludeItemId && id === String(excludeItemId).toUpperCase()) continue;
          const key = id || text(row?.title || row?.name || "");
          if (!key || seen.has(key)) continue;
          seen.add(key);
          rows.push(row);
        }
        if (results.length < limit) break;
        if (rows.length >= 250) break;
      }
      if (rows.length >= 120) break;
    }
    if (rows.length >= 120) break;
  }

  diagnostics.sampled_titles = rows.length;
  const ranked = buildRepeatedKeywordRows(rows);
  Object.defineProperty(ranked, "diagnostics", {
    value: diagnostics,
    enumerable: false,
  });
  return ranked;
}

async function mlTrendsByCategory({ siteId = "MLB", categoryId = "", headers = {} }) {
  if (!categoryId) return [];
  const candidates = [
    `${ML_API}/trends/${encodeURIComponent(siteId)}/${encodeURIComponent(categoryId)}`,
    `${ML_API}/sites/${encodeURIComponent(siteId)}/trends/search?category=${encodeURIComponent(categoryId)}`,
  ];
  for (const url of candidates) {
    try {
      const payload = await fetchJson(url, { headers, retries: 2 });
      const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.results) ? payload.results : [];
      const terms = rows
        .map((row) => text(row?.keyword || row?.query || row?.text || row?.value || ""))
        .filter(Boolean);
      if (terms.length) return terms;
    } catch {
      continue;
    }
  }
  return [];
}

async function mlCategoryDetail(categoryId, headers = {}) {
  if (!categoryId) return null;
  try {
    return await fetchJson(`${ML_API}/categories/${encodeURIComponent(categoryId)}`, { headers, retries: 2 });
  } catch {
    return null;
  }
}

async function mlListingFee({ siteId = "MLB", price = 0, listingTypeId = "", categoryId = "", headers = {} }) {
  const numericPrice = Number(price || 0);
  if (!numericPrice || !listingTypeId) return null;
  const url = new URL(`${ML_API}/sites/${encodeURIComponent(siteId)}/listing_prices`);
  url.searchParams.set("price", String(numericPrice));
  url.searchParams.set("listing_type_id", listingTypeId);
  if (categoryId) url.searchParams.set("category_id", categoryId);
  try {
    const payload = await fetchJson(url.toString(), { headers, retries: 2 });
    const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.results) ? payload.results : [payload].filter(Boolean);
    const row = rows.find((item) => item?.listing_type_id === listingTypeId) || rows[0] || null;
    return row
      ? {
          listing_type_id: row?.listing_type_id || listingTypeId,
          sale_fee: Number(row?.sale_fee_details?.gross_amount || row?.sale_fee_amount || 0),
          fixed_fee: Number(row?.sale_fee_details?.fixed_fee || 0),
          percentage_fee: Number(row?.sale_fee_details?.percentage_fee || 0),
        }
      : null;
  } catch {
    return null;
  }
}

async function mlVisits(itemId, headers = {}) {
  if (!itemId) return null;
  const candidates = [
    `${ML_API}/visits/items?ids=${encodeURIComponent(itemId)}`,
    `${ML_API}/items/${encodeURIComponent(itemId)}/visits/time_window?last=30&unit=day`,
  ];
  for (const url of candidates) {
    try {
      const payload = await fetchJson(url, { headers, retries: 1 });
      const direct = payload?.[itemId] || payload?.[String(itemId).toUpperCase()] || payload;
      const total = Number(
        direct?.total_visits ||
          direct?.total ||
          direct?.visits ||
          direct?.total_visits_quantity ||
          (Array.isArray(direct?.results) ? direct.results.reduce((sum, row) => sum + Number(row?.total || row?.visits || 0), 0) : 0),
      );
      if (Number.isFinite(total) && total > 0) {
        return { visits_30d: total, source: url.includes("time_window") ? "ml_visits_time_window" : "ml_visits_items" };
      }
    } catch {
      continue;
    }
  }
  return null;
}

async function fetchMlItemDetail(itemId, headers = {}) {
  const id = String(itemId || "").toUpperCase();
  if (!/^MLB\d{6,}$/.test(id)) return null;
  const hasAuth = Boolean(headers?.Authorization || headers?.authorization);
  let firstItem = null;
  let firstSource = hasAuth ? "items_api_authenticated" : "items_api_public";

  try {
    const item = await fetchJson(`${ML_API}/items/${encodeURIComponent(id)}`, { headers, retries: 2 });
    if (item?.id || item?.title) {
      firstItem = item;
      if (item?.date_created || item?.start_time || item?.last_updated || item?.stop_time) {
        return { item, source: firstSource };
      }
    }
  } catch (error) {
    if (hasAuth) console.warn("[extension realtime] items/{id} falhou para data do anuncio:", id, error?.message || error);
    // tenta abaixo via endpoint em lote, que em algumas rotas autenticadas retorna mais campos.
  }

  try {
    const url = new URL(`${ML_API}/items`);
    url.searchParams.set("ids", id);
    url.searchParams.set(
      "attributes",
      [
        "id",
        "title",
        "price",
        "original_price",
        "sold_quantity",
        "available_quantity",
        "pictures",
        "listing_type_id",
        "category_id",
        "site_id",
        "condition",
        "catalog_listing",
        "catalog_product_id",
        "warranty",
        "shipping",
        "date_created",
        "last_updated",
        "start_time",
        "stop_time",
        "permalink",
        "attributes",
        "seller_id",
      ].join(","),
    );
    const payload = await fetchJson(url.toString(), { headers, retries: 2 });
    const rows = Array.isArray(payload) ? payload : [];
    const found = rows.find((row) => String(row?.body?.id || row?.id || "").toUpperCase() === id) || rows[0];
    const item = found?.body || found || null;
    if (!item) return firstItem ? { item: firstItem, source: firstSource } : null;
    const merged = firstItem ? { ...firstItem, ...item } : item;
    return { item: merged, source: hasAuth ? "items_batch_authenticated" : "items_batch_public" };
  } catch (error) {
    if (hasAuth) console.warn("[extension realtime] items?ids falhou para data do anuncio:", id, error?.message || error);
    return firstItem ? { item: firstItem, source: firstSource } : null;
  }
}

async function fetchMlUserProductDetail(userProductId, headers = {}) {
  const id = String(userProductId || "").toUpperCase();
  if (!/^MLBU\d{6,}$/.test(id)) return null;
  const hasAuth = Boolean(headers?.Authorization || headers?.authorization);
  let firstUserProduct = null;
  let firstSource = "";
  const sources = [
    `${ML_API}/user-products/${encodeURIComponent(id)}`,
    `${ML_API}/user-products/${encodeURIComponent(id)}?attributes=id,item_id,date_created,start_time,last_updated,stop_time,status`,
    `${ML_API}/user-products/${encodeURIComponent(id)}?attributes=id,item_id,meliCreatedAt,created_at,createdAt,dateCreated,createdDate,last_updated,updated_at,updatedAt,status`,
  ];
  for (const source of sources) {
    try {
      const payload = await fetchJson(source, { headers, retries: 2 });
      const body = payload?.body || payload;
      if (body && typeof body === "object") {
        const currentSource = hasAuth ? "user_product_api_authenticated" : "user_product_api_public";
        if (!firstUserProduct) {
          firstUserProduct = body;
          firstSource = currentSource;
        }
        if (pickCreatedAt(body) || pickUpdatedAt(body)) {
          return { userProduct: body, source: currentSource };
        }
      }
    } catch {
      continue;
    }
  }
  return firstUserProduct ? { userProduct: firstUserProduct, source: firstSource || (hasAuth ? "user_product_api_authenticated" : "user_product_api_public") } : null;
}

function pickItemIdFromCatalogPayload(payload) {
  const candidates = [
    payload?.buy_box_winner?.item_id,
    payload?.buy_box_winner?.id,
    payload?.winner_item_id,
    payload?.winner?.item_id,
    payload?.winner?.id,
    payload?.item_id,
    payload?.id,
  ];
  for (const candidate of candidates) {
    const value = String(candidate || "").toUpperCase();
    if (/^MLB\d{6,}$/.test(value)) return value;
  }

  const rows = [
    ...(Array.isArray(payload?.results) ? payload.results : []),
    ...(Array.isArray(payload?.items) ? payload.items : []),
  ];
  for (const row of rows) {
    const value = String(row?.id || row?.item_id || row?.item?.id || "").toUpperCase();
    if (/^MLB\d{6,}$/.test(value)) return value;
  }
  return "";
}

async function resolveCatalogProductItemId(productId, headers = {}) {
  const catalogProductId = String(productId || "").toUpperCase();
  if (!/^MLB\d{6,}$/.test(catalogProductId)) return "";

  const candidates = [
    `${ML_API}/products/${encodeURIComponent(catalogProductId)}`,
    `${ML_API}/sites/MLB/search?catalog_product_id=${encodeURIComponent(catalogProductId)}&limit=1`,
  ];
  for (const url of candidates) {
    try {
      const payload = await fetchJson(url, { headers, retries: 2 });
      const itemId = pickItemIdFromCatalogPayload(payload);
      if (itemId && itemId !== catalogProductId) return itemId;
    } catch {
      continue;
    }
  }
  return "";
}

function buildKeywordSuggestions(baseTerms, trendTerms = []) {
  const core = unique([...baseTerms, ...trendTerms]).slice(0, 8);
  const suggestions = [];
  for (let i = 0; i < core.length; i += 1) {
    const a = core[i];
    const b = core[(i + 1) % core.length];
    if (a && b && a !== b) suggestions.push(`${a} ${b}`);
  }
  return unique(suggestions).slice(0, 8);
}

async function buildMlProductRealtime({ url, itemId = "", productId = "", pageSignals = {}, networkEntries = [], headers = {}, title = "", generateKeywords = false }) {
  const networkSignals = extractMlSignalsFromNetwork(networkEntries);
  const pageStateSignals = normalizePageSignals(pageSignals);
  let mlb = resolveMlItemId({ url, itemId, productId, networkEntries }) || pageStateSignals.item_id;
  const catalogProductId = productId || networkSignals.catalog_product_id || parseMlProductId(url);
  if (!mlb && catalogProductId) {
    mlb = await resolveCatalogProductItemId(catalogProductId, headers);
  }
  if (!mlb) return { available: false, reason: "mlb_not_found", product_id: catalogProductId || null };
  const userProductId = parseMlUserProductId(url) || text(pageSignals?.user_product_id || pageSignals?.userProductId || "");

  const itemDetail = await fetchMlItemDetail(mlb, headers);
  const item = itemDetail?.item || null;
  const effectivePrice = Number(item?.price || networkSignals.price || pageStateSignals.price || 0);
  const siteId = text(item?.site_id || networkSignals.site_id || pageStateSignals.site_id || "MLB");
  const categoryId = text(item?.category_id || networkSignals.category_id || pageStateSignals.category_id || "");
  const sellerId = item?.seller_id ? String(item.seller_id) : "";
  const category = await mlCategoryDetail(categoryId, headers);
  const fee = await mlListingFee({
    siteId,
    price: effectivePrice,
    listingTypeId: item?.listing_type_id || networkSignals.listing_type_id || pageStateSignals.listing_type_id || "",
    categoryId,
    headers,
  });
  let visits = await mlVisits(mlb, headers);
  if (!visits?.visits_30d && networkSignals.visits_30d) {
    visits = { visits_30d: networkSignals.visits_30d, source: "network_page" };
  }

  let seller = null;
  const effectiveSellerId = sellerId || networkSignals.seller_id || pageStateSignals.seller_id || "";
  if (effectiveSellerId) {
    try {
      seller = await fetchJson(`${ML_API}/users/${encodeURIComponent(effectiveSellerId)}`, { headers, retries: 2 });
    } catch {
      seller = null;
    }
  }

  const trendTerms = await mlTrendsByCategory({ siteId, categoryId, headers });
  const effectiveTitle = item?.title || text(title) || "";
  const titleTerms = tokenize(effectiveTitle);
  const repeatedKeywords = generateKeywords
    ? await mlRepeatedKeywordsFromSearch({
        siteId,
        query: effectiveTitle || text(networkSignals.seo_keywords?.[0] || ""),
        categoryId,
        excludeItemId: mlb,
        headers,
        maxPages: 5,
      })
    : [];
  const keywordDiagnostics = repeatedKeywords.diagnostics || null;
  const repeatedTerms = repeatedKeywords.map((row) => text(row.term).toLowerCase()).filter(Boolean);
  const baseTerms = unique([...repeatedTerms, ...titleTerms, ...trendTerms.map((t) => text(t).toLowerCase())]).slice(0, 8);

  const ranked = repeatedKeywords.slice(0, 30);
  if (!generateKeywords && !ranked.length) {
    for (const term of baseTerms.slice(0, 6)) {
      try {
        const total = await mlSearchCount({ siteId, term, categoryId, headers });
        const rank = levelFromCount(total);
        ranked.push({ term, total, level: rank.level, label: rank.label });
      } catch {
        ranked.push({ term, total: null, level: "unknown", label: "Concorrencia indefinida" });
      }
    }
  }

  const userProductDetail = !pageStateSignals.date_created && !item?.date_created && !item?.start_time && userProductId
    ? await fetchMlUserProductDetail(userProductId, headers)
    : null;
  const userProduct = userProductDetail?.userProduct || null;
  const itemDateCreated = pickCreatedAt(item);
  const itemLastUpdated = pickUpdatedAt(item);
  const userProductDateCreated = pickCreatedAt(userProduct);
  const userProductLastUpdated = pickUpdatedAt(userProduct);
  const now = Date.now();
  const effectiveDateCreated = pageStateSignals.date_created || itemDateCreated || networkSignals.date_created || userProductDateCreated || null;
  const effectiveLastUpdated = pageStateSignals.last_updated || itemLastUpdated || networkSignals.last_updated || userProductLastUpdated || null;
  const createdAt = effectiveDateCreated ? new Date(effectiveDateCreated).getTime() : null;
  const ageDiff = createdAt ? now - createdAt : null;
  const ageDays = Number.isFinite(ageDiff) && ageDiff > 0 ? Math.max(1, Math.round(ageDiff / 86400000)) : null;
  const sold = Number(item?.sold_quantity || networkSignals.sold_quantity || 0);
  const monthlySales = ageDays ? Number(((sold / ageDays) * 30).toFixed(2)) : null;
  const availableQuantity = Number(item?.available_quantity || networkSignals.available_quantity || 0);
  const picturesCount = Math.max(
    Array.isArray(item?.pictures) ? item.pictures.length : 0,
    Number(networkSignals.pictures_count || pageStateSignals.pictures_count || 0),
  );
  const attrs = Array.isArray(item?.attributes)
    ? item.attributes
        .map((attr) => ({
          id: attr?.id || null,
          name: attr?.name || null,
          value: attr?.value_name || attr?.value_id || null,
        }))
        .filter((attr) => attr.name || attr.value)
    : [];
  const eans = attrs
    .filter((attr) => /^(GTIN|EAN|BARCODE|UNIVERSAL_PRODUCT_CODE)$/i.test(String(attr.id || "")) || /ean|gtin|codigo universal|código universal|barcode/i.test(String(attr.name || "")))
    .map((attr) => text(attr.value))
    .filter(Boolean);

  return {
    available: true,
    source: "ml_public_api",
    data_quality: {
      summary: networkEntries?.length
        ? "MLB resolvido com apoio forte do network da pagina; produto, vendedor, taxas, avaliacoes e visitas consultados/enriquecidos quando disponiveis."
        : "Produto, vendedor, taxas e visitas consultados em fontes oficiais quando disponiveis.",
      product: item ? "api_publica_ml_enriquecida_por_network" : "network_page",
      item_detail: itemDetail?.source || "indisponivel",
      date_created: effectiveDateCreated
        ? (pageStateSignals.date_created ? "page_initial_state" : userProductDateCreated ? userProductDetail?.source || "user_product_api" : itemDetail?.source || "network_page")
        : "indisponivel",
      visits: visits?.visits_30d ? visits?.source || "api_publica_ml" : "indisponivel",
      estimates: "estimado_por_historico_de_vendas",
      network_entries: Array.isArray(networkEntries) ? networkEntries.length : 0,
      melidata_events: networkSignals.events || 0,
      user_product_id: userProductId || null,
      user_product: userProductDetail?.source || "indisponivel",
      keywords: generateKeywords
        ? (repeatedKeywords.length ? "busca_ml_titulos_ate_pagina_5" : "busca_ml_sem_ocorrencias_suficientes")
        : "termos_por_titulo_tendencia_ou_seo",
      keyword_search: keywordDiagnostics,
    },
    page_type: "product",
    product: {
      id: mlb,
      title: effectiveTitle || mlb,
      price: effectivePrice,
      original_price: Number(item?.original_price || networkSignals.original_price || pageStateSignals.original_price || 0) || null,
      sold_quantity: sold,
      available_quantity: availableQuantity,
      pictures: picturesCount,
      listing_type_id: item?.listing_type_id || networkSignals.listing_type_id || pageStateSignals.listing_type_id || null,
      category_id: categoryId || networkSignals.category_id || null,
      category_name: category?.name || null,
      category_path: Array.isArray(category?.path_from_root)
        ? category.path_from_root.map((row) => row?.name).filter(Boolean).join(" > ")
        : null,
      site_id: siteId || "MLB",
      condition: item?.condition || networkSignals.item_condition || pageStateSignals.item_condition || null,
      catalog_listing: Boolean(item?.catalog_listing),
      catalog_product_id: item?.catalog_product_id || catalogProductId || networkSignals.catalog_product_id || null,
      warranty: item?.warranty || null,
      shipping_free: Boolean(item?.shipping?.free_shipping || networkSignals.free_shipping),
      shipping_mode: item?.shipping?.mode || networkSignals.shipping_mode || null,
      logistic_type: item?.shipping?.logistic_type || networkSignals.logistic_type || null,
      date_created: effectiveDateCreated,
      last_updated: effectiveLastUpdated,
      permalink: item?.permalink || url,
      attributes: attrs.slice(0, 20),
      eans: unique(eans).slice(0, 6),
      reviews: {
        rate: networkSignals.review_rate || pageStateSignals.review_rate,
        count: networkSignals.reviews_count || pageStateSignals.reviews_count,
        with_comment: networkSignals.reviews_with_comment,
        pictures_quantity: networkSignals.reviews_pictures_quantity,
      },
      promotions: networkSignals.promotions,
      domain_id: networkSignals.domain_id || null,
    },
    seller: seller
      ? {
          id: effectiveSellerId,
          nickname: seller?.nickname || null,
          level_id: seller?.seller_reputation?.level_id || networkSignals.reputation_level || null,
          power_seller_status: seller?.seller_reputation?.power_seller_status || networkSignals.power_seller_status || null,
          official_store_id: networkSignals.official_store_id || null,
          transactions_completed: Number(seller?.seller_reputation?.transactions?.completed || 0),
          transactions_total: Number(seller?.seller_reputation?.transactions?.total || 0),
          claims_rate: Number(seller?.seller_reputation?.metrics?.claims?.rate || 0),
          delayed_handling_time_rate: Number(seller?.seller_reputation?.metrics?.delayed_handling_time?.rate || 0),
          cancellations_rate: Number(seller?.seller_reputation?.metrics?.cancellations?.rate || 0),
          registration_date: seller?.registration_date || null,
          city: seller?.address?.city || null,
          state: seller?.address?.state || null,
        }
      : networkSignals.seller_name || networkSignals.seller_id
        ? {
            id: networkSignals.seller_id || null,
            nickname: networkSignals.seller_name || null,
            level_id: networkSignals.reputation_level || null,
            power_seller_status: networkSignals.power_seller_status || null,
            official_store_id: networkSignals.official_store_id || null,
          }
        : null,
    estimates: {
      age_days: ageDays,
      monthly_sales_projection: monthlySales,
      gross_revenue_projection: monthlySales != null ? Number((monthlySales * effectivePrice).toFixed(2)) : null,
    },
    fees: fee,
    traffic: visits,
    keywords: {
      ranked: ranked.length
        ? ranked
        : (!generateKeywords ? networkSignals.seo_keywords.slice(0, 6).map((term) => ({ term, total: null, level: "unknown", label: "Termo SEO do ML" })) : []),
      suggestions: buildKeywordSuggestions(baseTerms, unique([...repeatedTerms, ...trendTerms, ...networkSignals.seo_keywords.map((v) => v.toLowerCase())])),
    },
  };
}

async function buildMlSearchRealtime({ url, query = "", headers = {}, generateKeywords = false }) {
  const searchQuery = query || parseMlQuery(url);
  if (!searchQuery) return { available: false, reason: "query_not_found" };

  const payload = await fetchJson(`${ML_API}/sites/MLB/search?q=${encodeURIComponent(searchQuery)}&limit=20`, {
    headers,
    retries: 2,
  });

  const results = Array.isArray(payload?.results) ? payload.results : [];
  const prices = results.map((row) => Number(row?.price || 0)).filter((n) => Number.isFinite(n) && n > 0);
  const categoryFilter = (payload?.available_filters || []).find((f) => String(f?.id || "").toLowerCase() === "category");
  const categoryId = String(categoryFilter?.values?.[0]?.id || payload?.filters?.find?.((f) => f?.id === "category")?.values?.[0]?.id || "");
  const trendTerms = await mlTrendsByCategory({ siteId: "MLB", categoryId, headers });

  const repeatedKeywords = generateKeywords
    ? await mlRepeatedKeywordsFromSearch({
        siteId: "MLB",
        query: searchQuery,
        categoryId,
        headers,
        maxPages: 5,
      })
    : [];
  const keywordDiagnostics = repeatedKeywords.diagnostics || null;
  const repeatedTerms = repeatedKeywords.map((row) => text(row.term).toLowerCase()).filter(Boolean);
  const baseTerms = unique([
    ...repeatedTerms,
    ...tokenize(searchQuery),
    ...trendTerms.map((t) => text(t).toLowerCase()),
  ]).slice(0, 8);

  const ranked = repeatedKeywords.slice(0, 30);
  if (!generateKeywords && !ranked.length) {
    for (const term of baseTerms.slice(0, 6)) {
      try {
        const total = await mlSearchCount({ siteId: "MLB", term, categoryId, headers });
        const rank = levelFromCount(total);
        ranked.push({ term, total, level: rank.level, label: rank.label });
      } catch {
        ranked.push({ term, total: null, level: "unknown", label: "Concorrencia indefinida" });
      }
    }
  }

  return {
    available: true,
    source: "ml_public_api",
    data_quality: {
      keywords: generateKeywords
        ? (repeatedKeywords.length ? "busca_ml_titulos_ate_pagina_5" : "busca_ml_sem_ocorrencias_suficientes")
        : "termos_por_titulo_tendencia_ou_seo",
      keyword_search: keywordDiagnostics,
    },
    page_type: "search",
    query: searchQuery,
    search: {
      total_results: Number(payload?.paging?.total || 0),
      avg_price: prices.length ? Number((prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(2)) : null,
      min_price: prices.length ? Math.min(...prices) : null,
      max_price: prices.length ? Math.max(...prices) : null,
      category_id: categoryId || null,
    },
    keywords: {
      ranked,
      suggestions: buildKeywordSuggestions(baseTerms, unique([...repeatedTerms, ...trendTerms])),
    },
  };
}

async function buildShopeeRealtime({ url, pageType = "", query = "", title = "" }) {
  const currentQuery = query || parseShopeeQuery(url);
  const { shopId, itemId } = parseShopeeIds(url);

  const result = {
    available: false,
    source: "shopee_public_api",
    page_type: pageType || (itemId ? "product" : "search"),
    query: currentQuery || null,
    product: null,
    seller: null,
    keywords: { ranked: [], suggestions: [] },
    notes: [],
  };

  if (itemId && shopId) {
    try {
      const itemPayload = await fetchJson(
        `https://shopee.com.br/api/v4/item/get?itemid=${encodeURIComponent(itemId)}&shopid=${encodeURIComponent(shopId)}`,
        {
          headers: {
            "user-agent": "Mozilla/5.0",
            referer: url,
          },
          retries: 1,
        },
      );
      const data = itemPayload?.data || {};
      result.product = {
        item_id: itemId,
        shop_id: shopId,
        name: data?.name || null,
        price: Number(data?.price || 0) / 100000,
        historical_sold: Number(data?.historical_sold || 0),
        stock: Number(data?.stock || 0),
      };
      result.available = true;
    } catch {
      result.notes.push("item_get_unavailable");
    }
  }

  const keywordBase = unique([...tokenize(currentQuery), ...tokenize(title)]).slice(0, 8);

  if (currentQuery) {
    try {
      const sugPayload = await fetchJson(
        `https://shopee.com.br/api/v4/search/search_suggestion?keyword=${encodeURIComponent(currentQuery)}&limit=10&offset=0`,
        {
          headers: {
            "user-agent": "Mozilla/5.0",
            referer: "https://shopee.com.br/",
          },
          retries: 1,
        },
      );
      const rows = Array.isArray(sugPayload?.data?.sections)
        ? sugPayload.data.sections.flatMap((section) => section?.data || [])
        : [];
      const terms = rows
        .map((row) => text(row?.item?.hint || row?.keyword || row?.text || ""))
        .filter(Boolean)
        .slice(0, 10);
      const ranked = terms.map((term, idx) => {
        const level = idx <= 2 ? "high" : idx <= 6 ? "medium" : "low";
        return {
          term,
          total: null,
          level,
          label: level === "high" ? "Concorrencia alta" : level === "medium" ? "Concorrencia media" : "Concorrencia baixa",
        };
      });
      result.keywords = {
        ranked,
        suggestions: buildKeywordSuggestions(keywordBase, terms.map((v) => String(v).toLowerCase())),
      };
      result.available = true;
    } catch {
      result.notes.push("search_suggestion_unavailable");
    }
  }

  if (!result.keywords.ranked.length) {
    const fallback = keywordBase.map((term) => ({ term, total: null, level: "unknown", label: "Concorrencia indefinida" }));
    result.keywords = {
      ranked: fallback,
      suggestions: buildKeywordSuggestions(keywordBase, []),
    };
  }

  return result;
}

async function buildRealtimeInsights({
  marketplace = "",
  pageType = "",
  url = "",
  itemId = "",
  productId = "",
  networkEntries = [],
  pageSignals = {},
  query = "",
  title = "",
  mlCreds = null,
  generateKeywords = false,
} = {}) {
  const kind = parseMarketplace(marketplace, url);
  if (kind === "ml") {
    const headers = authHeaders(mlCreds);
    if (String(pageType || "").toLowerCase() === "search") {
      return buildMlSearchRealtime({ url, query, headers, generateKeywords });
    }
    return buildMlProductRealtime({ url, itemId, productId, pageSignals, networkEntries, headers, title, generateKeywords });
  }

  if (kind === "shopee") {
    return buildShopeeRealtime({ url, pageType, query, title });
  }

  return {
    available: false,
    reason: "unsupported_marketplace",
    source: "unknown",
  };
}

module.exports = {
  buildRealtimeInsights,
};
