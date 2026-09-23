// services/productAdsService.js
const fetch = require("node-fetch");
const TokenService = require("./tokenService");
const config = require("../config/config");
const simpleCache = require("./simpleCache");

const SITE_ID = "MLB";
const ITEMS_URL = "https://api.mercadolibre.com/items";
const USERS_ME_URL = "https://api.mercadolibre.com/users/me";
const ORDERS_SEARCH_URL = "https://api.mercadolibre.com/orders/search";
const SALES_30D_CACHE_TTL_SEC = 60 * 5;

function urls() {
  return {
    advertisers:
      "https://api.mercadolibre.com/advertising/advertisers?product_id=PADS",

    productAdsCampaignsSearch: (advId) =>
      `https://api.mercadolibre.com/advertising/${SITE_ID}/advertisers/${advId}/product_ads/campaigns/search`,

    // Endpoint atual de detalhe/metrica de campanha (api-version: 2).
    productAdsCampaignDetail: (_advId, campaignId) =>
      `https://api.mercadolibre.com/advertising/${SITE_ID}/product_ads/campaigns/${campaignId}`,

    // Fluxo atual de leitura de anuncios: Ad Groups.
    productAdsAdGroupsSearch: (advId) =>
      `https://api.mercadolibre.com/advertising/${SITE_ID}/advertisers/${advId}/product_ads/ad_groups/search`,

    productAdsCampaignAdGroupsMetrics: (campaignId) =>
      `https://api.mercadolibre.com/advertising/${SITE_ID}/product_ads/campaigns/${campaignId}/ad_groups/metrics`,

    productAdsAdGroupAds: (adGroupId) =>
      `https://api.mercadolibre.com/advertising/${SITE_ID}/product_ads/ad_groups/${adGroupId}/ads`,

    // Escrita: mantemos apenas recursos de anuncio ainda publicados. Leituras nao usam estes paths.
    productAdsCampaigns: (advId) =>
      `https://api.mercadolibre.com/advertising/${SITE_ID}/advertisers/${advId}/product_ads/campaigns`,
    productAdsAdByItemId: (advId, itemId) =>
      `https://api.mercadolibre.com/advertising/${SITE_ID}/advertisers/${advId}/product_ads/ads/${encodeURIComponent(itemId)}`,
    productAdsAdByItemMarketplace: (itemId) =>
      `https://api.mercadolibre.com/marketplace/advertising/${SITE_ID}/product_ads/ads/${encodeURIComponent(itemId)}?channel=marketplace`,
    productAdsAdByItemMarketplaceAdvertiser: (advId, itemId) =>
      `https://api.mercadolibre.com/marketplace/advertising/${SITE_ID}/advertisers/${advId}/product_ads/ads/${encodeURIComponent(itemId)}?channel=marketplace`,
    productAdsAdByItemSite: (itemId) =>
      `https://api.mercadolibre.com/advertising/${SITE_ID}/product_ads/ads/${encodeURIComponent(itemId)}`,
  };
}

function buildProductAdsItemTargetUrls(advertiserId, itemId) {
  const U = urls();
  const raw = [
    U.productAdsAdByItemMarketplace(itemId),
    U.productAdsAdByItemMarketplaceAdvertiser(advertiserId, itemId),
    U.productAdsAdByItemId(advertiserId, itemId),
    U.productAdsAdByItemSite(itemId),
  ].filter(Boolean);
  return Array.from(new Set(raw));
}

async function resolveCampaignItemTargetIds(
  advertiserId,
  campaignId,
  itemOrAdId,
  state
) {
  const seed = String(itemOrAdId || "").trim();
  const ids = new Set(seed ? [seed] : []);
  if (!seed) return [];

  try {
    const rows = await listarTodosAdsDaCampanha(
      advertiserId,
      campaignId,
      {},
      state
    );
    const seedLower = seed.toLowerCase();

    for (const row of rows || []) {
      const adId = String(
        row?.id ??
          row?.ad_id ??
          row?.adId ??
          row?.advertising_id ??
          row?.advertisingId ??
          ""
      ).trim();
      const itemId = String(row?.item_id ?? row?.itemId ?? "").trim();

      if (!adId && !itemId) continue;

      const matchesSeed =
        (adId && adId.toLowerCase() === seedLower) ||
        (itemId && itemId.toLowerCase() === seedLower);
      if (!matchesSeed) continue;

      if (adId) ids.add(adId);
      if (itemId) ids.add(itemId);
    }
  } catch (err) {
    console.warn(
      "[ProductAds] Falha ao resolver IDs de anuncio/item para mutacao:",
      err?.message || err
    );
  }

  return Array.from(ids).filter(Boolean);
}

// ======================================================
// Métricas: lista "mínima segura" e lista "expandida"
// ======================================================
const METRICS_MIN = [
  "clicks",
  "prints",
  "ctr",
  "cost",
  "cpc",
  "acos",
  "roas",
  "units_quantity",
  "total_amount",
];

const METRICS_EXTENDED = [
  ...METRICS_MIN,
  "direct_amount",
  "indirect_amount",
  "tacos",
  "organic_units_amount",
];

function numberOrZero(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function numberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function firstFiniteNumber(values = []) {
  for (const value of Array.isArray(values) ? values : []) {
    const n = numberOrNull(value);
    if (n != null) return n;
  }
  return null;
}

function extractCampaignDailyBudget(campaign) {
  if (!campaign || typeof campaign !== "object") return null;

  return firstFiniteNumber([
    campaign.daily_budget,
    campaign.dailyBudget,
    campaign.budget,
    campaign.budget_amount,
    campaign.budgetAmount,
    campaign.average_daily_budget,
    campaign.averageDailyBudget,
    campaign.daily_budget_amount,
    campaign.dailyBudgetAmount,
    campaign.budget?.amount,
    campaign.budget?.value,
    campaign.budget?.daily_budget,
    campaign.budget?.dailyBudget,
    campaign.daily_budget?.amount,
    campaign.daily_budget?.value,
    campaign.average_daily_budget?.amount,
    campaign.average_daily_budget?.value,
  ]);
}

function buildCampaignsSummary(campaigns = []) {
  return campaigns.reduce(
    (acc, campaign) => {
      const metrics = campaign?.metrics || campaign?.metrics_summary || {};
      const amount = numberOrZero(metrics.total_amount);
      const directAmount = numberOrZero(metrics.direct_amount);
      const indirectAmount = numberOrZero(metrics.indirect_amount);
      const cost = numberOrZero(metrics.cost);
      const clicks = numberOrZero(metrics.clicks);
      const prints = numberOrZero(metrics.prints);
      const units = numberOrZero(metrics.units_quantity);
      const tacos = numberOrNull(metrics.tacos);

      acc.total_campaigns += 1;
      if (String(campaign?.status || "").toLowerCase() === "active") {
        acc.active_campaigns += 1;
      }

      acc.amount += amount;
      acc.direct_amount += directAmount;
      acc.indirect_amount += indirectAmount;
      acc.cost += cost;
      acc.clicks += clicks;
      acc.prints += prints;
      acc.units += units;
      if (tacos != null && tacos > 0 && cost > 0) {
        acc.tacos_sales_base += cost / (tacos / 100);
      }
      return acc;
    },
    {
      total_campaigns: 0,
      active_campaigns: 0,
      amount: 0,
      direct_amount: 0,
      indirect_amount: 0,
      cost: 0,
      clicks: 0,
      prints: 0,
      units: 0,
      tacos_sales_base: 0,
    },
  );
}

// ======================================================
// Helper de chamada autenticada
// ======================================================
async function withAuth(url, init, state) {
  const call = async (token) => {
    const headers = {
      ...(init?.headers || {}),
      Authorization: `Bearer ${token}`,
    };
    return fetch(url, { ...init, headers });
  };

  let resp = await call(state.token);
  if (resp.status !== 401) return resp;

  const novo = await TokenService.renovarToken(state.creds);
  state.token = novo.access_token;

  return call(state.token);
}

async function prepararAuth(opts = {}) {
  const creds =
    opts && opts.mlCreds && typeof opts.mlCreds === "object"
      ? opts.mlCreds
      : {};
  if (!creds.accountKey && !creds.account_key && opts?.accountKey) {
    creds.accountKey = opts.accountKey;
  }
  const token = await TokenService.renovarTokenSeNecessario(creds);
  return { token, creds };
}

// ======================================================
// Util: controlar concorrência (evita rate-limit)
// ======================================================
async function pMapLimit(list, limit, mapper) {
  const ret = new Array(list.length);
  let i = 0;

  const workers = new Array(Math.min(limit, list.length))
    .fill(null)
    .map(async () => {
      while (true) {
        const idx = i++;
        if (idx >= list.length) break;
        ret[idx] = await mapper(list[idx], idx);
      }
    });

  await Promise.all(workers);
  return ret;
}

// ==========================================
// Descobrir advertiser_id da conta
// ==========================================
async function obterAdvertiserId(state) {
  const U = urls();

  const r = await withAuth(
    U.advertisers,
    {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "Api-Version": "1",
      },
    },
    state
  );

  const txt = await r.text().catch(() => "");
  if (!r.ok) {
    const err = new Error(`advertisers HTTP ${r.status} ${txt}`);
    err.code = "ADVERTISERS_ERROR";
    throw err;
  }

  let data;
  try {
    data = txt ? JSON.parse(txt) : {};
  } catch (e) {
    const err = new Error(`Falha ao parsear advertisers: ${e.message}`);
    err.code = "ADVERTISERS_ERROR";
    throw err;
  }

  const list = Array.isArray(data.advertisers) ? data.advertisers : [];
  if (!list.length) {
    const err = new Error("Nenhum advertiser retornado.");
    err.code = "NO_ADVERTISER";
    throw err;
  }

  const adv = list.find((a) => a.site_id === SITE_ID) || list[0];

  const id = adv.advertiser_id || adv.id;
  if (!id) {
    const err = new Error("Advertiser sem advertiser_id válido.");
    err.code = "NO_ADVERTISER";
    throw err;
  }

  return id;
}

// ==========================================
// Helper: buscar thumbnails (AUTENTICADO)
// ==========================================
async function buscarThumbnailsParaItens(itemIds = [], state) {
  const uniqueIds = Array.from(new Set(itemIds.filter(Boolean)));
  if (!uniqueIds.length) return {};

  const map = {};
  let logged401 = false;
  const chunkSize = 20;

  for (let i = 0; i < uniqueIds.length; i += chunkSize) {
    const slice = uniqueIds.slice(i, i + chunkSize);

    const params = new URLSearchParams();
    params.set("ids", slice.join(","));
    params.set("attributes", "id,thumbnail,secure_thumbnail");

    const url = `${ITEMS_URL}?${params.toString()}`;

    try {
      const r = await withAuth(
        url,
        { method: "GET", headers: { "Content-Type": "application/json" } },
        state
      );

      const txt = await r.text().catch(() => "");

      if (!r.ok) {
        if (r.status === 401 && !logged401) {
          console.warn(
            "[ProductAds] Falha ao buscar thumbnails (401). Verifique permissões do token para /items."
          );
          logged401 = true;
        } else if (r.status !== 401) {
          console.warn(
            "[ProductAds] Falha ao buscar thumbnails:",
            r.status,
            txt
          );
        }
        continue;
      }

      let data;
      try {
        data = txt ? JSON.parse(txt) : [];
      } catch (e) {
        console.warn("[ProductAds] Erro parseando thumbnails:", e.message);
        continue;
      }

      for (const row of data) {
        if (!row || row.code !== 200 || !row.body) continue;
        const body = row.body;
        if (!body.id) continue;

        map[body.id] = body.secure_thumbnail || body.thumbnail || null;
      }
    } catch (e) {
      console.warn(
        "[ProductAds] Erro inesperado ao buscar thumbnails:",
        e.message
      );
    }
  }

  return map;
}

// ======================================================
// Helpers internos de Product Ads
// ======================================================
async function fetchJsonOrError(r) {
  const txt = await r.text().catch(() => "");
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try {
      const errData = txt ? JSON.parse(txt) : null;
      if (errData?.error) msg = errData.error;
      if (errData?.message) msg += ` - ${errData.message}`;
      if (!errData?.error && !errData?.message && txt)
        msg = `HTTP ${r.status} ${txt}`;
    } catch (_) {
      if (txt) msg = `HTTP ${r.status} ${txt}`;
    }
    const err = new Error(msg);
    err.httpStatus = r.status;
    err.rawBody = txt;
    throw err;
  }

  try {
    return txt ? JSON.parse(txt) : {};
  } catch (e) {
    const err = new Error(`Parse error: ${e.message}`);
    err.rawBody = txt;
    throw err;
  }
}

function pickCreatedAt(obj) {
  if (!obj) return null;
  return (
    obj.meliCreatedAt || // (o app que você analisou usa isso)
    obj.date_created ||
    obj.dateCreated ||
    obj.created_date ||
    obj.createdDate ||
    obj.created_at ||
    obj.createdAt ||
    null
  );
}

function pickLastUpdated(obj) {
  if (!obj) return null;
  return (
    obj.last_updated ||
    obj.lastUpdated ||
    obj.updated_at ||
    obj.updatedAt ||
    obj.modified_at ||
    obj.modifiedAt ||
    obj.modification_date ||
    obj.modificationDate ||
    null
  );
}

async function tentarAdsSearchComFallback({ state, urlBase, paramsObj }) {
  const doCall = async (metricsList) => {
    const params = new URLSearchParams(paramsObj);
    params.set("metrics", metricsList.join(","));
    const url = `${urlBase}?${params.toString()}`;

    const r = await withAuth(
      url,
      { method: "GET", headers: { "api-version": "2" } },
      state
    );

    return fetchJsonOrError(r);
  };

  try {
    return await doCall(METRICS_EXTENDED);
  } catch (e) {
    console.warn("[ProductAds] metrics fallback (extended -> min):", e.message);
    return await doCall(METRICS_MIN);
  }
}


function normalizeAdGroupMetrics(row = {}) {
  const nested = row?.metrics_summary || row?.metrics || {};
  const metrics = { ...nested };
  const names = Array.from(new Set([...METRICS_EXTENDED, "cvr", "sov", "tacos"]));
  for (const name of names) {
    if (metrics[name] == null && row?.[name] != null) metrics[name] = row[name];
    const upper = String(name).toUpperCase();
    if (metrics[name] == null && row?.[upper] != null) metrics[name] = row[upper];
  }
  return metrics;
}

function normalizeAdGroupRow(row = {}) {
  const externalId = String(
    row?.ad_group_external_id ??
      row?.item_id ??
      row?.itemId ??
      row?.external_id ??
      ""
  ).trim();
  const adGroupId = String(row?.id ?? row?.ad_group_id ?? row?.adGroupId ?? "").trim();
  return {
    ...row,
    id: adGroupId || row?.id || null,
    ad_id: adGroupId || null,
    advertising_id: adGroupId || null,
    ad_group_id: adGroupId || null,
    item_id: externalId || null,
    title: row?.title || row?.name || externalId || adGroupId || "Anuncio patrocinado",
    thumbnail: row?.secure_thumbnail || row?.thumbnail || row?.picture_url || null,
    status: String(row?.status || "").toLowerCase() || null,
    campaign_id: row?.campaign_id ?? row?.campaignId ?? null,
    ad_group_type: row?.ad_group_type ?? row?.type ?? null,
    metrics: normalizeAdGroupMetrics(row),
  };
}

async function buscarAdGroups(
  advertiserId,
  {
    date_from,
    date_to,
    campaign_id,
    item_ids,
    statuses,
    query,
    page = 1,
    limit = 100,
    offset: explicitOffset,
    include_metrics,
  } = {},
  state
) {
  const U = urls();
  const safeLimit = Math.max(1, Math.min(800, Number(limit) || 100));
  const safePage = Math.max(1, Number(page) || 1);
  const offset = Number.isFinite(Number(explicitOffset))
    ? Math.max(0, Number(explicitOffset))
    : (safePage - 1) * safeLimit;

  const wantsMetrics =
    include_metrics === true ||
    (include_metrics !== false && !!date_from && !!date_to);
  const paramsObj = {
    limit: String(safeLimit),
    offset: String(offset),
  };
  if (wantsMetrics) paramsObj.metrics_summary = "true";
  if (date_from) paramsObj.date_from = date_from;
  if (date_to) paramsObj.date_to = date_to;
  if (campaign_id) paramsObj["filters[campaigns]"] = String(campaign_id);
  const itemIds = normalizeItemIds(item_ids || []);
  if (itemIds.length) paramsObj["filters[item_ids]"] = itemIds.join(",");
  if (statuses) {
    const statusText = Array.isArray(statuses) ? statuses.join(",") : String(statuses);
    if (statusText.trim()) paramsObj["filters[statuses]"] = statusText.trim().toLowerCase();
  }
  if (query && String(query).trim()) paramsObj["filters[q]"] = String(query).trim();

  const callAdGroups = async (metricsList) => {
    const params = new URLSearchParams(paramsObj);
    params.set(
      "metrics",
      metricsList.map((name) => String(name).toUpperCase()).join(",")
    );
    const r = await withAuth(
      `${U.productAdsAdGroupsSearch(advertiserId)}?${params.toString()}`,
      { method: "GET", headers: { "api-version": "2" } },
      state
    );
    return fetchJsonOrError(r);
  };

  let data;
  if (wantsMetrics) {
    try {
      data = await callAdGroups(Array.from(new Set([...METRICS_EXTENDED, "cvr", "sov", "tacos"])));
    } catch (err) {
      console.warn("[ProductAds] Ad Groups metrics fallback:", err?.message || err);
      data = await callAdGroups(METRICS_MIN);
    }
  } else {
    const params = new URLSearchParams(paramsObj);
    const r = await withAuth(
      `${U.productAdsAdGroupsSearch(advertiserId)}?${params.toString()}`,
      { method: "GET", headers: { "api-version": "2" } },
      state
    );
    data = await fetchJsonOrError(r);
  }

  const results = Array.isArray(data?.results)
    ? data.results.map(normalizeAdGroupRow)
    : [];
  return {
    results,
    paging: data?.paging || { offset, limit: safeLimit, total: results.length },
    metrics_summary: data?.metrics_summary || null,
  };
}

async function obterCampanhaPorId(advertiserId, campaignId, state) {
  const U = urls();

  // 1) tenta endpoint de detalhe
  try {
    const r = await withAuth(
      U.productAdsCampaignDetail(advertiserId, campaignId),
      { method: "GET", headers: { "api-version": "2" } },
      state
    );
    const data = await fetchJsonOrError(r);
    return data || null;
  } catch (e) {
    // 2) fallback: search filtrando por id (caso detalhe não exista)
    try {
      const paramsObj = {
        limit: "1",
        offset: "0",
        aggregation_type: "campaign",
        "filters[campaign_ids]": String(campaignId),
      };
      const data = await tentarAdsSearchComFallback({
        state,
        urlBase: U.productAdsCampaignsSearch(advertiserId),
        paramsObj,
      });
      return (data.results || [])[0] || null;
    } catch (e2) {
      return null;
    }
  }
}

async function contarAdgroupsDaCampanha(
  advertiserId,
  campaignId,
  { date_from, date_to } = {},
  state
) {
  try {
    const data = await buscarAdGroups(
      advertiserId,
      { date_from, date_to, campaign_id: campaignId, limit: 1, page: 1, include_metrics: false },
      state
    );
    const total = Number(data?.paging?.total);
    return Number.isFinite(total) ? total : data.results.length;
  } catch (e) {
    console.warn("[ProductAds] Nao foi possivel contar Ad Groups:", e?.message || e);
    return null;
  }
}

async function listarTodosAdsDaCampanha(
  advertiserId,
  campaignId,
  { date_from, date_to } = {},
  state
) {
  const limit = 500;
  let offset = 0;
  const all = [];
  let total = null;

  while (true) {
    const data = await buscarAdGroups(
      advertiserId,
      {
        date_from,
        date_to,
        campaign_id: campaignId,
        limit,
        offset,
      },
      state
    );
    const results = Array.isArray(data.results) ? data.results : [];
    const pagingTotal = Number(data?.paging?.total);
    if (Number.isFinite(pagingTotal)) total = pagingTotal;
    all.push(...results);
    offset += results.length;
    if (!results.length) break;
    if (Number.isFinite(total) && offset >= total) break;
    if (results.length < limit) break;
  }

  return all;
}

async function listarTodasCampanhasAds(
  advertiserId,
  { date_from, date_to } = {},
  state
) {
  const U = urls();
  const limit = 50;
  let offset = 0;
  let all = [];
  let total = null;

  while (true) {
    const paramsObj = {};
    if (date_from) paramsObj.date_from = date_from;
    if (date_to) paramsObj.date_to = date_to;
    paramsObj.limit = String(limit);
    paramsObj.offset = String(offset);
    paramsObj.aggregation_type = "campaign";

    const data = await tentarAdsSearchComFallback({
      state,
      urlBase: U.productAdsCampaignsSearch(advertiserId),
      paramsObj,
    });

    const results = Array.isArray(data.results) ? data.results : [];
    const paging = data.paging || {};
    total = typeof paging.total === "number" ? paging.total : total;

    all.push(...results);

    offset += results.length;
    if (!results.length) break;
    if (typeof total === "number" && offset >= total) break;
    if (results.length < limit) break;
  }

  return {
    results: all,
    paging: {
      total: typeof total === "number" ? total : all.length,
      offset: 0,
      limit,
    },
  };
}

function mergeCampaignCatalogWithMetrics(catalogRows = [], metricRows = []) {
  const metricsById = new Map();
  for (const row of metricRows || []) {
    const id = row?.id || row?.campaign_id;
    if (!id) continue;
    metricsById.set(String(id), row);
  }

  const merged = [];
  const seen = new Set();

  const pushRow = (row) => {
    const id = row?.id || row?.campaign_id;
    if (!id) return;

    const key = String(id);
    if (seen.has(key)) return;
    seen.add(key);

    const metricRow = metricsById.get(key) || {};
    const rowMetrics = row?.metrics;
    const metricMetrics = metricRow?.metrics;
    const metrics =
      rowMetrics && typeof rowMetrics === "object" && Object.keys(rowMetrics).length
        ? rowMetrics
        : metricMetrics && typeof metricMetrics === "object"
        ? metricMetrics
        : {};

    merged.push({
      ...row,
      id,
      name: row?.name || metricRow?.name || String(id),
      status: row?.status || metricRow?.status || null,
      strategy: row?.strategy || metricRow?.strategy || null,
      daily_budget:
        extractCampaignDailyBudget(row) ?? extractCampaignDailyBudget(metricRow),
      acos_target:
        row?.acos_target != null ? row.acos_target : metricRow?.acos_target ?? null,
      roas_target:
        row?.roas_target != null
          ? row.roas_target
          : row?.goal != null
          ? row.goal
          : metricRow?.roas_target ?? metricRow?.goal ?? null,
      roas: row?.roas != null ? row.roas : metricRow?.roas ?? null,
      created_at: pickCreatedAt(row) || pickCreatedAt(metricRow) || null,
      last_updated: pickLastUpdated(row) || pickLastUpdated(metricRow) || null,
      metrics,
    });
  };

  for (const row of catalogRows || []) pushRow(row);
  for (const row of metricRows || []) pushRow(row);

  return merged;
}

function toISODateLocal(date) {
  const d = date instanceof Date ? date : new Date(date);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);
}

function addDaysISO(isoDate, deltaDays) {
  const d = new Date(`${isoDate}T00:00:00`);
  d.setDate(d.getDate() + Number(deltaDays || 0));
  return toISODateLocal(d);
}

function rangeLast30Days() {
  const date_to = toISODateLocal(new Date());
  const date_from = addDaysISO(date_to, -29);
  return { date_from, date_to };
}

function startOfDayBr(isoDate) {
  return `${isoDate}T00:00:00.000-03:00`;
}

function endOfDayBr(isoDate) {
  return `${isoDate}T23:59:59.999-03:00`;
}

function asPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function normalizeWizardStatus(value) {
  const raw = String(value || "all")
    .trim()
    .toLowerCase();

  if (raw === "active") return "active";
  if (raw === "paused") return "paused";
  if (raw === "without_campaign" || raw === "sem_campanha") {
    return "without_campaign";
  }
  return "all";
}

function normalizeText(value) {
  return String(value || "").trim();
}

function extractMlbIdsFromQuery(query) {
  const raw = normalizeText(query).toUpperCase();
  if (!raw) return [];

  const set = new Set();

  const explicit = raw.match(/\bMLB\d{5,}\b/g) || [];
  explicit.forEach((id) => set.add(id));

  const numeric = raw.match(/\b\d{5,}\b/g) || [];
  numeric.forEach((id) => set.add(`MLB${id}`));

  return Array.from(set);
}

function normalizeItemIds(list) {
  const set = new Set(
    (Array.isArray(list) ? list : [])
      .map((v) => String(v || "").trim())
      .filter(Boolean)
  );
  return Array.from(set);
}

async function obterSellerId(state) {
  const r = await withAuth(
    USERS_ME_URL,
    { method: "GET", headers: { "Content-Type": "application/json" } },
    state
  );

  const data = await fetchJsonOrError(r);
  const sellerId = data?.id || null;

  if (!sellerId) {
    const err = new Error("Nao foi possivel identificar o seller da conta.");
    err.code = "WIZARD_ITEMS_ERROR";
    throw err;
  }

  return String(sellerId);
}

async function buscarIdsItensSeller(
  sellerId,
  { query, page, limit } = {},
  state
) {
  const safePage = asPositiveInt(page, 1);
  const safeLimit = Math.min(100, Math.max(10, asPositiveInt(limit, 30)));
  const offset = (safePage - 1) * safeLimit;
  const q = normalizeText(query);
  const queryMlbIds = extractMlbIdsFromQuery(q);

  const runSellerItemsSearch = async (extraParams = {}) => {
    const params = new URLSearchParams();
    params.set("limit", String(safeLimit));
    params.set("offset", String(offset));
    if (q) params.set("q", q);

    Object.entries(extraParams || {}).forEach(([k, v]) => {
      if (v == null) return;
      params.set(String(k), String(v));
    });

    const url = `https://api.mercadolibre.com/users/${encodeURIComponent(
      sellerId
    )}/items/search?${params.toString()}`;

    const r = await withAuth(
      url,
      { method: "GET", headers: { "Content-Type": "application/json" } },
      state
    );
    return fetchJsonOrError(r);
  };

  const attempts = [
    { name: "status_active", params: { status: "active" } },
    { name: "default", params: {} },
    { name: "scan", params: { search_type: "scan" } },
  ];

  let data = null;
  let lastErr = null;

  for (const attempt of attempts) {
    try {
      data = await runSellerItemsSearch(attempt.params);
      break;
    } catch (err) {
      lastErr = err;
      const isBadRequest =
        Number(err?.httpStatus || 0) === 400 ||
        String(err?.message || "").toLowerCase().includes("bad_request");

      if (!isBadRequest) throw err;

      console.warn(
        `[ProductAds] items/search tentativa '${attempt.name}' falhou:`,
        err?.message || err
      );
    }
  }

  if (!data) {
    // Evita estourar o modal com 502 quando a API de busca do seller
    // devolve bad_request. Ainda permite busca direta por MLB.
    data = { results: [], paging: { total: 0 } };
    if (!queryMlbIds.length && lastErr) {
      console.warn(
        "[ProductAds] items/search indisponivel para esta conta:",
        lastErr?.message || lastErr
      );
    }
  }

  const results = Array.isArray(data?.results) ? data.results : [];
  const itemIdsFromSearch = results
    .map((v) => String(v || "").trim())
    .filter(Boolean);
  let itemIds = itemIdsFromSearch;

  if (queryMlbIds.length) {
    // Garante busca por MLB mesmo quando o endpoint de search do seller
    // nao retorna o item por "q". Validamos seller/status quando vier no payload.
    const details = await buscarDetalhesItens(queryMlbIds, state);
    const validMlbIds = queryMlbIds.filter((itemId) => {
      const detail = details.get(String(itemId));
      if (!detail) return false;

      const ownerId = String(detail.seller_id || "");
      const ownerMatches = !ownerId || ownerId === String(sellerId);
      const statusText = String(detail.status || "").toLowerCase();
      const isActive = !statusText || statusText === "active";
      return ownerMatches && isActive;
    });

    itemIds = Array.from(new Set([...validMlbIds, ...itemIdsFromSearch]));
  }

  const totalSearch = Number(data?.paging?.total);
  const total = Number.isFinite(totalSearch)
    ? Math.max(totalSearch, itemIds.length)
    : itemIds.length;

  return {
    page: safePage,
    limit: safeLimit,
    offset,
    total,
    itemIds,
  };
}

async function buscarDetalhesItens(itemIds = [], state) {
  const uniqueIds = normalizeItemIds(itemIds);
  if (!uniqueIds.length) return new Map();

  const out = new Map();
  const chunkSize = 20;

  for (let i = 0; i < uniqueIds.length; i += chunkSize) {
    const slice = uniqueIds.slice(i, i + chunkSize);
    const params = new URLSearchParams();
    params.set("ids", slice.join(","));
    params.set(
      "attributes",
      "id,title,status,thumbnail,secure_thumbnail,seller_custom_field,seller_id"
    );

    const url = `${ITEMS_URL}?${params.toString()}`;

    const r = await withAuth(
      url,
      { method: "GET", headers: { "Content-Type": "application/json" } },
      state
    );

    const txt = await r.text().catch(() => "");
    if (!r.ok) {
      console.warn("[ProductAds] Falha ao buscar detalhes de itens:", r.status);
      continue;
    }

    let rows = [];
    try {
      rows = txt ? JSON.parse(txt) : [];
    } catch (e) {
      console.warn("[ProductAds] Falha ao parsear detalhes de itens:", e.message);
      continue;
    }

    for (const row of rows) {
      if (!row || row.code !== 200 || !row.body?.id) continue;
      const body = row.body;

      out.set(String(body.id), {
        item_id: String(body.id),
        title: body.title || String(body.id),
        status: body.status || null,
        thumbnail: body.secure_thumbnail || body.thumbnail || null,
        sku: body.seller_custom_field || null,
        seller_id: body.seller_id || body.seller?.id || null,
      });
    }
  }

  return out;
}

async function buscarMapaCampanhas(advertiserId, state) {
  const cacheKey = `product-ads:wizard:campaigns:${advertiserId}`;
  const cached = simpleCache.get(cacheKey);
  if (cached && typeof cached === "object") return cached;

  const data = await listarTodasCampanhasAds(advertiserId, {}, state);
  const map = {};

  for (const campaign of data.results || []) {
    if (!campaign?.id) continue;
    map[String(campaign.id)] = {
      id: campaign.id,
      name: campaign.name || String(campaign.id),
      status: campaign.status || null,
    };
  }

  simpleCache.set(cacheKey, map, SALES_30D_CACHE_TTL_SEC);
  return map;
}

async function buscarAssociacaoCampanhaPorItem(itemIds = [], advertiserId, state) {
  const ids = normalizeItemIds(itemIds);
  if (!ids.length) return new Map();

  const out = new Map();
  const chunkSize = 50;

  for (let i = 0; i < ids.length; i += chunkSize) {
    const slice = ids.slice(i, i + chunkSize);
    try {
      const data = await buscarAdGroups(
        advertiserId,
        { item_ids: slice, limit: Math.max(50, slice.length), page: 1, include_metrics: false },
        state
      );

      for (const row of data.results || []) {
        const itemId = String(row?.item_id || row?.ad_group_external_id || "").trim();
        if (!itemId) continue;

        const previous = out.get(itemId);
        const next = {
          campaign_id: row?.campaign_id || null,
          ad_status: row?.status || null,
          ad_group_id: row?.ad_group_id || row?.id || null,
        };

        if (!previous) {
          out.set(itemId, next);
          continue;
        }

        const prevActive = String(previous.ad_status || "").toLowerCase() === "active";
        const nextActive = String(next.ad_status || "").toLowerCase() === "active";
        if (!prevActive && nextActive) out.set(itemId, next);
      }
    } catch (e) {
      console.warn("[ProductAds] Falha ao mapear itens para Ad Groups:", e?.message || e);
    }
  }

  return out;
}

async function buscarVendas30dPorItem(sellerId, state) {
  const { date_from, date_to } = rangeLast30Days();
  const cacheKey = `product-ads:wizard:sales30:${sellerId}:${date_from}:${date_to}`;
  const cached = simpleCache.get(cacheKey);
  if (cached && typeof cached === "object") return cached;

  const salesMap = {};
  const limit = 50;
  let offset = 0;
  let total = Infinity;
  let scanned = 0;
  const maxOrders = 2000;
  let truncated = false;

  while (offset < total && scanned < maxOrders) {
    const params = new URLSearchParams();
    params.set("seller", String(sellerId));
    params.set("order.status", "paid");
    params.set("order.date_closed.from", startOfDayBr(date_from));
    params.set("order.date_closed.to", endOfDayBr(date_to));
    params.set("sort", "date_desc");
    params.set("limit", String(limit));
    params.set("offset", String(offset));

    const url = `${ORDERS_SEARCH_URL}?${params.toString()}`;
    const r = await withAuth(
      url,
      { method: "GET", headers: { "Content-Type": "application/json" } },
      state
    );

    const data = await fetchJsonOrError(r);
    const orders = Array.isArray(data?.results) ? data.results : [];
    const pagingTotal = Number(data?.paging?.total);
    total = Number.isFinite(pagingTotal) ? pagingTotal : total;

    if (!orders.length) break;

    for (const order of orders) {
      const orderItems = Array.isArray(order?.order_items) ? order.order_items : [];
      for (const row of orderItems) {
        const itemId = String(row?.item?.id || row?.item_id || "").trim();
        if (!itemId) continue;
        const quantity = Number(row?.quantity || 0);
        if (!Number.isFinite(quantity) || quantity <= 0) continue;

        salesMap[itemId] = Number(salesMap[itemId] || 0) + quantity;
      }
    }

    scanned += orders.length;
    offset += orders.length;

    if (orders.length < limit) break;
    if (offset >= total) break;
  }

  if (scanned >= maxOrders && offset < total) truncated = true;

  const payload = {
    date_from,
    date_to,
    sales_by_item: salesMap,
    scanned_orders: scanned,
    truncated,
  };

  simpleCache.set(cacheKey, payload, SALES_30D_CACHE_TTL_SEC);
  return payload;
}

async function vincularItemNaCampanha(advertiserId, itemId, campaignId, state) {
  const body = {
    campaign_id: Number(campaignId),
    status: "active",
    channel: "marketplace",
  };

  const attempts = [];
  for (const targetUrl of buildProductAdsItemTargetUrls(advertiserId, itemId)) {
    attempts.push({ method: "PUT", url: targetUrl });
    attempts.push({ method: "POST", url: targetUrl });
  }

  const errors = [];

  for (const attempt of attempts) {
    try {
      const r = await withAuth(
        attempt.url,
        {
          method: attempt.method,
          headers: {
            "api-version": "2",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
        state
      );

      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        errors.push(`${attempt.method} ${r.status} ${txt}`);
        continue;
      }

      const txt = await r.text().catch(() => "");
      const data = txt ? JSON.parse(txt) : {};
      return { success: true, item_id: itemId, data };
    } catch (e) {
      errors.push(`${attempt.method} ${e.message}`);
    }
  }

  return {
    success: false,
    item_id: itemId,
    error: errors.join(" | ") || "Falha ao vincular item na campanha.",
  };
}

function normalizeCampaignStatus(value) {
  const status = String(value || "")
    .trim()
    .toLowerCase();
  if (!status) return null;
  if (["active", "enabled", "on"].includes(status)) return "active";
  if (["paused", "disabled", "off", "pause"].includes(status)) return "paused";
  return null;
}

function summarizeCampaignPayload(campaign) {
  if (!campaign || typeof campaign !== "object") return null;
  return {
    id: campaign.id || campaign.campaign_id || null,
    name: campaign.name || null,
    status: campaign.status || null,
    strategy: campaign.strategy || null,
    roas_target: numberOrZero(campaign.roas_target || campaign.goal),
    daily_budget: extractCampaignDailyBudget(campaign),
    acos_target:
      campaign.acos_target != null ? numberOrZero(campaign.acos_target) : null,
    created_at: pickCreatedAt(campaign) || null,
    last_updated: pickLastUpdated(campaign) || null,
    metrics: campaign.metrics || campaign.metrics_summary || {},
  };
}

function buildCampaignUpdateBody(payload = {}, currentCampaign = {}) {
  const body = {};

  const name = normalizeText(payload?.name);
  if (name) {
    if (name.length < 3 || name.length > 30) {
      const err = new Error("Nome da campanha deve ter entre 3 e 30 caracteres.");
      err.code = "INVALID_INPUT";
      throw err;
    }
    body.name = name;
  }

  const roasCandidate =
    payload?.roas_target ?? payload?.goal ?? currentCampaign?.roas_target;
  if (roasCandidate != null && roasCandidate !== "") {
    const roas = Number(roasCandidate);
    if (!Number.isFinite(roas) || roas <= 0) {
      const err = new Error("ROAS objetivo invalido.");
      err.code = "INVALID_INPUT";
      throw err;
    }
    body.roas_target = roas;
  }

  const budgetCandidate =
    payload?.daily_budget ??
    payload?.budget ??
    extractCampaignDailyBudget(currentCampaign);
  if (budgetCandidate != null && budgetCandidate !== "") {
    const budget = Number(budgetCandidate);
    if (!Number.isFinite(budget) || budget <= 0) {
      const err = new Error("Orcamento diario invalido.");
      err.code = "INVALID_INPUT";
      throw err;
    }
    body.daily_budget = budget;
    body.budget = budget;
  }

  const normalizedStatus = normalizeCampaignStatus(payload?.status);
  if (normalizedStatus) {
    body.status = normalizedStatus;
  }

  body.channel = currentCampaign?.channel || "marketplace";
  body.strategy = currentCampaign?.strategy || "PROFITABILITY";

  return body;
}

async function atualizarCampanhaMl(
  advertiserId,
  campaignId,
  payload = {},
  currentCampaign = {},
  state
) {
  const U = urls();
  const body = buildCampaignUpdateBody(payload, currentCampaign);
  const errors = [];

  const attempts = [
    { method: "PATCH", url: U.productAdsCampaignDetail(advertiserId, campaignId) },
    { method: "PUT", url: U.productAdsCampaignDetail(advertiserId, campaignId) },
  ];

  for (const attempt of attempts) {
    try {
      const r = await withAuth(
        attempt.url,
        {
          method: attempt.method,
          headers: {
            "api-version": "2",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
        state
      );

      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        errors.push(`${attempt.method} ${r.status} ${txt}`);
        continue;
      }

      const txt = await r.text().catch(() => "");
      return txt ? JSON.parse(txt) : {};
    } catch (err) {
      errors.push(`${attempt.method} ${err?.message || err}`);
    }
  }

  const error = new Error(
    errors.join(" | ") || "Falha ao atualizar campanha no Product Ads."
  );
  error.code = "CAMPAIGN_UPDATE_ERROR";
  throw error;
}

async function desvincularItemDaCampanha(advertiserId, itemId, campaignId, state) {
  const bodyVariants = [
    { campaign_id: 0, channel: "marketplace" },
    { campaign_id: 0 },
    { campaign_id: null },
  ];
  const urlsToTry = buildProductAdsItemTargetUrls(advertiserId, itemId);
  const errors = [];

  for (const targetUrl of urlsToTry) {
    for (const body of bodyVariants) {
      try {
        const r = await withAuth(
          targetUrl,
          {
            method: "PUT",
            headers: {
              "api-version": "2",
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
          },
          state
        );

        if (r.ok) return { success: true, item_id: itemId };

        const txt = await r.text().catch(() => "");
        if (r.status === 401) {
          return {
            success: false,
            item_id: itemId,
            error: `PERMISSION_DENIED ${txt}`,
          };
        }
        errors.push(`PUT ${targetUrl} ${r.status} ${txt}`);
      } catch (err) {
        errors.push(`PUT ${targetUrl} ${err?.message || err}`);
      }
    }
  }

  return {
    success: false,
    item_id: itemId,
    error: errors.join(" | ") || "Falha ao remover anuncio da campanha.",
  };
}

class ProductAdsService {
  // ======================================================
  // RESUMO LEVE DE CAMPANHAS
  // Reutiliza o search com fallback já validado no projeto,
  // sem enriquecimentos pesados de detalhe/adgroup.
  // ======================================================
  static async obterResumoCampanhas({ date_from, date_to } = {}, options = {}) {
    try {
      const state = await prepararAuth(options);
      const advertiserId = await obterAdvertiserId(state);
      const data = await listarTodasCampanhasAds(
        advertiserId,
        { date_from, date_to },
        state,
      );

      const campaigns = (data.results || []).map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        metrics: c.metrics_summary || c.metrics || {},
      }));
      const summary = buildCampaignsSummary(campaigns);
      const amount = numberOrZero(summary.amount);
      const cost = numberOrZero(summary.cost);
      const clicks = numberOrZero(summary.clicks);
      const prints = numberOrZero(summary.prints);
      const tacosSalesBase = numberOrZero(summary.tacos_sales_base);

      return {
        success: true,
        advertiser_id: advertiserId,
        site_id: SITE_ID,
        date_from,
        date_to,
        campaigns,
        summary: {
          ...summary,
          ctr: prints > 0 ? (clicks / prints) * 100 : 0,
          cpc: clicks > 0 ? cost / clicks : 0,
          acos: amount > 0 ? (cost / amount) * 100 : 0,
          roas: cost > 0 ? amount / cost : 0,
          tacos: tacosSalesBase > 0 ? (cost / tacosSalesBase) * 100 : null,
        },
        paging: data.paging || {},
      };
    } catch (err) {
      return {
        success: false,
        error: err?.message || String(err),
        code: err.code || "CAMPAIGNS_SUMMARY_ERROR",
      };
    }
  }

  // ======================================================
  // LISTAR CAMPANHAS (agregado por campanha)
  // Agora inclui: created_at + adgroups_count
  // ======================================================
  static async listarCampanhas({ date_from, date_to } = {}, options = {}) {
    try {
      const state = await prepararAuth(options);
      const advertiserId = await obterAdvertiserId(state);
      const metricsData = await listarTodasCampanhasAds(
        advertiserId,
        { date_from, date_to },
        state
      );

      const metricRows = Array.isArray(metricsData?.results)
        ? metricsData.results
        : [];

      // campaigns/search e a fonte atual tanto para catalogo quanto para metricas.
      const mergedRows = mergeCampaignCatalogWithMetrics(metricRows, metricRows);

      const baseCampaigns = (mergedRows || [])
        .map((c) => ({
          id: c.id || c.campaign_id || c.campaignId || null,
          name: c.name,
          status: c.status,
          strategy: c.strategy,
          acos_target: c.acos_target,
          roas_target: c.roas_target ?? c.goal ?? null,
          daily_budget: extractCampaignDailyBudget(c),
          roas: c.roas,
          // tenta pegar direto do search (se vier)
          created_at: pickCreatedAt(c),
          last_updated: pickLastUpdated(c),
          metrics: c.metrics || {},
          adgroups_count: null,
        }))
        .filter((c) => c.id != null && c.id !== "");

      // Preenche created_at (se faltar) e adgroups_count
      const enriched = await pMapLimit(baseCampaigns, 5, async (c) => {
        let created_at = c.created_at;
        let last_updated = c.last_updated;
        let daily_budget = c.daily_budget;
        let detail = null;

        if (!created_at || !last_updated || daily_budget == null) {
          detail = await obterCampanhaPorId(advertiserId, c.id, state);
        }

        if (!created_at && detail) {
          created_at = pickCreatedAt(detail) || null;
        }

        if (!last_updated && detail) {
          last_updated = pickLastUpdated(detail) || null;
        }

        if (daily_budget == null && detail) {
          daily_budget = extractCampaignDailyBudget(detail);
        }

        const adgroups_count = await contarAdgroupsDaCampanha(
          advertiserId,
          c.id,
          { date_from, date_to },
          state
        );

        return {
          ...c,
          created_at,
          last_updated,
          daily_budget,
          adgroups_count,
        };
      });

      return {
        success: true,
        date_from,
        date_to,
        campaigns: enriched,
        paging: metricsData?.paging || {},
      };
    } catch (err) {
      return {
        success: false,
        error: err?.message || String(err),
        code: err.code || "CAMPAIGNS_ERROR",
      };
    }
  }

  // ======================================================
  // LISTAR ITENS DA CAMPANHA (ads) COM MÉTRICAS + THUMB
  // ======================================================
  static async listarItensCampanha(
    campaignId,
    { date_from, date_to } = {},
    options = {}
  ) {
    try {
      const state = await prepararAuth(options);
      const advertiserId = await obterAdvertiserId(state);
      const U = urls();

      // ======================================================
      // 1) Busca métrica dos ADS (OFICIAL: Advertising Product Ads)
      // ======================================================
      const data = {
        results: await listarTodosAdsDaCampanha(
          advertiserId,
          campaignId,
          { date_from, date_to },
          state,
        ),
        paging: {},
      };

      let items = (data.results || []).map((it) => {
        const metrics = it.metrics || {};
        const clicks = Number(metrics.clicks ?? 0);
        const units = Number(metrics.units_quantity ?? 0);
        const adId = String(
          it.id ??
            it.ad_id ??
            it.adId ??
            it.advertising_id ??
            it.advertisingId ??
            ""
        ).trim();

        const conversion_rate = clicks > 0 ? units / clicks : null;

        return {
          item_id: it.item_id || it.itemId || null,
          ad_id: adId || null,
          advertising_id: adId || null,
          title: it.title || it.item_id || "Anuncio patrocinado",
          sku: it.sku || null,
          status: it.status,
          cpc: it.cpc ?? metrics.cpc ?? null,
          ad_group_id: it.ad_group_id || it.adgroup_id || it.adGroupId || it.id || null,
          ad_group_type: it.ad_group_type || null,

          publication_quality: null,
          thumbnail: it.thumbnail || null,

          metrics: {
            ...metrics,
            conversion_rate,
          },
        };
      });

      // ======================================================
      // 2) Enriquecimento via Items API (OFICIAL)
      //    - thumbnail / secure_thumbnail
      //    - seller_custom_field (SKU interno do seller)
      //    - attributes (fallback p/ SKU)
      //    - health (qualidade) quando disponível
      // ======================================================
      const normalizeQualityToPct = (raw) => {
        if (raw == null) return null;
        const n = Number(raw);
        if (!Number.isFinite(n)) return null;

        // Alguns retornos são 0..1, outros podem ser 0..100
        if (n >= 0 && n <= 1) return Math.round(n * 100);
        if (n >= 0 && n <= 100) return Math.round(n);
        return null;
      };

      const extractSkuFromItemBody = (body) => {
        // 1) seller_custom_field (mais comum)
        if (body?.seller_custom_field) return String(body.seller_custom_field);

        // 2) attributes[] (quando existe SELLER_SKU)
        const attrs = Array.isArray(body?.attributes) ? body.attributes : [];
        const cand =
          attrs.find(
            (a) => String(a?.id || "").toUpperCase() === "SELLER_SKU"
          ) ||
          attrs.find((a) => String(a?.id || "").toUpperCase() === "SKU") ||
          null;

        const v =
          cand?.value_name ??
          cand?.value_id ??
          (Array.isArray(cand?.values) && cand.values[0]?.name) ??
          null;

        return v != null && String(v).trim() ? String(v).trim() : null;
      };

      const enrichFromItemsApi = async (itemIds) => {
        const uniqueIds = Array.from(new Set(itemIds.filter(Boolean)));
        if (!uniqueIds.length) return new Map();

        const out = new Map();
        const chunkSize = 20; // mantém seu padrão (URL curta e segura)

        for (let i = 0; i < uniqueIds.length; i += chunkSize) {
          const slice = uniqueIds.slice(i, i + chunkSize);

          const params = new URLSearchParams();
          params.set("ids", slice.join(","));
          // pede o que precisamos
          params.set(
            "attributes",
            [
              "id",
              "title",
              "thumbnail",
              "secure_thumbnail",
              "seller_custom_field",
              "attributes",
              "health",
            ].join(",")
          );

          const url = `${ITEMS_URL}?${params.toString()}`;

          const r = await withAuth(
            url,
            {
              method: "GET",
              headers: { "Content-Type": "application/json" },
            },
            state
          );

          const txt = await r.text().catch(() => "");
          if (!r.ok) {
            console.warn("[ProductAds] Items API falhou:", r.status, txt);
            continue;
          }

          let rows;
          try {
            rows = txt ? JSON.parse(txt) : [];
          } catch (e) {
            console.warn("[ProductAds] Items API parse error:", e.message);
            continue;
          }

          // formato típico: [{ code:200, body:{...}}, ...]
          for (const row of rows) {
            if (!row || row.code !== 200 || !row.body?.id) continue;
            const body = row.body;

            const id = String(body.id);
            const thumb = body.secure_thumbnail || body.thumbnail || null;
            const sku = extractSkuFromItemBody(body);

            const quality =
              normalizeQualityToPct(body.health) ??
              normalizeQualityToPct(body.quality) ??
              null;

            out.set(id, {
              thumbnail: thumb,
              sku,
              publication_quality: quality,
            });
          }
        }

        return out;
      };

      // ======================================================
      // 3) Fallback oficial p/ qualidade: /items/{id}/health
      //    (só pros que não vieram no batch)
      // ======================================================
      const fetchItemHealth = async (itemId) => {
        const url = `${ITEMS_URL}/${encodeURIComponent(itemId)}/health`;

        try {
          const r = await withAuth(
            url,
            {
              method: "GET",
              headers: { "Content-Type": "application/json" },
            },
            state
          );

          const txt = await r.text().catch(() => "");
          if (!r.ok) return null;

          let data;
          try {
            data = txt ? JSON.parse(txt) : {};
          } catch (_) {
            return null;
          }

          // Já vi retornos tipo { health: 0.85 } ou { value: 0.85 }
          const raw =
            data?.health ??
            data?.value ??
            data?.item_health ??
            data?.result ??
            null;

          return normalizeQualityToPct(raw);
        } catch (_) {
          return null;
        }
      };

      // ======================================================
      // 4) Aplica enrich + fallback health
      // ======================================================
      const ids = items
        .map((i) => i.item_id)
        .filter((id) => /^MLB\d+$/i.test(String(id || "")));
      const enrichMap = await enrichFromItemsApi(ids);

      items = items.map((it) => {
        const e = enrichMap.get(String(it.item_id));
        if (!e) return it;
        return {
          ...it,
          thumbnail: e.thumbnail ?? it.thumbnail ?? null,
          sku: e.sku ?? it.sku ?? null,
          publication_quality:
            e.publication_quality ?? it.publication_quality ?? null,
        };
      });

      // fallback health por item (só quando não veio)
      const needHealth = items
        .filter(
          (it) =>
            /^MLB\d+$/i.test(String(it.item_id || "")) &&
            (it.publication_quality == null ||
              !Number.isFinite(Number(it.publication_quality)))
        )
        .map((it) => String(it.item_id));

      if (needHealth.length) {
        // concorrência baixa pra não estourar rate-limit
        const healthMap = new Map();

        await pMapLimit(needHealth, 6, async (id) => {
          const q = await fetchItemHealth(id);
          if (q != null) healthMap.set(id, q);
        });

        items = items.map((it) => {
          const q = healthMap.get(String(it.item_id));
          if (q == null) return it;
          return { ...it, publication_quality: q };
        });
      }

      // Se você quiser que o front use it.health diretamente,
      // basta duplicar:
      items = items.map((it) => ({
        ...it,
        health: it.publication_quality, // compatível com seu detectQuality(it)
      }));

      return {
        success: true,
        campaign_id: campaignId,
        date_from,
        date_to,
        items,
        paging: data.paging || {},
      };
    } catch (err) {
      return {
        success: false,
        error: err?.message || String(err),
        code: err.code || "ITEMS_ERROR",
      };
    }
  }
  // ======================================================
  // MÉTRICAS DIÁRIAS (para o gráfico)
  // ======================================================
  static async metricasDiarias({ date_from, date_to } = {}, options = {}) {
    try {
      const state = await prepararAuth(options);
      const advertiserId = await obterAdvertiserId(state);
      const U = urls();

      const params = new URLSearchParams();
      if (date_from) params.set("date_from", date_from);
      if (date_to) params.set("date_to", date_to);

      params.set(
        "metrics",
        [
          "clicks",
          "prints",
          "cost",
          "total_amount",
          "direct_amount",
          "indirect_amount",
          "units_quantity",
          "direct_units_quantity",
          "indirect_units_quantity",
          "roas",
          "ctr",
          "cvr",
        ].join(",")
      );
      params.set("aggregation_type", "DAILY");
      params.set("aggregation", "sum");
      params.set("limit", "200");

      const url = `${U.productAdsCampaignsSearch(
        advertiserId
      )}?${params.toString()}`;

      const r = await withAuth(
        url,
        { method: "GET", headers: { "api-version": "2" } },
        state
      );

      const data = await fetchJsonOrError(r);

      const seriesByDate = new Map();

      for (const row of data.results || []) {
        const metrics = row.metrics_summary || row.metrics || row || {};
        const date =
          row.date ||
          row.day ||
          row.reference_date ||
          row.interval_start ||
          row.interval?.start ||
          row.dimensions?.date ||
          null;

        if (!date) continue;

        const dateKey = String(date).slice(0, 10);
        const directAmount = Number(metrics.direct_amount || 0);
        const indirectAmount = Number(metrics.indirect_amount || 0);
        const totalAmount = Number(metrics.total_amount || 0);
        const revenue = totalAmount > 0 ? totalAmount : directAmount + indirectAmount;
        const directUnits = Number(metrics.direct_units_quantity || 0);
        const indirectUnits = Number(metrics.indirect_units_quantity || 0);
        const unitsQuantity = Number(metrics.units_quantity || 0);
        const units = unitsQuantity > 0 ? unitsQuantity : directUnits + indirectUnits;

        const acc = seriesByDate.get(dateKey) || {
          date: dateKey,
          clicks: 0,
          prints: 0,
          cost: 0,
          total_amount: 0,
          direct_amount: 0,
          indirect_amount: 0,
          units_quantity: 0,
          direct_units_quantity: 0,
          indirect_units_quantity: 0,
          roas: 0,
          ctr: 0,
          cvr: 0,
        };

        acc.clicks += Number(metrics.clicks || 0);
        acc.prints += Number(metrics.prints || 0);
        acc.cost += Number(metrics.cost || 0);
        acc.total_amount += revenue;
        acc.direct_amount += directAmount;
        acc.indirect_amount += indirectAmount;
        acc.units_quantity += units;
        acc.direct_units_quantity += directUnits;
        acc.indirect_units_quantity += indirectUnits;

        seriesByDate.set(dateKey, acc);
      }

      const series = Array.from(seriesByDate.values())
        .sort((a, b) => String(a.date).localeCompare(String(b.date)))
        .map((row) => {
          const clicks = Number(row.clicks || 0);
          const prints = Number(row.prints || 0);
          const cost = Number(row.cost || 0);
          const revenue = Number(row.total_amount || 0);
          const units = Number(row.units_quantity || 0);

          return {
            ...row,
            roas: cost > 0 ? revenue / cost : 0,
            ctr: prints > 0 ? (clicks / prints) * 100 : 0,
            cvr: clicks > 0 ? (units / clicks) * 100 : 0,
          };
        });

      return { success: true, date_from, date_to, series };
    } catch (err) {
      return {
        success: false,
        error: err?.message || String(err),
        code: err.code || "METRICS_ERROR",
      };
    }
  }

  // ======================================================
  // WIZARD - PASSO 1: LISTAR ITENS PARA CRIAR CAMPANHA
  // ======================================================
  static async listarItensWizardCriacao(
    { query, status, page, limit } = {},
    options = {}
  ) {
    try {
      const state = await prepararAuth(options);
      const advertiserId = await obterAdvertiserId(state);
      const sellerId = await obterSellerId(state);

      const normalizedQuery = normalizeText(query);
      const normalizedStatus = normalizeWizardStatus(status);
      const paging = await buscarIdsItensSeller(
        sellerId,
        { query: normalizedQuery, page, limit },
        state
      );

      const ids = paging.itemIds || [];

      const [detailsMap, associationMap, campaignMap, sales30] = await Promise.all(
        [
          buscarDetalhesItens(ids, state),
          buscarAssociacaoCampanhaPorItem(ids, advertiserId, state),
          buscarMapaCampanhas(advertiserId, state),
          buscarVendas30dPorItem(sellerId, state),
        ]
      );

      const salesMap = sales30?.sales_by_item || {};

      let items = ids.map((itemId) => {
        const detail = detailsMap.get(String(itemId)) || {
          item_id: String(itemId),
          title: String(itemId),
          status: null,
          thumbnail: null,
          sku: null,
        };

        const assoc = associationMap.get(String(itemId)) || null;
        const currentCampaign =
          assoc?.campaign_id != null
            ? campaignMap[String(assoc.campaign_id)] || {
                id: assoc.campaign_id,
                name: `Campanha ${assoc.campaign_id}`,
                status: assoc?.ad_status || null,
              }
            : null;

        const campaignStatus = String(
          currentCampaign?.status || assoc?.ad_status || ""
        )
          .trim()
          .toLowerCase();

        return {
          item_id: String(itemId),
          title: detail.title || String(itemId),
          thumbnail: detail.thumbnail || null,
          sku: detail.sku || null,
          listing_status: detail.status || null,
          current_campaign: currentCampaign
            ? {
                id: currentCampaign.id,
                name: currentCampaign.name,
                status: currentCampaign.status || assoc?.ad_status || null,
              }
            : null,
          campaign_status: campaignStatus || null,
          sales_last_30d: Number(salesMap[String(itemId)] || 0),
        };
      });

      if (normalizedStatus === "active") {
        items = items.filter(
          (it) => String(it.campaign_status || "").toLowerCase() === "active"
        );
      } else if (normalizedStatus === "paused") {
        items = items.filter(
          (it) => String(it.campaign_status || "").toLowerCase() === "paused"
        );
      } else if (normalizedStatus === "without_campaign") {
        items = items.filter((it) => !it.current_campaign);
      }

      items.sort(
        (a, b) => Number(b.sales_last_30d || 0) - Number(a.sales_last_30d || 0)
      );

      return {
        success: true,
        query: normalizedQuery,
        status: normalizedStatus,
        seller_id: sellerId,
        date_from_sales: sales30?.date_from || null,
        date_to_sales: sales30?.date_to || null,
        items,
        paging: {
          page: paging.page,
          limit: paging.limit,
          offset: paging.offset,
          total: paging.total,
        },
        meta: {
          sales_scan_truncated: !!sales30?.truncated,
          scanned_orders_30d: Number(sales30?.scanned_orders || 0),
        },
      };
    } catch (err) {
      return {
        success: false,
        error: err?.message || String(err),
        code: err.code || "WIZARD_ITEMS_ERROR",
      };
    }
  }

  // ======================================================
  // WIZARD - PASSO 2: CRIAR CAMPANHA E VINCULAR ITENS
  // ======================================================
  static async criarCampanhaComItens(payload = {}, options = {}) {
    try {
      const campaignName = normalizeText(payload?.name);
      const roasTarget = Number(payload?.roas_target);
      const dailyBudget = Number(payload?.daily_budget);
      const itemIds = normalizeItemIds(payload?.item_ids);

      if (!itemIds.length) {
        return {
          success: false,
          error: "Selecione ao menos 1 anuncio para criar a campanha.",
          code: "NO_ITEMS_SELECTED",
        };
      }

      if (!campaignName || campaignName.length < 3 || campaignName.length > 30) {
        return {
          success: false,
          error: "Nome da campanha deve ter entre 3 e 30 caracteres.",
          code: "INVALID_INPUT",
        };
      }

      if (!Number.isFinite(roasTarget) || roasTarget <= 0) {
        return {
          success: false,
          error: "ROAS objetivo invalido.",
          code: "INVALID_INPUT",
        };
      }

      if (!Number.isFinite(dailyBudget) || dailyBudget <= 0) {
        return {
          success: false,
          error: "Orcamento diario invalido.",
          code: "INVALID_INPUT",
        };
      }

      const state = await prepararAuth(options);
      const advertiserId = await obterAdvertiserId(state);
      const U = urls();

      const createBody = {
        name: campaignName,
        channel: "marketplace",
        strategy: "PROFITABILITY",
        roas_target: Number(roasTarget),
        budget: Number(dailyBudget),
        daily_budget: Number(dailyBudget),
        status: "active",
      };

      const createResp = await withAuth(
        U.productAdsCampaigns(advertiserId),
        {
          method: "POST",
          headers: {
            "api-version": "2",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(createBody),
        },
        state
      );

      const createData = await fetchJsonOrError(createResp);
      const campaignId = createData?.id || createData?.campaign_id || null;

      if (!campaignId) {
        const err = new Error(
          "API nao retornou ID da campanha apos criacao."
        );
        err.code = "CAMPAIGN_CREATE_ERROR";
        throw err;
      }

      const linkResults = await pMapLimit(itemIds, 5, async (itemId) =>
        vincularItemNaCampanha(advertiserId, itemId, campaignId, state)
      );

      const linkedItems = linkResults.filter((row) => row?.success);
      const failedItems = linkResults
        .filter((row) => !row?.success)
        .map((row) => ({
          item_id: row?.item_id || null,
          error: row?.error || "Falha ao vincular anuncio.",
        }));

      const warnings = [];
      if (failedItems.length) {
        warnings.push(
          `Nem todos os anuncios foram vinculados (${linkedItems.length}/${itemIds.length}).`
        );
      }

      return {
        success: true,
        campaign: {
          id: campaignId,
          name: createData?.name || campaignName,
          status: createData?.status || "active",
          strategy: createData?.strategy || "PROFITABILITY",
          roas_target: Number(createData?.roas_target ?? roasTarget),
          daily_budget: Number(
            createData?.daily_budget ?? createData?.budget ?? dailyBudget
          ),
        },
        selection: {
          total_selected: itemIds.length,
          linked_count: linkedItems.length,
          failed_count: failedItems.length,
          failed_items: failedItems,
        },
        warnings,
      };
    } catch (err) {
      return {
        success: false,
        error: err?.message || String(err),
        code: err.code || "CAMPAIGN_CREATE_ERROR",
      };
    }
  }

  // ======================================================
  // DETALHE DE CAMPANHA
  // ======================================================
  static async obterCampanha(campaignId, options = {}) {
    try {
      const state = await prepararAuth(options);
      const advertiserId = await obterAdvertiserId(state);

      const detail = await obterCampanhaPorId(advertiserId, campaignId, state);
      if (!detail) {
        return {
          success: false,
          error: "Campanha nao encontrada.",
          code: "CAMPAIGNS_ERROR",
        };
      }

      const adgroups_count = await contarAdgroupsDaCampanha(
        advertiserId,
        campaignId,
        {},
        state
      );

      return {
        success: true,
        campaign: {
          ...summarizeCampaignPayload(detail),
          adgroups_count,
        },
      };
    } catch (err) {
      return {
        success: false,
        error: err?.message || String(err),
        code: err.code || "CAMPAIGNS_ERROR",
      };
    }
  }

  // ======================================================
  // EDITAR CAMPANHA (nome, budget, ROAS, status)
  // ======================================================
  static async atualizarCampanha() {
    return {
      success: false,
      code: "CAMPAIGN_MANAGEMENT_UNSUPPORTED",
      error: "O Mercado Livre nao permite editar campanhas Product Ads por integracao.",
    };
  }

  // ======================================================
  // METRICAS DIARIAS DE UMA CAMPANHA
  // ======================================================
  static async metricasDiariasCampanha(
    campaignId,
    { date_from, date_to } = {},
    options = {}
  ) {
    try {
      const state = await prepararAuth(options);
      const U = urls();
      const params = new URLSearchParams();
      if (date_from) params.set("date_from", date_from);
      if (date_to) params.set("date_to", date_to);
      params.set("aggregation_type", "DAILY");
      params.set("aggregation", "sum");
      params.set("metrics", METRICS_EXTENDED.join(","));

      const r = await withAuth(
        `${U.productAdsCampaignDetail(null, campaignId)}?${params.toString()}`,
        { method: "GET", headers: { "api-version": "2" } },
        state
      );
      const data = await fetchJsonOrError(r);
      const rows = Array.isArray(data) ? data : Array.isArray(data?.results) ? data.results : [];
      const seriesByDate = new Map();

      for (const row of rows) {
        const metrics = row?.metrics || row?.metrics_summary || row || {};
        const date = row?.date || row?.day || row?.reference_date || row?.interval_start || row?.interval?.start || row?.dimensions?.date || null;
        if (!date) continue;
        const dateKey = String(date).slice(0, 10);
        const directAmount = numberOrZero(metrics.direct_amount);
        const indirectAmount = numberOrZero(metrics.indirect_amount);
        const totalAmount = numberOrZero(metrics.total_amount);
        const revenue = totalAmount > 0 ? totalAmount : directAmount + indirectAmount;
        const clicks = numberOrZero(metrics.clicks);
        const prints = numberOrZero(metrics.prints);
        const cost = numberOrZero(metrics.cost);
        const units = numberOrZero(metrics.units_quantity);
        seriesByDate.set(dateKey, {
          date: dateKey,
          clicks,
          prints,
          cost,
          total_amount: revenue,
          direct_amount: directAmount,
          indirect_amount: indirectAmount,
          units_quantity: units,
        });
      }

      const series = Array.from(seriesByDate.values())
        .sort((a, b) => String(a.date).localeCompare(String(b.date)))
        .map((row) => ({
          ...row,
          ctr: row.prints > 0 ? (row.clicks / row.prints) * 100 : 0,
          cpc: row.clicks > 0 ? row.cost / row.clicks : 0,
          roas: row.cost > 0 ? row.total_amount / row.cost : 0,
          acos: row.total_amount > 0 ? (row.cost / row.total_amount) * 100 : 0,
          cvr: row.clicks > 0 ? (row.units_quantity / row.clicks) * 100 : 0,
        }));

      return { success: true, campaign_id: String(campaignId), date_from, date_to, series };
    } catch (err) {
      return {
        success: false,
        error: err?.message || String(err),
        code: err.code || "METRICS_ERROR",
      };
    }
  }

  // ======================================================
  // AD GROUPS GLOBAIS (ANUNCIOS PATROCINADOS)
  // ======================================================
  static async listarAdGroups(
    { date_from, date_to, campaign_id, status, query, page, limit, all } = {},
    options = {}
  ) {
    try {
      const state = await prepararAuth(options);
      const advertiserId = await obterAdvertiserId(state);
      const wantsAll = [true, 1, "1", "true", "yes"].includes(all);

      if (!wantsAll) {
        const data = await buscarAdGroups(
          advertiserId,
          {
            date_from,
            date_to,
            campaign_id,
            statuses: status && status !== "all" ? status : null,
            query,
            page,
            limit,
          },
          state
        );
        return {
          success: true,
          date_from,
          date_to,
          ads: data.results,
          paging: data.paging,
          metrics_summary: data.metrics_summary,
          truncated: false,
        };
      }

      const pageSize = 800;
      const maxRows = 5000;
      const ads = [];
      let offset = 0;
      let total = null;
      let firstSummary = null;

      while (ads.length < maxRows) {
        const data = await buscarAdGroups(
          advertiserId,
          {
            date_from,
            date_to,
            campaign_id,
            statuses: status && status !== "all" ? status : null,
            query,
            limit: Math.min(pageSize, maxRows - ads.length),
            offset,
          },
          state
        );
        const rows = Array.isArray(data.results) ? data.results : [];
        if (firstSummary == null) firstSummary = data.metrics_summary || null;
        const pagingTotal = Number(data?.paging?.total);
        if (Number.isFinite(pagingTotal)) total = pagingTotal;
        ads.push(...rows);
        offset += rows.length;
        if (!rows.length) break;
        if (Number.isFinite(total) && offset >= total) break;
        if (rows.length < pageSize) break;
      }

      const resolvedTotal = Number.isFinite(total) ? total : ads.length;
      return {
        success: true,
        date_from,
        date_to,
        ads,
        paging: { offset: 0, limit: ads.length, total: resolvedTotal },
        metrics_summary: firstSummary,
        truncated: resolvedTotal > ads.length,
      };
    } catch (err) {
      return {
        success: false,
        error: err?.message || String(err),
        code: err.code || "ITEMS_ERROR",
      };
    }
  }

  // ======================================================
  // ITENS DISPONIVEIS PARA ADICIONAR NA CAMPANHA
  // ======================================================
  static async listarItensDisponiveisCampanha(
    campaignId,
    { query, status, page, limit } = {},
    options = {}
  ) {
    try {
      const base = await ProductAdsService.listarItensWizardCriacao(
        { query, status, page, limit },
        options
      );

      if (!base?.success) return base;

      const items = (base.items || []).filter(
        (item) => String(item?.current_campaign?.id || "") !== String(campaignId)
      );

      return {
        ...base,
        items,
        campaign_id: String(campaignId),
      };
    } catch (err) {
      return {
        success: false,
        error: err?.message || String(err),
        code: err.code || "WIZARD_ITEMS_ERROR",
      };
    }
  }

  // ======================================================
  // ADICIONAR ITENS EM CAMPANHA EXISTENTE
  // ======================================================
  static async adicionarItensCampanha(campaignId, payload = {}, options = {}) {
    try {
      const itemIds = normalizeItemIds(payload?.item_ids);
      if (!itemIds.length) {
        return {
          success: false,
          error: "Selecione ao menos 1 anuncio para adicionar na campanha.",
          code: "NO_ITEMS_SELECTED",
        };
      }

      const state = await prepararAuth(options);
      const advertiserId = await obterAdvertiserId(state);

      const linkResults = await pMapLimit(itemIds, 5, async (itemId) =>
        vincularItemNaCampanha(advertiserId, itemId, campaignId, state)
      );

      const linkedItems = linkResults.filter((row) => row?.success);
      const failedItems = linkResults
        .filter((row) => !row?.success)
        .map((row) => ({
          item_id: row?.item_id || null,
          error: row?.error || "Falha ao vincular anuncio.",
        }));

      return {
        success: true,
        campaign_id: String(campaignId),
        selection: {
          total_selected: itemIds.length,
          linked_count: linkedItems.length,
          failed_count: failedItems.length,
          failed_items: failedItems,
        },
        warnings: failedItems.length
          ? [
              `Nem todos os anuncios foram vinculados (${linkedItems.length}/${itemIds.length}).`,
            ]
          : [],
      };
    } catch (err) {
      return {
        success: false,
        error: err?.message || String(err),
        code: err.code || "ITEMS_ERROR",
      };
    }
  }

  // ======================================================
  // REMOVER ITEM DA CAMPANHA
  // ======================================================
  static async removerItemCampanha(campaignId, itemId, options = {}) {
    try {
      const safeItemId = String(itemId || "").trim();
      if (!safeItemId) {
        return {
          success: false,
          error: "Item invalido para remocao.",
          code: "INVALID_INPUT",
        };
      }

      const state = await prepararAuth(options);
      const advertiserId = await obterAdvertiserId(state);
      const candidateIds = await resolveCampaignItemTargetIds(
        advertiserId,
        campaignId,
        safeItemId,
        state
      );
      const idsToTry = candidateIds.length ? candidateIds : [safeItemId];
      const errors = [];
      let resolvedItemId = null;

      for (const candidateId of idsToTry) {
        const result = await desvincularItemDaCampanha(
          advertiserId,
          candidateId,
          campaignId,
          state
        );
        if (result?.success) {
          resolvedItemId = candidateId;
          break;
        }
        if (/PERMISSION_DENIED/i.test(String(result?.error || ""))) {
          return {
            success: false,
            error:
              "A conta/token autenticado nao possui permissao de escrita para alterar Product Ads nesta conta.",
            code: "PERMISSION_DENIED",
          };
        }
        errors.push(result?.error || `Falha ao remover anuncio ${candidateId}.`);
      }

      if (!resolvedItemId) {
        const joinedErrors = errors.join(" | ");
        const permissionDenied =
          /permission to write|unauthorizedexception|does not have permission/i.test(
            joinedErrors
          );
        return {
          success: false,
          error: permissionDenied
            ? "A conta/token autenticado nao possui permissao de escrita para alterar Product Ads nesta conta."
            : joinedErrors || "Falha ao remover anuncio da campanha.",
          code: permissionDenied ? "PERMISSION_DENIED" : "ITEM_REMOVE_ERROR",
        };
      }

      return {
        success: true,
        campaign_id: String(campaignId),
        item_id: safeItemId,
        resolved_item_id: resolvedItemId,
      };
    } catch (err) {
      return {
        success: false,
        error: err?.message || String(err),
        code: err.code || "ITEM_REMOVE_ERROR",
      };
    }
  }

  // ======================================================
  // ATUALIZAR STATUS DO ITEM NA CAMPANHA
  // ======================================================
  static async atualizarItemCampanha(
    campaignId,
    itemId,
    payload = {},
    options = {}
  ) {
    try {
      const nextStatus = normalizeCampaignStatus(payload?.status);
      if (!nextStatus) {
        return {
          success: false,
          error: "Status do anuncio invalido.",
          code: "INVALID_INPUT",
        };
      }

      const safeItemId = String(itemId || "").trim();
      if (!safeItemId) {
        return {
          success: false,
          error: "Item invalido.",
          code: "INVALID_INPUT",
        };
      }

      const state = await prepararAuth(options);
      const advertiserId = await obterAdvertiserId(state);
      const body = {
        campaign_id: Number(campaignId),
        status: nextStatus,
        channel: "marketplace",
      };
      const bodyVariants = [
        body,
        { campaign_id: Number(campaignId), status: nextStatus },
        { status: nextStatus, channel: "marketplace" },
        { status: nextStatus },
      ];
      const candidateIds = await resolveCampaignItemTargetIds(
        advertiserId,
        campaignId,
        safeItemId,
        state
      );
      const idsToTry = candidateIds.length ? candidateIds : [safeItemId];
      const errors = [];

      for (const candidateId of idsToTry) {
        const attempts = buildProductAdsItemTargetUrls(advertiserId, candidateId).map(
          (targetUrl) => ({ method: "PUT", url: targetUrl })
        );

        for (const attempt of attempts) {
          for (const bodyVariant of bodyVariants) {
            try {
              const r = await withAuth(
                attempt.url,
                {
                  method: attempt.method,
                  headers: {
                    "api-version": "2",
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify(bodyVariant),
                },
                state
              );

              if (r.ok) {
                return {
                  success: true,
                  campaign_id: String(campaignId),
                  item_id: safeItemId,
                  resolved_item_id: candidateId,
                  status: nextStatus,
                };
              }

              const txt = await r.text().catch(() => "");
              if (r.status === 401) {
                return {
                  success: false,
                  error:
                    "A conta/token autenticado nao possui permissao de escrita para alterar Product Ads nesta conta.",
                  code: "PERMISSION_DENIED",
                };
              }
              errors.push(
                `${candidateId} ${attempt.method} ${attempt.url} ${r.status} ${txt}`
              );
            } catch (err) {
              errors.push(
                `${candidateId} ${attempt.method} ${attempt.url} ${err?.message || err}`
              );
            }
          }
        }
      }

      return {
        success: false,
        error: (() => {
          const joinedErrors = errors.join(" | ");
          const permissionDenied =
            /permission to write|unauthorizedexception|does not have permission/i.test(
              joinedErrors
            );
          return permissionDenied
            ? "A conta/token autenticado nao possui permissao de escrita para alterar Product Ads nesta conta."
            : joinedErrors || "Falha ao atualizar status do anuncio.";
        })(),
        code: (() => {
          const joinedErrors = errors.join(" | ");
          return /permission to write|unauthorizedexception|does not have permission/i.test(
            joinedErrors
          )
            ? "PERMISSION_DENIED"
            : "ITEMS_ERROR";
        })(),
      };
    } catch (err) {
      return {
        success: false,
        error: err?.message || String(err),
        code: err.code || "ITEMS_ERROR",
      };
    }
  }

  // ======================================================
  // EXPORTAR CSV (mlb, campanha)
  // ======================================================
  static async exportarItensCampanhaCsv(
    campaignId,
    { date_from, date_to } = {},
    options = {}
  ) {
    try {
      const state = await prepararAuth(options);
      const advertiserId = await obterAdvertiserId(state);

      let campaignName = "";
      const detail = await obterCampanhaPorId(advertiserId, campaignId, state);
      campaignName = detail?.name || "";

      const allAds = await listarTodosAdsDaCampanha(
        advertiserId,
        campaignId,
        { date_from, date_to },
        state
      );

      const rows = [["mlb", "campanha"]];
      for (const ad of allAds) {
        const mlb = ad.item_id || "";
        rows.push([mlb, campaignName || String(campaignId)]);
      }

      const csv = rows
        .map((cols) =>
          cols
            .map((v) => {
              const s = String(v ?? "");
              return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
            })
            .join(",")
        )
        .join("\n");

      return { success: true, csv, filename: `campanha_${campaignId}.csv` };
    } catch (err) {
      return {
        success: false,
        error: err?.message || String(err),
        code: err.code || "ITEMS_ERROR",
      };
    }
  }
}

module.exports = ProductAdsService;
