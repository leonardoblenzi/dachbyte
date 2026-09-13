// services/itemsService.js
const fetch = require('node-fetch');
const TokenService = require('./tokenService');
const config = require('../config/config');

function urls() {
  return {
    users_me: (config?.urls?.users_me) || 'https://api.mercadolibre.com/users/me',
    items:    (config?.urls?.items)    || 'https://api.mercadolibre.com/items',
  };
}

async function withAuth(url, init, state) {
  const call = async (token) => {
    const headers = { ...(init?.headers||{}), Authorization: `Bearer ${token}` };
    return fetch(url, { ...init, headers });
  };
  let r = await call(state.token);
  if (r.status !== 401) return r;
  const novo = await TokenService.renovarToken(state.creds);
  state.token = novo.access_token;
  return call(state.token);
}

async function prepararAuth(opts = {}) {
  const token = await TokenService.renovarTokenSeNecessario(opts?.mlCreds || {});
  return { token, creds: opts?.mlCreds || {}, key: opts?.accountKey || 'sem-conta' };
}

class ItemsService {
  static async obterItemBasico(mlbId, options = {}) {
    const state = await prepararAuth(options);
    const U = urls();

    const rItem = await withAuth(`${U.items}/${mlbId}`, { method:'GET' }, state);
    if (!rItem.ok) {
      const tx = await rItem.text().catch(()=> '');
      throw new Error(`Falha ao obter item: HTTP ${rItem.status} ${tx}`);
    }
    const item = await rItem.json();
    return {
      id: item.id,
      title: item.title,
      price: Number(item.price),
      currency_id: item.currency_id,
      seller_id: item.seller_id,
      listing_type_id: item.listing_type_id,
      thumbnail: item.thumbnail,
      permalink: item.permalink,
    };
  }
}

module.exports = ItemsService;
