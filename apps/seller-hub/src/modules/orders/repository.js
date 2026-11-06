// @ts-check
"use strict";

/**
 * Pedido no formato comum (todos os canais).
 * @typedef {{
 *   orderId: string, status: "open" | "cancelled", channelStatus?: string | null, fulfillment?: boolean,
 *   total?: number | null, orderedAt?: string | Date | null, updatedAt?: string | Date | null,
 *   lines: Array<{ lineKey: string, listingId: string, variationId?: string, channelSku?: string | null, title?: string | null, quantity: number, unitPrice?: number | null }>,
 * }} ChannelOrder
 */

/**
 * Pedidos, itens e notificações (schema hub).
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<any>, queryOne: (sql: string, params?: unknown[]) => Promise<any>,
 *           transaction: (work: (client: any) => Promise<any>) => Promise<any> }} db
 */
function createOrdersRepository(db) {
  const LINE_COLUMNS = `l.id, l.line_key as "lineKey", l.listing_id as "listingId", l.variation_id as "variationId", l.quantity::float as quantity,
    l.item_id as "itemId", l.sale_applied as "saleApplied", l.cancel_applied as "cancelApplied", l.pending_link as "pendingLink",
    exists (select 1 from hub.listings h join hub.channel_orders co on co.id = l.order_id
             where h.channel_account_id = co.channel_account_id and h.listing_id = l.listing_id
               and h.variation_id in (l.variation_id, '') and h.fulfillment) as "listingFulfillment"`;

  return {
    /** Conta conectada pelo id externo (webhook). @param {string} channel @param {string} externalAccountId */
    async findAccountByExternal(channel, externalAccountId) {
      return db.queryOne(
        `select id, tenant_id as "tenantId", channel, external_account_id as "externalAccountId", status
           from hub.channel_accounts where channel = $1 and external_account_id = $2 and status <> 'disconnected'`, [channel, String(externalAccountId)]);
    },

    /** @param {number} accountId */
    async getAccount(accountId) {
      return db.queryOne(
        `select id, tenant_id as "tenantId", channel, external_account_id as "externalAccountId", status,
                stock_sync_mode as "mode", orders_synced_at as "ordersSyncedAt"
           from hub.channel_accounts where id = $1`, [accountId]);
    },

    /** Contas lidas pelo polling de segurança. */
    async pollableAccounts() {
      const { rows } = await db.query(
        `select id, tenant_id as "tenantId", channel, orders_synced_at as "ordersSyncedAt" from hub.channel_accounts where status = 'connected' order by id`);
      return rows;
    },

    /** @param {number} accountId @param {Date} at */
    async setOrdersSyncedAt(accountId, at) {
      await db.query("update hub.channel_accounts set orders_synced_at = $2 where id = $1", [accountId, at]);
    },

    /**
     * Grava o pedido e os itens. O vínculo do item vem do anúncio importado (mesma conta, anúncio e
     * variação; sem variação no Hub, vale o anúncio "pai"). Marcas de baixa já aplicadas são mantidas.
     * @param {number} accountId @param {ChannelOrder} order
     */
    async upsertOrder(accountId, order) {
      return db.transaction(async (client) => {
        const { rows: [saved] } = await client.query(
          `insert into hub.channel_orders (channel_account_id, external_order_id, status, channel_status, fulfillment, total, ordered_at, channel_updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           on conflict (channel_account_id, external_order_id) do update set
             status = excluded.status, channel_status = excluded.channel_status, fulfillment = excluded.fulfillment,
             total = excluded.total, ordered_at = coalesce(hub.channel_orders.ordered_at, excluded.ordered_at),
             channel_updated_at = excluded.channel_updated_at, updated_at = now()
           returning id`,
          [accountId, String(order.orderId), order.status, order.channelStatus || null, Boolean(order.fulfillment), order.total ?? null, order.orderedAt || null, order.updatedAt || null]);
        await client.query(
          `insert into hub.order_lines (order_id, line_key, listing_id, variation_id, channel_sku, title, quantity, unit_price, item_id)
           select $1, x.line_key, x.listing_id, coalesce(x.variation_id, ''), x.channel_sku, x.title, x.quantity, x.unit_price,
                  (select l.item_id from hub.listings l
                    where l.channel_account_id = $2 and l.listing_id = x.listing_id and l.variation_id in (coalesce(x.variation_id, ''), '')
                    order by (l.variation_id = coalesce(x.variation_id, '')) desc limit 1)
             from jsonb_to_recordset($3::jsonb) as x(line_key text, listing_id text, variation_id text, channel_sku text, title text, quantity numeric, unit_price numeric)
           on conflict (order_id, line_key) do update set
             quantity = excluded.quantity, unit_price = excluded.unit_price, title = excluded.title, channel_sku = excluded.channel_sku,
             item_id = coalesce(hub.order_lines.item_id, excluded.item_id)`,
          [saved.id, accountId, JSON.stringify(order.lines.map((l) => ({
            line_key: l.lineKey, listing_id: String(l.listingId), variation_id: l.variationId ? String(l.variationId) : "", channel_sku: l.channelSku || null,
            title: l.title || null, quantity: l.quantity, unit_price: l.unitPrice ?? null,
          })))]);
        const { rows: lines } = await client.query(`select ${LINE_COLUMNS} from hub.order_lines l where l.order_id = $1 order by l.id`, [saved.id]);
        return { id: Number(saved.id), lines };
      });
    },

    /** Kits e componentes dos itens informados. @param {string} tenantId @param {number[]} itemIds */
    async itemsWithComponents(tenantId, itemIds) {
      const { rows } = await db.query(
        `select i.id, i.kind,
                coalesce((select json_agg(json_build_object('itemId', k.component_item_id, 'quantity', k.quantity::float))
                            from hub.kit_components k where k.kit_item_id = i.id), '[]') as components
           from hub.items i where i.tenant_id = $1 and i.id = any($2::bigint[])`, [tenantId, itemIds]);
      return rows;
    },

    /** @param {number[]} lineIds @param {{ saleApplied?: boolean, cancelApplied?: boolean, pendingLink?: boolean }} flags */
    async markLines(lineIds, flags) {
      if (!lineIds.length) return;
      await db.query(
        `update hub.order_lines set
           sale_applied = coalesce($2, sale_applied), cancel_applied = coalesce($3, cancel_applied), pending_link = coalesce($4, pending_link)
         where id = any($1::bigint[])`,
        [lineIds, flags.saleApplied ?? null, flags.cancelApplied ?? null, flags.pendingLink ?? null]);
    },

    /**
     * Vendas sem vínculo do anúncio que acabou de ser vinculado: passa a ter o item e volta para a baixa.
     * @param {string} tenantId @param {number} listingDbId
     */
    async claimPendingForListing(tenantId, listingDbId) {
      const { rows } = await db.query(
        `update hub.order_lines ol set item_id = l.item_id
           from hub.listings l, hub.channel_orders o, hub.channel_accounts a
          where l.id = $2 and l.item_id is not null and a.id = l.channel_account_id and a.tenant_id = $1
            and o.id = ol.order_id and o.channel_account_id = l.channel_account_id
            and ol.listing_id = l.listing_id and ol.variation_id in (l.variation_id, '') and ol.pending_link
         returning ol.order_id`, [tenantId, listingDbId]);
      return [...new Set(rows.map((/** @type {any} */ r) => Number(r.order_id)))];
    },

    /** Pedido com itens (para reaplicar a baixa). @param {number} orderId */
    async getOrderWithLines(orderId) {
      const order = await db.queryOne(
        `select o.id, o.external_order_id as "orderId", o.status, o.fulfillment, a.id as "accountId", a.tenant_id as "tenantId"
           from hub.channel_orders o join hub.channel_accounts a on a.id = o.channel_account_id where o.id = $1`, [orderId]);
      if (!order) return null;
      const { rows } = await db.query(`select ${LINE_COLUMNS} from hub.order_lines l where l.order_id = $1 order by l.id`, [orderId]);
      return { ...order, lines: rows };
    },

    /** @param {string} tenantId @param {{ pendingOnly?: boolean, limit?: number, offset?: number }} [options] */
    async listOrders(tenantId, { pendingOnly = false, limit = 50, offset = 0 } = {}) {
      const { rows } = await db.query(
        `select o.id, a.channel, coalesce(a.label, a.external_account_id) as account, o.external_order_id as "orderId", o.status,
                o.channel_status as "channelStatus", o.fulfillment, o.total::float as total, o.ordered_at as "orderedAt",
                json_agg(json_build_object('sku', coalesce(i.sku, ol.channel_sku), 'title', ol.title, 'quantity', ol.quantity::float,
                  'listingId', ol.listing_id, 'variationId', ol.variation_id, 'pending', ol.pending_link, 'applied', ol.sale_applied,
                  'returned', ol.cancel_applied) order by ol.id) as lines,
                bool_or(ol.pending_link) as "hasPending"
           from hub.channel_orders o
           join hub.channel_accounts a on a.id = o.channel_account_id and a.tenant_id = $1
           join hub.order_lines ol on ol.order_id = o.id
           left join hub.items i on i.id = ol.item_id
          group by o.id, a.id
         having (not $2 or bool_or(ol.pending_link))
          order by o.ordered_at desc nulls last, o.id desc
          limit $3 offset $4`,
        [tenantId, pendingOnly, Math.min(200, Math.max(1, limit)), Math.max(0, offset)]);
      return rows;
    },

    /**
     * Guarda a notificação (reenvio em rajada cai no mesmo dedupe_key). Devolve null se já existia.
     * @param {{ channel: string, externalAccountId: string | null, topic: string, resourceId: string, dedupeKey: string, payload?: any }} event
     */
    async insertWebhook(event) {
      return db.queryOne(
        `insert into hub.webhook_events (channel, external_account_id, topic, resource_id, dedupe_key, payload)
         values ($1, $2, $3, $4, $5, $6) on conflict (dedupe_key) do nothing returning id`,
        [event.channel, event.externalAccountId, event.topic, event.resourceId, event.dedupeKey, JSON.stringify(event.payload || {})]);
    },

    /** @param {number} id */
    async getWebhook(id) {
      return db.queryOne(
        `select id, channel, external_account_id as "externalAccountId", topic, resource_id as "resourceId", status, attempts
           from hub.webhook_events where id = $1`, [id]);
    },

    /** @param {number} id @param {"processed" | "ignored" | "failed"} status @param {string | null} [error] */
    async markWebhook(id, status, error = null) {
      await db.query(
        "update hub.webhook_events set status = $2, error = $3, attempts = attempts + 1, processed_at = now() where id = $1",
        [id, status, error ? String(error).slice(0, 500) : null]);
    },
  };
}

module.exports = { createOrdersRepository };
