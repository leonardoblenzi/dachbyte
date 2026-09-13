"use strict";

const Bull = require("bull");
const crypto = require("crypto");
const fetch = require("node-fetch");
const ExcelJS = require("exceljs");
const TokenService = require("./tokenService");
const { makeBullClient, getSharedRedis } = require("../lib/redisClient");
const { recordAuthEvent } = require("./authAuditService");

const QUEUE_NAME = "promo-smart-optimizer";
const ANALYSIS_TTL_MS = Math.max(
  5 * 60 * 1000,
  Number(process.env.PROMO_SMART_ANALYSIS_TTL_MS || 60 * 60 * 1000),
);
const ANALYSIS_MAX_CAMPAIGNS = Math.max(
  10,
  Number(process.env.PROMO_SMART_ANALYSIS_MAX_CAMPAIGNS || 1000),
);
const ANALYSIS_MAX_PAGES = Math.max(
  10,
  Number(process.env.PROMO_SMART_ANALYSIS_MAX_PAGES || 250),
);
const ANALYSIS_PAGE_LIMIT = 50;
const SMART_BUYER_DISCOUNT_TOLERANCE = Math.max(
  0.01,
  Number(process.env.PROMO_SMART_BUYER_DISCOUNT_TOLERANCE || 0.08),
);
const SMART_BUYER_PRICE_TOLERANCE = Math.max(
  0.01,
  Number(process.env.PROMO_SMART_BUYER_PRICE_TOLERANCE || 0.05),
);
const SMART_REBATE_MIN_GAIN_PP = Math.max(
  0.01,
  Number(process.env.PROMO_SMART_REBATE_MIN_GAIN_PP || 0.05),
);
const TRANSIENT_ATTEMPTS = Math.max(
  1,
  Number(process.env.PROMO_SMART_TRANSIENT_ATTEMPTS || 4),
);
const TRANSIENT_BASE_MS = Math.max(
  500,
  Number(process.env.PROMO_SMART_TRANSIENT_BASE_MS || 1500),
);
const ACCOUNT_LOCK_TTL_MS = Math.max(
  60 * 1000,
  Number(process.env.PROMO_SMART_ACCOUNT_LOCK_TTL_MS || 20 * 60 * 1000),
);

let queue = null;
let workerStarted = false;

class SmartOptimizerCancelledError extends Error {
  constructor(message = "Otimizacao Smart cancelada pelo usuario.") {
    super(message);
    this.name = "SmartOptimizerCancelledError";
  }
}

class SmartOptimizerSafetyError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = "SmartOptimizerSafetyError";
    this.details = details;
  }
}

async function readBullJobProgress(job, fallback = 0) {
  try {
    const value = typeof job?.progress === "function" ? job.progress() : fallback;
    const resolved = await Promise.resolve(value);
    const parsed = Number(resolved);
    return Number.isFinite(parsed) ? parsed : Number(fallback || 0);
  } catch {
    return Number(fallback || 0);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function ensureQueue() {
  if (queue) return queue;
  queue = new Bull(QUEUE_NAME, {
    createClient: (type) => makeBullClient(type, QUEUE_NAME),
  });
  queue.on("error", (error) => {
    console.error("[PromoSmartOptimizer] queue error:", error?.message || error);
  });
  return queue;
}

function redisClient() {
  try {
    return getSharedRedis("promo-smart-intelligence");
  } catch {
    return null;
  }
}

function analysisCacheKey(id) {
  return `promo:smart-intelligence:analysis:${String(id || "")}`;
}

function normalizeAccountKey(value) {
  const text = String(value || "").trim();
  if (!text || text.toLowerCase() === "default") return null;
  return text;
}

function canAccessData(data = {}, accountKey) {
  const wanted = normalizeAccountKey(accountKey);
  const current = normalizeAccountKey(data?.accountKey);
  return !!wanted && !!current && wanted === current;
}

function toNum(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round2(value) {
  const n = toNum(value);
  return n == null ? null : Math.round((n + Number.EPSILON) * 100) / 100;
}

function clampPct(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function safeText(value, max = 800) {
  const text = value == null ? "" : String(value);
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function normalizeStatus(value) {
  const s = String(value || "").trim().toLowerCase();
  if (s === "programmed" || s === "scheduled") return "pending";
  if (s === "in_progress") return "pending";
  if (s === "active") return "started";
  return s;
}

function isParticipatingStatus(value) {
  return ["started", "pending"].includes(normalizeStatus(value));
}

function updateMlCredsFromToken(mlCreds, payload) {
  if (!payload) return null;
  if (typeof payload === "string") {
    mlCreds.access_token = payload;
    return payload;
  }
  const token = payload.access_token || payload.token || null;
  if (token) mlCreds.access_token = token;
  if (payload.refresh_token) mlCreds.refresh_token = payload.refresh_token;
  return token;
}

async function authFetch(url, init = {}, mlCreds = {}) {
  const call = async (token) => {
    const headers = {
      Accept: "application/json",
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
    };
    return fetch(url, { ...init, headers });
  };

  let token = mlCreds?.access_token || null;
  if (!token) {
    const refreshed = await TokenService.renovarTokenSeNecessario(mlCreds);
    token = updateMlCredsFromToken(mlCreds, refreshed);
  }

  let response = await call(token);
  if (response.status !== 401) return response;

  const renewed = await TokenService.renovarToken(mlCreds);
  const newToken = updateMlCredsFromToken(mlCreds, renewed);
  return call(newToken);
}

async function parseJsonSafe(response) {
  const text = await response.text().catch(() => "");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: safeText(text, 2000) };
  }
}

function isTransientStatus(status) {
  const n = Number(status);
  return n === 429 || (n >= 500 && n <= 599);
}

async function withTransientRetry(fn, { attempts = TRANSIENT_ATTEMPTS } = {}) {
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      last = await fn(attempt);
      if (!last || !isTransientStatus(last.status)) return last;
    } catch (error) {
      last = { ok: false, status: 0, error: error?.message || String(error) };
    }
    if (attempt < attempts) {
      const jitter = Math.floor(Math.random() * Math.max(200, TRANSIENT_BASE_MS * 0.35));
      await sleep(Math.min(20000, TRANSIENT_BASE_MS * 2 ** (attempt - 1)) + jitter);
    }
  }
  return last;
}

function extractResults(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.data?.results)) return payload.data.results;
  return [];
}

function nextSearchAfter(payload) {
  const paging = payload?.paging || payload?.data?.paging || {};
  return (
    paging.searchAfter ??
    paging.search_after ??
    paging.next_token ??
    paging.nextToken ??
    null
  );
}

function promotionIdOf(value) {
  return String(value?.id || value?.promotion_id || value?.code || "").trim();
}

function promotionTypeOf(value) {
  return String(value?.type || value?.promotion_type || "").trim().toUpperCase();
}

function promotionNameOf(value) {
  return String(
    value?.name || value?.title || value?.promotion_name || value?.id || value?.promotion_id || "SMART",
  ).trim();
}

function campaignStart(value) {
  return value?.start_date || value?.valid_from || value?.date_from || value?.start || null;
}

function campaignFinish(value) {
  return value?.finish_date || value?.end_date || value?.valid_to || value?.date_to || value?.finish || null;
}

async function fetchMe(mlCreds) {
  const response = await authFetch("https://api.mercadolibre.com/users/me", {}, mlCreds);
  const body = await parseJsonSafe(response);
  if (!response.ok) {
    throw new Error(body?.message || body?.error || `Falha ao consultar users/me (HTTP ${response.status}).`);
  }
  return body;
}

async function fetchUserPromotionsPage(mlCreds, userId, { limit, offset, status = null }) {
  const buildDirectUrl = (withAppVersion = true) => {
    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
    });
    if (withAppVersion) params.set("app_version", "v2");
    if (status) params.set("status", String(status));
    return `https://api.mercadolibre.com/seller-promotions/users/${encodeURIComponent(
      userId,
    )}?${params.toString()}`;
  };

  const requestJson = async (url, init = {}) => {
    const call = await withTransientRetry(async () => {
      const response = await authFetch(url, init, mlCreds);
      return { response, status: response.status };
    });
    const response = call?.response;
    if (!response) return { ok: false, status: 0, body: {}, url };
    const body = await parseJsonSafe(response);
    return { ok: response.ok, status: response.status, body, url };
  };

  let direct = await requestJson(buildDirectUrl(true));
  const directText = safeText(direct?.body?.message || direct?.body?.error || direct?.body?.raw || "", 800);
  if (!direct.ok && /invalid[\s_]*app_version/i.test(directText)) {
    direct = await requestJson(buildDirectUrl(false));
  }
  if (direct.ok) return direct;

  // Compatibilidade com contas em que o catalogo de campanhas responde apenas
  // pelo recurso marketplace. Nao mascaramos erro de autenticacao/permissao.
  if (![401, 403].includes(Number(direct.status))) {
    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
    });
    if (status) params.set("status", String(status));
    const marketplaceUrl = `https://api.mercadolibre.com/marketplace/seller-promotions/users/${encodeURIComponent(
      userId,
    )}?${params.toString()}`;
    const marketplace = await requestJson(marketplaceUrl, {
      headers: { version: "v2" },
    });
    if (marketplace.ok) return marketplace;
  }

  return direct;
}

async function fetchUserPromotions(mlCreds, userId) {
  const merged = [];
  const seen = new Set();
  let anySourceSucceeded = false;
  let firstError = null;

  const fetchSource = async (status = null) => {
    let offset = 0;
    for (let page = 0; page < ANALYSIS_MAX_PAGES; page += 1) {
      const result = await fetchUserPromotionsPage(mlCreds, userId, {
        limit: ANALYSIS_PAGE_LIMIT,
        offset,
        status,
      });
      if (!result?.ok) {
        const body = result?.body || {};
        const error = new Error(
          body?.message || body?.error || `Falha ao listar campanhas (HTTP ${result?.status || 0}).`,
        );
        error.status = Number(result?.status || 0);
        error.url = result?.url || null;
        throw error;
      }

      anySourceSucceeded = true;
      const rows = extractResults(result.body);
      let added = 0;
      for (const row of rows) {
        const id = promotionIdOf(row);
        if (!id) continue;
        const key = `${id}|${promotionTypeOf(row)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(row && typeof row === "object" && status && !row.status
          ? { ...row, status }
          : row);
        added += 1;
      }

      if (rows.length < ANALYSIS_PAGE_LIMIT) break;
      const total = toNum(result.body?.paging?.total ?? result.body?.data?.paging?.total);
      offset += ANALYSIS_PAGE_LIMIT;
      if (total != null && offset >= total) break;
      if (added === 0) break;
    }
  };

  // A consulta sem status e a fonte principal. Consultas por status sao apenas
  // complementares e nunca derrubam a Inteligencia caso uma versao/conta do ML
  // nao aceite um desses filtros.
  const sources = [null, "started", "pending", "scheduled", "programmed"];
  for (const status of sources) {
    try {
      await fetchSource(status);
    } catch (error) {
      if (!firstError) firstError = error;
      if ([401, 403].includes(Number(error?.status || 0))) throw error;
      // filtro complementar incompatível: segue com as demais fontes.
    }
  }

  if (!anySourceSucceeded) throw firstError || new Error("Falha ao listar campanhas SMART.");
  return merged;
}

async function fetchSmartCampaigns(mlCreds) {
  const me = await fetchMe(mlCreds);
  const userId = me?.id;
  if (!userId) throw new Error("Nao foi possivel identificar o usuario Mercado Livre.");

  const rows = await fetchUserPromotions(mlCreds, userId);
  const merged = [];
  const seen = new Set();
  for (const row of rows) {
    if (promotionTypeOf(row) !== "SMART") continue;
    const id = promotionIdOf(row);
    if (!id || seen.has(id)) continue;
    const st = normalizeStatus(row?.status);
    // Campanhas SMART relevantes para a analise: em execucao ou pendentes.
    // Itens candidatos nao sao participacoes e finished nao deve ser otimizada.
    if (st && !["started", "pending"].includes(st)) continue;
    seen.add(id);
    merged.push(row);
    if (merged.length >= ANALYSIS_MAX_CAMPAIGNS) break;
  }
  return merged;
}

async function fetchPromotionDetail(mlCreds, promotionId) {
  const params = new URLSearchParams({ promotion_type: "SMART", app_version: "v2" });
  const url = `https://api.mercadolibre.com/seller-promotions/promotions/${encodeURIComponent(
    promotionId,
  )}?${params.toString()}`;
  const response = await authFetch(url, {}, mlCreds).catch(() => null);
  if (!response?.ok) return null;
  return parseJsonSafe(response);
}

async function fetchSmartCampaignItems(mlCreds, campaign, { itemId = null } = {}) {
  const promotionId = promotionIdOf(campaign);
  if (!promotionId) return [];

  const merged = [];
  let searchAfter = null;
  let offset = 0;
  const seenTokens = new Set();
  const seenRows = new Set();

  for (let page = 0; page < ANALYSIS_MAX_PAGES; page += 1) {
    const params = new URLSearchParams({
      promotion_type: "SMART",
      limit: String(ANALYSIS_PAGE_LIMIT),
      app_version: "v2",
    });
    if (itemId) params.set("item_id", String(itemId).toUpperCase());
    if (searchAfter) params.set("search_after", searchAfter);
    else if (offset > 0) params.set("offset", String(offset));

    const url = `https://api.mercadolibre.com/seller-promotions/promotions/${encodeURIComponent(
      promotionId,
    )}/items?${params.toString()}`;

    const call = await withTransientRetry(async () => {
      const response = await authFetch(url, {}, mlCreds);
      return { response, status: response.status };
    });
    const response = call?.response;
    if (!response) {
      const error = new Error(`Falha de rede ao consultar itens da Smart ${promotionId}.`);
      error.status = 0;
      throw error;
    }
    const body = await parseJsonSafe(response);
    if (!response.ok) {
      const error = new Error(
        body?.message || body?.error || `Falha ao consultar Smart ${promotionId} (HTTP ${response.status}).`,
      );
      error.status = response.status;
      error.url = url;
      throw error;
    }

    const rows = extractResults(body);
    let added = 0;
    for (const row of rows) {
      const rowId = String(row?.id || row?.item_id || "").trim().toUpperCase();
      const offerId = String(row?.offer_id || row?.ref_id || "").trim();
      const rowKey = `${rowId}|${offerId}|${normalizeStatus(row?.status)}`;
      if (seenRows.has(rowKey)) continue;
      seenRows.add(rowKey);
      merged.push(row);
      added += 1;
    }

    if (itemId || rows.length < ANALYSIS_PAGE_LIMIT) break;

    const next = nextSearchAfter(body);
    if (next && !seenTokens.has(String(next))) {
      seenTokens.add(String(next));
      searchAfter = String(next);
      continue;
    }

    const total = toNum(body?.paging?.total ?? body?.data?.paging?.total);
    if (total != null && merged.length < total && added > 0) {
      // Alguns payloads SMART atuais informam total/limit sem search_after.
      // Offset e usado apenas como fallback, com deduplicacao para evitar loop.
      searchAfter = null;
      offset += ANALYSIS_PAGE_LIMIT;
      continue;
    }
    break;
  }

  return merged;
}

function pickOfferId(value) {
  const refs = [
    value?.offer_id,
    value?._variant_offer_id,
    value?.ref_id,
    value?.id,
  ]
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
  return refs.find((entry) => /^OFFER-/i.test(entry)) || refs[0] || null;
}

function percentParts(value, benefits = null) {
  const localBenefits = value?.benefits || {};
  const meli = toNum(
    value?.meli_percentage ??
      value?.meli_percent ??
      value?.rebate_meli_percent ??
      localBenefits?.meli_percent ??
      benefits?.meli_percent,
  );
  const seller = toNum(
    value?.seller_percentage ??
      value?.seller_percent ??
      localBenefits?.seller_percent ??
      benefits?.seller_percent,
  );
  const explicit = toNum(value?.discount_percentage);
  const total = explicit != null ? explicit : meli != null || seller != null ? (meli || 0) + (seller || 0) : null;
  return { meli: round2(meli), seller: round2(seller), total: round2(total) };
}

function resolveOriginalPrice(value) {
  return toNum(value?.original_price ?? value?.item_original_price ?? value?.regular_amount ?? value?.base_price);
}

function resolveFinalPrice(value, totalPercent = null) {
  const explicit = toNum(
    value?.deal_price ??
      value?.new_price ??
      value?.discounted_price ??
      value?.final_price ??
      value?.price,
  );
  const original = resolveOriginalPrice(value);
  if (explicit != null && original != null && explicit <= original * 1.001) return round2(explicit);
  if (original != null && totalPercent != null) {
    return round2(original * (1 - totalPercent / 100));
  }
  return explicit != null ? round2(explicit) : null;
}

function parseDateMs(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
}

function normalizeInterval(startValue, finishValue) {
  const startMs = parseDateMs(startValue);
  const finishMs = parseDateMs(finishValue);
  return {
    start: startValue || null,
    finish: finishValue || null,
    startMs,
    finishMs,
  };
}

function expandSmartRow(row, campaign) {
  const itemId = String(row?.id || row?.item_id || "").trim().toUpperCase();
  if (!itemId) return [];

  const campaignBenefits = campaign?.benefits || campaign?.promotion_benefits || null;
  const offers = Array.isArray(row?.offers) && row.offers.length ? row.offers : [null];
  const variants = [];

  for (const offer of offers) {
    const merged = offer && typeof offer === "object" ? { ...row, ...offer } : { ...row };
    const status = normalizeStatus(merged?.status ?? row?.status ?? campaign?.status);
    if (!isParticipatingStatus(status)) continue;

    const parts = percentParts(merged, campaignBenefits);
    const originalPrice = round2(resolveOriginalPrice(merged));
    const finalPrice = resolveFinalPrice(merged, parts.total);
    const interval = normalizeInterval(
      campaignStart(merged) || campaignStart(campaign),
      campaignFinish(merged) || campaignFinish(campaign),
    );

    variants.push({
      item_id: itemId,
      promotion_id: promotionIdOf(campaign),
      promotion_name: promotionNameOf(campaign),
      promotion_status: normalizeStatus(campaign?.status),
      status,
      offer_id: pickOfferId(merged),
      meli_percentage: parts.meli,
      seller_percentage: parts.seller,
      total_discount_percentage: parts.total,
      original_price: originalPrice,
      final_price: finalPrice,
      start_date: interval.start,
      finish_date: interval.finish,
      start_ms: interval.startMs,
      finish_ms: interval.finishMs,
    });
  }

  // Alguns payloads trazem os dados somente na linha principal, mesmo com offers auxiliares.
  if (!variants.length && isParticipatingStatus(row?.status ?? campaign?.status)) {
    const status = normalizeStatus(row?.status ?? campaign?.status);
    const parts = percentParts(row, campaignBenefits);
    const interval = normalizeInterval(
      campaignStart(row) || campaignStart(campaign),
      campaignFinish(row) || campaignFinish(campaign),
    );
    variants.push({
      item_id: itemId,
      promotion_id: promotionIdOf(campaign),
      promotion_name: promotionNameOf(campaign),
      promotion_status: normalizeStatus(campaign?.status),
      status,
      offer_id: pickOfferId(row),
      meli_percentage: parts.meli,
      seller_percentage: parts.seller,
      total_discount_percentage: parts.total,
      original_price: round2(resolveOriginalPrice(row)),
      final_price: resolveFinalPrice(row, parts.total),
      start_date: interval.start,
      finish_date: interval.finish,
      start_ms: interval.startMs,
      finish_ms: interval.finishMs,
    });
  }

  const seen = new Set();
  return variants.filter((entry) => {
    const key = [
      entry.item_id,
      entry.promotion_id,
      entry.offer_id || "",
      entry.status,
      entry.start_date || "",
      entry.finish_date || "",
      entry.total_discount_percentage ?? "",
      entry.meli_percentage ?? "",
      entry.seller_percentage ?? "",
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function intervalsOverlap(a, b) {
  if (a?.start_ms == null || a?.finish_ms == null || b?.start_ms == null || b?.finish_ms == null) {
    return false;
  }
  return a.start_ms <= b.finish_ms && b.start_ms <= a.finish_ms;
}

function coversInterval(winner, loser) {
  if (
    winner?.start_ms == null ||
    winner?.finish_ms == null ||
    loser?.start_ms == null ||
    loser?.finish_ms == null
  ) {
    return false;
  }
  return winner.start_ms <= loser.start_ms && winner.finish_ms >= loser.finish_ms;
}

function buyerConditionEquivalent(a, b) {
  const aDisc = toNum(a?.total_discount_percentage);
  const bDisc = toNum(b?.total_discount_percentage);
  if (aDisc == null || bDisc == null) return false;
  if (Math.abs(aDisc - bDisc) > SMART_BUYER_DISCOUNT_TOLERANCE) return false;

  const aPrice = toNum(a?.final_price);
  const bPrice = toNum(b?.final_price);
  if (aPrice != null && bPrice != null && Math.abs(aPrice - bPrice) > SMART_BUYER_PRICE_TOLERANCE) {
    return false;
  }
  return true;
}

function statusCompatibleForReplacement(winner, loser) {
  const winnerStatus = normalizeStatus(winner?.status);
  const loserStatus = normalizeStatus(loser?.status);
  if (loserStatus === "started") return winnerStatus === "started";
  return ["started", "pending", "scheduled"].includes(winnerStatus);
}

function rebateImprovement(winner, loser) {
  const winnerSeller = toNum(winner?.seller_percentage);
  const loserSeller = toNum(loser?.seller_percentage);
  const winnerMeli = toNum(winner?.meli_percentage);
  const loserMeli = toNum(loser?.meli_percentage);
  if (winnerSeller == null || loserSeller == null || winnerMeli == null || loserMeli == null) {
    return { ok: false, seller_gain_pp: null, meli_gain_pp: null };
  }
  const sellerGain = loserSeller - winnerSeller;
  const meliGain = winnerMeli - loserMeli;
  return {
    ok: sellerGain >= SMART_REBATE_MIN_GAIN_PP && meliGain >= SMART_REBATE_MIN_GAIN_PP,
    seller_gain_pp: round2(sellerGain),
    meli_gain_pp: round2(meliGain),
  };
}

function concreteOffer(value) {
  return /^OFFER-/i.test(String(value?.offer_id || ""));
}

function safeReplacementCheck(winner, loser) {
  if (!winner || !loser || winner === loser) return { ok: false, reason: "invalid_pair" };
  if (winner.promotion_id === loser.promotion_id && winner.offer_id === loser.offer_id) {
    return { ok: false, reason: "same_offer" };
  }
  if (!intervalsOverlap(winner, loser)) return { ok: false, reason: "no_overlap" };
  if (!buyerConditionEquivalent(winner, loser)) return { ok: false, reason: "buyer_condition_differs" };
  if (!coversInterval(winner, loser)) return { ok: false, reason: "partial_coverage" };
  if (!statusCompatibleForReplacement(winner, loser)) return { ok: false, reason: "status_incompatible" };
  if (!concreteOffer(winner) || !concreteOffer(loser)) return { ok: false, reason: "offer_id_missing" };
  const rebate = rebateImprovement(winner, loser);
  if (!rebate.ok) return { ok: false, reason: "no_rebate_gain", ...rebate };
  return { ok: true, reason: "safe", ...rebate };
}

function opportunityId(itemId, loser, winner) {
  return crypto
    .createHash("sha1")
    .update(
      [
        itemId,
        loser?.promotion_id,
        loser?.offer_id,
        winner?.promotion_id,
        winner?.offer_id,
      ].join("|"),
    )
    .digest("hex")
    .slice(0, 20);
}

function offerSortScore(a, b) {
  const aSeller = toNum(a?.seller_percentage) ?? Infinity;
  const bSeller = toNum(b?.seller_percentage) ?? Infinity;
  if (aSeller !== bSeller) return aSeller - bSeller;
  const aMeli = toNum(a?.meli_percentage) ?? -Infinity;
  const bMeli = toNum(b?.meli_percentage) ?? -Infinity;
  if (aMeli !== bMeli) return bMeli - aMeli;
  const aStarted = normalizeStatus(a?.status) === "started" ? 1 : 0;
  const bStarted = normalizeStatus(b?.status) === "started" ? 1 : 0;
  return bStarted - aStarted;
}

function reviewReasonForPair(a, b) {
  if (!intervalsOverlap(a, b)) return null;
  if (!buyerConditionEquivalent(a, b)) return "Condições diferentes para o comprador";
  if (!coversInterval(b, a) && !coversInterval(a, b)) return "Vigências se sobrepõem apenas parcialmente";
  if (!concreteOffer(a) || !concreteOffer(b)) return "Offer ID insuficiente para remoção segura";
  if (!statusCompatibleForReplacement(b, a) && !statusCompatibleForReplacement(a, b)) {
    return "Estados das promoções não permitem substituição automática";
  }
  const ab = rebateImprovement(b, a);
  const ba = rebateImprovement(a, b);
  if (!ab.ok && !ba.ok) return "Não há ganho claro de participação do Mercado Livre";
  return "Cenário requer revisão manual";
}

function analyzeSmartRecords(records = [], itemDetails = {}) {
  const groups = new Map();
  for (const record of records) {
    const itemId = String(record?.item_id || "").trim().toUpperCase();
    if (!itemId) continue;
    if (!groups.has(itemId)) groups.set(itemId, []);
    groups.get(itemId).push(record);
  }

  const opportunities = [];
  const reviews = [];
  let conflictItems = 0;
  let alreadyOptimized = 0;

  for (const [itemId, groupRaw] of groups.entries()) {
    const group = groupRaw
      .filter((entry) => isParticipatingStatus(entry?.status))
      .sort((a, b) => (a.start_ms || 0) - (b.start_ms || 0));
    if (group.length < 2) continue;

    let hasOverlap = false;
    for (let i = 0; i < group.length && !hasOverlap; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        if (intervalsOverlap(group[i], group[j])) {
          hasOverlap = true;
          break;
        }
      }
    }
    if (!hasOverlap) continue;
    conflictItems += 1;

    const itemOpps = [];
    for (const loser of group) {
      const winners = group
        .filter((winner) => winner !== loser)
        .map((winner) => ({ winner, check: safeReplacementCheck(winner, loser) }))
        .filter((entry) => entry.check.ok)
        .sort((a, b) => offerSortScore(a.winner, b.winner));
      if (!winners.length) continue;
      const best = winners[0];
      const detail = itemDetails[itemId] || {};
      itemOpps.push({
        id: opportunityId(itemId, loser, best.winner),
        item_id: itemId,
        title: detail.title || itemId,
        sku: detail.seller_custom_field || detail.sku || null,
        classification: "safe",
        reason: "Mesma condição ao comprador, cobertura integral da vigência e maior participação do Mercado Livre.",
        current: { ...loser },
        recommended: { ...best.winner },
        seller_gain_pp: best.check.seller_gain_pp,
        meli_gain_pp: best.check.meli_gain_pp,
      });
    }

    // Remove recomendações redundantes do mesmo offer perdedor e privilegia o melhor vencedor.
    const byLoser = new Map();
    for (const opp of itemOpps) {
      const key = `${opp.current.promotion_id}|${opp.current.offer_id}`;
      const prev = byLoser.get(key);
      if (!prev || offerSortScore(opp.recommended, prev.recommended) < 0) byLoser.set(key, opp);
    }
    opportunities.push(...byLoser.values());

    if (!byLoser.size) {
      const reasons = new Set();
      for (let i = 0; i < group.length; i += 1) {
        for (let j = i + 1; j < group.length; j += 1) {
          const reason = reviewReasonForPair(group[i], group[j]);
          if (reason) reasons.add(reason);
        }
      }
      const detail = itemDetails[itemId] || {};
      if (reasons.size) {
        reviews.push({
          item_id: itemId,
          title: detail.title || itemId,
          sku: detail.seller_custom_field || detail.sku || null,
          classification: "review",
          reasons: [...reasons],
          offers: group.map((entry) => ({ ...entry })),
        });
      } else {
        alreadyOptimized += 1;
      }
    }
  }

  return {
    opportunities,
    reviews,
    summary: {
      item_groups: groups.size,
      conflict_items: conflictItems,
      safe_opportunities: opportunities.length,
      review_items: reviews.length,
      already_optimized: alreadyOptimized,
    },
  };
}

async function fetchItemDetails(mlCreds, itemIds = []) {
  const out = Object.create(null);
  const unique = [...new Set(itemIds.map((id) => String(id || "").trim().toUpperCase()).filter(Boolean))];
  for (let i = 0; i < unique.length; i += 20) {
    const group = unique.slice(i, i + 20);
    const params = new URLSearchParams({
      ids: group.join(","),
      attributes: "id,title,seller_custom_field,price",
    });
    const response = await authFetch(`https://api.mercadolibre.com/items?${params.toString()}`, {}, mlCreds).catch(() => null);
    if (!response?.ok) continue;
    const body = await parseJsonSafe(response);
    for (const row of Array.isArray(body) ? body : []) {
      const item = row?.body || row || {};
      if (item?.id) {
        out[String(item.id).toUpperCase()] = {
          title: item.title || null,
          seller_custom_field: item.seller_custom_field || null,
          price: toNum(item.price),
        };
      }
    }
  }
  return out;
}

async function updateJobMeta(job, patch = {}) {
  job.data.__meta = {
    ...(job.data.__meta || {}),
    ...patch,
    updatedAt: Date.now(),
  };
  await job.update(job.data);
}

async function checkCancelled(job) {
  const latest = await job.queue.getJob(job.id).catch(() => null);
  const data = latest?.data || job.data || {};
  if (data?.cancelRequested === true || data?.__meta?.cancelRequested === true) {
    throw new SmartOptimizerCancelledError();
  }
}

function auditBase(job) {
  const ctx = job?.data?.auditContext || {};
  return {
    userId: Number(ctx.userId) || null,
    email: ctx.email || null,
    ip: ctx.ip || null,
    userAgent: ctx.userAgent || null,
    accountKey: ctx.accountKey || job?.data?.accountKey || null,
    accountLabel: ctx.accountLabel || job?.data?.accountLabel || null,
    meli_conta_id: ctx.meli_conta_id || job?.data?.mlCreds?.meli_conta_id || null,
  };
}

async function auditJob(job, evento, status, metadata = {}) {
  const base = auditBase(job);
  await recordAuthEvent({
    userId: base.userId,
    email: base.email,
    evento,
    status,
    ip: base.ip,
    userAgent: base.userAgent,
    metadata: {
      accountKey: base.accountKey,
      accountLabel: base.accountLabel,
      meli_conta_id: base.meli_conta_id,
      operation_id: job?.data?.operationId || null,
      job_id: job?.id ? String(job.id) : null,
      ...metadata,
    },
  }).catch((error) => {
    console.error("[PromoSmartOptimizer] audit error:", error?.message || error);
  });
}

async function storeAnalysisResult(id, result) {
  const redis = redisClient();
  if (!redis) return;
  try {
    await redis.set(analysisCacheKey(id), JSON.stringify(result), "PX", ANALYSIS_TTL_MS);
  } catch (error) {
    console.warn("[PromoSmartOptimizer] falha ao armazenar análise:", error?.message || error);
  }
}

async function loadAnalysisResult(id) {
  const redis = redisClient();
  if (redis) {
    try {
      const raw = await redis.get(analysisCacheKey(id));
      if (raw) return JSON.parse(raw);
    } catch {}
  }

  const q = ensureQueue();
  const job = await q.getJob(id).catch(() => null);
  if (!job) return null;
  const state = await job.getState().catch(() => "unknown");
  if (state !== "completed") return null;
  return job.returnvalue || null;
}

async function runAnalysisJob(job) {
  const { mlCreds = {} } = job.data || {};
  await updateJobMeta(job, {
    stateLabel: "analisando Smart",
    phase: "campaigns",
    processed: 0,
    total: 0,
    startedAt: Date.now(),
  });
  await job.progress(1);
  await auditJob(job, "promotion_smart_analysis_started", "success");

  const campaigns = await fetchSmartCampaigns(mlCreds);
  await updateJobMeta(job, {
    phase: "items",
    total: campaigns.length,
    campaignCount: campaigns.length,
  });

  const records = [];
  const warnings = [];
  let itemRowsScanned = 0;
  let campaignsSucceeded = 0;
  for (let index = 0; index < campaigns.length; index += 1) {
    await checkCancelled(job);
    const campaign = campaigns[index];
    try {
      const rows = await fetchSmartCampaignItems(mlCreds, campaign);
      itemRowsScanned += rows.length;
      for (const row of rows) records.push(...expandSmartRow(row, campaign));
      campaignsSucceeded += 1;
    } catch (error) {
      const status = Number(error?.status || 0);
      if (status === 401 || status === 403) throw error;
      warnings.push({
        promotion_id: promotionIdOf(campaign),
        promotion_name: promotionNameOf(campaign),
        status: status || null,
        message: safeText(error?.message || String(error), 500),
      });
    }

    const processed = index + 1;
    const progress = campaigns.length ? 5 + Math.round((processed / campaigns.length) * 65) : 65;
    await updateJobMeta(job, {
      processed,
      itemRowsScanned,
      currentCampaign: promotionNameOf(campaign),
      failedCampaigns: warnings.length,
    });
    await job.progress(progress);
  }

  if (campaigns.length > 0 && campaignsSucceeded === 0) {
    const first = warnings[0];
    throw new Error(
      first?.message
        ? `Nao foi possivel consultar as campanhas SMART. ${first.message}`
        : "Nao foi possivel consultar as campanhas SMART do Mercado Livre.",
    );
  }

  const groupedIds = [...new Set(records.map((row) => row.item_id).filter(Boolean))];
  await updateJobMeta(job, { phase: "enrichment", itemGroups: groupedIds.length });
  await job.progress(75);
  const itemDetails = await fetchItemDetails(mlCreds, groupedIds);

  await updateJobMeta(job, { phase: "analysis" });
  await job.progress(88);
  const analyzed = analyzeSmartRecords(records, itemDetails);
  const generatedAt = new Date().toISOString();
  const result = {
    ok: true,
    analysis_id: String(job.id),
    accountKey: job.data.accountKey || null,
    accountLabel: job.data.accountLabel || null,
    generated_at: generatedAt,
    expires_at: new Date(Date.now() + ANALYSIS_TTL_MS).toISOString(),
    summary: {
      campaigns_analyzed: campaignsSucceeded,
      campaigns_found: campaigns.length,
      campaigns_with_warnings: warnings.length,
      item_rows_scanned: itemRowsScanned,
      items_analyzed: groupedIds.length,
      ...analyzed.summary,
    },
    warnings,
    opportunities: analyzed.opportunities,
    reviews: analyzed.reviews,
  };

  await storeAnalysisResult(job.id, result);
  await updateJobMeta(job, {
    stateLabel: "análise concluída",
    phase: "completed",
    processed: campaigns.length,
    summary: result.summary,
  });
  await job.progress(100);
  await auditJob(job, "promotion_smart_analysis_completed", "success", {
    ...result.summary,
  });
  return result;
}

async function acquireAccountLock(accountKey, job) {
  const redis = redisClient();
  if (!redis) return { acquired: true, release: async () => {}, refresh: async () => {} };
  const key = `promo:smart-intelligence:account-lock:${String(accountKey || "unknown")}`;
  const token = `${process.pid}:${job?.id}:${Date.now()}:${Math.random().toString(36).slice(2)}`;

  for (let attempt = 0; attempt < 150; attempt += 1) {
    await checkCancelled(job);
    const ok = await redis.set(key, token, "PX", ACCOUNT_LOCK_TTL_MS, "NX").catch(() => null);
    if (ok === "OK") {
      return {
        acquired: true,
        refresh: async () => {
          try {
            if ((await redis.get(key)) === token) await redis.pexpire(key, ACCOUNT_LOCK_TTL_MS);
          } catch {}
        },
        release: async () => {
          try {
            if ((await redis.get(key)) === token) await redis.del(key);
          } catch {}
        },
      };
    }
    await updateJobMeta(job, { stateLabel: "aguardando outra otimização Smart da conta" });
    await sleep(2000);
  }

  throw new Error("Tempo limite aguardando outra otimização Smart da mesma conta.");
}

async function fetchSingleSmartRecord(mlCreds, snapshot) {
  const campaign = {
    id: snapshot?.promotion_id,
    promotion_id: snapshot?.promotion_id,
    name: snapshot?.promotion_name,
    type: "SMART",
    status: snapshot?.promotion_status,
    start_date: snapshot?.start_date,
    finish_date: snapshot?.finish_date,
  };
  const detail = await fetchPromotionDetail(mlCreds, snapshot?.promotion_id).catch(() => null);
  if (detail && typeof detail === "object") Object.assign(campaign, detail);
  const rows = await fetchSmartCampaignItems(mlCreds, campaign, { itemId: snapshot?.item_id });
  const variants = rows.flatMap((row) => expandSmartRow(row, campaign));
  const expectedOfferId = String(snapshot?.offer_id || "").trim();
  const exact = variants.find((entry) => String(entry.offer_id || "") === expectedOfferId);

  // Para operações destrutivas, um OFFER-* específico jamais pode ser
  // substituído silenciosamente pelo único offer que restou na campanha.
  // Se o offer esperado sumiu, o estado correto é "ausente".
  if (expectedOfferId) return exact || null;
  return variants.length === 1 ? variants[0] : null;
}

async function inspectSmartRecord(mlCreds, snapshot) {
  try {
    return { ok: true, record: await fetchSingleSmartRecord(mlCreds, snapshot), error: null };
  } catch (error) {
    return { ok: false, record: null, error };
  }
}

async function deleteSmartParticipation(mlCreds, snapshot) {
  const params = new URLSearchParams({
    promotion_type: "SMART",
    promotion_id: String(snapshot?.promotion_id || ""),
    offer_id: String(snapshot?.offer_id || ""),
    app_version: "v2",
  });
  const url = `https://api.mercadolibre.com/seller-promotions/items/${encodeURIComponent(
    snapshot?.item_id,
  )}?${params.toString()}`;

  for (let attempt = 1; attempt <= TRANSIENT_ATTEMPTS; attempt += 1) {
    const response = await authFetch(url, { method: "DELETE" }, mlCreds).catch(() => null);
    if (response?.ok) {
      return { ok: true, status: response.status, body: await parseJsonSafe(response) };
    }

    const body = response ? await parseJsonSafe(response) : {};
    const status = Number(response?.status || 0);

    // DELETE é potencialmente ambíguo. Antes de reenviar após erro transitório,
    // confirme se a oferta já desapareceu para evitar repetição cega.
    if (!response || isTransientStatus(status)) {
      const inspected = await inspectSmartRecord(mlCreds, snapshot);
      if (inspected.ok && !inspected.record) {
        return {
          ok: true,
          status: status || 200,
          body,
          confirmed_after_ambiguous_response: true,
        };
      }
      if (attempt < TRANSIENT_ATTEMPTS) {
        await sleep(Math.min(15000, TRANSIENT_BASE_MS * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500));
        continue;
      }
      if (!inspected.ok) {
        return {
          ok: false,
          status: status || 503,
          body,
          error: `Não foi possível confirmar o estado da Smart após uma resposta ambígua: ${inspected.error?.message || "falha de consulta"}.`,
        };
      }
    }

    // Se já não existe, tratamos como estado final idempotente somente depois
    // de uma consulta bem-sucedida confirmar a ausência do OFFER específico.
    if (status === 404 || status === 400) {
      const inspected = await inspectSmartRecord(mlCreds, snapshot);
      if (inspected.ok && !inspected.record) return { ok: true, status, body, already_absent: true };
      if (!inspected.ok) {
        return {
          ok: false,
          status,
          body,
          error: `A remoção retornou HTTP ${status}, mas não foi possível confirmar se a oferta já estava ausente.`,
        };
      }
    }

    return {
      ok: false,
      status,
      body,
      error: body?.message || body?.error || `Falha ao remover Smart (HTTP ${status || 0}).`,
    };
  }

  return { ok: false, status: 503, error: "Falha transitória persistente ao remover Smart." };
}

async function revalidateOpportunity(mlCreds, opportunity) {
  // Falha de API/rede não equivale a "oferta ausente". Deixe o erro subir
  // para a camada do item em vez de classificar incorretamente como skip.
  const [current, recommended] = await Promise.all([
    fetchSingleSmartRecord(mlCreds, opportunity?.current),
    fetchSingleSmartRecord(mlCreds, opportunity?.recommended),
  ]);
  if (!current) return { ok: false, skip: true, reason: "Promoção a remover não está mais ativa/programada." };
  if (!recommended) return { ok: false, skip: true, reason: "Promoção recomendada não está mais disponível." };

  const check = safeReplacementCheck(recommended, current);
  if (!check.ok) {
    const reasonMap = {
      buyer_condition_differs: "A condição ao comprador mudou desde a análise.",
      partial_coverage: "A vigência mudou e não há mais cobertura integral.",
      status_incompatible: "O estado das promoções mudou desde a análise.",
      offer_id_missing: "O Mercado Livre não retornou um Offer ID seguro para a remoção.",
      no_rebate_gain: "A vantagem de rebate deixou de existir.",
      no_overlap: "As promoções não se sobrepõem mais.",
    };
    return { ok: false, skip: true, reason: reasonMap[check.reason] || "Cenário alterado desde a análise." };
  }

  return { ok: true, current, recommended, check };
}

async function runOptimizeJob(job) {
  const { mlCreds = {}, opportunities = [] } = job.data || {};
  const total = opportunities.length;
  const operationId = job.data.operationId || `SMART-OPT-${job.id}`;
  job.data.operationId = operationId;
  await updateJobMeta(job, {
    stateLabel: "otimizando Smart",
    processed: 0,
    total,
    success: 0,
    failed: 0,
    skipped: 0,
    startedAt: Date.now(),
    results: [],
  });
  await job.progress(0);
  await auditJob(job, "promotion_smart_optimization_started", "success", {
    total_items: total,
    analysis_id: job.data.analysisId || null,
  });

  const lock = await acquireAccountLock(job.data.accountKey, job);
  let success = 0;
  let failed = 0;
  let skipped = 0;
  const results = [];

  try {
    for (let index = 0; index < opportunities.length; index += 1) {
      await checkCancelled(job);
      await lock.refresh();
      const opportunity = opportunities[index];
      const itemId = opportunity?.item_id;
      let row = {
        opportunity_id: opportunity?.id || null,
        item_id: itemId,
        title: opportunity?.title || itemId,
        current_promotion_id: opportunity?.current?.promotion_id || null,
        current_offer_id: opportunity?.current?.offer_id || null,
        recommended_promotion_id: opportunity?.recommended?.promotion_id || null,
        recommended_offer_id: opportunity?.recommended?.offer_id || null,
        discount_percentage: opportunity?.current?.total_discount_percentage ?? null,
        meli_before: opportunity?.current?.meli_percentage ?? null,
        meli_after: opportunity?.recommended?.meli_percentage ?? null,
        seller_before: opportunity?.current?.seller_percentage ?? null,
        seller_after: opportunity?.recommended?.seller_percentage ?? null,
        meli_gain_pp: opportunity?.meli_gain_pp ?? null,
        seller_gain_pp: opportunity?.seller_gain_pp ?? null,
        status: "processing",
        message: "",
      };

      try {
        const revalidated = await revalidateOpportunity(mlCreds, opportunity);
        if (!revalidated.ok) {
          skipped += 1;
          row = { ...row, status: "skipped", message: revalidated.reason || "Cenário alterado." };
        } else {
          row.current_promotion_id = revalidated.current.promotion_id;
          row.current_offer_id = revalidated.current.offer_id;
          row.recommended_promotion_id = revalidated.recommended.promotion_id;
          row.recommended_offer_id = revalidated.recommended.offer_id;
          row.discount_percentage = revalidated.current.total_discount_percentage;
          row.meli_before = revalidated.current.meli_percentage;
          row.meli_after = revalidated.recommended.meli_percentage;
          row.seller_before = revalidated.current.seller_percentage;
          row.seller_after = revalidated.recommended.seller_percentage;
          row.meli_gain_pp = revalidated.check.meli_gain_pp;
          row.seller_gain_pp = revalidated.check.seller_gain_pp;

          const removed = await deleteSmartParticipation(mlCreds, revalidated.current);
          if (!removed.ok) {
            failed += 1;
            row = {
              ...row,
              status: "error",
              message: removed.error || "Falha ao remover a Smart menos vantajosa.",
              ml_status: removed.status || null,
            };
          } else {
            // Pós-confirmação: a oferta removida precisa desaparecer e a vencedora permanecer.
            // Uma falha de consulta aqui não pode ser interpretada como ausência: houve
            // uma operação destrutiva e precisamos parar até conseguir confirmar o estado.
            let loserAfter;
            let winnerAfter;
            try {
              [loserAfter, winnerAfter] = await Promise.all([
                fetchSingleSmartRecord(mlCreds, revalidated.current),
                fetchSingleSmartRecord(mlCreds, revalidated.recommended),
              ]);
            } catch (confirmationError) {
              row = {
                ...row,
                status: "safety_pause",
                message: `Não foi possível confirmar o estado das Smart após a remoção: ${confirmationError?.message || "falha de consulta"}. Processamento interrompido por segurança.`,
              };
              failed += 1;
              results.push(row);
              await updateJobMeta(job, {
                stateLabel: "pausado por segurança",
                safetyPaused: true,
                processed: index + 1,
                success,
                failed,
                skipped,
                results,
              });
              await auditJob(job, "promotion_smart_optimization_item_processed", "warn", row);
              throw new SmartOptimizerSafetyError(row.message, row);
            }

            if (loserAfter) {
              failed += 1;
              row = {
                ...row,
                status: "error",
                message: "O Mercado Livre respondeu à remoção, mas a promoção antiga ainda aparece ativa/programada.",
              };
            } else if (!winnerAfter) {
              failed += 1;
              row = {
                ...row,
                status: "safety_pause",
                message: "A Smart recomendada deixou de ser confirmada após a remoção. Processamento interrompido por segurança.",
              };
              results.push(row);
              await updateJobMeta(job, {
                stateLabel: "pausado por segurança",
                safetyPaused: true,
                processed: index + 1,
                success,
                failed,
                skipped,
                results,
              });
              await auditJob(job, "promotion_smart_optimization_item_processed", "warn", row);
              throw new SmartOptimizerSafetyError(row.message, row);
            } else {
              success += 1;
              row = {
                ...row,
                status: "optimized",
                message: "Smart menos vantajosa removida e melhor condição confirmada.",
              };
            }
          }
        }
      } catch (error) {
        if (error instanceof SmartOptimizerSafetyError || error instanceof SmartOptimizerCancelledError) throw error;
        failed += 1;
        row = { ...row, status: "error", message: error?.message || String(error) };
      }

      results.push(row);
      const processed = index + 1;
      await updateJobMeta(job, {
        stateLabel: "otimizando Smart",
        processed,
        success,
        failed,
        skipped,
        results,
      });
      await job.progress(total ? clampPct((processed / total) * 100) : 100);
      await auditJob(
        job,
        "promotion_smart_optimization_item_processed",
        row.status === "optimized" ? "success" : row.status === "skipped" ? "info" : "warn",
        row,
      );
    }

    await updateJobMeta(job, {
      stateLabel: failed > 0 ? "concluído parcialmente" : "concluído",
      processed: total,
      success,
      failed,
      skipped,
      results,
      completedAt: Date.now(),
    });
    await job.progress(100);
    await auditJob(job, "promotion_smart_optimization_completed", failed > 0 ? "warn" : "success", {
      total,
      success,
      failed,
      skipped,
    });
    return { ok: failed === 0, total, processed: total, success, failed, skipped, results, operation_id: operationId };
  } finally {
    await lock.release();
  }
}

async function processJob(job) {
  try {
    if (job.data?.kind === "analyze") return await runAnalysisJob(job);
    if (job.data?.kind === "optimize") return await runOptimizeJob(job);
    throw new Error(`Tipo de job Smart desconhecido: ${job.data?.kind || "unknown"}`);
  } catch (error) {
    if (error instanceof SmartOptimizerCancelledError) {
      const meta = job.data?.__meta || {};
      await updateJobMeta(job, {
        stateLabel: "cancelado",
        cancelRequested: true,
        canceledAt: Date.now(),
      });
      const processed = Number(meta.processed || 0);
      const total = Number(meta.total || job.data?.opportunities?.length || 0);
      await job.progress(total > 0 ? clampPct((processed / total) * 100) : 0);
      await auditJob(job, "promotion_smart_optimization_canceled", "warn", { processed, total });
      return {
        ok: false,
        canceled: true,
        total,
        processed,
        success: Number(meta.success || 0),
        failed: Number(meta.failed || 0),
        skipped: Number(meta.skipped || 0),
        results: Array.isArray(meta.results) ? meta.results : [],
      };
    }

    if (error instanceof SmartOptimizerSafetyError) {
      await updateJobMeta(job, {
        stateLabel: "pausado por segurança",
        safetyPaused: true,
        resumable: false,
        failedAt: Date.now(),
      });
      await auditJob(job, "promotion_smart_optimization_safety_paused", "warn", {
        reason: error.message,
        details: error.details || null,
      });
    } else if (job.data?.kind === "analyze") {
      await updateJobMeta(job, { stateLabel: "falha na análise", error: error?.message || String(error) });
      await auditJob(job, "promotion_smart_analysis_failed", "error", { reason: error?.message || String(error) });
    } else {
      await updateJobMeta(job, { stateLabel: "falhou", error: error?.message || String(error) });
      await auditJob(job, "promotion_smart_optimization_failed", "error", { reason: error?.message || String(error) });
    }
    throw error;
  }
}

function makeJobId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function operationId() {
  return `SMART-OPT-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

function resolveJobMetrics(job, state) {
  const meta = job?.data?.__meta || {};
  const ret = job?.returnvalue || {};
  const total = Number(meta.total ?? ret.total ?? job?.data?.opportunities?.length ?? 0) || 0;
  const processed = Number(meta.processed ?? ret.processed ?? 0) || 0;
  const success = Number(meta.success ?? ret.success ?? 0) || 0;
  const failed = Number(meta.failed ?? ret.failed ?? 0) || 0;
  const skipped = Number(meta.skipped ?? ret.skipped ?? 0) || 0;
  const progress = total > 0 ? clampPct((processed / total) * 100) : state === "completed" ? 100 : 0;
  return { total, processed, success, failed, skipped, progress };
}

async function buildWorkbook(job) {
  const state = await job.getState().catch(() => "unknown");
  const metrics = resolveJobMetrics(job, state);
  const meta = job.data?.__meta || {};
  const rows = Array.isArray(meta.results)
    ? meta.results
    : Array.isArray(job.returnvalue?.results)
      ? job.returnvalue.results
      : [];

  const wb = new ExcelJS.Workbook();
  wb.creator = "Davantti";
  wb.created = new Date();

  const summary = wb.addWorksheet("Resumo");
  const summaryRows = [
    ["Operação", job.data?.operationId || ""],
    ["Job", String(job.id)],
    ["Conta", job.data?.accountLabel || job.data?.accountKey || ""],
    ["Análise origem", job.data?.analysisId || ""],
    ["Estado", meta.stateLabel || state],
    ["Total selecionado", metrics.total],
    ["Otimizados", metrics.success],
    ["Ignorados por revalidação", metrics.skipped],
    ["Erros", metrics.failed],
    ["Processados", metrics.processed],
    ["Início", meta.startedAt ? new Date(meta.startedAt).toISOString() : ""],
    ["Fim", meta.completedAt ? new Date(meta.completedAt).toISOString() : ""],
  ];
  summary.addRows(summaryRows);
  summary.getColumn(1).width = 30;
  summary.getColumn(2).width = 42;
  summary.getColumn(1).font = { bold: true };

  const sheet = wb.addWorksheet("Otimizações Smart");
  sheet.columns = [
    { header: "MLB", key: "item_id", width: 18 },
    { header: "Anúncio", key: "title", width: 42 },
    { header: "Status", key: "status", width: 18 },
    { header: "Mensagem", key: "message", width: 54 },
    { header: "Promo removida", key: "current_promotion_id", width: 24 },
    { header: "Offer removido", key: "current_offer_id", width: 28 },
    { header: "Promo mantida", key: "recommended_promotion_id", width: 24 },
    { header: "Offer mantido", key: "recommended_offer_id", width: 28 },
    { header: "Desconto total %", key: "discount_percentage", width: 17 },
    { header: "ML antes %", key: "meli_before", width: 14 },
    { header: "ML depois %", key: "meli_after", width: 14 },
    { header: "Seller antes %", key: "seller_before", width: 15 },
    { header: "Seller depois %", key: "seller_after", width: 15 },
    { header: "Ganho ML p.p.", key: "meli_gain_pp", width: 15 },
    { header: "Redução Seller p.p.", key: "seller_gain_pp", width: 18 },
  ];
  rows.forEach((row) => sheet.addRow(row));
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = { from: "A1", to: `O${Math.max(1, rows.length + 1)}` };

  return wb.xlsx.writeBuffer();
}

module.exports = {
  init() {
    ensureQueue();
  },

  initWorker() {
    if (workerStarted) return;
    const q = ensureQueue();
    q.process(2, processJob);
    workerStarted = true;
    console.log("[PromoSmartOptimizer] worker iniciado");
  },

  async startAnalysis({ mlCreds, accountKey, accountLabel, auditContext = null }) {
    const q = ensureQueue();
    const id = makeJobId("analysis");
    await q.add(
      {
        kind: "analyze",
        mlCreds: { ...(mlCreds || {}) },
        accountKey: normalizeAccountKey(accountKey),
        accountLabel: accountLabel || accountKey || null,
        auditContext,
        createdAt: Date.now(),
      },
      {
        jobId: id,
        removeOnComplete: 50,
        removeOnFail: false,
      },
    );
    return id;
  },

  async getAnalysis(id, { accountKey = null } = {}) {
    const q = ensureQueue();
    const job = await q.getJob(id).catch(() => null);
    if (job && !canAccessData(job.data || {}, accountKey)) return null;

    const cached = await loadAnalysisResult(id);
    if (cached) {
      if (normalizeAccountKey(cached.accountKey) !== normalizeAccountKey(accountKey)) return null;
      return { state: "completed", progress: 100, result: cached };
    }
    if (!job) return null;

    const state = await job.getState().catch(() => "unknown");
    const meta = job.data?.__meta || {};
    const progress = clampPct(await readBullJobProgress(job, 0));
    return {
      state,
      progress,
      phase: meta.phase || null,
      current_campaign: meta.currentCampaign || null,
      processed: Number(meta.processed || 0),
      total: Number(meta.total || 0),
      item_rows_scanned: Number(meta.itemRowsScanned || 0),
      error: meta.error || (state === "failed" ? job.failedReason || "Falha na análise." : null),
      result: null,
    };
  },

  async enqueueOptimization({ analysisId, opportunityIds, accountKey, accountLabel, mlCreds, auditContext = null }) {
    const analysis = await loadAnalysisResult(analysisId);
    if (!analysis) throw new Error("A análise expirou ou não foi encontrada. Execute uma nova análise.");
    if (normalizeAccountKey(analysis.accountKey) !== normalizeAccountKey(accountKey)) {
      throw new Error("A análise pertence a outra conta Mercado Livre.");
    }

    const ids = new Set((Array.isArray(opportunityIds) ? opportunityIds : []).map((value) => String(value || "").trim()).filter(Boolean));
    const opportunities = (Array.isArray(analysis.opportunities) ? analysis.opportunities : []).filter((opp) => ids.has(String(opp?.id || "")));
    if (!opportunities.length) throw new Error("Selecione pelo menos uma oportunidade segura para otimizar.");
    if (opportunities.length !== ids.size) throw new Error("Uma ou mais oportunidades selecionadas não pertencem à análise atual.");

    const q = ensureQueue();
    const id = makeJobId("opt");
    const opId = operationId();
    await q.add(
      {
        kind: "optimize",
        analysisId,
        opportunities,
        mlCreds: { ...(mlCreds || {}) },
        accountKey: normalizeAccountKey(accountKey),
        accountLabel: accountLabel || accountKey || null,
        auditContext,
        operationId: opId,
        createdAt: Date.now(),
      },
      {
        jobId: id,
        removeOnComplete: 100,
        removeOnFail: false,
      },
    );
    return { id, operationId: opId, total: opportunities.length };
  },

  async listRecent(limit = 25, { accountKey = null } = {}) {
    const q = ensureQueue();
    const jobs = await q.getJobs(
      ["active", "waiting", "delayed", "failed", "completed"],
      0,
      Math.max(0, limit * 3 - 1),
      false,
    );
    // getState() é uma ida ao Redis. Fazê-la em série fazia o endpoint global
    // /api/promocoes/jobs levar dezenas de segundos quando havia histórico.
    const scoped = jobs
      .filter((job) => job.data?.kind === "optimize" && canAccessData(job.data || {}, accountKey))
      .slice(0, Math.max(1, Number(limit || 25)));
    return Promise.all(
      scoped.map(async (job) => {
        const state = await job.getState().catch(() => "unknown");
        const meta = job.data?.__meta || {};
        const metrics = resolveJobMetrics(job, state);
        const stateLabel = meta.stateLabel || state;
        return {
          id: String(job.id),
          title: "Otimizando SMART por rebate",
          label: "Otimizando SMART por rebate",
          state: stateLabel,
          lifecycle_status:
            meta.safetyPaused === true
              ? "paused_safety"
              : stateLabel === "cancelado"
                ? "canceled"
                : state === "active"
                  ? "processing"
                  : state === "waiting" || state === "delayed"
                    ? "queued"
                    : state === "completed"
                      ? metrics.failed > 0
                        ? "partial"
                        : "completed"
                      : state === "failed"
                        ? "failed"
                        : null,
          processed: metrics.processed,
          total: metrics.total,
          success: metrics.success,
          failed: metrics.failed,
          skipped: metrics.skipped,
          progress: metrics.progress,
          completed: state === "completed" && stateLabel !== "cancelado",
          safety_paused: meta.safetyPaused === true,
          resumable: false,
          cancel_requested: job.data?.cancelRequested === true || meta.cancelRequested === true,
          can_cancel: ["active", "waiting", "delayed"].includes(state),
          account: {
            key: job.data?.accountKey || null,
            label: job.data?.accountLabel || job.data?.accountKey || null,
          },
          accountKey: job.data?.accountKey || null,
          accountLabel: job.data?.accountLabel || job.data?.accountKey || null,
          operation_id: job.data?.operationId || null,
          pending: Math.max(0, metrics.total - metrics.processed),
          updated_at: new Date(
            meta.updatedAt || job.finishedOn || job.processedOn || job.timestamp || Date.now(),
          ).toISOString(),
          full_report_url: `/api/promocoes/jobs/${encodeURIComponent(`smart:${job.id}`)}/download.xlsx`,
        };
      }),
    );
  },

  async jobDetail(id, { accountKey = null } = {}) {
    const q = ensureQueue();
    const job = await q.getJob(id).catch(() => null);
    if (!job || job.data?.kind !== "optimize" || !canAccessData(job.data || {}, accountKey)) return null;
    const state = await job.getState().catch(() => "unknown");
    const meta = job.data?.__meta || {};
    const metrics = resolveJobMetrics(job, state);
    return {
      id: String(job.id),
      title: "Otimizando SMART por rebate",
      state: meta.stateLabel || state,
      lifecycle_status: meta.safetyPaused === true ? "paused_safety" : state === "active" ? "processing" : state === "completed" ? (metrics.failed > 0 ? "partial" : "completed") : state === "failed" ? "failed" : "queued",
      ...metrics,
      skipped: metrics.skipped,
      safety_paused: meta.safetyPaused === true,
      resumable: false,
      cancel_requested: job.data?.cancelRequested === true || meta.cancelRequested === true,
      can_cancel: ["active", "waiting", "delayed"].includes(state),
      account: { key: job.data?.accountKey || null, label: job.data?.accountLabel || job.data?.accountKey || null },
      accountKey: job.data?.accountKey || null,
      accountLabel: job.data?.accountLabel || job.data?.accountKey || null,
      operation_id: job.data?.operationId || null,
      pending: Math.max(0, metrics.total - metrics.processed),
      full_report_url: `/api/promocoes/jobs/${encodeURIComponent(`smart:${job.id}`)}/download.xlsx`,
      updated_at: new Date(meta.updatedAt || job.finishedOn || job.processedOn || job.timestamp || Date.now()).toISOString(),
      data: { results: Array.isArray(meta.results) ? meta.results : [] },
      result: job.returnvalue || null,
    };
  },

  async cancelJob(id, { accountKey = null } = {}) {
    const q = ensureQueue();
    const job = await q.getJob(id).catch(() => null);
    if (!job || job.data?.kind !== "optimize" || !canAccessData(job.data || {}, accountKey)) return null;
    const state = await job.getState().catch(() => "unknown");
    const meta = job.data?.__meta || {};
    const metrics = resolveJobMetrics(job, state);

    if (["completed", "failed"].includes(state)) {
      return { ok: false, status: meta.stateLabel || state, error: "O job já está encerrado.", ...metrics };
    }

    job.data.cancelRequested = true;
    job.data.__meta = { ...meta, cancelRequested: true, stateLabel: "cancelando", updatedAt: Date.now() };
    await job.update(job.data);
    return { ok: true, status: "cancelando", ...metrics };
  },

  async getJobXlsx(id, { accountKey = null } = {}) {
    const q = ensureQueue();
    const job = await q.getJob(id).catch(() => null);
    if (!job || job.data?.kind !== "optimize" || !canAccessData(job.data || {}, accountKey)) return null;
    return {
      filename: `otimizacao_smart_${id}.xlsx`,
      buffer: await buildWorkbook(job),
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    };
  },

  _test: {
    normalizeStatus,
    isParticipatingStatus,
    expandSmartRow,
    intervalsOverlap,
    coversInterval,
    buyerConditionEquivalent,
    statusCompatibleForReplacement,
    rebateImprovement,
    safeReplacementCheck,
    analyzeSmartRecords,
    readBullJobProgress,
  },
};
