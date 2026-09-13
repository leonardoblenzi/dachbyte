"use strict";

const { query, queryOne } = require("../config/postgres");

const PAID_EXCLUDED_STATUSES = ["CANCELLED", "UNPAID", "TO_RETURN"];
const EXCLUDED_CHANNEL_LOGISTICS_CARRIERS = [
  "retirada normal na agência",
  "retirada normal na agencia",
];

function normalizeItemId(value) {
  if (value == null || value === "") {
    return null;
  }

  try {
    return BigInt(value).toString();
  } catch (_error) {
    return null;
  }
}

function buildBaseOrderWhereClauses(params, shopId, range) {
  params.push(Number(shopId));
  const clauses = [`o."shopId" = $${params.length}`];

  params.push(EXCLUDED_CHANNEL_LOGISTICS_CARRIERS);
  clauses.push(
    `LOWER(COALESCE(o."shippingCarrier", '')) <> ALL($${params.length}::text[])`,
  );

  params.push(range.from);
  const fromParam = `$${params.length}`;
  params.push(range.to);
  const toParam = `$${params.length}`;

  clauses.push(
    `(
      (o."shopeeCreateTime" >= ${fromParam} AND o."shopeeCreateTime" <= ${toParam})
      OR (
        o."shopeeCreateTime" IS NULL
        AND o."createdAt" >= ${fromParam}
        AND o."createdAt" <= ${toParam}
      )
    )`,
  );

  return clauses;
}

function mapOrderSummaryRow(row) {
  return {
    id: Number(row.id),
    shopeeCreateTime: row.shopeeCreateTime || null,
    createdAt: row.createdAt || null,
    gmvCents: Number(row.gmvCents || 0),
  };
}

function mapDetailedOrderRow(row) {
  return {
    id: Number(row.id),
    orderSn: row.orderSn,
    orderStatus: row.orderStatus || null,
    gmvCents: Number(row.gmvCents || 0),
    shopeeCreateTime: row.shopeeCreateTime || null,
    createdAt: row.createdAt || null,
    items: Array.isArray(row.items) ? row.items : [],
  };
}

async function countCreatedOrdersForRange(shopId, range) {
  const params = [];
  const clauses = buildBaseOrderWhereClauses(params, shopId, range);

  const row = await queryOne(
    `
      SELECT COUNT(*)::int AS total
      FROM "Order" o
      WHERE ${clauses.join("\n        AND ")}
    `,
    params,
  );

  return Number(row?.total || 0);
}

async function listCreatedOrdersForRange(shopId, range) {
  const params = [];
  const clauses = buildBaseOrderWhereClauses(params, shopId, range);

  const result = await query(
    `
      SELECT
        o.id,
        o."shopeeCreateTime",
        o."createdAt",
        o."gmvCents"
      FROM "Order" o
      WHERE ${clauses.join("\n        AND ")}
      ORDER BY o."shopeeCreateTime" ASC NULLS LAST, o."createdAt" ASC, o.id ASC
    `,
    params,
  );

  return result.rows.map(mapOrderSummaryRow);
}

async function listPaidOrdersDetailedForRange(shopId, range, itemId = null) {
  const params = [];
  const clauses = buildBaseOrderWhereClauses(params, shopId, range);

  params.push(PAID_EXCLUDED_STATUSES);
  clauses.push(`o."orderStatus" IS NOT NULL`);
  clauses.push(`o."orderStatus" <> ALL($${params.length}::text[])`);

  const normalizedItemId = normalizeItemId(itemId);
  if (normalizedItemId) {
    params.push(normalizedItemId);
    clauses.push(
      `EXISTS (
        SELECT 1
        FROM "OrderItem" filter_oi
        WHERE filter_oi."orderId" = o.id
          AND filter_oi."itemId" = $${params.length}::bigint
      )`,
    );
  }

  const result = await query(
    `
      SELECT
        o.id,
        o."orderSn",
        o."orderStatus",
        o."gmvCents",
        o."shopeeCreateTime",
        o."createdAt",
        COALESCE(
          (
            SELECT json_agg(
              json_build_object(
                'itemId', oi."itemId",
                'itemName', oi."itemName",
                'imageUrl', COALESCE(oi."imageUrl", img.url),
                'quantity', oi.quantity,
                'product',
                  CASE
                    WHEN p.id IS NULL THEN NULL
                    ELSE json_build_object(
                      'title', p.title,
                      'images',
                        CASE
                          WHEN img.url IS NULL THEN '[]'::json
                          ELSE json_build_array(json_build_object('url', img.url))
                        END
                    )
                  END
              )
              ORDER BY oi.id ASC
            )
            FROM "OrderItem" oi
            LEFT JOIN "Product" p ON p.id = oi."productId"
            LEFT JOIN LATERAL (
              SELECT pi.url
              FROM "ProductImage" pi
              WHERE pi."productId" = p.id
              ORDER BY pi.id ASC
              LIMIT 1
            ) img ON TRUE
            WHERE oi."orderId" = o.id
          ),
          '[]'::json
        ) AS items
      FROM "Order" o
      WHERE ${clauses.join("\n        AND ")}
      ORDER BY o."shopeeCreateTime" ASC NULLS LAST, o."createdAt" ASC, o.id ASC
    `,
    params,
  );

  return result.rows.map(mapDetailedOrderRow);
}

module.exports = {
  countCreatedOrdersForRange,
  listCreatedOrdersForRange,
  listPaidOrdersDetailedForRange,
};
