"use strict";

// Projecao mensal do Magalu: pedidos replicados agrupados por dia (fuso de Sao Paulo),
// filtrados pelos status do pedido escolhidos na tela.
const db = require("../config/postgres");
const ux = require("./uxAnalyticsRepository");

const VALUE_SQL = "case when o.amount_total is not null and coalesce(o.amount_normalizer,0)>0 then o.amount_total::numeric/o.amount_normalizer else 0 end";
const LOCAL_DAY_SQL = "(o.purchased_at at time zone 'America/Sao_Paulo')::date";

function statusFilter(statuses, params) {
  if (!Array.isArray(statuses) || !statuses.length) return "";
  params.push(statuses.map((value) => String(value).toLowerCase()));
  return ` and lower(coalesce(o.status,'')) = any($${params.length}::text[])`;
}

// Receita e pedidos por dia entre [from, to] (datas locais, inclusivas).
async function dailySeries(accountId, { from, to, statuses }) {
  const params = [Number(accountId), from, to];
  const where = statusFilter(statuses, params);
  const { rows } = await db.query(`select to_char(${LOCAL_DAY_SQL},'YYYY-MM-DD') as day,
      count(*)::int as orders, coalesce(sum(${VALUE_SQL}),0)::numeric as revenue
    from magalu.orders o
    where o.account_id=$1 and o.is_present=true and o.purchased_at is not null
      and ${LOCAL_DAY_SQL} >= $2::date and ${LOCAL_DAY_SQL} <= $3::date${where}
    group by 1 order by 1`, params);
  return rows.map((row) => ({ day: row.day, orders: Number(row.orders), revenue: Number(row.revenue) }));
}

// Pedidos e receita do periodo por status do pedido (todos os status, sem filtro).
async function statusBreakdown(accountId, { from, to }) {
  const { rows } = await db.query(`select coalesce(nullif(lower(o.status),''),'sem status') as status,
      count(*)::int as orders, coalesce(sum(${VALUE_SQL}),0)::numeric as revenue
    from magalu.orders o
    where o.account_id=$1 and o.is_present=true and o.purchased_at is not null
      and ${LOCAL_DAY_SQL} >= $2::date and ${LOCAL_DAY_SQL} <= $3::date
    group by 1 order by 2 desc`, [Number(accountId), from, to]);
  return rows.map((row) => ({ status: row.status, orders: Number(row.orders), revenue: Number(row.revenue) }));
}

// Receita do periodo por tipo de entrega: Full (Magalu Entregas Fulfillment) ou demais.
async function fulfillmentBreakdown(accountId, { from, to, statuses }) {
  const params = [Number(accountId), from, to];
  const where = statusFilter(statuses, params);
  const { rows } = await db.query(`select coalesce(d.full_delivery,false) as full_delivery,
      count(*)::int as orders, coalesce(sum(${VALUE_SQL}),0)::numeric as revenue
    from magalu.orders o
    left join lateral (select bool_or(coalesce(x.is_fulfillment,false)) as full_delivery from magalu.deliveries x
      where x.order_id=o.id and x.account_id=o.account_id and x.is_present=true) d on true
    where o.account_id=$1 and o.is_present=true and o.purchased_at is not null
      and ${LOCAL_DAY_SQL} >= $2::date and ${LOCAL_DAY_SQL} <= $3::date${where}
    group by 1`, params);
  const out = { full: { orders: 0, revenue: 0 }, other: { orders: 0, revenue: 0 } };
  for (const row of rows) {
    const key = row.full_delivery ? "full" : "other";
    out[key] = { orders: Number(row.orders), revenue: Number(row.revenue) };
  }
  return out;
}

// Unidades vendidas: itens dos pedidos (pedido, entrega ou relatorio financeiro).
function shiftDay(iso, days) { const d = new Date(`${iso}T00:00:00.000Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
async function unitsSold(accountId, { from, to, statuses }) {
  // A CTE de itens recorta por data em UTC: janela com 1 dia a mais de cada lado e
  // o recorte exato pelo dia local de Sao Paulo ($5..$6).
  const params = [Number(accountId), shiftDay(from, -1), shiftDay(to, 1), null, from, to];
  const where = statusFilter(statuses, params);
  const row = await db.queryOne(`${ux._test.marginOrderCte()}
    select coalesce(sum(si.quantity),0)::numeric as units
    from source_items si join magalu.orders o on o.id=si.order_id and o.account_id=si.account_id
    where (o.purchased_at at time zone 'America/Sao_Paulo')::date between $5::date and $6::date${where}`, params);
  return Number(row?.units || 0);
}

// Status do pedido que a API trouxe para a conta (base das opcoes do filtro).
async function availableStatuses(accountId) {
  const { rows } = await db.query(`select coalesce(nullif(lower(status),''),'sem status') as status, count(*)::int as orders
    from magalu.orders where account_id=$1 and is_present=true group by 1 order by 2 desc`, [Number(accountId)]);
  return rows.map((row) => ({ status: row.status, orders: Number(row.orders) }));
}

module.exports = { dailySeries, statusBreakdown, fulfillmentBreakdown, unitsSold, availableStatuses };
