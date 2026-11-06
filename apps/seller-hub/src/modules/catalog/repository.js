// @ts-check
"use strict";

/**
 * Acesso ao banco do catálogo (schema hub). SQL explícito, sem ORM.
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<any>, queryOne: (sql: string, params?: unknown[]) => Promise<any> }} db
 */
function createCatalogRepository(db) {
  return {
    /** @param {string} tenantId */
    async listItemsForMatching(tenantId) {
      const { rows } = await db.query(
        "select id, sku_key as \"skuKey\", ean, name from hub.items where tenant_id = $1 and active", [tenantId]);
      return rows;
    },

    /**
     * Cria itens mestres a partir dos anúncios (ignora SKUs que já existem).
     * @param {string} tenantId
     * @param {Array<{ sku: string, skuKey: string, name: string | null, ean: string | null }>} items
     */
    async insertItems(tenantId, items) {
      if (!items.length) return 0;
      const { rowCount } = await db.query(
        `insert into hub.items (tenant_id, sku, sku_key, name, ean, origin)
         select $1, x.sku, x.sku_key, x.name, x.ean, 'channel_import'
           from jsonb_to_recordset($2::jsonb) as x(sku text, sku_key text, name text, ean text)
         on conflict (tenant_id, sku_key) do nothing`,
        [tenantId, JSON.stringify(items.map((i) => ({ sku: i.sku, sku_key: i.skuKey, name: i.name, ean: i.ean })))]);
      return rowCount || 0;
    },

    /**
     * Grava (ou atualiza) os anúncios vistos numa importação, com o vínculo decidido.
     * Vínculo manual nunca é desfeito por uma importação automática.
     * @param {number} accountId
     * @param {Array<Record<string, any>>} rows
     */
    async upsertListings(accountId, rows) {
      if (!rows.length) return 0;
      const { rowCount } = await db.query(
        `insert into hub.listings (channel_account_id, listing_id, variation_id, channel_sku, sku_key, ean, title, status,
                                   fulfillment, channel_stock, price, item_id, link_method, link_suggestion_item_id, seen_at, channel_checked_at)
         select $1, x.listing_id, coalesce(x.variation_id, ''), x.channel_sku, x.sku_key, x.ean, x.title, x.status,
                coalesce(x.fulfillment, false), x.channel_stock, x.price, x.item_id, x.link_method, x.suggestion_item_id, now(), now()
           from jsonb_to_recordset($2::jsonb) as x(listing_id text, variation_id text, channel_sku text, sku_key text, ean text,
                title text, status text, fulfillment boolean, channel_stock numeric, price numeric, item_id bigint,
                link_method text, suggestion_item_id bigint)
         on conflict (channel_account_id, listing_id, variation_id) do update set
           channel_sku = excluded.channel_sku, sku_key = excluded.sku_key, ean = excluded.ean, title = excluded.title,
           status = excluded.status, fulfillment = excluded.fulfillment, channel_stock = excluded.channel_stock,
           price = excluded.price, seen_at = now(), updated_at = now(), channel_checked_at = now(),
           item_id = case when hub.listings.link_method = 'manual' then hub.listings.item_id else excluded.item_id end,
           link_method = case when hub.listings.link_method = 'manual' then 'manual' else excluded.link_method end,
           link_suggestion_item_id = case when hub.listings.link_method = 'manual' then null else excluded.link_suggestion_item_id end`,
        [accountId, JSON.stringify(rows)]);
      return rowCount || 0;
    },

    /** @param {number} accountId */
    async startImportRun(accountId) {
      return db.queryOne("insert into hub.import_runs (channel_account_id, status, started_at) values ($1, 'running', now()) returning id", [accountId]);
    },

    /** @param {number} runId @param {{ status: string, listingsSeen?: number, linkedAuto?: number, unlinked?: number, error?: string | null }} result */
    async finishImportRun(runId, result) {
      await db.query(
        `update hub.import_runs set status = $2, listings_seen = $3, linked_auto = $4, unlinked = $5, error_message = $6, finished_at = now()
          where id = $1`,
        [runId, result.status, result.listingsSeen || 0, result.linkedAuto || 0, result.unlinked || 0, result.error || null]);
    },

    /** @param {string} tenantId */
    async overview(tenantId) {
      return db.queryOne(
        `select
           (select count(*)::int from hub.items i where i.tenant_id = $1 and i.active) as items,
           (select count(*)::int from hub.channel_accounts a where a.tenant_id = $1 and a.status <> 'disconnected') as accounts,
           count(l.id)::int as listings,
           count(l.id) filter (where l.item_id is not null)::int as linked,
           count(l.id) filter (where l.item_id is null)::int as unlinked,
           count(l.id) filter (where l.item_id is null and l.link_suggestion_item_id is not null)::int as with_suggestion
         from hub.listings l join hub.channel_accounts a on a.id = l.channel_account_id
         where a.tenant_id = $1`, [tenantId]);
    },

    /** @param {string} tenantId @param {{ q?: string, limit?: number, offset?: number }} options */
    async listItems(tenantId, { q = "", limit = 50, offset = 0 } = {}) {
      const { rows } = await db.query(
        `select i.id, i.sku, i.name, i.ean, i.kind,
                coalesce(json_agg(json_build_object('channel', a.channel, 'account', coalesce(a.label, a.external_account_id),
                  'listingId', l.listing_id, 'variationId', l.variation_id, 'status', l.status, 'stock', l.channel_stock,
                  'fulfillment', l.fulfillment)) filter (where l.id is not null), '[]') as listings
           from hub.items i
           left join hub.listings l on l.item_id = i.id
           left join hub.channel_accounts a on a.id = l.channel_account_id
          where i.tenant_id = $1 and i.active
            and ($2 = '' or i.sku ilike '%' || $2 || '%' or coalesce(i.name, '') ilike '%' || $2 || '%' or coalesce(i.ean, '') = $2)
          group by i.id
          order by i.sku
          limit $3 offset $4`,
        [tenantId, String(q || "").trim(), Math.min(200, Math.max(1, limit)), Math.max(0, offset)]);
      return rows;
    },

    /** @param {string} tenantId @param {{ limit?: number, offset?: number }} options */
    async listUnlinked(tenantId, { limit = 50, offset = 0 } = {}) {
      const { rows } = await db.query(
        `select l.id, a.channel, coalesce(a.label, a.external_account_id) as account, l.listing_id as "listingId",
                l.variation_id as "variationId", l.channel_sku as "channelSku", l.title, l.status, l.channel_stock as stock,
                s.id as "suggestionItemId", s.sku as "suggestionSku", s.name as "suggestionName"
           from hub.listings l
           join hub.channel_accounts a on a.id = l.channel_account_id
           left join hub.items s on s.id = l.link_suggestion_item_id
          where a.tenant_id = $1 and l.item_id is null
          order by (s.id is null), a.channel, l.title
          limit $2 offset $3`,
        [tenantId, Math.min(200, Math.max(1, limit)), Math.max(0, offset)]);
      return rows;
    },

    /** Vínculo manual (só dentro da mesma empresa). @param {string} tenantId @param {number} listingId @param {number} itemId */
    async linkManually(tenantId, listingId, itemId) {
      return db.queryOne(
        `update hub.listings l set item_id = i.id, link_method = 'manual', link_suggestion_item_id = null, updated_at = now()
           from hub.channel_accounts a, hub.items i
          where l.id = $2 and a.id = l.channel_account_id and a.tenant_id = $1 and i.id = $3 and i.tenant_id = $1
          returning l.id, l.item_id as "itemId"`,
        [tenantId, listingId, itemId]);
    },
  };
}

module.exports = { createCatalogRepository };
