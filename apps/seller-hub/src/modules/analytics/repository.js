// @ts-check
"use strict";

// Pedido vale pela data da compra no fuso de São Paulo; cancelado ou devolvido não entra no faturamento.
const ORDER_DAY = "(o.ordered_at at time zone 'America/Sao_Paulo')::date";
const VALUE = "coalesce(o.products_total, o.total, 0)";
const LOST = "o.stage in ('cancelled','returned')";

/** @param {any} db */
function createAnalyticsRepository(db) {
  return {
    /**
     * Vendas por conta no período (datas inclusivas).
     * @param {string} tenantId @param {{ from: string, to: string, channel: string | null, accountId: number | null }} f
     */
    async salesByAccount(tenantId, { from, to, channel, accountId }) {
      const { rows } = await db.query(
        `select a.id as "accountId", a.channel, coalesce(a.nickname, a.label, a.external_account_id) as account,
                (count(*) filter (where not ${LOST}))::int as orders,
                coalesce(sum(${VALUE}) filter (where not ${LOST}), 0)::float as gmv,
                (count(*) filter (where ${LOST}))::int as "cancelledOrders",
                coalesce(sum(${VALUE}) filter (where ${LOST}), 0)::float as "cancelledValue"
           from hub.channel_accounts a
           join hub.channel_orders o on o.channel_account_id = a.id
          where a.tenant_id = $1 and ${ORDER_DAY} between $2::date and $3::date
            and ($4::text is null or a.channel = $4) and ($5::bigint is null or a.id = $5)
          group by a.id
          order by gmv desc`,
        [tenantId, from, to, channel, accountId]);
      return rows;
    },

    /**
     * Vendas por produto e canal no período. Produto = item do Hub (SKU da empresa);
     * linha sem vínculo fica pelo SKU do canal (ou pelo anúncio, se não houver SKU).
     * @param {string} tenantId @param {{ from: string, to: string, channel: string | null, accountId: number | null }} f
     */
    async productSales(tenantId, { from, to, channel, accountId }) {
      const { rows } = await db.query(
        `select case when ol.item_id is not null then 'i:' || ol.item_id
                     else 'c:' || a.channel || ':' || coalesce(nullif(ol.channel_sku, ''), ol.listing_id) end as key,
                ol.item_id as "itemId",
                coalesce(i.sku, nullif(ol.channel_sku, ''), ol.listing_id) as sku,
                coalesce(i.name, max(ol.title)) as name,
                a.channel,
                sum(ol.quantity)::float as units,
                -- Sem preço unitário (alguns canais), pedido de uma linha só usa o total do pedido.
                coalesce(sum(coalesce(ol.quantity * ol.unit_price, case when lc.n = 1 then ${VALUE} end)), 0)::float as revenue,
                count(distinct o.id)::int as orders
           from hub.order_lines ol
           join hub.channel_orders o on o.id = ol.order_id
           join hub.channel_accounts a on a.id = o.channel_account_id
           left join hub.items i on i.id = ol.item_id
           join lateral (select count(*) as n from hub.order_lines x where x.order_id = o.id) lc on true
          where a.tenant_id = $1 and ${ORDER_DAY} between $2::date and $3::date and not ${LOST}
            and ($4::text is null or a.channel = $4) and ($5::bigint is null or a.id = $5)
          group by 1, 2, 3, i.name, a.channel`,
        [tenantId, from, to, channel, accountId]);
      return rows;
    },
  };
}

module.exports = { createAnalyticsRepository };
