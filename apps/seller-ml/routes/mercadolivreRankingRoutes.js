"use strict";

const express = require("express");
const db = require("../db/db");
const TokenService = require("../services/tokenService");
const { decryptToken } = require("../services/tokenCrypto");
const {
  getUserId,
  isAdminUserFresh,
  userCompanyContext,
} = require("../services/companyAccessService");

const router = express.Router();

const ML_API = "https://api.mercadolibre.com";

const fetchRef = (...args) => fetch(...args);
const SNAPSHOT_PRESET_LIMITS = [30, 50, 100];
const DEFAULT_SNAPSHOT_LIMIT = 30;
const LIVE_LIMIT_MIN = 10;
const LIVE_LIMIT_MAX = 100;
const SNAPSHOT_TYPES = ["faturamento", "quantidade"];
let rankingSettingsTableReady = false;
let rankingSettingsTableInitPromise = null;

async function ensureRankingSettingsTable() {
  if (rankingSettingsTableReady) return;
  if (!rankingSettingsTableInitPromise) {
    rankingSettingsTableInitPromise = (async () => {
      await db.query(
        `create table if not exists ml_ranking_anuncios_settings (
          id bigserial primary key,
          meli_conta_id bigint not null references meli_contas (id) on delete cascade,
          persist_enabled boolean not null default false,
          snapshot_limit integer not null default 30,
          configured_by_user_id bigint references usuarios (id) on delete set null,
          configured_at timestamptz,
          criado_em timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          constraint ml_ranking_anuncios_settings_snapshot_limit_check
            check (snapshot_limit in (30, 50, 100))
        )`,
      );
      await db.query(
        `create unique index if not exists ux_ml_ranking_anuncios_settings_conta
           on ml_ranking_anuncios_settings (meli_conta_id)`,
      );
      rankingSettingsTableReady = true;
    })().catch((error) => {
      rankingSettingsTableInitPromise = null;
      throw error;
    });
  }
  await rankingSettingsTableInitPromise;
}

function getTokenFromRequest(req, res) {
  const token = req?.ml?.accessToken || res?.locals?.accessToken || req?.access_token || null;
  if (!token) {
    throw new Error("Token ML ausente no request.");
  }
  return token;
}

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

function startOfDay(ymdValue) {
  return `${ymdValue}T00:00:00.000-00:00`;
}

function endOfDay(ymdValue) {
  return `${ymdValue}T23:59:59.999-00:00`;
}

function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function addMonths(date, months) {
  const d = new Date(date.getTime());
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

function startOfMonth(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function endOfMonth(date) {
  return addDays(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)), -1);
}

function startOfQuarter(date) {
  const month = Math.floor(date.getUTCMonth() / 3) * 3;
  return new Date(Date.UTC(date.getUTCFullYear(), month, 1));
}

function endOfQuarter(date) {
  const start = startOfQuarter(date);
  return addDays(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 3, 1)), -1);
}

function clampRange(range) {
  const today = new Date();
  const maxPast = addMonths(today, -6);
  const from = new Date(`${range.from}T00:00:00.000Z`);
  const to = new Date(`${range.to}T00:00:00.000Z`);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) {
    throw new Error("Datas invalidas.");
  }
  if (from < maxPast) {
    throw new Error("A data personalizada permite consultar no maximo 6 meses para tras.");
  }
  if (from > to) {
    throw new Error("Data inicial maior que data final.");
  }
  return { from: ymd(from), to: ymd(to) };
}

function resolveMainRange(query) {
  const today = new Date();
  const period = String(query.periodo || "mes_atual").toLowerCase();

  if (period === "custom" || period === "personalizado" || period === "data_personalizada") {
    if (!query.dataInicio || !query.dataFim) {
      throw new Error("dataInicio e dataFim sao obrigatorios para periodo personalizado.");
    }
    return clampRange({ from: String(query.dataInicio), to: String(query.dataFim) });
  }

  if (period === "7d" || period === "ultimos_7_dias") {
    return { from: ymd(addDays(today, -6)), to: ymd(today) };
  }
  if (period === "30d" || period === "ultimos_30_dias") {
    return { from: ymd(addDays(today, -29)), to: ymd(today) };
  }
  if (period === "tri" || period === "trimestre") {
    return { from: ymd(startOfQuarter(today)), to: ymd(today < endOfQuarter(today) ? today : endOfQuarter(today)) };
  }
  if (period === "sem" || period === "semestre") {
    return { from: ymd(addMonths(today, -6)), to: ymd(today) };
  }

  return { from: ymd(startOfMonth(today)), to: ymd(today) };
}

function resolveCompareRange(query, mainRange) {
  const mode = String(query.compararCom || "periodo_anterior").toLowerCase();
  const mainFrom = new Date(`${mainRange.from}T00:00:00.000Z`);
  const mainTo = new Date(`${mainRange.to}T00:00:00.000Z`);
  const days = Math.max(1, Math.round((mainTo - mainFrom) / 86400000) + 1);

  if (mode === "custom" || mode === "personalizado" || mode === "data_personalizada") {
    if (!query.dataComparacaoInicio || !query.dataComparacaoFim) {
      throw new Error("Datas de comparacao sao obrigatorias para comparacao personalizada.");
    }
    return clampRange({ from: String(query.dataComparacaoInicio), to: String(query.dataComparacaoFim) });
  }

  if (mode === "ultimos_7_dias" || mode === "7d") {
    const today = new Date();
    return { from: ymd(addDays(today, -6)), to: ymd(today) };
  }
  if (mode === "mes_anterior" || mode === "previous_month") {
    const prev = addMonths(startOfMonth(mainFrom), -1);
    return { from: ymd(startOfMonth(prev)), to: ymd(endOfMonth(prev)) };
  }
  if (mode === "trimestre_anterior" || mode === "triant") {
    const currentQuarter = startOfQuarter(mainFrom);
    const prevQuarter = addMonths(currentQuarter, -3);
    return { from: ymd(prevQuarter), to: ymd(endOfQuarter(prevQuarter)) };
  }
  if (mode === "semestre_anterior" || mode === "semant") {
    const to = addDays(mainFrom, -1);
    return { from: ymd(addMonths(to, -6)), to: ymd(to) };
  }

  return { from: ymd(addDays(mainFrom, -days)), to: ymd(addDays(mainFrom, -1)) };
}

function parseBoolFilter(raw) {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value || value === "todos" || value === "all") return null;
  if (["1", "true", "sim", "yes", "only"].includes(value)) return true;
  if (["0", "false", "nao", "no", "skip"].includes(value)) return false;
  return null;
}

function parseBool(value, fallback = false) {
  if (value === true || value === false) return value;
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "sim", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "nao", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function normalizeSnapshotLimit(raw, fallback = DEFAULT_SNAPSHOT_LIMIT) {
  const value = Number(raw);
  return SNAPSHOT_PRESET_LIMITS.includes(value) ? value : fallback;
}

function clampLiveLimit(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return LIVE_LIMIT_MIN;
  return Math.max(LIVE_LIMIT_MIN, Math.min(LIVE_LIMIT_MAX, value));
}

function currentMeliContaId(res) {
  const id = Number(res?.locals?.mlCreds?.meli_conta_id || 0);
  return Number.isFinite(id) && id > 0 ? id : 0;
}

function snapshotModeLabel(limit) {
  const resolved = normalizeSnapshotLimit(limit, DEFAULT_SNAPSHOT_LIMIT);
  if (resolved === 100) return "Detalhado (100)";
  if (resolved === 50) return "Balanceado (50)";
  return "Leve (30)";
}

async function canManageRankingConfig(req, res) {
  if (await isAdminUserFresh(req)) return true;
  const reqRole = String(req?.user?.papel || req?.user?.role || req?.user?.nivel || "").trim().toLowerCase();
  if (["owner", "admin", "administrador", "admin_master"].includes(reqRole)) return true;
  const userId = getUserId(req);
  if (!userId) return false;
  const empresaId = Number(res?.locals?.empresaId || res?.locals?.mlCreds?.empresa_id || 0);
  const context = await userCompanyContext(
    userId,
    Number.isFinite(empresaId) && empresaId > 0 ? empresaId : null,
  );
  const role = String(context?.papel || "").trim().toLowerCase();
  return role === "owner" || role === "admin" || role === "administrador";
}

async function getSellerId(token) {
  const response = await fetchRef(`${ML_API}/users/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`users/me ${response.status}`);
  const json = await response.json();
  return json.id;
}

async function* iterOrders({ token, sellerId, from, to }) {
  let offset = 0;
  const limit = 50;

  for (;;) {
    const url = new URL(`${ML_API}/orders/search`);
    url.searchParams.set("seller", sellerId);
    url.searchParams.set("order.status", "paid");
    url.searchParams.set("order.date_created.from", startOfDay(from));
    url.searchParams.set("order.date_created.to", endOfDay(to));
    url.searchParams.set("sort", "date_desc");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));

    let json = null;
    for (let attempts = 1; attempts <= 5; attempts += 1) {
      const response = await fetchRef(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.status === 429 && attempts < 5) {
        await new Promise((resolve) => setTimeout(resolve, attempts * 450));
        continue;
      }
      if (!response.ok) throw new Error(`orders/search ${response.status}`);
      json = await response.json();
      break;
    }

    const results = Array.isArray(json?.results) ? json.results : [];
    for (const order of results) yield order;

    const total = Number(json?.paging?.total || 0);
    offset += limit;
    if (!results.length || offset >= total) return;
  }
}

function variationLabel(orderItem) {
  const attrs = orderItem?.item?.variation_attributes;
  if (!Array.isArray(attrs) || !attrs.length) return "";
  return attrs
    .map((attr) => attr?.value_name || attr?.value_id || "")
    .filter(Boolean)
    .join(" / ");
}

async function aggregateOrders({ token, sellerId, range }) {
  const map = new Map();

  for await (const order of iterOrders({ token, sellerId, from: range.from, to: range.to })) {
    const full = order?.shipping?.logistic_type === "fulfillment";
    for (const orderItem of order.order_items || []) {
      const mlb = String(orderItem?.item?.id || "").toUpperCase();
      if (!mlb) continue;
      const units = Number(orderItem?.quantity || 0);
      if (units <= 0) continue;
      const unitPrice = Number(orderItem?.unit_price || 0);
      const revenue = unitPrice * units;
      const row = map.get(mlb) || {
        mlb,
        title: orderItem?.item?.title || mlb,
        variation: variationLabel(orderItem),
        gross_sales: 0,
        units_sold: 0,
        weighted_price: 0,
        is_full: false,
      };
      row.gross_sales += revenue;
      row.units_sold += units;
      row.weighted_price += unitPrice * units;
      row.is_full = row.is_full || full;
      if (!row.variation) row.variation = variationLabel(orderItem);
      map.set(mlb, row);
    }
  }

  return Array.from(map.values()).map((row) => ({
    ...row,
    gross_sales_cents: Math.round(row.gross_sales * 100),
    average_price_cents: row.units_sold > 0 ? Math.round((row.weighted_price / row.units_sold) * 100) : 0,
    average_ticket_cents: row.units_sold > 0 ? Math.round((row.gross_sales / row.units_sold) * 100) : 0,
  }));
}

async function fetchJson(url, headers, retries = 2) {
  let lastError;
  for (let index = 0; index < retries; index += 1) {
    const response = await fetchRef(url, { headers });
    const text = await response.text();
    if (response.status === 429 || response.status >= 500) {
      await new Promise((resolve) => setTimeout(resolve, 350 * (index + 1)));
      continue;
    }
    if (!response.ok) {
      lastError = new Error(`GET ${url} -> ${response.status}`);
      break;
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      lastError = error;
      break;
    }
  }
  if (lastError) throw lastError;
  return null;
}

async function enrichItems(token, rows) {
  const ids = Array.from(new Set(rows.map((row) => row.mlb).filter(Boolean)));
  const out = new Map();
  const headers = { Authorization: `Bearer ${token}` };
  const attrs = [
    "id",
    "title",
    "thumbnail",
    "secure_thumbnail",
    "price",
    "category_id",
    "listing_type_id",
    "catalog_listing",
    "shipping",
    "tags",
    "video_id",
  ].join(",");

  for (let index = 0; index < ids.length; index += 20) {
    const chunk = ids.slice(index, index + 20);
    const url = `${ML_API}/items?ids=${encodeURIComponent(chunk.join(","))}&attributes=${encodeURIComponent(attrs)}`;
    try {
      const payload = await fetchJson(url, headers, 2);
      for (const item of Array.isArray(payload) ? payload : []) {
        const body = item?.body || {};
        if (!body?.id) continue;
        out.set(String(body.id).toUpperCase(), {
          title: body.title || String(body.id),
          thumbnail: body.secure_thumbnail || body.thumbnail || "",
          price_cents: Math.round(Number(body.price || 0) * 100),
          category_id: body.category_id || "",
          listing_type_id: body.listing_type_id || "",
          catalog: Boolean(body.catalog_listing),
          free_shipping: Boolean(body?.shipping?.free_shipping),
          clips: Boolean(body.video_id || (Array.isArray(body.tags) && body.tags.some((tag) => String(tag).toLowerCase().includes("video")))),
        });
      }
    } catch (error) {
      console.warn("[Ranking] Falha ao enriquecer items:", error?.message || error);
    }
  }

  return out;
}

async function fetchPromoMap(token, ids) {
  const out = new Map();
  const headers = { Authorization: `Bearer ${token}` };
  for (const id of ids) {
    try {
      const payload = await fetchJson(`${ML_API}/items/${encodeURIComponent(id)}/prices`, headers, 2);
      const buckets = [];
      if (Array.isArray(payload?.prices?.prices)) buckets.push(...payload.prices.prices);
      if (Array.isArray(payload?.prices)) buckets.push(...payload.prices);
      if (Array.isArray(payload?.promotions)) buckets.push(...payload.promotions);
      const now = Date.now();
      const active = buckets.some((price) => {
        const type = String(price?.type || price?.status || "").toLowerCase();
        const from = price?.conditions?.start_time || price?.date_from || price?.start_time;
        const to = price?.conditions?.end_time || price?.date_to || price?.end_time;
        const inWindow = (!from || now >= new Date(from).getTime()) && (!to || now <= new Date(to).getTime());
        return inWindow && (type.includes("promotion") || type === "active" || Number(price?.regular_amount || 0) > Number(price?.amount || price?.price || 0));
      });
      out.set(id, active);
    } catch {
      out.set(id, false);
    }
  }
  return out;
}

async function getAdvertisersForToken(token) {
  try {
    const payload = await fetchJson(`${ML_API}/advertising/advertisers?product_id=PADS`, {
      Authorization: `Bearer ${token}`,
      "Api-Version": "1",
    }, 2);
    const map = new Map();
    for (const advertiser of payload?.advertisers || []) {
      if (!map.has(advertiser.site_id)) map.set(advertiser.site_id, advertiser.advertiser_id);
    }
    return map;
  } catch {
    return new Map();
  }
}

async function fetchAdsMap(token, ids, range) {
  const out = new Map(ids.map((id) => [id, false]));
  const advertisers = await getAdvertisersForToken(token);
  const bySite = new Map();
  ids.forEach((id) => {
    const site = String(id).slice(0, 3);
    if (!bySite.has(site)) bySite.set(site, []);
    bySite.get(site).push(id);
  });

  for (const [site, itemIds] of bySite.entries()) {
    const advertiserId = advertisers.get(site);
    if (!advertiserId) continue;
    const qs = new URLSearchParams({
      limit: String(itemIds.length),
      offset: "0",
      date_from: range.from,
      date_to: range.to,
      metrics: "clicks,prints,cost,total_amount",
      metrics_summary: "true",
      aggregation: "sum",
    });
    qs.set("filters[item_id]", itemIds.join(","));
    qs.set("filters[channel]", "marketplace");
    const url = `${ML_API}/advertising/${site}/advertisers/${advertiserId}/product_ads/ads/search?${qs.toString()}`;
    try {
      const payload = await fetchJson(url, { Authorization: `Bearer ${token}`, "api-version": "2" }, 2);
      for (const item of payload?.results || []) {
        const id = String(item?.item_id || "").toUpperCase();
        const status = String(item?.status || "").toLowerCase();
        const metrics = item?.metrics || {};
        const active = status === "active" || Number(metrics.clicks || 0) + Number(metrics.prints || 0) + Number(metrics.cost || 0) > 0;
        if (id) out.set(id, active);
      }
    } catch {
      // Product Ads can be unavailable for the account; keep badge off.
    }
  }
  return out;
}

function deltaPercent(current, previous) {
  if (!previous) return current ? null : 0;
  return ((current - previous) / previous) * 100;
}

function performanceStatus(row) {
  if (!row.previous_position) return "Novo no ranking";
  if (row.exited) return "Saiu do ranking";
  const movement = row.previous_position - row.position;
  const revenueDelta = row.gross_sales_delta_percent;
  if (movement >= 2 && revenueDelta > 10) return "Crescendo";
  if (movement <= -3 && revenueDelta < -10) return "Perdendo forca";
  if (revenueDelta < -5 || movement <= -2) return "Atencao";
  if (Math.abs(movement) <= 1 && Math.abs(revenueDelta || 0) < 10) return "Estavel";
  return "Crescendo";
}

function applyPositions(rows, ordenarPor) {
  const metric = ordenarPor === "quantidade" || ordenarPor === "qtd" ? "units_sold" : "gross_sales_cents";
  return rows
    .slice()
    .sort((a, b) => (b[metric] || 0) - (a[metric] || 0))
    .map((row, index) => ({ ...row, position: index + 1 }));
}

function applyFilters(rows, filters) {
  return rows.filter((row) => {
    if (filters.marca && !String(row.title || "").toLowerCase().includes(filters.marca)) return false;
    if (filters.categoria && filters.categoria !== "todas" && String(row.category_id || "").toLowerCase() !== filters.categoria) return false;
    if (filters.tipoAnuncio && filters.tipoAnuncio !== "todos" && String(row.listing_type_id || "").toLowerCase() !== filters.tipoAnuncio) return false;
    if (filters.catalogo !== null && Boolean(row.badges?.catalog) !== filters.catalogo) return false;
    if (filters.clips !== null && Boolean(row.badges?.clips) !== filters.clips) return false;
    if (filters.ads !== null && Boolean(row.badges?.ads) !== filters.ads) return false;
    if (filters.full !== null && Boolean(row.badges?.full) !== filters.full) return false;
    return true;
  });
}

function buildInsights({ currentTop, previousTop, ranking, exited, totalRevenueCents, limit }) {
  const insights = [];
  const entered = ranking.filter((row) => !row.previous_position);
  const climbed = ranking.filter((row) => row.position_movement > 0).sort((a, b) => b.position_movement - a.position_movement);
  const dropped = ranking.filter((row) => row.position_movement < 0).sort((a, b) => a.position_movement - b.position_movement);
  const growingRevenue = ranking.filter((row) => Number.isFinite(row.gross_sales_delta_percent)).sort((a, b) => b.gross_sales_delta_percent - a.gross_sales_delta_percent);
  const fallingRevenue = ranking.filter((row) => Number.isFinite(row.gross_sales_delta_percent)).sort((a, b) => a.gross_sales_delta_percent - b.gross_sales_delta_percent);
  const losing = ranking.filter((row) => ["Atencao", "Perdendo forca"].includes(row.performance_status));
  const top5Share = totalRevenueCents > 0
    ? ranking.slice(0, 5).reduce((sum, row) => sum + row.gross_sales_cents, 0) / totalRevenueCents
    : 0;
  const topShare = totalRevenueCents > 0
    ? ranking.reduce((sum, row) => sum + row.gross_sales_cents, 0) / totalRevenueCents
    : 0;

  if (climbed[0]) {
    insights.push({
      type: "growth",
      severity: "success",
      title: "Maior alta",
      message: `${climbed[0].mlb} subiu ${climbed[0].position_movement} posicoes e assumiu o #${climbed[0].position} do ranking.`,
    });
  }
  if (dropped[0]) {
    insights.push({
      type: "drop",
      severity: "danger",
      title: "Maior queda",
      message: `${dropped[0].mlb} caiu ${Math.abs(dropped[0].position_movement)} posicoes e variou ${Number(dropped[0].gross_sales_delta_percent || 0).toFixed(1)}% em faturamento.`,
    });
  }
  if (entered.length) {
    insights.push({
      type: "entered",
      severity: "info",
      title: "Entrou no ranking",
      message: `${entered.length} anuncio${entered.length > 1 ? "s entraram" : " entrou"} no Top ${limit} neste periodo.`,
    });
  }
  if (exited.length) {
    insights.push({
      type: "exited",
      severity: "danger",
      title: "Saiu do ranking",
      message: `${exited.length} anuncio${exited.length > 1 ? "s sairam" : " saiu"} do Top ${limit}. ${exited[0].mlb} era #${exited[0].previous_position}.`,
    });
  }
  if (losing[0]) {
    insights.push({
      type: "attention",
      severity: "warning",
      title: "Perdendo performance",
      message: `${losing[0].mlb} pede atencao: status ${losing[0].performance_status} e ${Number(losing[0].gross_sales_delta_percent || 0).toFixed(1)}% em faturamento.`,
    });
  }
  if (growingRevenue[0]) {
    insights.push({
      type: "revenue_up",
      severity: "success",
      title: "Maior crescimento de faturamento",
      message: `${growingRevenue[0].mlb} cresceu ${Number(growingRevenue[0].gross_sales_delta_percent || 0).toFixed(1)}% em vendas brutas.`,
    });
  }
  if (fallingRevenue[0]) {
    insights.push({
      type: "revenue_down",
      severity: "danger",
      title: "Maior queda de faturamento",
      message: `${fallingRevenue[0].mlb} reduziu ${Math.abs(Number(fallingRevenue[0].gross_sales_delta_percent || 0)).toFixed(1)}% em vendas brutas.`,
    });
  }
  insights.push({
    type: "concentration",
    severity: topShare >= 0.65 ? "warning" : "info",
    title: `Concentracao Top ${limit}`,
    message: `Top ${limit} anuncios representam ${(topShare * 100).toFixed(1)}% do faturamento total. Top 5 concentra ${(top5Share * 100).toFixed(1)}%.`,
  });

  return insights;
}

function normalizeRankingType(raw) {
  const value = String(raw || "faturamento").trim().toLowerCase();
  return value === "quantidade" || value === "qtd" ? "quantidade" : "faturamento";
}

async function getRankingConfig(meliContaId) {
  await ensureRankingSettingsTable();
  if (!Number.isFinite(Number(meliContaId)) || Number(meliContaId) <= 0) {
    return {
      persist_enabled: false,
      snapshot_limit: DEFAULT_SNAPSHOT_LIMIT,
    };
  }
  const { rows } = await db.query(
    `select persist_enabled, snapshot_limit, configured_at, updated_at
       from ml_ranking_anuncios_settings
      where meli_conta_id = $1
      limit 1`,
    [Number(meliContaId)],
  );
  const row = rows?.[0];
  if (!row) {
    return {
      persist_enabled: false,
      snapshot_limit: DEFAULT_SNAPSHOT_LIMIT,
    };
  }
  return {
    persist_enabled: parseBool(row.persist_enabled, false),
    snapshot_limit: normalizeSnapshotLimit(row.snapshot_limit, DEFAULT_SNAPSHOT_LIMIT),
    configured_at: row.configured_at || null,
    updated_at: row.updated_at || null,
  };
}

async function upsertRankingConfig({ meliContaId, persistEnabled, snapshotLimit, userId = null }) {
  await ensureRankingSettingsTable();
  const resolvedPersist = parseBool(persistEnabled, false);
  const resolvedLimit = normalizeSnapshotLimit(snapshotLimit, DEFAULT_SNAPSHOT_LIMIT);
  const requesterId = Number.isFinite(Number(userId)) && Number(userId) > 0 ? Number(userId) : null;
  const { rows } = await db.query(
    `insert into ml_ranking_anuncios_settings
      (meli_conta_id, persist_enabled, snapshot_limit, configured_by_user_id, configured_at, updated_at)
     values ($1, $2, $3, $4, now(), now())
     on conflict (meli_conta_id)
     do update set
       persist_enabled = excluded.persist_enabled,
       snapshot_limit = excluded.snapshot_limit,
       configured_by_user_id = excluded.configured_by_user_id,
       configured_at = now(),
       updated_at = now()
     returning persist_enabled, snapshot_limit, configured_at, updated_at`,
    [Number(meliContaId), resolvedPersist, resolvedLimit, requesterId],
  );
  const row = rows?.[0] || {};
  return {
    persist_enabled: parseBool(row.persist_enabled, resolvedPersist),
    snapshot_limit: normalizeSnapshotLimit(row.snapshot_limit, resolvedLimit),
    configured_at: row.configured_at || null,
    updated_at: row.updated_at || null,
  };
}

function isFullMonthRange(range) {
  const from = new Date(`${range.from}T00:00:00.000Z`);
  const to = new Date(`${range.to}T00:00:00.000Z`);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) return false;
  return range.from === ymd(startOfMonth(from)) && range.to === ymd(endOfMonth(from));
}

function isClosedMonthRange(range) {
  if (!isFullMonthRange(range)) return false;
  const today = new Date();
  const monthStart = startOfMonth(new Date(`${range.from}T00:00:00.000Z`));
  const currentMonthStart = startOfMonth(today);
  return monthStart < currentMonthStart;
}

function parseMonthArg(value) {
  const parts = String(value || "").split("-").map((part) => Number(part));
  if (parts.length !== 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) {
    throw new Error(`Mes invalido: ${value}`);
  }
  const year = parts[0];
  const month = parts[1];
  if (month < 1 || month > 12) throw new Error(`Mes invalido: ${value}`);
  const start = new Date(Date.UTC(year, month - 1, 1));
  return { from: ymd(start), to: ymd(endOfMonth(start)), year, month };
}

function monthRange(year, month) {
  return parseMonthArg(`${year}-${String(month).padStart(2, "0")}`);
}

function previousClosedMonthRange(now = new Date()) {
  const previous = addMonths(startOfMonth(now), -1);
  return monthRange(previous.getUTCFullYear(), previous.getUTCMonth() + 1);
}

function snapshotRowToRanking(row) {
  const payload = row.payload_item && typeof row.payload_item === "object" ? row.payload_item : {};
  return {
    ...payload,
    mlb: String(row.mlb || payload.mlb || "").toUpperCase(),
    title: row.titulo || payload.title || row.mlb,
    thumbnail: row.imagem || payload.thumbnail || "",
    variation: row.variacao || payload.variation || "",
    category_id: row.categoria_id || payload.category_id || "",
    listing_type_id: row.listing_type_id || payload.listing_type_id || "",
    gross_sales_cents: Number(row.vendas_brutas_cents || payload.gross_sales_cents || 0),
    units_sold: Number(row.quantidade_vendas || payload.units_sold || 0),
    average_price_cents: Number(row.preco_medio_cents || payload.average_price_cents || 0),
    average_ticket_cents: Number(row.ticket_medio_cents || payload.average_ticket_cents || 0),
    revenue_share: Number(row.participacao_percentual || 0) / 100,
    position: Number(row.posicao || payload.position || 0),
    position_current: Number(row.posicao || payload.position || 0),
    badges: {
      catalog: Boolean(row.catalogo),
      clips: Boolean(row.clips),
      full: Boolean(row.is_full),
      promo: Boolean(row.promocao),
      ads: Boolean(row.ads_ativo),
      free_shipping: Boolean(row.frete_gratis),
      ...(payload.badges || {}),
    },
  };
}

async function loadSnapshotRows({ meliContaId, range, tipoRanking, preferredLimit = DEFAULT_SNAPSHOT_LIMIT }) {
  if (!meliContaId || !isClosedMonthRange(range)) return null;
  const safePreferred = clampLiveLimit(preferredLimit);
  const header = await db.query(
    `select id,
            limite,
            total_faturamento_cents,
            total_quantidade,
            payload_summary,
            payload_insights
       from ml_ranking_anuncios_snapshots
      where meli_conta_id = $1
        and periodo_inicio = $2::date
        and periodo_fim = $3::date
        and tipo_ranking = $4
      order by
        case when limite >= $5 then 0 else 1 end asc,
        case when limite >= $5 then limite end asc nulls last,
        case when limite < $5 then limite end desc nulls last
      limit 1`,
    [meliContaId, range.from, range.to, tipoRanking, safePreferred],
  );
  const snapshot = header.rows?.[0] || null;
  if (!snapshot) return null;

  const items = await db.query(
    `select *
       from ml_ranking_anuncios_snapshot_items
      where snapshot_id = $1
      order by posicao asc`,
    [snapshot.id],
  );

  return {
    snapshot,
    rows: (items.rows || []).map(snapshotRowToRanking),
  };
}

function buildRankingPayload({ reqQuery = {}, currentPositioned, previousPositioned, mainRange, compareRange, ordenarPor, limit, fromSnapshots = false, snapshotLimit = null }) {
  const previousById = new Map(previousPositioned.map((row) => [row.mlb, row]));
  const currentTop = currentPositioned.slice(0, limit);
  const previousTop = previousPositioned.slice(0, limit);
  const currentTopIds = new Set(currentTop.map((row) => row.mlb));

  const totalRevenueCents = currentPositioned.reduce((sum, row) => sum + Number(row.gross_sales_cents || 0), 0);
  const totalUnits = currentPositioned.reduce((sum, row) => sum + Number(row.units_sold || 0), 0);
  const previousTotalRevenueCents = previousPositioned.reduce((sum, row) => sum + Number(row.gross_sales_cents || 0), 0);
  const previousTotalUnits = previousPositioned.reduce((sum, row) => sum + Number(row.units_sold || 0), 0);

  const ranking = currentTop.map((row) => {
    const prev = previousById.get(row.mlb) || null;
    const previousShare = previousTotalRevenueCents > 0 && prev ? prev.gross_sales_cents / previousTotalRevenueCents : 0;
    const currentShare = totalRevenueCents > 0 ? row.gross_sales_cents / totalRevenueCents : 0;
    const output = {
      ...row,
      position_current: row.position,
      previous_position: prev?.position || null,
      position_movement: prev?.position ? prev.position - row.position : null,
      previous_gross_sales_cents: prev?.gross_sales_cents || 0,
      previous_units_sold: prev?.units_sold || 0,
      previous_average_ticket_cents: prev?.average_ticket_cents || 0,
      gross_sales_delta_percent: deltaPercent(row.gross_sales_cents, prev?.gross_sales_cents || 0),
      units_delta: row.units_sold - (prev?.units_sold || 0),
      units_delta_percent: deltaPercent(row.units_sold, prev?.units_sold || 0),
      revenue_share: currentShare,
      previous_revenue_share: previousShare,
      revenue_share_delta_pp: (currentShare - previousShare) * 100,
    };
    output.performance_status = performanceStatus(output);
    return output;
  });

  const exited = previousTop
    .filter((row) => !currentTopIds.has(row.mlb))
    .map((row) => ({
      ...row,
      exited: true,
      previous_position: row.position,
      position_current: null,
      performance_status: "Saiu do ranking",
    }));

  const bestUp = ranking.filter((row) => row.position_movement > 0).sort((a, b) => b.position_movement - a.position_movement)[0] || null;
  const bestDown = ranking.filter((row) => row.position_movement < 0).sort((a, b) => a.position_movement - b.position_movement)[0] || null;
  const topRevenueCents = ranking.reduce((sum, row) => sum + Number(row.gross_sales_cents || 0), 0);

  const summary = {
    gross_sales_total_cents: totalRevenueCents,
    gross_sales_delta_percent: deltaPercent(totalRevenueCents, previousTotalRevenueCents),
    units_total: totalUnits,
    units_delta_percent: deltaPercent(totalUnits, previousTotalUnits),
    average_ticket_cents: totalUnits > 0 ? Math.round(totalRevenueCents / totalUnits) : 0,
    average_ticket_delta_percent: deltaPercent(
      totalUnits > 0 ? totalRevenueCents / totalUnits : 0,
      previousTotalUnits > 0 ? previousTotalRevenueCents / previousTotalUnits : 0,
    ),
    top_share: totalRevenueCents > 0 ? topRevenueCents / totalRevenueCents : 0,
    best_up: bestUp,
    best_down: bestDown,
  };

  const insights = buildInsights({
    currentTop,
    previousTop,
    ranking,
    exited,
    totalRevenueCents,
    limit,
  });

  return {
    ok: true,
    meta: {
      periodo: reqQuery.periodo || "mes_atual",
      compararCom: reqQuery.compararCom || "periodo_anterior",
      ordenarPor,
      limite: limit,
      range: mainRange,
      compare_range: compareRange,
      source: fromSnapshots ? "snapshot" : "live",
      snapshot_limit: fromSnapshots ? snapshotLimit : null,
    },
    summary,
    ranking,
    insights,
    exited_ranking: exited,
  };
}

async function maybeBuildSnapshotPayload({ reqQuery, meliContaId, mainRange, compareRange, ordenarPor, limit, filters }) {
  const tipoRanking = normalizeRankingType(ordenarPor);
  const requestedLimit = clampLiveLimit(limit);
  const [currentSnapshot, previousSnapshot] = await Promise.all([
    loadSnapshotRows({ meliContaId, range: mainRange, tipoRanking, preferredLimit: requestedLimit }),
    loadSnapshotRows({ meliContaId, range: compareRange, tipoRanking, preferredLimit: requestedLimit }),
  ]);
  if (!currentSnapshot) return null;
  if (!previousSnapshot) return null;
  const currentSnapshotLimit = Number(currentSnapshot.snapshot?.limite || 0);
  const previousSnapshotLimit = Number(previousSnapshot.snapshot?.limite || 0);
  if (currentSnapshotLimit < requestedLimit || previousSnapshotLimit < requestedLimit) {
    return null;
  }

  const effectiveLimit = requestedLimit;
  const currentPositioned = applyPositions(applyFilters(currentSnapshot.rows, filters), tipoRanking).slice(0, effectiveLimit);
  const previousPositioned = applyPositions(applyFilters(previousSnapshot.rows, filters), tipoRanking).slice(0, effectiveLimit);
  return buildRankingPayload({
    reqQuery,
    currentPositioned,
    previousPositioned,
    mainRange,
    compareRange,
    ordenarPor: tipoRanking,
    limit: effectiveLimit,
    fromSnapshots: true,
    snapshotLimit: effectiveLimit,
  });
}

async function buildLiveRankingRows({ token, sellerId, range, ordenarPor }) {
  const aggregated = await aggregateOrders({ token, sellerId, range });
  const ids = aggregated.map((row) => row.mlb);
  const [itemMap, adsMap, promoMap] = await Promise.all([
    enrichItems(token, aggregated),
    fetchAdsMap(token, ids, range),
    fetchPromoMap(token, ids.slice(0, 60)),
  ]);

  const enriched = aggregated.map((row) => {
    const item = itemMap.get(row.mlb) || {};
    return {
      ...row,
      title: item.title || row.title,
      thumbnail: item.thumbnail || "",
      category_id: item.category_id || "",
      listing_type_id: item.listing_type_id || "",
      badges: {
        catalog: Boolean(item.catalog),
        clips: Boolean(item.clips),
        full: Boolean(row.is_full),
        promo: Boolean(promoMap.get(row.mlb)),
        ads: Boolean(adsMap.get(row.mlb)),
        free_shipping: Boolean(item.free_shipping),
      },
    };
  });

  return applyPositions(enriched, ordenarPor);
}

function snapshotSummary(rows) {
  const totalRevenueCents = rows.reduce((sum, row) => sum + Number(row.gross_sales_cents || 0), 0);
  const totalUnits = rows.reduce((sum, row) => sum + Number(row.units_sold || 0), 0);
  return {
    gross_sales_total_cents: totalRevenueCents,
    units_total: totalUnits,
    average_ticket_cents: totalUnits > 0 ? Math.round(totalRevenueCents / totalUnits) : 0,
    top_share: 1,
  };
}

async function saveSnapshot({ meliContaId, range, tipoRanking, positionedRows, snapshotLimit = DEFAULT_SNAPSHOT_LIMIT }) {
  const resolvedSnapshotLimit = normalizeSnapshotLimit(snapshotLimit, DEFAULT_SNAPSHOT_LIMIT);
  const rows = positionedRows.slice(0, resolvedSnapshotLimit);
  const summary = snapshotSummary(rows);
  const result = await db.query(
    `insert into ml_ranking_anuncios_snapshots
      (meli_conta_id, periodo_inicio, periodo_fim, tipo_ranking, limite,
       total_faturamento_cents, total_quantidade, payload_summary, payload_ranking, payload_insights,
       gerado_em, atualizado_em)
     values ($1, $2::date, $3::date, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, now(), now())
     on conflict (meli_conta_id, periodo_inicio, periodo_fim, tipo_ranking, limite)
     do update set
       total_faturamento_cents = excluded.total_faturamento_cents,
       total_quantidade = excluded.total_quantidade,
       payload_summary = excluded.payload_summary,
       payload_ranking = excluded.payload_ranking,
       payload_insights = excluded.payload_insights,
       gerado_em = now(),
       atualizado_em = now()
     returning id`,
    [
      meliContaId,
      range.from,
      range.to,
      tipoRanking,
      resolvedSnapshotLimit,
      summary.gross_sales_total_cents,
      summary.units_total,
      JSON.stringify(summary),
      JSON.stringify(rows),
      JSON.stringify([]),
    ],
  );
  const snapshotId = result.rows[0].id;

  await db.query(
    `delete from ml_ranking_anuncios_snapshot_items where snapshot_id = $1`,
    [snapshotId],
  );

  for (const row of rows) {
    const share = summary.gross_sales_total_cents > 0
      ? (Number(row.gross_sales_cents || 0) / summary.gross_sales_total_cents) * 100
      : 0;
    await db.query(
      `insert into ml_ranking_anuncios_snapshot_items
        (snapshot_id, meli_conta_id, periodo_inicio, periodo_fim, tipo_ranking,
         mlb, posicao, titulo, imagem, variacao, categoria_id, listing_type_id,
         catalogo, clips, is_full, promocao, ads_ativo, frete_gratis,
         vendas_brutas_cents, quantidade_vendas, preco_medio_cents, ticket_medio_cents,
         participacao_percentual, payload_item)
       values
        ($1, $2, $3::date, $4::date, $5,
         $6, $7, $8, $9, $10, $11, $12,
         $13, $14, $15, $16, $17, $18,
         $19, $20, $21, $22, $23, $24::jsonb)`,
      [
        snapshotId,
        meliContaId,
        range.from,
        range.to,
        tipoRanking,
        row.mlb,
        row.position,
        row.title,
        row.thumbnail,
        row.variation,
        row.category_id,
        row.listing_type_id,
        Boolean(row.badges?.catalog),
        Boolean(row.badges?.clips),
        Boolean(row.badges?.full),
        Boolean(row.badges?.promo),
        Boolean(row.badges?.ads),
        Boolean(row.badges?.free_shipping),
        Number(row.gross_sales_cents || 0),
        Number(row.units_sold || 0),
        Number(row.average_price_cents || 0),
        Number(row.average_ticket_cents || 0),
        share,
        JSON.stringify({ ...row, revenue_share: share / 100 }),
      ],
    );
  }

  return { snapshotId, count: rows.length, summary };
}

async function getActiveAccountsForSnapshots(accountIds = null) {
  await ensureRankingSettingsTable();
  const params = [];
  let where = "where coalesce(mc.status, 'ativa') = 'ativa' and coalesce(rs.persist_enabled, false) = true";
  if (Array.isArray(accountIds) && accountIds.length) {
    params.push(accountIds);
    where += ` and mc.id = any($${params.length}::bigint[])`;
  }
  const { rows } = await db.query(
    `select mc.id,
            mc.apelido,
            mc.meli_user_id,
            mc.site_id,
            mt.access_token,
            mt.access_expires_at,
            mt.refresh_token,
            mt.scope,
            coalesce(rs.persist_enabled, false) as ranking_persist_enabled,
            coalesce(rs.snapshot_limit, ${DEFAULT_SNAPSHOT_LIMIT}) as ranking_snapshot_limit
       from meli_contas mc
       join meli_tokens mt on mt.meli_conta_id = mc.id
       left join ml_ranking_anuncios_settings rs on rs.meli_conta_id = mc.id
       ${where}
      order by mc.id asc`,
    params,
  );
  return rows || [];
}

async function monthlySnapshotsComplete({ range, accountIds = null }) {
  const accounts = await getActiveAccountsForSnapshots(accountIds);
  if (!accounts.length) return true;
  const ids = accounts.map((account) => Number(account.id)).filter(Boolean);
  const { rows } = await db.query(
    `select meli_conta_id, limite, count(distinct tipo_ranking)::int as tipos
       from ml_ranking_anuncios_snapshots
      where periodo_inicio = $1::date
        and periodo_fim = $2::date
        and meli_conta_id = any($3::bigint[])
        and tipo_ranking = any($4::text[])
      group by meli_conta_id, limite`,
    [range.from, range.to, ids, SNAPSHOT_TYPES],
  );
  const done = new Set((rows || []).map((row) => `${Number(row.meli_conta_id)}:${Number(row.limite)}:${Number(row.tipos || 0)}`));
  return accounts.every((account) => {
    const limit = normalizeSnapshotLimit(account.ranking_snapshot_limit, DEFAULT_SNAPSHOT_LIMIT);
    for (const key of done) {
      const [accountIdText, limitText, tiposText] = key.split(":");
      const accountId = Number(accountIdText);
      const currentLimit = Number(limitText);
      const tipos = Number(tiposText);
      if (accountId === Number(account.id) && currentLimit === limit && tipos >= SNAPSHOT_TYPES.length) {
        return true;
      }
    }
    return false;
  });
}

async function getTokenForSnapshotAccount(account) {
  const creds = {
    app_id: process.env.ML_APP_ID || process.env.APP_ID || process.env.CLIENT_ID || null,
    client_secret: process.env.ML_CLIENT_SECRET || process.env.CLIENT_SECRET || null,
    redirect_uri: process.env.ML_REDIRECT_URI || process.env.REDIRECT_URI || null,
    meli_conta_id: account.id,
    account_key: String(account.id),
    meli_user_id: account.meli_user_id,
    site_id: account.site_id || "MLB",
    access_token: account.access_token ? decryptToken(account.access_token) : null,
    refresh_token: account.refresh_token ? decryptToken(account.refresh_token) : null,
    access_expires_at: account.access_expires_at || null,
    scope: account.scope || null,
  };
  return TokenService.renovarTokenSeNecessario(creds);
}

async function generateMonthlySnapshotsForAccount({ account, range }) {
  const token = await getTokenForSnapshotAccount(account);
  const sellerId = account.meli_user_id || await getSellerId(token);
  const baseRows = await buildLiveRankingRows({ token, sellerId, range, ordenarPor: "faturamento" });
  const snapshotLimit = normalizeSnapshotLimit(account.ranking_snapshot_limit, DEFAULT_SNAPSHOT_LIMIT);
  const results = [];

  for (const tipoRanking of SNAPSHOT_TYPES) {
    const positioned = applyPositions(baseRows, tipoRanking);
    const saved = await saveSnapshot({
      meliContaId: account.id,
      range,
      tipoRanking,
      positionedRows: positioned,
      snapshotLimit,
    });
    results.push({ tipoRanking, snapshot_limit: snapshotLimit, ...saved });
  }

  return results;
}

async function generateMonthlySnapshots({ range, accountIds = null }) {
  const accounts = await getActiveAccountsForSnapshots(accountIds);
  const output = [];

  for (const account of accounts) {
    try {
      const snapshots = await generateMonthlySnapshotsForAccount({ account, range });
      output.push({ meli_conta_id: account.id, ok: true, snapshots });
      console.log(`[Ranking] Snapshot ${range.from}..${range.to} conta=${account.id} ok`);
    } catch (error) {
      output.push({ meli_conta_id: account.id, ok: false, error: error?.message || String(error) });
      console.error(`[Ranking] Snapshot conta=${account.id} falhou:`, error?.message || error);
    }
  }

  return output;
}

async function backfillMonthlySnapshots({ year = new Date().getUTCFullYear(), months = [1, 2, 3, 4], accountIds = null } = {}) {
  const output = [];
  for (const month of months.map(Number).filter((value) => Number.isFinite(value))) {
    const range = monthRange(year, month);
    output.push({ month, range, accounts: await generateMonthlySnapshots({ range, accountIds }) });
  }
  return output;
}

async function withSnapshotAdvisoryLock(fn) {
  const lockKey = "ml_ranking_monthly_snapshots";
  const lockedResult = await db.query(`select pg_try_advisory_lock(hashtext($1)) as locked`, [lockKey]);
  if (!lockedResult.rows?.[0]?.locked) {
    return { skipped: true, reason: "lock_not_acquired" };
  }
  try {
    return await fn();
  } finally {
    await db.query(`select pg_advisory_unlock(hashtext($1))`, [lockKey]).catch(() => null);
  }
}

async function runDueMonthlySnapshots({ now = new Date(), accountIds = null } = {}) {
  const day = Number(new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
  }).format(now));
  if (day !== 1) return { skipped: true, reason: "not_first_day" };

  return withSnapshotAdvisoryLock(async () => {
    const range = previousClosedMonthRange(now);
    if (await monthlySnapshotsComplete({ range, accountIds })) {
      return { skipped: true, reason: "already_generated", range };
    }
    return {
      skipped: false,
      range,
      accounts: await generateMonthlySnapshots({ range, accountIds }),
    };
  });
}

router.get("/ranking-anuncios/config", async (req, res) => {
  try {
    const meliContaId = currentMeliContaId(res);
    if (!meliContaId) {
      return res.status(400).json({
        ok: false,
        error: "missing_meli_conta",
        detail: "Conta Mercado Livre nao identificada para esta sessao.",
      });
    }
    const config = await getRankingConfig(meliContaId);
    const canManage = await canManageRankingConfig(req, res);
    return res.json({
      ok: true,
      config,
      permissions: {
        can_manage: canManage,
      },
      micro_status: config.persist_enabled
        ? `Persistencia ativa: ${snapshotModeLabel(config.snapshot_limit)}`
        : "Persistencia inativa",
    });
  } catch (error) {
    console.error("[Ranking] Falha ao carregar config:", error);
    return res.status(500).json({
      ok: false,
      error: "ranking_config_load_failed",
      detail: error?.message || String(error),
    });
  }
});

router.put("/ranking-anuncios/config", async (req, res) => {
  try {
    const meliContaId = currentMeliContaId(res);
    if (!meliContaId) {
      return res.status(400).json({
        ok: false,
        error: "missing_meli_conta",
        detail: "Conta Mercado Livre nao identificada para esta sessao.",
      });
    }
    if (!(await canManageRankingConfig(req, res))) {
      return res.status(403).json({
        ok: false,
        error: "forbidden",
        detail: "Somente usuario admin pode alterar persistencia do ranking.",
      });
    }
    const config = await upsertRankingConfig({
      meliContaId,
      persistEnabled: req.body?.persist_enabled,
      snapshotLimit: req.body?.snapshot_limit,
      userId: req.user?.uid || null,
    });
    return res.json({
      ok: true,
      config,
      permissions: {
        can_manage: true,
      },
      micro_status: config.persist_enabled
        ? `Persistencia ativa: ${snapshotModeLabel(config.snapshot_limit)}`
        : "Persistencia inativa",
    });
  } catch (error) {
    console.error("[Ranking] Falha ao salvar config:", error);
    return res.status(500).json({
      ok: false,
      error: "ranking_config_save_failed",
      detail: error?.message || String(error),
    });
  }
});

router.get("/ranking-anuncios", async (req, res) => {
  try {
    const token = getTokenFromRequest(req, res);
    const mainRange = resolveMainRange(req.query);
    const compareRange = resolveCompareRange(req.query, mainRange);
    const ordenarPor = normalizeRankingType(req.query.ordenarPor);
    const limit = clampLiveLimit(req.query.limite || LIVE_LIMIT_MIN);
    const meliContaId = currentMeliContaId(res);
    const filters = {
      marca: String(req.query.marca || "").trim().toLowerCase(),
      categoria: String(req.query.categoria || "todas").trim().toLowerCase(),
      tipoAnuncio: String(req.query.tipoAnuncio || "todos").trim().toLowerCase(),
      catalogo: parseBoolFilter(req.query.catalogo),
      clips: parseBoolFilter(req.query.clips),
      ads: parseBoolFilter(req.query.ads),
      full: parseBoolFilter(req.query.full),
    };

    const snapshotPayload = await maybeBuildSnapshotPayload({
      reqQuery: req.query,
      meliContaId,
      mainRange,
      compareRange,
      ordenarPor,
      limit,
      filters,
    });
    if (snapshotPayload) return res.json(snapshotPayload);

    const sellerId = await getSellerId(token);
    const [currentAgg, previousAgg] = await Promise.all([
      aggregateOrders({ token, sellerId, range: mainRange }),
      aggregateOrders({ token, sellerId, range: compareRange }),
    ]);

    const allIds = Array.from(new Set(currentAgg.concat(previousAgg).map((row) => row.mlb)));
    const [itemMap, adsMap, promoMap] = await Promise.all([
      enrichItems(token, currentAgg.concat(previousAgg)),
      fetchAdsMap(token, allIds, mainRange),
      fetchPromoMap(token, allIds.slice(0, 60)),
    ]);

    function mergeEnrichment(row) {
      const item = itemMap.get(row.mlb) || {};
      return {
        ...row,
        title: item.title || row.title,
        thumbnail: item.thumbnail || "",
        category_id: item.category_id || "",
        listing_type_id: item.listing_type_id || "",
        badges: {
          catalog: Boolean(item.catalog),
          clips: Boolean(item.clips),
          full: Boolean(row.is_full),
          promo: Boolean(promoMap.get(row.mlb)),
          ads: Boolean(adsMap.get(row.mlb)),
          free_shipping: Boolean(item.free_shipping),
        },
      };
    }

    const currentEnriched = applyFilters(currentAgg.map(mergeEnrichment), filters);
    const previousEnriched = applyFilters(previousAgg.map(mergeEnrichment), filters);
    const currentPositioned = applyPositions(currentEnriched, ordenarPor);
    const previousSnapshot = await loadSnapshotRows({
      meliContaId,
      range: compareRange,
      tipoRanking: ordenarPor,
      preferredLimit: limit,
    });
    const previousSnapshotLimit = Number(previousSnapshot?.snapshot?.limite || 0);
    const previousPositioned = previousSnapshot && previousSnapshotLimit >= limit
      ? applyPositions(applyFilters(previousSnapshot.rows, filters), ordenarPor).slice(0, limit)
      : applyPositions(previousEnriched, ordenarPor);

    return res.json(buildRankingPayload({
      reqQuery: req.query,
      currentPositioned,
      previousPositioned,
      mainRange,
      compareRange,
      ordenarPor,
      limit,
      fromSnapshots: false,
    }));
  } catch (error) {
    console.error("[Ranking] Falha:", error);
    return res.status(500).json({
      ok: false,
      error: "ranking_anuncios_failed",
      detail: error?.message || String(error),
    });
  }
});

router.snapshots = {
  backfillMonthlySnapshots,
  generateMonthlySnapshots,
  runDueMonthlySnapshots,
};

module.exports = router;
