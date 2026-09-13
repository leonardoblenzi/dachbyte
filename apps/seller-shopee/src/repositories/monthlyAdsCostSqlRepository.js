"use strict";

const { query } = require("../config/postgres");
const { PAID_EXCLUDED_STATUSES } = require("../utils/orderStatusRules");

function mapExpenseRow(row) {
  return {
    itemId: row.itemId == null ? null : String(row.itemId),
    expense: Number(row.expense || 0),
  };
}

function mapSalesRow(row) {
  return {
    itemId: row.itemId == null ? null : String(row.itemId),
    quantity: Number(row.quantity || 0),
  };
}

async function listMonthlyAdsExpenseByItemId(shopId, start, end) {
  const result = await query(
    `
      SELECT
        "itemId",
        COALESCE(SUM(expense), 0)::bigint AS expense
      FROM "AdsHourlyMetric"
      WHERE "shopId" = $1
        AND "itemId" IS NOT NULL
        AND date >= $2
        AND date <= $3
      GROUP BY "itemId"
    `,
    [Number(shopId), start, end],
  );

  return result.rows.map(mapExpenseRow);
}

async function listPaidOrderSalesQtyByItemId(shopId, start, end) {
  const result = await query(
    `
      SELECT
        oi."itemId",
        COALESCE(SUM(oi.quantity), 0)::bigint AS quantity
      FROM "OrderItem" oi
      INNER JOIN "Order" o ON o.id = oi."orderId"
      WHERE oi."shopId" = $1
        AND o."shopeeCreateTime" >= $2
        AND o."shopeeCreateTime" <= $3
        AND o."orderStatus" IS NOT NULL
        AND o."orderStatus" <> ALL($4::text[])
      GROUP BY oi."itemId"
    `,
    [Number(shopId), start, end, PAID_EXCLUDED_STATUSES],
  );

  return result.rows.map(mapSalesRow);
}

module.exports = {
  listMonthlyAdsExpenseByItemId,
  listPaidOrderSalesQtyByItemId,
};
