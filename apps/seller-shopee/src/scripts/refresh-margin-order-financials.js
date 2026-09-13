"use strict";

const env = require("../config/env");
const { query } = require("../config/postgres");
const { syncOrderIncome } = require("../services/OrderSyncService");

const EXCLUDED_STATUSES = ["CANCELLED", "UNPAID", "IN_CANCEL"];

function parseArgs(argv) {
  const args = {
    rangeDays: 90,
    shopInternalId: null,
    orderSn: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "").trim();
    if (!token) continue;

    if (token === "--range-days") {
      args.rangeDays = Number(argv[index + 1] || args.rangeDays);
      index += 1;
      continue;
    }

    if (token === "--shop-id") {
      args.shopInternalId = Number(argv[index + 1] || 0) || null;
      index += 1;
      continue;
    }

    if (token === "--order-sn") {
      args.orderSn = String(argv[index + 1] || "").trim() || null;
      index += 1;
    }
  }

  if (!Number.isFinite(args.rangeDays) || args.rangeDays <= 0) {
    args.rangeDays = 90;
  }

  return args;
}

function chunk(list, size) {
  const output = [];
  for (let index = 0; index < list.length; index += size) {
    output.push(list.slice(index, index + size));
  }
  return output;
}

async function listTargetShops(shopInternalId) {
  const params = [];
  let whereClause = `
    WHERE (
      tok."accessToken" IS NOT NULL
      OR tok."refreshToken" IS NOT NULL
    )
  `;

  if (shopInternalId) {
    params.push(shopInternalId);
    whereClause += ` AND s.id = $${params.length}`;
  }

  const result = await query(
    `
      SELECT
        s.id,
        s."shopId"::text AS shopee_shop_id
      FROM "Shop" s
      INNER JOIN "OAuthToken" tok
        ON tok."shopId" = s.id
      ${whereClause}
      ORDER BY s.id ASC
    `,
    params,
  );

  return result.rows.map((row) => ({
    id: Number(row.id),
    shopeeShopId: String(row.shopee_shop_id),
  }));
}

async function listOrdersForRefresh({ shopInternalId, rangeDays, orderSn }) {
  const params = [shopInternalId];
  let whereClause = `
    WHERE o."shopId" = $1
      AND o."orderStatus" IS NOT NULL
      AND o."orderStatus" <> ALL($2::text[])
  `;
  params.push(EXCLUDED_STATUSES);

  if (orderSn) {
    params.push(orderSn);
    whereClause += ` AND o."orderSn" = $${params.length}`;
  } else {
    params.push(rangeDays);
    whereClause += `
      AND COALESCE(o."shopeeCreateTime", o."createdAt") >= NOW() - ($${params.length}::int * INTERVAL '1 day')
    `;
  }

  const result = await query(
    `
      SELECT
        o."orderSn" AS order_sn
      FROM "Order" o
      ${whereClause}
      ORDER BY COALESCE(o."shopeeCreateTime", o."createdAt") DESC
    `,
    params,
  );

  return result.rows.map((row) => String(row.order_sn));
}

async function run() {
  const args = parseArgs(process.argv.slice(2));

  console.log("[refresh-margin-order-financials] start", {
    databaseUrlConfigured: Boolean(env.DATABASE_URL),
    rangeDays: args.rangeDays,
    shopInternalId: args.shopInternalId,
    orderSn: args.orderSn,
  });

  const shops = await listTargetShops(args.shopInternalId);
  if (!shops.length) {
    console.log("[refresh-margin-order-financials] no shops found");
    return;
  }

  const summary = [];

  for (const shop of shops) {
    const orderSns = await listOrdersForRefresh({
      shopInternalId: shop.id,
      rangeDays: args.rangeDays,
      orderSn: args.orderSn,
    });

    let ok = 0;
    let failed = 0;

    for (const batch of chunk(orderSns, 5)) {
      const results = await Promise.allSettled(
        batch.map((currentOrderSn) =>
          syncOrderIncome(shop.id, shop.shopeeShopId, currentOrderSn),
        ),
      );

      for (const result of results) {
        if (result.status === "fulfilled" && result.value !== false) {
          ok += 1;
        } else {
          failed += 1;
        }
      }
    }

    summary.push({
      shopInternalId: shop.id,
      shopeeShopId: shop.shopeeShopId,
      totalOrders: orderSns.length,
      ok,
      failed,
    });

    console.log("[refresh-margin-order-financials] shop done", summary.at(-1));
  }

  const totals = summary.reduce(
    (acc, item) => {
      acc.shops += 1;
      acc.orders += item.totalOrders;
      acc.ok += item.ok;
      acc.failed += item.failed;
      return acc;
    },
    { shops: 0, orders: 0, ok: 0, failed: 0 },
  );

  console.log("[refresh-margin-order-financials] completed", {
    totals,
    summary,
  });
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[refresh-margin-order-financials] failed", {
      message: error?.message || String(error),
    });
    process.exit(1);
  });
