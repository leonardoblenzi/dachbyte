"use strict";

const {
  insertWorkflowEventWithClient,
} = require("../../../platform/extensions/coreContracts");
const { createOpticalOrderWithClient } = require("./opticalService");

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function afterSaleCreated({ client, companyId, sale, customer, items, extensionPayloads, actorUserId }) {
  const optical = extensionPayloads?.["vertical.optical"];
  if (!optical) return null;
  const opticalOrder = await createOpticalOrderWithClient(client, companyId, sale, customer, items, optical, actorUserId);
  const html = [
    `<h2>Pedido optico OP-${opticalOrder.number}</h2>`,
    `<p>OS-${opticalOrder.serviceOrderNumber} | Entrega: ${escapeHtml(opticalOrder.promisedDate || "A definir")}</p>`,
    `<p>Medidas: DNP OD ${escapeHtml(optical?.measurements?.rightDnp || "-")} / DNP OE ${escapeHtml(optical?.measurements?.leftDnp || "-")} | Alturas ${escapeHtml(optical?.measurements?.rightHeight || "-")} / ${escapeHtml(optical?.measurements?.leftHeight || "-")}</p>`,
  ].join("");
  return {
    response: { opticalOrder },
    receipt: {
      extensionPayload: { opticalOrder, optical },
      legacyPayload: { opticalOrder, optical },
      html,
    },
  };
}

async function decorateIdempotentResult({ client, companyId, sale }) {
  const opticalResult = await client.query(`
    select o.id, o.number, o.sale_id as "saleId", o.prescription_id as "prescriptionId",
      o.service_order_id as "serviceOrderId", so.number as "serviceOrderNumber", o.status,
      o.promised_date as "promisedDate"
    from volt_core.optical_orders o
    left join volt_core.service_orders so on so.id = o.service_order_id and so.company_id = o.company_id
    where o.company_id = $1 and o.sale_id = $2
    limit 1;
  `, [companyId, sale.id]);
  if (!opticalResult.rowCount) return null;
  return { response: { opticalOrder: opticalResult.rows[0] } };
}

async function beforeSaleUpdated({ client, companyId, saleId }) {
  const optical = await client.query(`
    select id
    from volt_core.optical_orders
    where company_id = $1 and sale_id = $2 and status <> 'canceled'
    limit 1;
  `, [companyId, saleId]);
  if (!optical.rowCount) return null;
  throw Object.assign(new Error("Venda optica com pedido em andamento deve ser cancelada e lancada novamente"), {
    statusCode: 409,
    code: "SALE_EDIT_OPTICAL_REQUIRES_CANCELLATION",
  });
}

async function decorateSaleRows({ client, companyId, rows }) {
  const sales = Array.isArray(rows) ? rows : [];
  const saleIds = sales.map((row) => row.id).filter(Boolean);
  if (!saleIds.length) return null;

  const result = await client.query(`
    select id, number, sale_id as "saleId", status, promised_date as "promisedDate", delivered_at as "deliveredAt"
    from volt_core.optical_orders
    where company_id = $1 and sale_id = any($2::text[])
  `, [companyId, saleIds]);
  const bySaleId = new Map(result.rows.map((row) => [String(row.saleId), row]));

  for (const sale of sales) {
    const order = bySaleId.get(String(sale.id));
    if (!order) continue;
    sale.extensions = {
      ...(sale.extensions || {}),
      "vertical.optical": {
        opticalOrderId: order.id,
        opticalOrderNumber: order.number,
        status: order.status,
        promisedDate: order.promisedDate || null,
        deliveredAt: order.deliveredAt || null,
      },
    };
    // Compatibility aliases consumed by the current client mapper.
    sale.opticalOrderId = order.id;
    sale.opticalOrderNumber = order.number;
    sale.opticalOrderStatus = order.status;
    sale.opticalPromisedDate = order.promisedDate || null;
    sale.fulfillmentReady = order.status === "ready";
  }
  return null;
}

async function resolveSaleListFilter({ filter }) {
  const key = String(filter || "").trim().toLowerCase();
  if (["pronto para retirada", "pronto_para_retirada"].includes(key)) {
    return {
      predicate: `s.status='pending_delivery' and exists (
        select 1 from volt_core.optical_orders o
        where o.company_id=s.company_id and o.sale_id=s.id and o.status='ready'
      )`,
    };
  }
  if (["em producao", "em_producao"].includes(key)) {
    return {
      predicate: `s.status='pending_delivery' and exists (
        select 1 from volt_core.optical_orders o
        where o.company_id=s.company_id and o.sale_id=s.id
          and o.status not in ('ready','delivered','canceled')
      )`,
    };
  }
  return null;
}

async function beforeSaleCanceled({ client, companyId, saleId, input }) {
  const opticalOrders = await client.query(
    "select id, status from volt_core.optical_orders where company_id = $1 and sale_id = $2 for update",
    [companyId, saleId],
  );
  if (!opticalOrders.rowCount) return null;
  const serviceOrders = await client.query(
    "select id, status from volt_core.service_orders where company_id = $1 and sale_id = $2 and optical_order_id is not null for update",
    [companyId, saleId],
  );
  await client.query("update volt_core.optical_orders set status = 'canceled', notes = coalesce($3,notes), updated_at = now() where company_id = $1 and sale_id = $2", [companyId, saleId, input.reason || null]);
  await client.query("update volt_core.service_orders set status = 'canceled', updated_at = now() where company_id = $1 and sale_id = $2 and optical_order_id is not null", [companyId, saleId]);
  for (const order of opticalOrders.rows) {
    if (order.status !== "canceled") {
      await insertWorkflowEventWithClient(client, companyId, "optical_order", "optical_order", order.id, order.status, "canceled", input.actorUserId, { source: "sale_cancel", saleId, reason: input.reason || null });
    }
  }
  return { metadata: { canceledOpticalOrders: opticalOrders.rowCount, canceledOpticalServiceOrders: serviceOrders.rowCount } };
}

async function afterDeliveryCompleted({ client, companyId, sale, actorUserId }) {
  const opticalResult = await client.query(`
    select id, number, status, service_order_id as "serviceOrderId"
    from volt_core.optical_orders
    where company_id = $1 and sale_id = $2
    limit 1
    for update;
  `, [companyId, sale.id]);
  if (!opticalResult.rowCount) return null;

  const opticalOrder = opticalResult.rows[0];
  if (opticalOrder.status !== "ready") {
    throw Object.assign(new Error("Pedido optico ainda nao esta pronto para retirada"), {
      statusCode: 409,
      code: "OPTICAL_ORDER_NOT_READY_FOR_DELIVERY",
    });
  }

  const serviceResult = opticalOrder.serviceOrderId ? await client.query(`
    select id, status
    from volt_core.service_orders
    where company_id = $1 and id = $2
    for update;
  `, [companyId, opticalOrder.serviceOrderId]) : { rowCount: 0, rows: [] };
  const serviceOrder = serviceResult.rows[0] || null;
  await client.query(`
    update volt_core.optical_orders set status = 'delivered', delivered_at = now(), updated_at = now()
    where company_id = $1 and id = $2;
  `, [companyId, opticalOrder.id]);
  if (serviceOrder) {
    await client.query(`
      update volt_core.service_orders set status = 'delivered', updated_at = now()
      where company_id = $1 and id = $2;
    `, [companyId, serviceOrder.id]);
  }
  await insertWorkflowEventWithClient(
    client,
    companyId,
    "optical_order",
    "optical_order",
    opticalOrder.id,
    opticalOrder.status,
    "delivered",
    actorUserId,
    { source: "sale_delivery", saleId: sale.id },
  );
  return { response: { opticalOrder: { ...opticalOrder, status: "delivered" } } };
}

async function beforeDeleteCanceledSale({ client, companyId, saleId }) {
  await client.query("delete from volt_core.optical_orders where company_id = $1 and sale_id = $2", [companyId, saleId]);
  await client.query("delete from volt_core.service_orders where company_id = $1 and sale_id = $2 and optical_order_id is not null", [companyId, saleId]);
  return null;
}

module.exports = {
  afterDeliveryCompleted,
  afterSaleCreated,
  beforeDeleteCanceledSale,
  beforeSaleCanceled,
  beforeSaleUpdated,
  decorateIdempotentResult,
  decorateSaleRows,
  resolveSaleListFilter,
};
