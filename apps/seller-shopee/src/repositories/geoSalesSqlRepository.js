"use strict";

const { query } = require("../config/postgres");
const { PAID_EXCLUDED_STATUSES } = require("../utils/orderStatusRules");

async function listOrdersByState(shopId, from, mode = "total") {
  const paidMode = String(mode || "").toLowerCase() === "pagos";

  const result = paidMode
    ? await query(
        `
          SELECT
            oga."stateNorm" AS "stateNorm",
            oga.state AS state,
            COUNT(*)::int AS count
          FROM "OrderGeoAddress" oga
          INNER JOIN "Order" o ON o.id = oga."orderId"
          WHERE oga."shopId" = $1
            AND oga."shopeeCreateTime" >= $2
            AND o."orderStatus" IS NOT NULL
            AND o."orderStatus" <> ALL($3::text[])
          GROUP BY oga."stateNorm", oga.state
        `,
        [Number(shopId), from, PAID_EXCLUDED_STATUSES],
      )
    : await query(
        `
          SELECT
            "stateNorm" AS "stateNorm",
            state,
            COUNT(*)::int AS count
          FROM "OrderGeoAddress"
          WHERE "shopId" = $1
            AND "shopeeCreateTime" >= $2
          GROUP BY "stateNorm", state
        `,
        [Number(shopId), from],
      );

  return result.rows.map((row) => ({
    stateNorm: row.stateNorm || null,
    state: row.state || null,
    count: Number(row.count || 0),
  }));
}

async function listOrdersByCityInState(shopId, from, stateNorms = [], mode = "total") {
  const paidMode = String(mode || "").toLowerCase() === "pagos";

  const result = paidMode
    ? await query(
        `
          SELECT
            oga."cityNorm" AS "cityNorm",
            oga.city AS city,
            COUNT(*)::int AS count
          FROM "OrderGeoAddress" oga
          INNER JOIN "Order" o ON o.id = oga."orderId"
          WHERE oga."shopId" = $1
            AND oga."shopeeCreateTime" >= $2
            AND oga."stateNorm" = ANY($3::text[])
            AND oga."cityNorm" IS NOT NULL
            AND o."orderStatus" IS NOT NULL
            AND o."orderStatus" <> ALL($4::text[])
          GROUP BY oga."cityNorm", oga.city
        `,
        [Number(shopId), from, stateNorms, PAID_EXCLUDED_STATUSES],
      )
    : await query(
        `
          SELECT
            "cityNorm" AS "cityNorm",
            city,
            COUNT(*)::int AS count
          FROM "OrderGeoAddress"
          WHERE "shopId" = $1
            AND "shopeeCreateTime" >= $2
            AND "stateNorm" = ANY($3::text[])
            AND "cityNorm" IS NOT NULL
          GROUP BY "cityNorm", city
        `,
        [Number(shopId), from, stateNorms],
      );

  return result.rows.map((row) => ({
    cityNorm: row.cityNorm || null,
    city: row.city || null,
    count: Number(row.count || 0),
  }));
}

module.exports = {
  listOrdersByCityInState,
  listOrdersByState,
};
