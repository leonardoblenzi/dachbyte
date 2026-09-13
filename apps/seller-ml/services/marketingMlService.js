"use strict";

const fetchRef = typeof globalThis.fetch === "function"
  ? globalThis.fetch.bind(globalThis)
  : require("node-fetch");
const TokenService = require("./tokenService");
const simpleCache = require("./simpleCache");

const ML_API = "https://api.mercadolibre.com";
const SITE_ID = "MLB";
const CACHE_TTL_SEC = 60 * 5;
const ADS_HISTORY_LIMIT_DAYS = 90;

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round(value, decimals = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(decimals));
}

function normalizeDate(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function diffDaysInclusive(from, to) {
  const a = new Date(`${from}T12:00:00Z`);
  const b = new Date(`${to}T12:00:00Z`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  return Math.floor((b.getTime() - a.getTime()) / 86400000) + 1;
}

function channel({
  status = "ok",
  investment = null,
  reason = null,
  affectsCompleteness = false,
  meta = {},
} = {}) {
  const available = status === "ok";
  return {
    available,
    included: available,
    status,
    investment: available ? round(numberOrZero(investment), 2) : null,
    reason: reason || null,
    affects_completeness: Boolean(affectsCompleteness),
    ...meta,
  };
}

function classifyUnavailableError(error) {
  const message = String(error?.message || error || "");
  const code = String(error?.code || "");
  const httpStatus = Number(error?.httpStatus || 0);

  // A propria documentacao do Mercado Livre informa que 404 com
  // "No permissions found for user_id" significa que o produto de Ads nao
  // esta habilitado para o usuario. Isso nao deve aparecer como falha tecnica.
  if (
    /no[_ ]advertiser/i.test(code)
    || /nenhum advertiser/i.test(message)
    || /no permissions found for user_id/i.test(message)
    || /produto.*nao.*habilitad/i.test(message)
  ) {
    return channel({
      status: "not_available",
      reason: "Canal nao habilitado/disponivel para esta conta no Mercado Livre.",
    });
  }

  if (httpStatus === 204) {
    return channel({ status: "not_available", reason: "Canal sem dados disponiveis para esta conta." });
  }

  return channel({
    status: "error",
    reason: message || "Falha ao consultar o canal.",
    affectsCompleteness: true,
  });
}

async function prepareAuth(options = {}) {
  const creds = options?.mlCreds && typeof options.mlCreds === "object"
    ? { ...options.mlCreds }
    : {};
  if (!creds.accountKey && !creds.account_key && options?.accountKey) {
    creds.accountKey = options.accountKey;
  }
  const token = await TokenService.renovarTokenSeNecessario(creds);
  return { token, creds };
}

async function withAuth(url, init, state) {
  const call = async (token) => fetchRef(url, {
    ...(init || {}),
    headers: {
      ...(init?.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });

  let response = await call(state.token);
  if (response.status !== 401) return response;

  const renewed = await TokenService.renovarToken(state.creds);
  state.token = renewed.access_token;
  return call(state.token);
}

async function fetchJson(url, { state, headers = {}, allowNoContent = true } = {}) {
  const response = await withAuth(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      "Content-Type": "application/json",
      ...headers,
    },
  }, state);

  if (allowNoContent && response.status === 204) {
    return { noContent: true, status: 204, data: null };
  }

  const text = await response.text().catch(() => "");
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}${text ? ` - ${text}` : ""}`);
    error.httpStatus = response.status;
    error.rawBody = text;
    throw error;
  }

  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (error) {
    const parseError = new Error(`Falha ao interpretar resposta do Mercado Livre: ${error.message}`);
    parseError.rawBody = text;
    throw parseError;
  }
  return { noContent: false, status: response.status, data };
}

async function getAdvertiser(productId, state) {
  const url = new URL(`${ML_API}/advertising/advertisers`);
  url.searchParams.set("product_id", productId);
  const result = await fetchJson(url.toString(), {
    state,
    headers: { "Api-Version": "1" },
  });
  if (result.noContent) return null;
  const advertisers = Array.isArray(result.data?.advertisers) ? result.data.advertisers : [];
  const advertiser = advertisers.find((row) => String(row?.site_id || "").toUpperCase() === SITE_ID)
    || advertisers[0]
    || null;
  if (!advertiser) return null;
  return advertiser.advertiser_id ?? advertiser.id ?? null;
}

async function getProductAdsSummary({ date_from, date_to }, options) {
  const ProductAdsService = require("./productAdsService");
  const result = await ProductAdsService.obterResumoCampanhas({ date_from, date_to }, options);
  if (!result?.success) return classifyUnavailableError({ code: result?.code, message: result?.error });
  return channel({
    status: "ok",
    investment: result?.summary?.cost,
    meta: {
      advertiser_id: result?.advertiser_id ?? null,
      campaigns: numberOrZero(result?.summary?.total_campaigns),
      revenue_attributed: round(numberOrZero(result?.summary?.amount), 2),
    },
  });
}

function displayCampaignType(value) {
  const type = String(value || "").trim().toUpperCase();
  if (type === "GUARANTEED") return "guaranteed";
  if (type === "PROGRAMMATIC") return "programmatic";
  return "unknown";
}

function metricInvestment(row = {}) {
  const direct = Number(row?.summary?.consumed_budget);
  if (Number.isFinite(direct)) return direct;
  const metrics = Array.isArray(row?.metrics) ? row.metrics : [];
  return metrics.reduce((sum, metric) => sum + numberOrZero(metric?.consumed_budget), 0);
}

function campaignInvestment(data = {}) {
  const direct = Number(data?.summary?.consumed_budget);
  if (Number.isFinite(direct)) return direct;
  const metrics = Array.isArray(data?.metrics) ? data.metrics : [];
  return metrics.reduce((sum, metric) => sum + numberOrZero(metric?.consumed_budget), 0);
}

async function getDisplayCampaignMetrics({ advertiserId, campaignId, date_from, date_to }, state) {
  const url = new URL(`${ML_API}/advertising/advertisers/${encodeURIComponent(advertiserId)}/display/campaigns/${encodeURIComponent(campaignId)}/metrics`);
  url.searchParams.set("date_from", date_from);
  url.searchParams.set("date_to", date_to);
  const result = await fetchJson(url.toString(), {
    state,
    headers: { "Api-Version": "1" },
  });
  if (result.noContent) return 0;
  return round(campaignInvestment(result.data), 2);
}

async function getDisplaySummary({ date_from, date_to, days }, state) {
  if (days > ADS_HISTORY_LIMIT_DAYS) {
    const unavailable = channel({
      status: "range_limit",
      reason: `DSP permite consultar ate ${ADS_HISTORY_LIMIT_DAYS} dias de historico por esta integracao.`,
      affectsCompleteness: true,
    });
    return { programmatic: unavailable, guaranteed: { ...unavailable } };
  }

  let advertiserId;
  try {
    advertiserId = await getAdvertiser("DISPLAY", state);
  } catch (error) {
    const unavailable = classifyUnavailableError(error);
    return { programmatic: unavailable, guaranteed: { ...unavailable } };
  }
  if (!advertiserId) {
    const unavailable = channel({ status: "not_available", reason: "DSP nao esta habilitado para esta conta." });
    return { programmatic: unavailable, guaranteed: { ...unavailable } };
  }

  try {
    const campaignsUrl = new URL(`${ML_API}/advertising/advertisers/${encodeURIComponent(advertiserId)}/display/campaigns`);
    campaignsUrl.searchParams.set("sort_by", "start_date");
    campaignsUrl.searchParams.set("sort_order", "desc");
    const campaignsResult = await fetchJson(campaignsUrl.toString(), {
      state,
      headers: { "Api-Version": "1" },
    });

    if (campaignsResult.noContent) {
      return {
        programmatic: channel({ status: "ok", investment: 0, meta: { advertiser_id: advertiserId, campaigns: 0 } }),
        guaranteed: channel({ status: "ok", investment: 0, meta: { advertiser_id: advertiserId, campaigns: 0 } }),
      };
    }

    const campaigns = Array.isArray(campaignsResult.data?.results) ? campaignsResult.data.results : [];
    if (!campaigns.length) {
      return {
        programmatic: channel({ status: "ok", investment: 0, meta: { advertiser_id: advertiserId, campaigns: 0 } }),
        guaranteed: channel({ status: "ok", investment: 0, meta: { advertiser_id: advertiserId, campaigns: 0 } }),
      };
    }

    // A documentacao publica oferece metricas por campanha e algumas contas
    // validam campaign_id mesmo no endpoint dimensional. Consultar campanha a
    // campanha evita o 400 "campaign_id param is missing" observado em producao.
    const totals = { programmatic: 0, guaranteed: 0, unknown: 0 };
    const counts = { programmatic: 0, guaranteed: 0, unknown: 0 };

    for (let i = 0; i < campaigns.length; i += 6) {
      const batch = campaigns.slice(i, i + 6);
      const rows = await Promise.all(batch.map(async (campaign) => {
        const campaignId = campaign?.id ?? campaign?.campaign_id;
        const type = displayCampaignType(campaign?.type);
        if (campaignId == null) return { type, investment: 0 };
        try {
          const investment = await getDisplayCampaignMetrics({
            advertiserId, campaignId, date_from, date_to,
          }, state);
          return { type, investment };
        } catch (error) {
          // Campanha antiga/inacessivel nao deve derrubar todas as demais.
          if ([204, 404].includes(Number(error?.httpStatus || 0))) {
            return { type, investment: 0 };
          }
          throw error;
        }
      }));
      for (const row of rows) {
        const type = ["programmatic", "guaranteed"].includes(row.type) ? row.type : "unknown";
        totals[type] += numberOrZero(row.investment);
        counts[type] += 1;
      }
    }

    const unknownInvestment = round(totals.unknown, 2);
    return {
      programmatic: channel({
        status: "ok",
        investment: round(totals.programmatic, 2),
        meta: {
          advertiser_id: advertiserId,
          campaigns: counts.programmatic,
          unclassified_display_investment: unknownInvestment,
        },
      }),
      guaranteed: channel({
        status: "ok",
        investment: round(totals.guaranteed, 2),
        meta: {
          advertiser_id: advertiserId,
          campaigns: counts.guaranteed,
          unclassified_display_investment: unknownInvestment,
        },
      }),
    };
  } catch (error) {
    const unavailable = classifyUnavailableError(error);
    return { programmatic: unavailable, guaranteed: { ...unavailable } };
  }
}


// IMPORTANTE — nomenclatura comercial x nomenclatura tecnica do Mercado Livre:
// - Na API Developers, o produto tecnico `DISPLAY` e usado para as campanhas que
//   o usuario enxerga no Mercado Ads como DSP. Por isso agregamos aqui
//   Programmatic + Guaranteed + qualquer valor nao classificado em um unico canal
//   de interface chamado `dsp`.
// - Na interface da Davantti, o nome `Display` fica RESERVADO para o objetivo de
//   campanha de seguidores da pagina. Hoje nao existe uma fonte publica confiavel
//   nesta integracao para obter esse investimento; portanto ele permanece
//   `unsupported` e NAO entra no marketing total.
// Nao somar `DISPLAY` tecnico e `DSP` como canais separados: seriam o mesmo gasto.
function buildDspChannel(display = {}) {
  const programmatic = display?.programmatic || {};
  const guaranteed = display?.guaranteed || {};

  if (!programmatic.available && !guaranteed.available) {
    const base = programmatic?.status ? programmatic : guaranteed;
    return {
      ...base,
      reason: base?.reason || "DSP nao esta disponivel para esta conta.",
      api_product_id: "DISPLAY",
      ui_channel: "DSP",
    };
  }

  const unclassified = Math.max(
    numberOrZero(programmatic?.unclassified_display_investment),
    numberOrZero(guaranteed?.unclassified_display_investment),
  );
  const programmaticInvestment = programmatic.available ? numberOrZero(programmatic.investment) : 0;
  const guaranteedInvestment = guaranteed.available ? numberOrZero(guaranteed.investment) : 0;

  return channel({
    status: "ok",
    investment: round(programmaticInvestment + guaranteedInvestment + unclassified, 2),
    meta: {
      api_product_id: "DISPLAY",
      ui_channel: "DSP",
      programmatic_investment: round(programmaticInvestment, 2),
      guaranteed_investment: round(guaranteedInvestment, 2),
      unclassified_investment: round(unclassified, 2),
      advertiser_id: programmatic?.advertiser_id ?? guaranteed?.advertiser_id ?? null,
    },
  });
}

function getFollowersDisplayChannel() {
  return channel({
    status: "unsupported",
    reason: "Display (seguidores da pagina) ainda nao possui uma fonte publica de investimento disponivel para esta integracao.",
    affectsCompleteness: true,
    meta: {
      ui_channel: "Display",
      objective: "page_followers",
      // Nao confundir com product_id=DISPLAY da API, que nesta aplicacao e exibido como DSP.
      api_source: null,
    },
  });
}

function extractBrandInvestment(data = {}) {
  const direct = Number(data?.summary?.consumed_budget);
  if (Number.isFinite(direct)) return direct;

  if (Array.isArray(data?.summary)) {
    return data.summary.reduce((sum, row) => sum + numberOrZero(row?.consumed_budget ?? row?.metrics?.consumed_budget), 0);
  }

  const daily = Array.isArray(data?.metrics) ? data.metrics : [];
  return daily.reduce((sum, row) => sum + numberOrZero(row?.metrics?.consumed_budget ?? row?.consumed_budget), 0);
}

async function getBrandAdsSummary({ date_from, date_to, days }, state) {
  if (days > ADS_HISTORY_LIMIT_DAYS) {
    return channel({
      status: "range_limit",
      reason: `Brand Ads permite consultar ate ${ADS_HISTORY_LIMIT_DAYS} dias de historico por esta integracao.`,
      affectsCompleteness: true,
    });
  }

  let advertiserId;
  try {
    advertiserId = await getAdvertiser("BADS", state);
  } catch (error) {
    return classifyUnavailableError(error);
  }
  if (!advertiserId) {
    return channel({
      status: "not_available",
      reason: "Brand Ads nao esta disponivel para esta conta (ou a conta foi migrada para Product Ads).",
    });
  }

  try {
    const url = new URL(`${ML_API}/advertising/advertisers/${encodeURIComponent(advertiserId)}/brand_ads/campaigns/metrics`);
    url.searchParams.set("date_from", date_from);
    url.searchParams.set("date_to", date_to);
    url.searchParams.set("aggregation_type", "daily");
    url.searchParams.set("strategy", "marketplace");
    const result = await fetchJson(url.toString(), { state });
    if (result.noContent) {
      return channel({
        status: "not_available",
        reason: "Brand Ads nao retornou dados para esta conta (possivel migracao para Product Ads).",
      });
    }
    return channel({
      status: "ok",
      investment: extractBrandInvestment(result.data),
      meta: { advertiser_id: advertiserId },
    });
  } catch (error) {
    if ([204, 404].includes(Number(error?.httpStatus))) {
      return channel({ status: "not_available", reason: "Brand Ads nao esta disponivel para esta conta." });
    }
    return classifyUnavailableError(error);
  }
}

function buildCacheKey({ accountKey, date_from, date_to }) {
  return `marketing-ml:${String(accountKey || "default")}:${date_from}:${date_to}`;
}

class MarketingMlService {
  static async getPeriodSummary(query = {}, options = {}) {
    const rawFrom = normalizeDate(query.date_from);
    const rawTo = normalizeDate(query.date_to);
    if (!rawFrom || !rawTo) {
      const error = new Error("Informe date_from e date_to no formato YYYY-MM-DD.");
      error.status = 400;
      throw error;
    }
    const date_from = rawFrom <= rawTo ? rawFrom : rawTo;
    const date_to = rawFrom <= rawTo ? rawTo : rawFrom;
    const days = diffDaysInclusive(date_from, date_to);
    if (!days || days < 1) {
      const error = new Error("Periodo de marketing invalido.");
      error.status = 400;
      throw error;
    }

    const cacheKey = buildCacheKey({ accountKey: options?.accountKey, date_from, date_to });
    const force = String(query.force_refresh || "").toLowerCase() === "true";
    if (!force) {
      const cached = simpleCache.get(cacheKey);
      if (cached) return { ...cached, cached: true };
    }

    let state = null;
    try {
      state = await prepareAuth(options);
    } catch (error) {
      const failed = classifyUnavailableError(error);
      const response = {
        success: true,
        date_from,
        date_to,
        days,
        cached: false,
        channels: {
          product_ads: { ...failed },
          dsp: { ...failed, api_product_id: "DISPLAY", ui_channel: "DSP" },
          display: getFollowersDisplayChannel(),
          brand_ads: { ...failed },
          affiliates: channel({
            status: "unsupported",
            reason: "A API publica do Mercado Livre ainda nao disponibiliza a comissao de Afiliados para esta integracao.",
            affectsCompleteness: true,
          }),
        },
        total_marketing_known: 0,
        partial: true,
        unavailable_sources: ["product_ads", "dsp", "display", "brand_ads", "affiliates"],
      };
      return response;
    }

    const [productAds, display, brandAds] = await Promise.all([
      getProductAdsSummary({ date_from, date_to }, options),
      getDisplaySummary({ date_from, date_to, days }, state),
      getBrandAdsSummary({ date_from, date_to, days }, state),
    ]);

    const affiliates = channel({
      status: "unsupported",
      reason: "A API publica do Mercado Livre ainda nao disponibiliza a comissao de Afiliados para esta integracao.",
      affectsCompleteness: true,
    });

    // `display` abaixo e o retorno tecnico do product_id=DISPLAY da API.
    // Comercialmente, nesta UI ele e apresentado como DSP. Veja buildDspChannel().
    const dsp = buildDspChannel(display);
    const followersDisplay = getFollowersDisplayChannel();

    const channels = {
      product_ads: productAds,
      dsp,
      display: followersDisplay,
      brand_ads: brandAds,
      affiliates,
    };

    // Somente canais com fonte conhecida entram na soma. Display (seguidores) e
    // Afiliados ficam visiveis como indisponiveis, mas nao sao tratados como R$ 0.
    const knownChannelKeys = ["product_ads", "dsp", "brand_ads"];
    const totalMarketingKnown = round(knownChannelKeys.reduce((sum, key) => {
      const row = channels[key];
      return sum + (row?.available ? numberOrZero(row.investment) : 0);
    }, 0), 2);
    const unavailableSources = Object.entries(channels)
      .filter(([, row]) => row?.affects_completeness)
      .map(([key]) => key);

    const response = {
      success: true,
      date_from,
      date_to,
      days,
      cached: false,
      channels,
      total_marketing_known: totalMarketingKnown,
      partial: unavailableSources.length > 0,
      unavailable_sources: unavailableSources,
      note: unavailableSources.length
        ? "Resultado pos-marketing considera apenas os canais disponiveis. Display (seguidores) e Afiliados ainda nao estao incluidos."
        : "Todos os canais de marketing configurados foram considerados.",
    };

    simpleCache.set(cacheKey, response, CACHE_TTL_SEC);
    return response;
  }

  static _test = {
    extractBrandInvestment,
    displayCampaignType,
    metricInvestment,
    campaignInvestment,
    buildDspChannel,
  };
}

module.exports = MarketingMlService;
