// services/sellerPromotionsService.js
const fetch = require('node-fetch');
const TokenService = require('./tokenService');
const config = require('../config/config');

const U = {
  users_me: (config?.urls?.users_me) || 'https://api.mercadolibre.com/users/me',
  base:     (config?.urls?.seller_promotions) || 'https://api.mercadolibre.com/seller-promotions',
  items:    'https://api.mercadolibre.com/items'
};

const up = s => String(s || '').toUpperCase();
const qs = o => new URLSearchParams(o).toString();

/* =============== AUTH (1 renovação máx) =============== */
function resolveCredsFrom(opts = {}) {
  const c = {
    app_id:        opts.mlCreds?.app_id        || process.env.APP_ID        || process.env.ML_APP_ID,
    client_secret: opts.mlCreds?.client_secret || process.env.CLIENT_SECRET  || process.env.ML_CLIENT_SECRET,
    refresh_token: opts.mlCreds?.refresh_token || process.env.REFRESH_TOKEN  || process.env.ML_REFRESH_TOKEN,
    access_token:  opts.mlCreds?.access_token  || process.env.ACCESS_TOKEN   || process.env.ML_ACCESS_TOKEN,
    redirect_uri:  opts.mlCreds?.redirect_uri  || process.env.REDIRECT_URI   || process.env.ML_REDIRECT_URI,
    key:           opts.accountKey || opts.mlCreds?.key || process.env.SELECTED_ACCOUNT || null,
  };
  return c;
}
function makeState(options = {}) {
  const creds = resolveCredsFrom(options);
  return { token: creds.access_token || null, creds, _renewedOnce: false };
}
async function authFetch(url, init, state) {
  const doCall = async (tok, extraHeaders = {}) => {
    const headers = { ...(init?.headers || {}), ...extraHeaders, Accept: 'application/json' };
    if (tok) headers.Authorization = `Bearer ${tok}`;
    return fetch(url, { ...init, headers });
  };
  let r = await doCall(state.token);
  if (r.status !== 401) return r;

  if (!state._renewedOnce) {
    try {
      const renewed = await TokenService.renovarToken(state.creds);
      state.token = renewed?.access_token || state.token;
      state._renewedOnce = true;
      r = await doCall(state.token);
      return r;
    } catch { return r; }
  }
  return r;
}

/* =============== GET/JSON helpers =============== */
async function parseJSONSafe(res) {
  const txt = await res.text().catch(() => '');
  try { return { ok: true, json: txt ? JSON.parse(txt) : {} } }
  catch { return { ok: false, text: txt } }
}
async function getJSON(url, state, userId, { tryCallerHeader = true } = {}) {
  let r = await authFetch(url, { method: 'GET' }, state);
  if (r.ok) {
    const parsed = await parseJSONSafe(r);
    if (parsed.ok) return { ok: true, json: parsed.json, hit: url };
  }
  if (tryCallerHeader && userId) {
    r = await authFetch(url, { method: 'GET', headers: { 'X-Caller-Id': String(userId) } }, state);
    if (r.ok) {
      const parsed2 = await parseJSONSafe(r);
      if (parsed2.ok) return { ok: true, json: parsed2.json, hit: `${url} + X-Caller-Id` };
    }
  }
  const body = await r.text().catch(() => '');
  return { ok: false, status: r.status, body, hit: url };
}

/* =============== Listar cards =============== */
async function fetchCardsByUser(state, userId, limit = 50, offset = 0) {
  let url = `${U.base}/users/${userId}?${qs({ app_version: 'v2', limit, offset })}`;
  let got = await getJSON(url, state, userId);
  if (got.ok) return got;

  url = `${U.base}/users/${userId}?${qs({ limit, offset })}`;
  got = await getJSON(url, state, userId);
  if (got.ok) return got;

  throw new Error(got.body || `Falha ao listar promoções do usuário (HTTP ${got.status})`);
}

/* =============== Itens do card (pagina) =============== */
async function pagePromotionItems(state, userId, promotionId, type, status, limit = 50, searchAfter = null) {
  const base = `${U.base}/promotions/${encodeURIComponent(promotionId)}/items`;
  const params = { promotion_type: type, limit: Math.min(50, limit) };
  if (status) params.status = status;
  if (searchAfter) params.search_after = searchAfter;

  let url = `${base}?${qs({ ...params, app_version: 'v2' })}`;
  let got = await getJSON(url, state, userId);
  if (got.ok) {
    const j = got.json || {};
    return { ok: true, results: j.results || j.items || j.data || [], paging: j.paging || {}, hit: got.hit };
  }
  if (/invalid[\s_]*app_version/i.test(got.body || '')) {
    url = `${base}?${qs(params)}`;
    got = await getJSON(url, state, userId);
    if (got.ok) {
      const j2 = got.json || {};
      return { ok: true, results: j2.results || j2.items || j2.data || [], paging: j2.paging || {}, hit: got.hit };
    }
  }
  return { ok: false, error: got.body || `HTTP ${got.status}`, results: [], paging: null };
}

/* =============== Fallback items/search =============== */
async function pageItemsFallback(state, userId, promotionId, limit = 50, searchAfter = null) {
  const base = `${U.base}/items/search`;
  const params = { promotion_id: promotionId, limit: Math.min(50, limit) };
  if (searchAfter) params.search_after = searchAfter;

  const url = `${base}?${qs(params)}`;
  const got = await getJSON(url, state, userId);
  if (!got.ok) return { ok: false, error: got.body || `HTTP ${got.status}`, results: [], paging: null };
  const j = got.json || {};
  return { ok: true, results: j.results || j.items || j.data || [], paging: j.paging || {}, hit: got.hit };
}

/* =============== Detalhes dos itens =============== */
async function fetchItemsDetails(state, ids = []) {
  const out = {};
  const chunk = 50;
  for (let i = 0; i < ids.length; i += chunk) {
    const part = ids.slice(i, i + chunk);
    const url = `${U.items}?ids=${part.join(',')}&attributes=id,title,available_quantity,seller_custom_field,price`;
    const got = await getJSON(url, state, null, { tryCallerHeader: false });
    if (!got.ok) continue;
    const arr = Array.isArray(got.json) ? got.json : [];
    for (const row of arr) {
      const b = row?.body || {};
      if (!b.id) continue;
      out[b.id] = {
        title: b.title || null,
        stock: typeof b.available_quantity === 'number' ? b.available_quantity : null,
        sku: b.seller_custom_field || null,
        price: typeof b.price === 'number' ? b.price : null,
      };
    }
  }
  return out;
}

/* =============== Detalhes da promoção (benefits / REBATE) =============== */
async function fetchPromotionDetails(state, userId, promotionId, type) {
  let url = `${U.base}/promotions/${encodeURIComponent(promotionId)}?${qs({ promotion_type: type, app_version: 'v2' })}`;
  let got = await getJSON(url, state, userId);
  if (got.ok) return got.json || null;

  if (/invalid[\s_]*app_version/i.test(got.body || '')) {
    url = `${U.base}/promotions/${encodeURIComponent(promotionId)}?${qs({ promotion_type: type })}`;
    got = await getJSON(url, state, userId);
    if (got.ok) return got.json || null;
  }
  return null;
}

function pct(val) {
  return (typeof val === 'number' && !Number.isNaN(val)) ? Math.round(val * 10) / 10 : null;
}
function pctFromPrices(discounted, original) {
  const d = Number(discounted), o = Number(original);
  if (!(o > 0) || !(d >= 0)) return null;
  return pct(((o - d) / o) * 100);
}

/* =============== SERVICE =============== */
class SellerPromotionsService {
  static async listarPromocoesDisponiveis(options = {}) {
    const state = makeState(options);

    const rMe = await authFetch(U.users_me, { method: 'GET' }, state);
    if (!rMe.ok) throw new Error(`users/me: HTTP ${rMe.status}`);
    const me = await rMe.json();
    const userId = me.id;

    const got = await fetchCardsByUser(state, userId, options.limit || 50, options.offset || 0);
    const raw = got.json || {};
    const results = raw.results || raw.promotions || raw.data || [];

    const cards = results.map(p => ({
      id: p.id || p.promotion_id || p.code || p.name,
      name: p.name || p.title || p.promotion_name || p.id,
      type: up(p.type || p.promotion_type),
      status: p.status,
      start_date: p.start_date || p.valid_from,
      finish_date: p.finish_date || p.valid_to,
      deadline_date: p.deadline_date,
      benefits: p.benefits || null,
    }));

    return { paging: raw.paging || {}, cards, source: got.hit };
  }

  static async listarItensDaPromocao(promotionId, options = {}) {
    const state = makeState(options);

    const rMe = await authFetch(U.users_me, { method: 'GET' }, state);
    if (!rMe.ok) throw new Error(`users/me: HTTP ${rMe.status}`);
    const me = await rMe.json();
    const userId = me.id;

    const type = up(options.type || 'SMART'); // obrigatório
    const want = Math.max(1, Number(options.limit || 200));
    const seen = new Set();
    const rawItems = { candidates: [], participants: [] };

    // 1) candidate
    let sa = null;
    while (rawItems.candidates.length < want) {
      const page = await pagePromotionItems(state, userId, promotionId, type, 'candidate', 50, sa);
      if (!page.ok) break;
      for (const it of page.results) {
        const id = it.id || it.item_id;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        rawItems.candidates.push(it);
      }
      sa = page.paging?.searchAfter || page.paging?.search_after || null;
      if (!sa) break;
    }
    // 2) started
    sa = null;
    while (rawItems.participants.length < want) {
      const page = await pagePromotionItems(state, userId, promotionId, type, 'started', 50, sa);
      if (!page.ok) break;
      for (const it of page.results) {
        const id = it.id || it.item_id;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        rawItems.participants.push(it);
      }
      sa = page.paging?.searchAfter || page.paging?.search_after || null;
      if (!sa) break;
    }
    // 3) pending
    sa = null;
    while (rawItems.participants.length < want) {
      const page = await pagePromotionItems(state, userId, promotionId, type, 'pending', 50, sa);
      if (!page.ok) break;
      for (const it of page.results) {
        const id = it.id || it.item_id;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        rawItems.participants.push(it);
      }
      sa = page.paging?.searchAfter || page.paging?.search_after || null;
      if (!sa) break;
    }

    // 4) fallback geral
    if (rawItems.candidates.length === 0 && rawItems.participants.length === 0) {
      let sa2 = null;
      while (rawItems.participants.length + rawItems.candidates.length < want) {
        const page = await pageItemsFallback(state, userId, promotionId, 50, sa2);
        if (!page.ok) break;
        for (const it of page.results) {
          const id = it.id || it.item_id;
          if (!id || seen.has(id)) continue;
          seen.add(id);
          const st = String(it.status || it.item_status || '').toLowerCase();
          if (st === 'candidate') rawItems.candidates.push(it);
          else rawItems.participants.push(it);
        }
        sa2 = page.paging?.searchAfter || page.paging?.search_after || null;
        if (!sa2) break;
      }
    }

    // Detalhes da promoção (benefits / REBATE)
    const promotionDetails = await fetchPromotionDetails(state, userId, promotionId, type);
    const promoBenefits = promotionDetails?.benefits || null;

    // Normaliza + enriquece
    const allRaw = [...rawItems.candidates, ...rawItems.participants];
    const ids = allRaw.map(x => x.id || x.item_id).filter(Boolean);
    const details = await fetchItemsDetails(state, ids);

    const all = allRaw.map(src => {
      const id = src.id || src.item_id;
      const d  = details[id] || {};
      const status = String(src.status || src.item_status || '').toLowerCase();
      const orig_api = Number(src.original_price ?? 0);
      const current_price = (typeof d.price === 'number') ? d.price : (orig_api || null);
      const original = (orig_api > 0) ? orig_api : (current_price ?? null);

      // preço final sugerido pela campanha
      let final_price = null;
      if (type === 'DEAL' && ['candidate', 'pending', 'scheduled'].includes(status)) {
        final_price =
          (src.max_discounted_price ?? null) ||
          (src.suggested_discounted_price ?? null) ||
          null;
      } else {
        final_price =
          (src.price ?? null) ||
          (src.top_deal_price ?? null) ||
          (src.suggested_discounted_price ?? null) ||
          (src.max_discounted_price ?? null) ||
          (src.min_discounted_price ?? null) ||
          null;
      }

      if (!final_price && original && (src.discount_percentage != null)) {
        const pctNum = Number(src.discount_percentage);
        if (!Number.isNaN(pctNum)) final_price = Math.max(0, original * (1 - pctNum/100));
      }

      // desconto da campanha
      let discount_amount = null, discount_pct = null;
      if (original && final_price) {
        discount_amount = Math.max(0, original - final_price);
        discount_pct = pctFromPrices(final_price, original);
      } else if (src.discount_percentage != null) {
        discount_pct = pct(Number(src.discount_percentage));
        if (original && discount_pct != null) {
          discount_amount = Math.max(0, original * (discount_pct/100));
          final_price = Math.max(0, original - discount_amount);
        }
      }

      return {
        id,
        title: d.title || null,
        stock: d.stock ?? null,
        sku: d.sku || null,

        status: src.status || src.item_status || 'candidate',
        current_price,               // preço atual do anúncio
        original_price: original,    // base para cálculo
        final_price: (final_price != null) ? Number(final_price) : null,
        discount_amount: (discount_amount != null) ? Number(discount_amount) : null,
        discount_pct,                // % do desconto da campanha

        max_discounted_price: src.max_discounted_price ?? null,
        suggested_discounted_price: src.suggested_discounted_price ?? null,
        discount_percentage: (src.discount_percentage != null) ? Number(src.discount_percentage) : null,

        currency_id: src.currency || src.currency_id || null,
        sub_type: src.sub_type || null,
        start_date: src.start_date || null,
        end_date: src.end_date || null,
      };
    });

    return {
      promotion: {
        id: promotionId,
        type,
        name: promotionDetails?.name || null,
        benefits: promoBenefits || null,
      },
      paging: {},
      items: all,
      buckets: {
        candidates: all.filter(i => String(i.status).toLowerCase() === 'candidate'),
        participants: all.filter(i => String(i.status).toLowerCase() !== 'candidate'),
      },
    };
  }
}

module.exports = SellerPromotionsService;
