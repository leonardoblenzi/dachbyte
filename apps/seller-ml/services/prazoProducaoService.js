"use strict";

const TokenService = require("./tokenService");

const _fetch = typeof fetch !== "undefined" ? fetch : require("node-fetch");
const fetchRef = (...args) => _fetch(...args);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const list = Array.isArray(items) ? items : [];
  const limit = Math.max(1, Number(concurrency) || 1);
  const results = new Array(list.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < list.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(list[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, list.length) }, () => worker())
  );
  return results;
}

function normMlb(v) {
  const s = String(v || "")
    .trim()
    .toUpperCase();
  if (!/^MLB\d{6,}$/.test(s)) return null;
  return s;
}

function clampInt(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  return Math.max(min, Math.min(max, i));
}

async function prepareAuthState({ accessToken = null, mlCreds = {} } = {}) {
  const creds = { ...(mlCreds || {}) };
  if (accessToken) creds.access_token = accessToken;

  const state = {
    token: accessToken || creds.access_token || null,
    creds,
  };

  if (!state.token && Object.keys(creds).length) {
    const token = await TokenService.renovarTokenSeNecessario(creds);
    state.token = typeof token === "string" ? token : token?.access_token || null;
    if (state.token) state.creds.access_token = state.token;
  }

  if (!state.token) {
    throw new Error("Token ML ausente para atualizar prazo de producao.");
  }

  return state;
}

async function renewAuthState(state) {
  if (!state?.creds || !Object.keys(state.creds).length) return false;

  const renewed = await TokenService.renovarToken(state.creds);
  const nextToken = renewed?.access_token || state.token;
  if (!nextToken) return false;

  state.token = nextToken;
  state.creds.access_token = nextToken;
  if (renewed?.refresh_token) state.creds.refresh_token = renewed.refresh_token;
  if (renewed?.expires_in) {
    state.creds.access_expires_at = new Date(
      Date.now() + Number(renewed.expires_in) * 1000
    ).toISOString();
  }
  return true;
}

async function authFetch(state, url, init = {}) {
  const call = (token) =>
    fetchRef(url, {
      ...init,
      headers: {
        ...(init.headers || {}),
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

  let response = await call(state.token);
  if (response.status !== 401) return response;

  const renewed = await renewAuthState(state);
  if (!renewed) return response;

  return call(state.token);
}

async function mlGetItem({ authState, mlbId }) {
  const url = `https://api.mercadolibre.com/items/${mlbId}`;
  const r = await authFetch(authState, url, { method: "GET" });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg =
      data?.message || data?.error || `Falha ao buscar item (${r.status})`;
    const err = new Error(msg);
    err.statusCode = r.status;
    err.details = data;
    throw err;
  }
  return data;
}

async function getSellerIdFromAuth({ authState, mlCreds = null } = {}) {
  const fromCreds = Number(
    mlCreds?.meli_user_id ||
      authState?.creds?.meli_user_id ||
      authState?.creds?.user_id ||
      0
  );
  if (Number.isFinite(fromCreds) && fromCreds > 0) return String(fromCreds);

  const r = await authFetch(authState, "https://api.mercadolibre.com/users/me", {
    method: "GET",
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg =
      data?.message || data?.error || `Falha ao identificar vendedor (${r.status})`;
    const err = new Error(msg);
    err.statusCode = r.status;
    err.details = data;
    throw err;
  }

  const id = data?.id || data?.user_id || null;
  if (!id) throw new Error("Nao foi possivel identificar o seller_id da conta.");
  return String(id);
}

async function listActiveSellerItemIds({
  authState,
  mlCreds = null,
  maxItems = null,
  onProgress = null,
} = {}) {
  const sellerId = await getSellerIdFromAuth({ authState, mlCreds });
  const hasMax =
    maxItems !== null && maxItems !== undefined && String(maxItems).trim() !== "";
  const max = hasMax ? clampInt(maxItems, 1, 50000) : null;

  const collect = (target, source) => {
    for (const rawId of Array.isArray(source) ? source : []) {
      const id = normMlb(rawId);
      if (!id || target.seen.has(id)) continue;
      target.seen.add(id);
      target.ids.push(id);
      if (max && target.ids.length >= max) break;
    }
  };

  async function notifyProgress(payload) {
    if (typeof onProgress === "function") await onProgress(payload);
  }

  async function scanSearch() {
    const state = { ids: [], seen: new Set() };
    let scrollId = null;
    let page = 0;

    for (;;) {
      const url = new URL(
        `https://api.mercadolibre.com/users/${encodeURIComponent(sellerId)}/items/search`
      );
      url.searchParams.set("status", "active");
      url.searchParams.set("search_type", "scan");
      url.searchParams.set("limit", "50");
      if (scrollId) url.searchParams.set("scroll_id", scrollId);

      const r = await authFetch(authState, url.toString(), { method: "GET" });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg =
          data?.message || data?.error || `Falha ao listar anuncios ativos (${r.status})`;
        const err = new Error(msg);
        err.statusCode = r.status;
        err.details = data;
        throw err;
      }

      const results = Array.isArray(data?.results) ? data.results : [];
      collect(state, results);

      page += 1;
      await notifyProgress({
        sellerId,
        listed: state.ids.length,
        page,
        mode: "scan",
        finished: false,
      });

      scrollId = data?.scroll_id || null;
      if (!results.length || !scrollId) break;
      if (max && state.ids.length >= max) break;
      if (page >= 1000) break;
    }

    return state.ids;
  }

  async function offsetSearch() {
    const state = { ids: [], seen: new Set() };
    let page = 0;
    let totalAvailable = 0;
    const pageSize = 50;

    for (let offset = 0; ; offset += pageSize) {
      const url = new URL(
        `https://api.mercadolibre.com/users/${encodeURIComponent(sellerId)}/items/search`
      );
      url.searchParams.set("status", "active");
      url.searchParams.set("limit", String(pageSize));
      url.searchParams.set("offset", String(offset));

      const r = await authFetch(authState, url.toString(), { method: "GET" });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg =
          data?.message || data?.error || `Falha ao listar anuncios ativos (${r.status})`;
        const err = new Error(msg);
        err.statusCode = r.status;
        err.details = data;
        throw err;
      }

      const results = Array.isArray(data?.results) ? data.results : [];
      totalAvailable = Number(data?.paging?.total || totalAvailable || 0);
      collect(state, results);
      page += 1;

      await notifyProgress({
        sellerId,
        listed: state.ids.length,
        page,
        totalAvailable,
        mode: "offset",
        finished: false,
      });

      if (!results.length) break;
      if (max && state.ids.length >= max) break;
      if (totalAvailable && offset + results.length >= totalAvailable) break;
      if (!max && offset + pageSize >= 1000) break;
    }

    return {
      ids: state.ids,
      totalAvailable,
      truncated: !max && totalAvailable > state.ids.length,
    };
  }

  let ids = [];
  let fallback = null;
  let scanError = null;
  try {
    ids = await scanSearch();
  } catch (error) {
    scanError = error;
  }

  if (!ids.length) {
    fallback = await offsetSearch();
    ids = fallback.ids;
  }

  await notifyProgress({
    sellerId,
    listed: ids.length,
    mode: fallback ? "offset" : "scan",
    finished: true,
  });

  if (!ids.length && scanError) throw scanError;
  return {
    sellerId,
    ids,
    source: fallback ? "offset" : "scan",
    totalAvailable: fallback?.totalAvailable || null,
    truncated: fallback?.truncated === true,
    scanError: scanError?.message || null,
  };
}

function upsertManufacturingSaleTerm(saleTerms = [], days) {
  const next = Array.isArray(saleTerms) ? [...saleTerms] : [];
  const id = "MANUFACTURING_TIME";

  const payloadTerm = {
    id,
    value_name: `${days} dias`,
    value_struct: { number: days, unit: "dias" },
  };

  const idx = next.findIndex((t) => String(t?.id || "").toUpperCase() === id);
  if (idx >= 0) next[idx] = { ...next[idx], ...payloadTerm };
  else next.push(payloadTerm);

  return next;
}

async function mlPutSaleTerms({ authState, mlbId, saleTerms }) {
  const url = `https://api.mercadolibre.com/items/${mlbId}`;

  const r = await authFetch(authState, url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sale_terms: saleTerms }),
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg =
      data?.message || data?.error || `Falha ao atualizar item (${r.status})`;
    const err = new Error(msg);
    err.statusCode = r.status;
    err.details = data;
    throw err;
  }
  return data;
}

function findManufacturingTerm(saleTerms = []) {
  return (Array.isArray(saleTerms) ? saleTerms : []).find(
    (term) => String(term?.id || "").toUpperCase() === "MANUFACTURING_TIME"
  ) || null;
}

function normalizeManufacturingTerm(term) {
  if (!term) {
    return {
      has_prazo: false,
      days: null,
      unit: null,
      value_name: null,
      raw: null,
    };
  }

  const rawNumber = Number(term?.value_struct?.number);
  const days = Number.isFinite(rawNumber) ? rawNumber : null;
  const unit = term?.value_struct?.unit || null;

  return {
    has_prazo: true,
    days,
    unit,
    value_name: term?.value_name || (days != null ? `${days} ${unit || "dias"}` : null),
    raw: term,
  };
}

async function consultPrazoProducao({
  accessToken,
  mlCreds = null,
  mlbIds = [],
  concurrency = 6,
}) {
  const ids = Array.from(
    new Set((Array.isArray(mlbIds) ? mlbIds : []).map(normMlb).filter(Boolean))
  );
  if (!ids.length) throw new Error("Informe ao menos um MLB valido para consultar.");

  const authState = await prepareAuthState({ accessToken, mlCreds: mlCreds || {} });
  const rows = await mapWithConcurrency(ids, concurrency, async (mlbId) => {
    return consultPrazoItemRow({ authState, mlbId });
  });

  const okRows = rows.filter((row) => row.success);
  const withPrazo = okRows.filter((row) => row.prazo?.has_prazo);
  const prazoValues = withPrazo
    .map((row) => Number(row.prazo?.days))
    .filter((value) => Number.isFinite(value));

  return {
    success: true,
    total: rows.length,
    found: okRows.length,
    errors: rows.filter((row) => !row.success).length,
    with_prazo: withPrazo.length,
    without_prazo: okRows.length - withPrazo.length,
    average_days: prazoValues.length
      ? prazoValues.reduce((sum, value) => sum + value, 0) / prazoValues.length
      : null,
    max_days: prazoValues.length ? Math.max(...prazoValues) : null,
    rows,
  };
}

async function consultPrazoItemRow({ authState, mlbId }) {
  const id = normMlb(mlbId) || String(mlbId || "").trim().toUpperCase();
  try {
    const item = await mlGetItem({ authState, mlbId: id });
    const prazo = normalizeManufacturingTerm(findManufacturingTerm(item.sale_terms));
    return {
      success: true,
      mlb_id: id,
      title: item?.title || null,
      status: item?.status || null,
      permalink: item?.permalink || null,
      catalog_listing: item?.catalog_listing === true,
      catalog_product_id: item?.catalog_product_id || null,
      shipping_mode: item?.shipping?.mode || null,
      logistic_type: item?.shipping?.logistic_type || null,
      last_updated: item?.last_updated || null,
      prazo,
    };
  } catch (error) {
    return {
      success: false,
      mlb_id: id,
      title: null,
      status: "erro",
      error: error?.message || "Falha ao consultar anuncio.",
      details: error?.details || null,
      prazo: normalizeManufacturingTerm(null),
    };
  }
}

function summarizePrazoRows(rows = []) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const okRows = safeRows.filter((row) => row.success);
  const withPrazo = okRows.filter((row) => row.prazo?.has_prazo);
  const prazoValues = withPrazo
    .map((row) => Number(row.prazo?.days))
    .filter((value) => Number.isFinite(value));

  return {
    success: true,
    total: safeRows.length,
    found: okRows.length,
    errors: safeRows.filter((row) => !row.success).length,
    with_prazo: withPrazo.length,
    without_prazo: okRows.length - withPrazo.length,
    average_days: prazoValues.length
      ? prazoValues.reduce((sum, value) => sum + value, 0) / prazoValues.length
      : null,
    max_days: prazoValues.length ? Math.max(...prazoValues) : null,
    rows: safeRows,
  };
}

/**
 * Atualiza manufacturing time (MANUFACTURING_TIME) sem destruir outros sale_terms:
 * - GET item
 * - merge sale_terms
 * - PUT item
 * - (opcional) GET de verificação
 */
async function updatePrazoProducao({
  accessToken,
  mlCreds = null,
  authState = null,
  mlbId,
  days,
  verify = true,
}) {
  const id = normMlb(mlbId);
  if (!id) throw new Error("MLB inválido");
  const d = clampInt(days, 0, 365); // ajuste se quiser (0..365)
  if (d == null) throw new Error("Dias inválidos");

  const state =
    authState || (await prepareAuthState({ accessToken, mlCreds: mlCreds || {} }));

  const before = await mlGetItem({ authState: state, mlbId: id });
  const beforeTerms = before.sale_terms || [];
  const beforeTerm =
    (beforeTerms || []).find((t) => t?.id === "MANUFACTURING_TIME") || null;

  const merged = upsertManufacturingSaleTerm(beforeTerms, d);
  const putRes = await mlPutSaleTerms({
    authState: state,
    mlbId: id,
    saleTerms: merged,
  });

  let after = null;
  let afterTerm = null;
  if (verify) {
    await sleep(250); // micro-pausa
    after = await mlGetItem({ authState: state, mlbId: id });
    afterTerm =
      (after.sale_terms || []).find((t) => t?.id === "MANUFACTURING_TIME") ||
      null;
  }

  return {
    success: true,
    mlb_id: id,
    title: before?.title || putRes?.title || null,
    manufacturing_before: beforeTerm,
    manufacturing_after: afterTerm,
    put_result: putRes,
  };
}

module.exports = {
  updatePrazoProducao,
  consultPrazoProducao,
  consultPrazoItemRow,
  summarizePrazoRows,
  listActiveSellerItemIds,
  prepareAuthState,
  normMlb,
  clampInt,
};
