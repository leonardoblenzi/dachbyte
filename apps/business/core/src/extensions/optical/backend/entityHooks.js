"use strict";

const { db } = require("../../../platform/extensions/coreContracts");

async function customerDependencies({ client, companyId, entityId }) {
  const result = await client.query(`
    select
      (select count(*) from volt_core.optical_prescriptions where company_id=$1 and customer_id=$2) +
      (select count(*) from volt_core.optical_orders where company_id=$1 and customer_id=$2) as total
  `, [companyId, entityId]);
  return { count: Number(result.rows[0]?.total || 0) };
}

async function dashboardContribute({ companyId, client }) {
  const summary = await client.query(`
    select
      count(*) filter (where o.status not in ('ready','delivered','canceled'))::int as "inProduction",
      count(*) filter (where o.status='ready')::int as ready,
      count(*) filter (where o.status not in ('delivered','canceled') and o.promised_date is not null and o.promised_date<current_date)::int as late,
      count(*) filter (where o.status='delivered' and o.delivered_at::date=current_date)::int as "completedToday"
    from volt_core.optical_orders o
    where o.company_id=$1
  `, [companyId]);
  const row = summary.rows[0] || {};
  const inProduction = Number(row.inProduction || 0);
  const ready = Number(row.ready || 0);
  const late = Number(row.late || 0);
  const completedToday = Number(row.completedToday || 0);

  return {
    alerts: [
      ...(late ? [{
        kind: "extension",
        icon: "glasses",
        id: "optical-late-orders",
        title: `${late} pedido${late === 1 ? "" : "s"} com entrega atrasada`,
        detail: "A previsao de entrega ja passou e o pedido segue aberto.",
        meta: "Pedidos",
        page: "sales",
        permission: "sales:read",
        intent: { tab: "orders", filter: "Entrega atrasada" },
        priority: 2,
      }] : []),
      ...(ready ? [{
        kind: "extension",
        icon: "glasses",
        id: "optical-ready-orders",
        title: `${ready} pedido${ready === 1 ? "" : "s"} pronto${ready === 1 ? "" : "s"} para retirada`,
        detail: "Pedidos finalizados na producao aguardando o cliente.",
        meta: "Pedidos",
        page: "sales",
        permission: "sales:read",
        intent: { tab: "orders", filter: "Pronto para retirada" },
        priority: 3,
      }] : []),
    ],
    widgets: [{
      id: "optical-orders",
      title: "Pedidos",
      detail: "Operacao optica",
      icon: "glasses",
      page: "sales",
      permission: "sales:read",
      intent: { tab: "orders" },
      items: [
        { id: "in-production", label: "Em producao", value: inProduction, intent: { tab: "orders", filter: "Em producao" } },
        { id: "ready", label: "Prontos para retirada", value: ready, intent: { tab: "orders", filter: "Pronto para retirada" } },
        { id: "late", label: "Atrasados", value: late, tone: late ? "danger" : "default", intent: { tab: "orders", filter: "Entrega atrasada" } },
        { id: "completed-today", label: "Concluidos hoje", value: completedToday, intent: { tab: "orders", filter: "Concluido hoje" } },
      ],
    }],
  };
}

async function decorateServiceOrders({ client = db, companyId, rows }) {
  const items = Array.isArray(rows) ? rows : [];
  if (!items.length) return null;
  const ids = items.map((row) => row.id).filter(Boolean);
  const result = await client.query(`
    select id,optical_order_id as "opticalOrderId"
    from volt_core.service_orders
    where company_id=$1 and id=any($2::text[]) and optical_order_id is not null
  `, [companyId, ids]);
  const byId = new Map(result.rows.map((row) => [row.id, row.opticalOrderId]));
  for (const row of items) {
    if (byId.has(row.id)) {
      row.extensions = { ...(row.extensions || {}), "vertical.optical": { opticalOrderId: byId.get(row.id) } };
      row.opticalOrderId = byId.get(row.id); // compatibility alias
    }
  }
  return null;
}

async function resolveServiceOrderWorkflow({ client, companyId, serviceOrderId }) {
  const result = await client.query(
    "select optical_order_id as \"opticalOrderId\" from volt_core.service_orders where company_id=$1 and id=$2",
    [companyId, serviceOrderId],
  );
  return result.rows[0]?.opticalOrderId ? { workflowKey: "optical_order" } : null;
}

module.exports = { customerDependencies, dashboardContribute, decorateServiceOrders, resolveServiceOrderWorkflow };
