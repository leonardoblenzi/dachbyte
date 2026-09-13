"use strict";

const { createId } = require("../../id");
const { insertAuditWithClient, insertEventWithClient } = require("./persistenceHelpers");

async function stockTotalsWithClient(client, companyId, productId) {
  const result = await client.query(`
    select
      coalesce((select sum(quantity) from volt_core.inventory_movements where company_id=$1 and product_id=$2),0)::numeric as physical,
      coalesce((select sum(quantity) from volt_core.stock_reservations where company_id=$1 and product_id=$2 and status='active'),0)::numeric as reserved;
  `, [companyId, productId]);
  const physical = Number(result.rows[0]?.physical || 0);
  const reserved = Number(result.rows[0]?.reserved || 0);
  return { physical, reserved, available: physical - reserved };
}

async function assertAvailableStockWithClient(client, companyId, productId, requested, message = "Estoque disponivel insuficiente") {
  const totals = await stockTotalsWithClient(client, companyId, productId);
  if (totals.available + 1e-9 < Number(requested || 0)) {
    const error = new Error(message);
    error.statusCode = 409;
    error.code = "INSUFFICIENT_AVAILABLE_STOCK";
    error.details = { productId, requested: Number(requested || 0), ...totals };
    throw error;
  }
  return totals;
}

function aggregateTrackedItems(items = []) {
  const quantities = new Map();
  for (const item of items) {
    if (!item?.product?.trackStock) continue;
    const productId = item.product.id;
    quantities.set(productId, (quantities.get(productId) || 0) + Number(item.quantity || 0));
  }
  return quantities;
}

async function createSaleReservationsWithClient(client, companyId, sale, items, actorUserId) {
  const quantities = aggregateTrackedItems(items);
  const created = [];
  for (const [productId, quantity] of quantities) {
    const id = createId("res");
    const result = await client.query(`
      insert into volt_core.stock_reservations (
        id, company_id, product_id, sale_id, quantity, status, actor_user_id, metadata
      ) values ($1,$2,$3,$4,$5,'active',$6,$7::jsonb)
      on conflict (company_id,sale_id,product_id) do update
        set quantity=excluded.quantity, status='active', released_at=null, release_reason=null,
            actor_user_id=excluded.actor_user_id, metadata=excluded.metadata, updated_at=now()
      returning id,product_id as "productId",sale_id as "saleId",quantity,status,reserved_at as "reservedAt";
    `, [id, companyId, productId, sale.id, quantity, actorUserId || null, JSON.stringify({ saleNumber: sale.number })]);
    const reservation = result.rows[0];
    created.push(reservation);
    await insertEventWithClient(client, companyId, "stock.reserved", { reservationId: reservation.id, saleId: sale.id, productId, quantity });
    await insertAuditWithClient(client, companyId, actorUserId, "stock.reserved", "stock_reservation", reservation.id, null, reservation, { saleId: sale.id });
  }
  return created;
}

async function releaseSaleReservationsWithClient(client, companyId, saleId, actorUserId, reason = "sale_canceled") {
  const current = await client.query(`
    select id,product_id as "productId",quantity,status
    from volt_core.stock_reservations
    where company_id=$1 and sale_id=$2 and status='active'
    for update;
  `, [companyId, saleId]);
  if (!current.rowCount) return [];
  const result = await client.query(`
    update volt_core.stock_reservations
    set status='released',released_at=now(),release_reason=$3,actor_user_id=coalesce($4,actor_user_id),updated_at=now()
    where company_id=$1 and sale_id=$2 and status='active'
    returning id,product_id as "productId",quantity,status,released_at as "releasedAt",release_reason as "releaseReason";
  `, [companyId, saleId, reason, actorUserId || null]);
  for (const reservation of result.rows) {
    await insertEventWithClient(client, companyId, "stock.reservation_released", { reservationId: reservation.id, saleId, productId: reservation.productId, quantity: Number(reservation.quantity), reason });
    await insertAuditWithClient(client, companyId, actorUserId, "stock.reservation_released", "stock_reservation", reservation.id, current.rows.find((row) => row.id === reservation.id) || null, reservation, { saleId, reason });
  }
  return result.rows;
}

async function consumeSaleReservationsWithClient(client, companyId, sale, actorUserId, operationalAt) {
  const expectedResult = await client.query(`
    select si.product_id as "productId",sum(si.quantity)::numeric as quantity,p.name
    from volt_core.sale_items si
    join volt_core.products p on p.company_id=si.company_id and p.id=si.product_id and p.track_stock=true
    where si.company_id=$1 and si.sale_id=$2
    group by si.product_id,p.name
    order by si.product_id;
  `, [companyId, sale.id]);
  const reservations = await client.query(`
    select r.id,r.product_id as "productId",r.quantity,r.status,p.name,p.track_stock as "trackStock"
    from volt_core.stock_reservations r
    join volt_core.products p on p.company_id=r.company_id and p.id=r.product_id
    where r.company_id=$1 and r.sale_id=$2 and r.status='active'
    order by r.product_id
    for update of r, p;
  `, [companyId, sale.id]);
  const expectedByProduct = new Map(expectedResult.rows.map((row) => [row.productId, Number(row.quantity || 0)]));
  const reservedByProduct = new Map(reservations.rows.map((row) => [row.productId, Number(row.quantity || 0)]));
  for (const expected of expectedResult.rows) {
    const reserved = reservedByProduct.get(expected.productId);
    if (reserved == null || Math.abs(reserved - Number(expected.quantity || 0)) > 0.000001) {
      const error = new Error(`Reserva de estoque inconsistente para ${expected.name || "produto do pedido"}`);
      error.statusCode = 409;
      error.code = "STOCK_RESERVATION_MISSING_OR_INCONSISTENT";
      error.details = { productId: expected.productId, expected: Number(expected.quantity || 0), reserved: reserved ?? 0 };
      throw error;
    }
  }
  for (const reservation of reservations.rows) {
    const expected = expectedByProduct.get(reservation.productId);
    if (expected == null || Math.abs(expected - Number(reservation.quantity || 0)) > 0.000001) {
      const error = new Error(`Reserva de estoque inesperada para ${reservation.name || "produto do pedido"}`);
      error.statusCode = 409;
      error.code = "STOCK_RESERVATION_MISSING_OR_INCONSISTENT";
      error.details = { productId: reservation.productId, expected: expected ?? 0, reserved: Number(reservation.quantity || 0) };
      throw error;
    }
  }
  for (const reservation of reservations.rows) {
    const totals = await stockTotalsWithClient(client, companyId, reservation.productId);
    if (totals.physical + 1e-9 < Number(reservation.quantity)) {
      const error = new Error(`Estoque fisico insuficiente para entregar ${reservation.name || "o produto reservado"}`);
      error.statusCode = 409;
      error.code = "RESERVED_STOCK_PHYSICAL_SHORTAGE";
      error.details = { reservationId: reservation.id, ...totals, quantity: Number(reservation.quantity) };
      throw error;
    }
  }
  const consumed = [];
  for (const reservation of reservations.rows) {
    await client.query(`
      insert into volt_core.inventory_movements (
        id,company_id,product_id,type,quantity,reason,source_type,source_id,actor_user_id,operational_at
      ) values ($1,$2,$3,'exit',$4,$5,'sale',$6,$7,$8);
    `, [createId("inv"), companyId, reservation.productId, -Number(reservation.quantity), `Entrega venda #${sale.number}`, sale.id, actorUserId || null, operationalAt]);
    const result = await client.query(`
      update volt_core.stock_reservations
      set status='consumed',released_at=now(),release_reason='delivery_completed',actor_user_id=coalesce($3,actor_user_id),updated_at=now()
      where company_id=$1 and id=$2 and status='active'
      returning id,product_id as "productId",quantity,status,released_at as "releasedAt";
    `, [companyId, reservation.id, actorUserId || null]);
    const updated = result.rows[0];
    consumed.push(updated);
    await insertEventWithClient(client, companyId, "stock.reservation_consumed", { reservationId: reservation.id, saleId: sale.id, productId: reservation.productId, quantity: Number(reservation.quantity) });
    await insertAuditWithClient(client, companyId, actorUserId, "stock.reservation_consumed", "stock_reservation", reservation.id, reservation, updated, { saleId: sale.id });
  }
  return consumed;
}

module.exports = {
  assertAvailableStockWithClient,
  consumeSaleReservationsWithClient,
  createSaleReservationsWithClient,
  releaseSaleReservationsWithClient,
  stockTotalsWithClient,
};
