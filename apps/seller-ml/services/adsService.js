// services/adsService.js
'use strict';

const _fetch = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
const fetchRef = (...args) => _fetch(...args);

const METRICS_LIST = [
  'clicks', 'prints', 'ctr', 'cost', 'cpc', 'acos',
  'organic_units_quantity', 'organic_units_amount', 'organic_items_quantity',
  'direct_items_quantity', 'indirect_items_quantity', 'advertising_items_quantity',
  'cvr', 'roas', 'sov',
  'direct_units_quantity', 'indirect_units_quantity', 'units_quantity',
  'direct_amount', 'indirect_amount', 'total_amount',
].join(',');

const DEFAULT_CHANNEL = 'marketplace';
const DEFAULT_AGGREGATION_TYPE = 'item';
const DEFAULT_AGGREGATION = 'sum';
const SEARCH_CHANNELS = ['marketplace'];
const SEARCH_CHUNK_SIZE = 100;
const MAX_ATTEMPTS = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeItemId(value) {
  return String(value || '').trim().toUpperCase();
}

async function getProfile(access_token) {
  const r = await fetchRef('https://api.mercadolibre.com/users/me', {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (!r.ok) throw new Error(`users/me ${r.status}`);
  return r.json();
}

function normalizeItemMetrics(json) {
  const ms = json?.metrics_summary || {};
  const cid = typeof json?.campaign_id === 'number' ? json.campaign_id : null;
  const stat = String(json?.status || '').trim().toLowerCase() || null;

  const impressions = Number(ms.prints || ms.impressions || 0);
  const clicks = Number(ms.clicks || 0);
  const spend = Number(ms.cost || 0);
  const totalAmount = Number(ms.total_amount || 0);
  const directAmount = Number(ms.direct_amount || 0);
  const indirectAmount = Number(ms.indirect_amount || 0);
  const revenue = totalAmount > 0 ? totalAmount : directAmount + indirectAmount;

  const spend_cents = Math.round(spend * 100);
  const revenue_cents = Math.round(revenue * 100);
  const in_campaign = !!cid || stat === 'active' || stat === 'paused';
  const had_activity = impressions > 0 || clicks > 0 || spend > 0 || revenue > 0;
  const acos = revenue > 0 ? (spend / revenue) : null;

  return {
    in_campaign,
    status: stat || (had_activity ? 'active' : null),
    campaign_id: cid,
    had_activity,
    clicks,
    impressions,
    spend_cents,
    revenue_cents,
    acos,
    raw_status: json?.status || null,
  };
}

function normalizeSearchMetrics(row) {
  const metrics = row?.metrics || row?.metrics_summary || {};
  const clicks = Number(metrics.clicks || 0);
  const impressions = Number(metrics.prints || metrics.impressions || 0);
  const spend = Number(metrics.cost || 0);
  const totalAmount = Number(metrics.total_amount || 0);
  const directAmount = Number(metrics.direct_amount || 0);
  const indirectAmount = Number(metrics.indirect_amount || 0);
  const revenue = totalAmount > 0 ? totalAmount : directAmount + indirectAmount;
  const spend_cents = Math.round(spend * 100);
  const revenue_cents = Math.round(revenue * 100);
  const rawStatus = String(row?.status || '').trim().toLowerCase();
  const status =
    rawStatus === 'active'
      ? 'active'
      : rawStatus === 'paused'
        ? 'paused'
        : null;

  return {
    in_campaign: status !== null,
    status,
    campaign_id: row?.campaign_id ?? null,
    had_activity: clicks + impressions + spend_cents + revenue_cents > 0,
    clicks,
    impressions,
    spend_cents,
    revenue_cents,
    acos: revenue > 0 ? (spend / revenue) : null,
    raw_status: row?.status || null,
  };
}

async function doFetch(url, { access_token, headers = {} } = {}) {
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const r = await fetchRef(url, {
      headers: {
        Authorization: `Bearer ${access_token}`,
        'api-version': '2',
        accept: 'application/json',
        ...headers,
      },
    });

    if (r.status === 429) {
      if (attempts >= MAX_ATTEMPTS) {
        throw new Error(`429 apos ${attempts} tentativas`);
      }
      await sleep(300 * attempts);
      continue;
    }

    if ([400, 403, 404].includes(r.status)) return null;
    if (!r.ok) throw new Error(`${url.pathname} -> ${r.status}`);
    return r.json();
  }
}

async function fetchAdsItemV2Ads({ siteId, itemId, access_token, date_from, date_to }) {
  const u = new URL(`https://api.mercadolibre.com/advertising/${encodeURIComponent(siteId)}/product_ads/ads/${encodeURIComponent(itemId)}`);
  u.searchParams.set('date_from', date_from);
  u.searchParams.set('date_to', date_to);
  u.searchParams.set('metrics', METRICS_LIST);
  u.searchParams.set('aggregation_type', DEFAULT_AGGREGATION_TYPE);
  u.searchParams.set('aggregation', DEFAULT_AGGREGATION);
  u.searchParams.set('channel', DEFAULT_CHANNEL);

  const json = await doFetch(u, { access_token });
  return json ? normalizeItemMetrics(json) : null;
}

async function fetchAdsItemV2Items({ siteId, itemId, access_token, date_from, date_to }) {
  const u = new URL(`https://api.mercadolibre.com/advertising/${encodeURIComponent(siteId)}/product_ads/items/${encodeURIComponent(itemId)}`);
  u.searchParams.set('date_from', date_from);
  u.searchParams.set('date_to', date_to);
  u.searchParams.set('metrics', METRICS_LIST);
  u.searchParams.set('aggregation_type', DEFAULT_AGGREGATION_TYPE);
  u.searchParams.set('aggregation', DEFAULT_AGGREGATION);
  u.searchParams.set('channel', DEFAULT_CHANNEL);

  const json = await doFetch(u, { access_token });
  return json ? normalizeItemMetrics(json) : null;
}

async function fetchAdsItemLegacy({ itemId, access_token, date_from, date_to }) {
  const u = new URL(`https://api.mercadolibre.com/advertising/product_ads/items/${encodeURIComponent(itemId)}`);
  u.searchParams.set('date_from', date_from);
  u.searchParams.set('date_to', date_to);
  u.searchParams.set('metrics', METRICS_LIST);
  u.searchParams.set('aggregation_type', DEFAULT_AGGREGATION_TYPE);
  u.searchParams.set('aggregation', DEFAULT_AGGREGATION);
  u.searchParams.set('channel', DEFAULT_CHANNEL);

  const json = await doFetch(u, { access_token });
  return json ? normalizeItemMetrics(json) : null;
}

async function fetchItemStatus({ siteId, itemId, access_token }) {
  const u = new URL(`https://api.mercadolibre.com/advertising/${encodeURIComponent(siteId)}/product_ads/items/${encodeURIComponent(itemId)}`);
  const json = await doFetch(u, { access_token });
  const raw = String(json?.status || '').trim().toLowerCase();
  if (raw === 'active') return 'active';
  if (raw === 'paused') return 'paused';
  return null;
}

async function getAdvertisersMap(access_token) {
  const url = new URL('https://api.mercadolibre.com/advertising/advertisers');
  url.searchParams.set('product_id', 'PADS');

  const r = await fetchRef(url, {
    headers: {
      Authorization: `Bearer ${access_token}`,
      'Api-Version': '1',
      accept: 'application/json',
    },
  });

  if (!r.ok) {
    throw new Error(`advertisers -> ${r.status}`);
  }

  const json = await r.json().catch(() => ({}));
  const advertisers = Array.isArray(json?.advertisers) ? json.advertisers : [];
  const out = new Map();

  for (const advertiser of advertisers) {
    const siteId = String(advertiser?.site_id || '').trim().toUpperCase();
    const advertiserId = advertiser?.advertiser_id ?? advertiser?.id ?? null;
    if (!siteId || !advertiserId || out.has(siteId)) continue;
    out.set(siteId, advertiserId);
  }

  return out;
}

async function fetchAdsBySearch({
  siteId,
  advertiserId,
  itemIds,
  access_token,
  date_from,
  date_to,
}) {
  const out = {};
  const ids = Array.from(new Set((itemIds || []).map(normalizeItemId).filter(Boolean)));
  if (!ids.length || !advertiserId) return out;

  for (let i = 0; i < ids.length; i += SEARCH_CHUNK_SIZE) {
    const slice = ids.slice(i, i + SEARCH_CHUNK_SIZE);

    for (const channel of SEARCH_CHANNELS) {
      const url = new URL(
        `https://api.mercadolibre.com/advertising/${encodeURIComponent(siteId)}/advertisers/${encodeURIComponent(advertiserId)}/product_ads/ads/search`
      );
      url.searchParams.set('limit', String(slice.length));
      url.searchParams.set('offset', '0');
      url.searchParams.set('date_from', date_from);
      url.searchParams.set('date_to', date_to);
      url.searchParams.set('metrics', 'clicks,prints,cost,acos,total_amount,direct_amount,indirect_amount');
      url.searchParams.set('metrics_summary', 'true');
      url.searchParams.set('aggregation', 'sum');
      url.searchParams.set('filters[item_id]', slice.join(','));
      url.searchParams.set('filters[channel]', channel);

      let json = null;
      try {
        json = await doFetch(url, { access_token });
      } catch (e) {
        console.warn(`Ads search falhou para ${siteId}: ${e.message || e}`);
        continue;
      }

      const results = Array.isArray(json?.results) ? json.results : [];
      for (const row of results) {
        const itemId = normalizeItemId(row?.item_id);
        if (!itemId) continue;

        const next = normalizeSearchMetrics(row);
        const prev = out[itemId];

        if (!prev) {
          out[itemId] = next;
          continue;
        }

        prev.in_campaign = prev.in_campaign || next.in_campaign;
        prev.status =
          prev.status === 'active' || next.status === 'active'
            ? 'active'
            : prev.status === 'paused' || next.status === 'paused'
              ? 'paused'
              : (prev.status || next.status || null);
        prev.had_activity = prev.had_activity || next.had_activity;
        prev.clicks += next.clicks;
        prev.impressions += next.impressions;
        prev.spend_cents += next.spend_cents;
        prev.revenue_cents += next.revenue_cents;
        prev.acos =
          prev.revenue_cents > 0
            ? (prev.spend_cents / prev.revenue_cents)
            : null;
      }
    }
  }

  return out;
}

async function metricsPorItens({ mlbIds, date_from, date_to, access_token }) {
  const ids = Array.from(new Set((mlbIds || []).map(normalizeItemId).filter(Boolean)));
  if (!ids.length) return {};

  let defaultSiteId = 'MLB';
  let advertisersMap = new Map();

  try {
    const me = await getProfile(access_token);
    if (me?.site_id) {
      defaultSiteId = String(me.site_id).trim().toUpperCase() || defaultSiteId;
    }
    advertisersMap = await getAdvertisersMap(access_token);
  } catch {
    // mantem fallback por item
  }

  const out = {};
  const idsBySite = new Map();

  for (const itemId of ids) {
    const siteId = itemId.slice(0, 3) || defaultSiteId;
    if (!idsBySite.has(siteId)) idsBySite.set(siteId, []);
    idsBySite.get(siteId).push(itemId);
  }

  for (const [siteId, siteIds] of idsBySite.entries()) {
    const advertiserId = advertisersMap.get(siteId);
    if (!advertiserId) continue;

    try {
      Object.assign(
        out,
        await fetchAdsBySearch({
          siteId,
          advertiserId,
          itemIds: siteIds,
          access_token,
          date_from,
          date_to,
        })
      );
    } catch (e) {
      console.warn(`Ads search geral falhou para ${siteId}: ${e.message || e}`);
    }
  }

  const pendingIds = ids.filter((itemId) => !out[itemId]);
  const CONCURRENCY = 6;
  let idx = 0;

  async function worker() {
    while (idx < pendingIds.length) {
      const current = idx++;
      const itemId = pendingIds[current];
      const siteId = itemId.slice(0, 3) || defaultSiteId;

      let attempts = 0;
      for (;;) {
        attempts += 1;
        try {
          let met = await fetchAdsItemV2Ads({
            siteId,
            itemId,
            access_token,
            date_from,
            date_to,
          });

          if (!met) {
            met = await fetchAdsItemV2Items({
              siteId,
              itemId,
              access_token,
              date_from,
              date_to,
            });
          }

          if (!met) {
            met = await fetchAdsItemLegacy({
              itemId,
              access_token,
              date_from,
              date_to,
            });
          }

          if (met && !met.status) {
            try {
              met.status = await fetchItemStatus({ siteId, itemId, access_token });
              met.in_campaign = met.in_campaign || !!met.status;
            } catch {}
          }

          if (met) out[itemId] = met;
          break;
        } catch (e) {
          if (attempts >= MAX_ATTEMPTS) {
            console.warn(`Ads metrics falharam para ${itemId}: ${e.message || e}`);
            break;
          }
          await sleep(250 * attempts);
        }
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(CONCURRENCY, pendingIds.length) },
    () => worker()
  );
  await Promise.all(workers);
  return out;
}

module.exports = { metricsPorItens };
