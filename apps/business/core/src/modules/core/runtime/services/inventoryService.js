"use strict";

const db = require("../../../../../db/db");
const { createId } = require("../../id");
const { insertAuditWithClient, insertEventWithClient } = require("./persistenceHelpers");
const { stockTotalsWithClient } = require("./stockReservationService");

function toQuantity(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}
function assertPositive(value, message, code) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    const error = new Error(message); error.statusCode = 400; error.code = code; throw error;
  }
  return number;
}
async function findProductWithClient(client, companyId, productId, productName, lock = false) {
  const result = await client.query(`select id, sku, name, category, type, sale_price as "salePrice", cost_price as "costPrice",
      minimum_stock as "minimumStock", track_stock as "trackStock", active
    from volt_core.products where company_id = $1 and ($2::text is not null and id = $2 or $3::text is not null and lower(name) = lower($3) or $3::text is not null and lower(sku) = lower($3))
    order by number asc limit 1 ${lock ? "for update" : ""};`, [companyId, productId || null, productName || null]);
  return result.rows[0] || null;
}

async function getStockPosition(companyId) {
  const result = await db.query(`
    with physical as (
      select product_id, coalesce(sum(quantity), 0)::numeric as quantity
      from volt_core.inventory_movements
      where company_id = $1
      group by product_id
    ), reserved as (
      select product_id, coalesce(sum(quantity), 0)::numeric as quantity
      from volt_core.stock_reservations
      where company_id = $1 and status = 'active'
      group by product_id
    )
    select
      p.id as "productId",
      p.sku,
      p.name,
      p.category,
      p.minimum_stock as "minimumStock",
      p.track_stock as "trackStock",
      coalesce(physical.quantity, 0)::numeric as "physicalQuantity",
      coalesce(reserved.quantity, 0)::numeric as "reservedQuantity",
      (coalesce(physical.quantity, 0) - coalesce(reserved.quantity, 0))::numeric as "availableQuantity",
      (coalesce(physical.quantity, 0) - coalesce(reserved.quantity, 0))::numeric as quantity,
      (p.track_stock and (coalesce(physical.quantity, 0) - coalesce(reserved.quantity, 0)) <= p.minimum_stock) as "lowStock"
    from volt_core.products p
    left join physical on physical.product_id = p.id
    left join reserved on reserved.product_id = p.id
    where p.company_id = $1
    order by p.number asc;
  `, [companyId]);

  return result.rows;
}

async function listInventoryMovements(companyId) {
  const result = await db.query(`
    select
      m.id,
      m.type,
      m.quantity,
      m.reason,
      m.source_type as "sourceType",
      m.source_id as "sourceId",
      m.actor_user_id as "actorUserId",
      m.notes,
      m.created_at as "createdAt",
      p.id as "productId",
      p.sku,
      p.name as "productName"
    from volt_core.inventory_movements m
    join volt_core.products p on p.id = m.product_id and p.company_id = m.company_id
    where m.company_id = $1
    order by m.created_at desc
    limit 100;
  `, [companyId]);

  return result.rows;
}

async function createInventoryMovement(companyId, input = {}) {
  const movementType = String(input.type || input.kind || "entry").toLowerCase();
  const sign = movementType === "exit" || movementType === "saida" ? -1 : 1;
  const isAdjustment = ["ajuste", "adjustment"].includes(movementType);
  const rawQuantity = toQuantity(input.quantity);
  const quantity = isAdjustment
    ? rawQuantity
    : assertPositive(rawQuantity, "Quantidade deve ser maior que zero", "INVENTORY_QUANTITY_INVALID") * sign;
  if (isAdjustment && Math.abs(quantity) < 0.001) {
    throw Object.assign(new Error("Saldo contado igual ao saldo atual. Nenhum ajuste necessario."), { statusCode: 400, code: "INVENTORY_ADJUSTMENT_ZERO" });
  }

  return db.withClient(async (client) => {
    await client.query("begin");
    try {
      if (isAdjustment && !String(input.reason || "").trim()) {
        const rules = await client.query("select settings from volt_core.company_configurations where company_id=$1", [companyId]);
        if (rules.rows[0]?.settings?.requireInventoryAdjustmentReason !== false) {
          throw Object.assign(new Error("Informe o motivo do ajuste de estoque"), { statusCode: 400, code: "INVENTORY_ADJUSTMENT_REASON_REQUIRED" });
        }
      }
      const product = await findProductWithClient(client, companyId, input.productId, input.product, true);
      if (!product) throw Object.assign(new Error("Produto nao encontrado"), { statusCode: 404, code: "PRODUCT_NOT_FOUND" });
      if (!product.trackStock) throw Object.assign(new Error("Produto nao controla estoque"), { statusCode: 400, code: "PRODUCT_DOES_NOT_TRACK_STOCK" });

      if (quantity < 0) {
        const stock = await stockTotalsWithClient(client, companyId, product.id);
        if (stock.available + quantity < -1e-9) {
          throw Object.assign(new Error("Estoque disponivel insuficiente para esta saida. Existem unidades reservadas para pedidos."), {
            statusCode: 409,
            code: "INSUFFICIENT_AVAILABLE_STOCK",
            details: stock,
          });
        }
      }

      const id = createId("inv");
      const result = await client.query(`
        insert into volt_core.inventory_movements (
          id, company_id, product_id, type, quantity, reason, source_type, source_id, actor_user_id, notes
        ) values ($1,$2,$3,$4,$5,$6,'manual',$7,$8,$9)
        returning id, type, quantity, reason, source_type as "sourceType", source_id as "sourceId",
          actor_user_id as "actorUserId", notes, created_at as "createdAt";
      `, [id, companyId, product.id,
        isAdjustment ? "adjustment" : quantity < 0 ? "exit" : "entry",
        quantity, input.reason || "Movimentacao manual", input.sourceId || null,
        input.actorUserId || null, input.notes || null]);
      await insertEventWithClient(client, companyId, "stock.moved", { movementId: id, productId: product.id, quantity });
      await insertAuditWithClient(client, companyId, input.actorUserId, "stock.moved", "inventory_movement", id, null, result.rows[0], { reason: input.reason });
      await client.query("commit");
      return { ...result.rows[0], productId: product.id, productName: product.name, sku: product.sku };
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });
}
module.exports = { createInventoryMovement, getStockPosition, listInventoryMovements };
