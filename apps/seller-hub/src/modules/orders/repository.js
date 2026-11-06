// @ts-check
"use strict";

/**
 * Situação padronizada do pedido (igual para todos os canais).
 * @typedef {"new" | "paid" | "invoiced" | "ready_to_ship" | "shipped" | "delivered" | "cancelled" | "returned"} OrderStage
 */
const STAGES = Object.freeze(["new", "paid", "invoiced", "ready_to_ship", "shipped", "delivered", "cancelled", "returned"]);

/**
 * Pedido no formato comum (todos os canais). Valores em reais.
 * - status: decide a baixa de estoque (open conta como venda; cancelled devolve).
 * - stage: andamento que o seller acompanha (novo → pago → faturado → pronto → enviado → entregue).
 * - productsTotal: valor dos produtos, sem frete (base da cobrança por %).
 * @typedef {{
 *   orderId: string, status: "open" | "cancelled", stage?: OrderStage, channelStatus?: string | null, fulfillment?: boolean,
 *   total?: number | null, productsTotal?: number | null, shippingPaid?: number | null, feesTotal?: number | null,
 *   discountTotal?: number | null, netTotal?: number | null,
 *   orderedAt?: string | Date | null, updatedAt?: string | Date | null, shipBy?: string | Date | null,
 *   shippedAt?: string | Date | null, deliveredAt?: string | Date | null,
 *   logisticType?: string | null, carrier?: string | null, trackingCode?: string | null, shipmentId?: string | null,
 *   invoiceNumber?: string | null, invoiceKey?: string | null,
 *   buyer?: { name?: string | null, city?: string | null, state?: string | null } | null,
 *   lines: Array<{ lineKey: string, listingId: string, variationId?: string, channelSku?: string | null, title?: string | null,
 *                  quantity: number, unitPrice?: number | null, saleFee?: number | null }>,
 * }} ChannelOrder
 */

/** Situação padrão quando o conector não informa. @param {ChannelOrder} order @returns {OrderStage} */
function stageOf(order) {
  if (order.status === "cancelled") return order.stage === "returned" ? "returned" : "cancelled";
  return order.stage && STAGES.includes(order.stage) ? order.stage : "paid";
}

/** Soma ignorando vazios (null se nada informado). @param {Array<number | null | undefined>} values */
function sumKnown(values) {
  const known = values.filter((v) => v != null && Number.isFinite(Number(v)));
  return known.length ? Math.round(known.reduce((s, v) => s + Number(v), 0) * 100) / 100 : null;
}

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
        const stage = stageOf(order);
        const productsTotal = order.productsTotal ?? sumKnown(order.lines.map((l) => (l.unitPrice == null ? null : Number(l.unitPrice) * Number(l.quantity))));
        const feesTotal = order.feesTotal ?? sumKnown(order.lines.map((l) => l.saleFee));
        // Líquido estimado quando o canal não informa: produtos − tarifas − descontos.
        const netTotal = order.netTotal ?? (productsTotal != null && feesTotal != null ? Math.round((productsTotal - feesTotal - Number(order.discountTotal || 0)) * 100) / 100 : null);
        const { rows: [previous] } = await client.query(
          "select id, stage from hub.channel_orders where channel_account_id = $1 and external_order_id = $2 for update", [accountId, String(order.orderId)]);
        const { rows: [saved] } = await client.query(
          `insert into hub.channel_orders (channel_account_id, external_order_id, status, channel_status, fulfillment, total, ordered_at, channel_updated_at,
                                           stage, stage_updated_at, products_total, shipping_paid, fees_total, discount_total, net_total, ship_by,
                                           shipped_at, delivered_at, cancelled_at, logistic_type, carrier, tracking_code, shipment_id,
                                           invoice_number, invoice_key, buyer_name, buyer_city, buyer_state)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), $10, $11, $12, $13, $14, $15,
                   coalesce($16::timestamptz, case when $9 in ('shipped','delivered') then now() end),
                   coalesce($17::timestamptz, case when $9 = 'delivered' then now() end),
                   case when $3 = 'cancelled' then now() end, $18, $19, $20, $21, $22, $23, $24, $25, $26)
           on conflict (channel_account_id, external_order_id) do update set
             status = excluded.status, channel_status = excluded.channel_status, fulfillment = excluded.fulfillment,
             total = excluded.total, ordered_at = coalesce(hub.channel_orders.ordered_at, excluded.ordered_at),
             channel_updated_at = excluded.channel_updated_at, updated_at = now(),
             stage = excluded.stage,
             stage_updated_at = case when hub.channel_orders.stage is distinct from excluded.stage then now() else hub.channel_orders.stage_updated_at end,
             products_total = coalesce(excluded.products_total, hub.channel_orders.products_total),
             shipping_paid = coalesce(excluded.shipping_paid, hub.channel_orders.shipping_paid),
             fees_total = coalesce(excluded.fees_total, hub.channel_orders.fees_total),
             discount_total = coalesce(excluded.discount_total, hub.channel_orders.discount_total),
             net_total = coalesce(excluded.net_total, hub.channel_orders.net_total),
             ship_by = coalesce(excluded.ship_by, hub.channel_orders.ship_by),
             shipped_at = coalesce(hub.channel_orders.shipped_at, excluded.shipped_at),
             delivered_at = coalesce(hub.channel_orders.delivered_at, excluded.delivered_at),
             cancelled_at = case when excluded.status = 'cancelled' then coalesce(hub.channel_orders.cancelled_at, now()) else null end,
             logistic_type = coalesce(excluded.logistic_type, hub.channel_orders.logistic_type),
             carrier = coalesce(excluded.carrier, hub.channel_orders.carrier),
             tracking_code = coalesce(excluded.tracking_code, hub.channel_orders.tracking_code),
             shipment_id = coalesce(excluded.shipment_id, hub.channel_orders.shipment_id),
             invoice_number = coalesce(excluded.invoice_number, hub.channel_orders.invoice_number),
             invoice_key = coalesce(excluded.invoice_key, hub.channel_orders.invoice_key),
             buyer_name = coalesce(excluded.buyer_name, hub.channel_orders.buyer_name),
             buyer_city = coalesce(excluded.buyer_city, hub.channel_orders.buyer_city),
             buyer_state = coalesce(excluded.buyer_state, hub.channel_orders.buyer_state)
           returning id`,
          [accountId, String(order.orderId), order.status, order.channelStatus || null, Boolean(order.fulfillment), order.total ?? null, order.orderedAt || null, order.updatedAt || null,
            stage, productsTotal, order.shippingPaid ?? null, feesTotal, order.discountTotal ?? null, netTotal, order.shipBy || null,
            order.shippedAt || null, order.deliveredAt || null, order.logisticType || null, order.carrier || null, order.trackingCode || null, order.shipmentId || null,
            order.invoiceNumber || null, order.invoiceKey || null, order.buyer?.name || null, order.buyer?.city || null, order.buyer?.state || null]);
        // Linha do tempo: recebido e cada mudança de situação.
        if (!previous) await client.query("insert into hub.order_events (order_id, kind, stage, channel_status) values ($1, 'received', $2, $3)", [saved.id, stage, order.channelStatus || null]);
        else if (previous.stage !== stage) await client.query("insert into hub.order_events (order_id, kind, stage, channel_status) values ($1, 'stage', $2, $3)", [saved.id, stage, order.channelStatus || null]);
        await client.query(
          `insert into hub.order_lines (order_id, line_key, listing_id, variation_id, channel_sku, title, quantity, unit_price, sale_fee, item_id)
           select $1, x.line_key, x.listing_id, coalesce(x.variation_id, ''), x.channel_sku, x.title, x.quantity, x.unit_price, x.sale_fee,
                  (select l.item_id from hub.listings l
                    where l.channel_account_id = $2 and l.listing_id = x.listing_id and l.variation_id in (coalesce(x.variation_id, ''), '')
                    order by (l.variation_id = coalesce(x.variation_id, '')) desc limit 1)
             from jsonb_to_recordset($3::jsonb) as x(line_key text, listing_id text, variation_id text, channel_sku text, title text, quantity numeric, unit_price numeric, sale_fee numeric)
           on conflict (order_id, line_key) do update set
             quantity = excluded.quantity, unit_price = excluded.unit_price, title = excluded.title, channel_sku = excluded.channel_sku,
             sale_fee = coalesce(excluded.sale_fee, hub.order_lines.sale_fee),
             item_id = coalesce(hub.order_lines.item_id, excluded.item_id)`,
          [saved.id, accountId, JSON.stringify(order.lines.map((l) => ({
            line_key: l.lineKey, listing_id: String(l.listingId), variation_id: l.variationId ? String(l.variationId) : "", channel_sku: l.channelSku || null,
            title: l.title || null, quantity: l.quantity, unit_price: l.unitPrice ?? null, sale_fee: l.saleFee ?? null,
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

    /** Evento na linha do tempo (ex.: baixa de estoque). @param {number} orderId @param {string} note */
    async addStockEvent(orderId, note) {
      await db.query("insert into hub.order_events (order_id, kind, note) values ($1, 'stock', $2)", [orderId, note]);
    },

    /**
     * Lista da central de pedidos. Filtros: situação, conta, período (data do pedido), busca (pedido, SKU, comprador,
     * rastreio, NF), atrasados (prazo de envio vencido) e vencendo (prazo nas próximas 24h).
     * @param {string} tenantId
     * @param {{ stage?: string, accountId?: number | null, from?: string | null, to?: string | null, q?: string,
     *           due?: "" | "late" | "today", pendingOnly?: boolean, limit?: number, offset?: number }} [options]
     */
    async searchOrders(tenantId, { stage = "", accountId = null, from = null, to = null, q = "", due = "", pendingOnly = false, limit = 50, offset = 0 } = {}) {
      const term = String(q || "").trim();
      const { rows } = await db.query(
        `with base as (
           select o.*, a.channel, coalesce(a.label, a.external_account_id) as account
             from hub.channel_orders o join hub.channel_accounts a on a.id = o.channel_account_id
            where a.tenant_id = $1
              and ($2 = '' or o.stage = $2)
              and ($3::bigint is null or a.id = $3)
              and ($4::timestamptz is null or o.ordered_at >= $4)
              and ($5::timestamptz is null or o.ordered_at < $5)
              and ($6 = '' or o.external_order_id ilike '%' || $6 || '%' or coalesce(o.buyer_name, '') ilike '%' || $6 || '%'
                   or coalesce(o.tracking_code, '') = $6 or coalesce(o.invoice_number, '') = $6
                   or exists (select 1 from hub.order_lines ol left join hub.items i on i.id = ol.item_id
                               where ol.order_id = o.id and (coalesce(ol.channel_sku, '') ilike '%' || $6 || '%' or coalesce(i.sku, '') ilike '%' || $6 || '%')))
              and ($7 = '' or (o.stage in ('new','paid','invoiced','ready_to_ship') and o.ship_by is not null
                   and (($7 = 'late' and o.ship_by < now()) or ($7 = 'today' and o.ship_by >= now() and o.ship_by < now() + interval '24 hours'))))
              and (not $8 or exists (select 1 from hub.order_lines ol where ol.order_id = o.id and ol.pending_link)))
         select b.id, b.channel, b.account, b.external_order_id as "orderId", b.status, b.stage, b.channel_status as "channelStatus",
                b.fulfillment, b.total::float as total, b.products_total::float as "productsTotal", b.shipping_paid::float as "shippingPaid",
                b.fees_total::float as "feesTotal", b.net_total::float as "netTotal", b.ordered_at as "orderedAt", b.ship_by as "shipBy",
                b.tracking_code as "trackingCode", b.invoice_number as "invoiceNumber", b.buyer_name as "buyerName", b.logistic_type as "logisticType",
                (select json_agg(json_build_object('sku', coalesce(i.sku, ol.channel_sku), 'title', ol.title, 'quantity', ol.quantity::float,
                  'listingId', ol.listing_id, 'variationId', ol.variation_id, 'pending', ol.pending_link, 'applied', ol.sale_applied,
                  'returned', ol.cancel_applied) order by ol.id)
                   from hub.order_lines ol left join hub.items i on i.id = ol.item_id where ol.order_id = b.id) as lines,
                exists (select 1 from hub.order_lines ol where ol.order_id = b.id and ol.pending_link) as "hasPending",
                count(*) over ()::int as "totalCount"
           from base b
          order by b.ordered_at desc nulls last, b.id desc
          limit $9 offset $10`,
        [tenantId, stage, accountId, from, to, term, due, pendingOnly, Math.min(5000, Math.max(1, limit)), Math.max(0, offset)]);
      return rows;
    },

    /** Contagem por situação e prazos (cabeçalho da central). @param {string} tenantId */
    async ordersSummary(tenantId) {
      return db.queryOne(
        `select
           count(*) filter (where o.stage = 'new')::int as new,
           count(*) filter (where o.stage = 'paid')::int as paid,
           count(*) filter (where o.stage = 'invoiced')::int as invoiced,
           count(*) filter (where o.stage = 'ready_to_ship')::int as "readyToShip",
           count(*) filter (where o.stage = 'shipped')::int as shipped,
           count(*) filter (where o.stage in ('new','paid','invoiced','ready_to_ship') and o.ship_by < now())::int as late,
           count(*) filter (where o.stage in ('new','paid','invoiced','ready_to_ship') and o.ship_by >= now() and o.ship_by < now() + interval '24 hours')::int as "dueToday"
           from hub.channel_orders o join hub.channel_accounts a on a.id = o.channel_account_id
          where a.tenant_id = $1 and not o.fulfillment`, [tenantId]);
    },

    /** Detalhe do pedido com itens e linha do tempo. @param {string} tenantId @param {number} id */
    async getOrderDetail(tenantId, id) {
      const order = await db.queryOne(
        `select o.id, a.channel, coalesce(a.label, a.external_account_id) as account, o.external_order_id as "orderId", o.status, o.stage,
                o.channel_status as "channelStatus", o.fulfillment, o.total::float as total, o.products_total::float as "productsTotal",
                o.shipping_paid::float as "shippingPaid", o.fees_total::float as "feesTotal", o.discount_total::float as "discountTotal",
                o.net_total::float as "netTotal", o.ordered_at as "orderedAt", o.ship_by as "shipBy", o.shipped_at as "shippedAt",
                o.delivered_at as "deliveredAt", o.cancelled_at as "cancelledAt", o.logistic_type as "logisticType", o.carrier,
                o.tracking_code as "trackingCode", o.shipment_id as "shipmentId", o.invoice_number as "invoiceNumber", o.invoice_key as "invoiceKey",
                o.buyer_name as "buyerName", o.buyer_city as "buyerCity", o.buyer_state as "buyerState"
           from hub.channel_orders o join hub.channel_accounts a on a.id = o.channel_account_id
          where o.id = $1 and a.tenant_id = $2`, [id, tenantId]);
      if (!order) return null;
      const [lines, events] = await Promise.all([
        db.query(
          `select ol.id, ol.listing_id as "listingId", ol.variation_id as "variationId", ol.channel_sku as "channelSku", ol.title,
                  ol.quantity::float as quantity, ol.unit_price::float as "unitPrice", ol.sale_fee::float as "saleFee",
                  ol.sale_applied as "saleApplied", ol.cancel_applied as "cancelApplied", ol.pending_link as "pendingLink",
                  i.id as "itemId", i.sku, i.name as "itemName"
             from hub.order_lines ol left join hub.items i on i.id = ol.item_id where ol.order_id = $1 order by ol.id`, [id]),
        db.query(`select kind, stage, channel_status as "channelStatus", note, created_at as "createdAt" from hub.order_events where order_id = $1 order by id`, [id]),
      ]);
      return { ...order, lines: lines.rows, events: events.rows };
    },

    /**
     * Vendas do mês (base da cobrança): pedidos do mês (fuso de São Paulo) que não foram cancelados/devolvidos,
     * pelo valor dos produtos sem frete. Créditos: pedidos de meses já fechados cancelados neste mês, depois
     * do fechamento (cancelado antes de fechar nunca entrou na base, então não gera crédito).
     * @param {string} tenantId @param {string} month "YYYY-MM-01"
     */
    async gmvMonth(tenantId, month) {
      return db.queryOne(
        `with o as (
           select o.*, coalesce(o.products_total, o.total, 0) as value,
                  date_trunc('month', o.ordered_at at time zone 'America/Sao_Paulo')::date as om,
                  date_trunc('month', o.cancelled_at at time zone 'America/Sao_Paulo')::date as cm
             from hub.channel_orders o join hub.channel_accounts a on a.id = o.channel_account_id where a.tenant_id = $1)
         select
           (select count(*)::int from o where om = $2::date and stage not in ('cancelled','returned')) as orders,
           (select coalesce(sum(value), 0)::float from o where om = $2::date and stage not in ('cancelled','returned')) as gmv,
           (select count(*)::int from o where om = $2::date and stage in ('cancelled','returned')) as "cancelledOrders",
           (select coalesce(sum(value), 0)::float from o where cm = $2::date and om < $2::date
              and exists (select 1 from hub.gmv_closings c where c.tenant_id = $1 and c.month = o.om and o.cancelled_at > c.closed_at)) as credits,
           (select row_to_json(c) from (select orders, gmv::float, credits::float, closed_at as "closedAt" from hub.gmv_closings where tenant_id = $1 and month = $2::date) c) as closing`,
        [tenantId, month]);
    },

    /** Extrato: pedidos que entram (ou saem, como crédito) na base do mês. @param {string} tenantId @param {string} month @param {{ limit?: number, offset?: number }} [options] */
    async gmvStatement(tenantId, month, { limit = 100, offset = 0 } = {}) {
      const { rows } = await db.query(
        `select o.id, a.channel, coalesce(a.label, a.external_account_id) as account, o.external_order_id as "orderId", o.stage,
                o.ordered_at as "orderedAt", o.cancelled_at as "cancelledAt", coalesce(o.products_total, o.total, 0)::float as value,
                case when date_trunc('month', o.ordered_at at time zone 'America/Sao_Paulo')::date = $2::date
                     then case when o.stage in ('cancelled','returned') then 'excluded' else 'counted' end
                     else 'credit' end as kind
           from hub.channel_orders o join hub.channel_accounts a on a.id = o.channel_account_id
          where a.tenant_id = $1 and (
                date_trunc('month', o.ordered_at at time zone 'America/Sao_Paulo')::date = $2::date
             or (date_trunc('month', o.cancelled_at at time zone 'America/Sao_Paulo')::date = $2::date
                 and date_trunc('month', o.ordered_at at time zone 'America/Sao_Paulo')::date < $2::date
                 and exists (select 1 from hub.gmv_closings c where c.tenant_id = $1 and o.cancelled_at > c.closed_at
                              and c.month = date_trunc('month', o.ordered_at at time zone 'America/Sao_Paulo')::date)))
          order by o.ordered_at desc, o.id desc limit $3 offset $4`,
        [tenantId, month, Math.min(5000, Math.max(1, limit)), Math.max(0, offset)]);
      return rows;
    },

    /** Fecha o mês (uma vez; não muda depois). @param {string} tenantId @param {string} month */
    async closeMonth(tenantId, month) {
      const m = await this.gmvMonth(tenantId, month);
      return db.queryOne(
        `insert into hub.gmv_closings (tenant_id, month, orders, gmv, credits) values ($1, $2, $3, $4, $5)
         on conflict (tenant_id, month) do nothing returning month, orders, gmv::float, credits::float`,
        [tenantId, month, m.orders, m.gmv, m.credits]);
    },

    /** Empresas com pedidos em meses ainda não fechados (antes do mês atual). @param {string} currentMonth */
    async monthsToClose(currentMonth) {
      const { rows } = await db.query(
        `select distinct a.tenant_id as "tenantId", to_char(date_trunc('month', o.ordered_at at time zone 'America/Sao_Paulo'), 'YYYY-MM-DD') as month
           from hub.channel_orders o join hub.channel_accounts a on a.id = o.channel_account_id
          where date_trunc('month', o.ordered_at at time zone 'America/Sao_Paulo')::date < $1::date
            and not exists (select 1 from hub.gmv_closings c where c.tenant_id = a.tenant_id
                             and c.month = date_trunc('month', o.ordered_at at time zone 'America/Sao_Paulo')::date)
          order by 2`, [currentMonth]);
      return rows;
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

module.exports = { createOrdersRepository, STAGES, stageOf };
