// controllers/PromocoesController.js
const fetch = require('node-fetch');
const TokenService = require('../services/tokenService');
const config = require('../config/config');

function U() {
  return {
    users_me:        (config?.urls?.users_me) || 'https://api.mercadolibre.com/users/me',
    items:           (config?.urls?.items) || 'https://api.mercadolibre.com/items',
    sellerPromoBase: (config?.urls?.seller_promotions) || 'https://api.mercadolibre.com/seller-promotions',
  };
}

async function prepareAuth(res) {
  const creds = res?.locals?.mlCreds || {};
  const token = await TokenService.renovarTokenSeNecessario(creds);
  return { token, creds, key: (creds.account_key || creds.accountKey || 'sem-conta') };
}

async function authFetch(url, init, state) {
  const call = async (tok) =>
    fetch(url, { ...init, headers: { ...(init?.headers || {}), Authorization: `Bearer ${tok}` } });

  let resp = await call(state.token);
  if (resp.status !== 401) return resp;

  const renewed = await TokenService.renovarToken(state.creds).catch(() => null);
  state.token = renewed?.access_token || state.token;
  return call(state.token);
}

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

class PromocoesController {
  // GET /api/promocoes/users
  static async users(req, res) {
    try {
      const state = await prepareAuth(res);
      const urls = U();

      const rMe = await authFetch(urls.users_me, { method: 'GET' }, state);
      if (!rMe.ok) {
        const body = await rMe.text().catch(()=> '');
        return res.status(rMe.status).json({ ok:false, step:'users/me', body });
      }
      const me = await rMe.json();
      const userId = me.id;

      const q = new URLSearchParams({ app_version: 'v2' });
      const rUsers = await authFetch(`${urls.sellerPromoBase}/users/${userId}?${q}`, { method:'GET' }, state);
      const raw = await rUsers.text();
      let json;
      try { json = JSON.parse(raw); } catch { json = { raw }; }

      return res.status(rUsers.status).send(json);
    } catch (e) {
      const status = e?.status || 500;
      return res.status(status).json({ ok:false, error: e?.message || String(e) });
    }
  }

  // GET /api/promocoes/promotions/:promotionId/items
  // -> itens + benefits + rebate_meli_percent (item ou campanha) + % desconto + preços
  static async promotionItems(req, res) {
    try {
      const state = await prepareAuth(res);
      const urls = U();

      const { promotionId } = req.params;
      if (!promotionId) return res.status(400).json({ ok:false, error:'promotionId ausente' });

      const {
        promotion_type = 'DEAL',
        status,
        limit = 50,
        search_after
      } = req.query;

      // 0) Detalhes da promoção (podem não trazer "benefits" em SMART/PRICE_MATCHING)
      const detUrl = `${urls.sellerPromoBase}/promotions/${encodeURIComponent(promotionId)}?promotion_type=${encodeURIComponent(promotion_type)}&app_version=v2`;
      const rDet = await authFetch(detUrl, { method:'GET' }, state);
      const det = await rDet.json().catch(()=>null);
      const benefits   = det?.benefits || null;
      const promoType  = det?.type || promotion_type;

      // 1) Itens da campanha
      const qs = new URLSearchParams({ promotion_type, app_version:'v2' });
      if (status) qs.set('status', status);
      if (limit) qs.set('limit', String(limit));
      if (search_after) qs.set('search_after', String(search_after));

      const r = await authFetch(
        `${urls.sellerPromoBase}/promotions/${encodeURIComponent(promotionId)}/items?${qs}`,
        { method:'GET' }, state
      );
      const promoJson = await r.json().catch(()=>({}));

      const results = Array.isArray(promoJson.results) ? promoJson.results : [];
      if (!results.length) {
        return res.json({ ...promoJson, promotion_benefits: benefits, promotion_type: promoType });
      }

      // 2) Enriquecimento com /items?ids=...
      const ids = results.map(x => x.id).filter(Boolean);
      const chunks = [];
      for (let i=0;i<ids.length;i+=20) chunks.push(ids.slice(i, i+20));
      const details = {};
      for (const pack of chunks) {
        const rr = await authFetch(
          `${urls.items}?ids=${pack.join(',')}&attributes=id,title,available_quantity,seller_custom_field,price`,
          { method:'GET' }, state
        );
        const blob = await rr.json().catch(()=>[]);
        (blob||[]).forEach(row=>{
          const b = row?.body || {};
          if (b?.id) details[b.id] = {
            title: b.title,
            available_quantity: b.available_quantity,
            seller_custom_field: b.seller_custom_field,
            price: b.price
          };
        });
      }

      // 3) Merge e normalização
      const merged = results.map(r => {
        const d = details[r.id] || {};
        const original = r.original_price ?? d.price ?? null; // preço cheio
        const deal     = r.price ?? null;                      // preço final se houver

        // % desconto sugerido
        let discountPct = r.discount_percentage;
        if ((discountPct == null) && original && deal && Number(original) > 0) {
          discountPct = (1 - (Number(deal)/Number(original))) * 100;
        }

        // % rebate do ML:
        //  - SMART / PRICE_MATCHING / PRICE_MATCHING_MELI_ALL: meli_percentage por item
        //  - MARKETPLACE_CAMPAIGN: benefits.meli_percent
        let rebate_meli_percent = null;
        if (r.meli_percentage != null) {
          rebate_meli_percent = Number(r.meli_percentage);
        } else if (benefits?.meli_percent != null) {
          rebate_meli_percent = Number(benefits.meli_percent);
        }

        return {
          ...r,
          title: d.title,
          available_quantity: d.available_quantity,
          seller_custom_field: d.seller_custom_field,
          original_price: original,
          deal_price: deal,
          discount_percentage: (discountPct != null ? round2(discountPct) : null),
          rebate_meli_percent
        };
      });

      return res.json({
        ...promoJson,
        results: merged,
        promotion_benefits: benefits,
        promotion_type: promoType
      });
    } catch (e) {
      const status = e?.status || 500;
      return res.status(status).json({ ok:false, error: e?.message || String(e) });
    }
  }
}

module.exports = PromocoesController;
