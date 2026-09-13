const { findShopForAccountById } = require("../repositories/runtimeSqlRepository");
const { listProductsByShopAndItemIds } = require("../repositories/analyticsSqlRepository");
const { findProductDetailByShopAndItemId } = require("../repositories/productSqlRepository");
const {
  countCreatedOrdersForRange,
  listCreatedOrdersForRange,
  listPaidOrdersDetailedForRange,
} = require("../repositories/metricsSqlRepository");

const ALLOWED_DAY_FILTERS = new Set([30, 60, 90]);

function normalizeDaysParam(raw) {
  const days = Number(raw || 30);
  return ALLOWED_DAY_FILTERS.has(days) ? days : 30;
}

function pctDelta(current, previous) {
  const prev = Number(previous || 0);
  if (!prev) return null;
  return Number((((Number(current || 0) - prev) / prev) * 100).toFixed(2));
}

function normalizeProductStatus(status) {
  return String(status || "")
    .trim()
    .toUpperCase();
}

function isActiveProductStatus(status) {
  const normalized = normalizeProductStatus(status);
  return normalized === "NORMAL" || normalized === "ACTIVE";
}

function getRangeFromDays(days) {
  const now = new Date();
  const currentTo = new Date(now);
  const currentFrom = new Date(now);
  currentFrom.setHours(0, 0, 0, 0);
  currentFrom.setDate(currentFrom.getDate() - (days - 1));

  const previousTo = new Date(currentFrom.getTime() - 1);
  const previousFrom = new Date(previousTo);
  previousFrom.setHours(0, 0, 0, 0);
  previousFrom.setDate(previousFrom.getDate() - (days - 1));

  return {
    current: { from: currentFrom, to: currentTo },
    previous: { from: previousFrom, to: previousTo },
  };
}

function formatIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatLabelDate(date) {
  return date.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
  });
}

function buildDayBuckets(from, days) {
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(from);
    date.setDate(date.getDate() + index);
    return {
      key: formatIsoDate(date),
      label: formatLabelDate(date),
      revenueCents: 0,
      ordersCreated: 0,
      ordersPaid: 0,
      quantity: 0,
    };
  });
}

function getOrderDate(order) {
  return order.shopeeCreateTime || order.createdAt || null;
}

function allocateProductsFromOrders(orders = []) {
  const byItemId = new Map();

  for (const order of orders) {
    const items = Array.isArray(order.items) ? order.items : [];
    const totalQty = items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    const orderRevenueCents = Number(order.gmvCents || 0);
    const uniqueOrders = new Set();

    for (const item of items) {
      if (item.itemId == null) continue;

      const itemId = String(item.itemId);
      const qty = Number(item.quantity || 0);
      const allocatedRevenueCents =
        totalQty > 0 ? Math.round((qty / totalQty) * orderRevenueCents) : 0;

      if (!byItemId.has(itemId)) {
        byItemId.set(itemId, {
          itemId,
          title: item.product?.title || item.itemName || `Item ${itemId}`,
          imageUrl: item.imageUrl || item.product?.images?.[0]?.url || null,
          quantity: 0,
          revenueCents: 0,
          orderIds: new Set(),
        });
      }

      const row = byItemId.get(itemId);
      row.quantity += qty;
      row.revenueCents += allocatedRevenueCents;
      row.orderIds.add(order.id);
      uniqueOrders.add(order.id);
    }
  }

  return new Map(
    Array.from(byItemId.entries()).map(([itemId, row]) => [
      itemId,
      {
        itemId,
        title: row.title,
        imageUrl: row.imageUrl,
        quantity: row.quantity,
        revenueCents: row.revenueCents,
        orderCount: row.orderIds.size,
      },
    ]),
  );
}

async function loadProductMetadataMap(shopId, itemIds = []) {
  const ids = Array.from(
    new Set(
      itemIds
        .map((itemId) => String(itemId || "").trim())
        .filter((itemId) => /^\d+$/.test(itemId)),
    ),
  );

  if (!ids.length) return new Map();

  const products = await listProductsByShopAndItemIds(shopId, ids);

  return new Map(
    products.map((product) => [
      String(product.itemId),
      {
        title: product.title || null,
        imageUrl: product.images?.[0]?.url || null,
        status: product.status || null,
      },
    ]),
  );
}

function hydrateProductMap(productMap, metadataMap) {
  for (const [itemId, row] of productMap.entries()) {
    const metadata = metadataMap.get(String(itemId));
    if (!metadata) continue;
    if ((!row.title || row.title === `Item ${itemId}`) && metadata.title) {
      row.title = metadata.title;
    }
    if (!row.imageUrl && metadata.imageUrl) {
      row.imageUrl = metadata.imageUrl;
    }
  }

  return productMap;
}

function filterProductMapByActiveStatus(productMap, metadataMap) {
  const filtered = new Map();
  for (const [itemId, row] of productMap.entries()) {
    const metadata = metadataMap.get(String(itemId));
    if (!metadata) continue;
    if (!isActiveProductStatus(metadata.status)) continue;
    filtered.set(itemId, row);
  }
  return filtered;
}

function getMovers(currentMap, previousMap) {
  const itemIds = new Set([
    ...Array.from(currentMap.keys()),
    ...Array.from(previousMap.keys()),
  ]);

  return Array.from(itemIds).map((itemId) => {
    const current = currentMap.get(itemId) || {
      itemId,
      title: `Item ${itemId}`,
      imageUrl: null,
      quantity: 0,
      revenueCents: 0,
      orderCount: 0,
    };
    const previous = previousMap.get(itemId) || {
      itemId,
      title: current.title,
      imageUrl: current.imageUrl,
      quantity: 0,
      revenueCents: 0,
      orderCount: 0,
    };

    return {
      itemId,
      title: current.title || previous.title || `Item ${itemId}`,
      imageUrl: current.imageUrl || previous.imageUrl || null,
      currentQuantity: current.quantity,
      previousQuantity: previous.quantity,
      currentRevenue: current.revenueCents / 100,
      previousRevenue: previous.revenueCents / 100,
      currentOrders: current.orderCount,
      previousOrders: previous.orderCount,
      quantityDelta: current.quantity - previous.quantity,
      revenueDelta: (current.revenueCents - previous.revenueCents) / 100,
      ordersDelta: current.orderCount - previous.orderCount,
      quantityDeltaPct: pctDelta(current.quantity, previous.quantity),
      revenueDeltaPct: pctDelta(current.revenueCents, previous.revenueCents),
      ordersDeltaPct: pctDelta(current.orderCount, previous.orderCount),
    };
  });
}

async function getActiveShopOrFail(req, res) {
  if (!req.auth) {
    res.status(401).json({ error: "unauthorized" });
    return null;
  }

  const shopDbId = req.auth.activeShopId || null;
  if (!shopDbId) {
    res.status(409).json({
      error: "select_shop_required",
      message: "Selecione uma loja para continuar.",
    });
    return null;
  }

  const shop = await findShopForAccountById(shopDbId, req.auth.accountId);

  if (!shop) {
    res.status(404).json({ error: "shop_not_found" });
    return null;
  }

  return shop;
}

async function getOrdersCreatedCount(shopId, range) {
  return countCreatedOrdersForRange(shopId, range);
}

async function getPaidOrdersDetailed(shopId, range) {
  return listPaidOrdersDetailedForRange(shopId, range);
}

function sumRevenueFromOrders(orders = []) {
  return orders.reduce(
    (sum, order) => sum + Number(order.gmvCents || 0),
    0,
  );
}

function buildOverviewMetrics({ paidOrders, createdCount, createdOrders }) {
  const revenuePaidCents = sumRevenueFromOrders(paidOrders);
  const revenueCreatedCents = sumRevenueFromOrders(createdOrders);
  const ordersPaid = paidOrders.length;
  const ticketAverageCents =
    ordersPaid > 0 ? Math.round(revenuePaidCents / ordersPaid) : 0;

  return {
    revenue: revenuePaidCents / 100,
    revenuePaid: revenuePaidCents / 100,
    revenueCreated: revenueCreatedCents / 100,
    ordersCreated: createdCount,
    ordersPaid,
    ticketAverage: ticketAverageCents / 100,
  };
}

function buildSeries(days, currentRange, currentCreatedOrders, currentPaidOrders, previousCreatedOrders, previousPaidOrders) {
  const currentBuckets = buildDayBuckets(currentRange.from, days);
  const previousBuckets = buildDayBuckets(currentRange.from, days);

  const addCreated = (targetBuckets, orders, sourceRangeFrom) => {
    for (const order of orders) {
      const date = getOrderDate(order);
      if (!date) continue;
      const bucketIndex = Math.floor(
        (new Date(date).setHours(0, 0, 0, 0) -
          new Date(sourceRangeFrom).setHours(0, 0, 0, 0)) /
          86400000,
      );
      if (bucketIndex >= 0 && bucketIndex < targetBuckets.length) {
        targetBuckets[bucketIndex].ordersCreated += 1;
      }
    }
  };

  const addPaid = (targetBuckets, orders, sourceRangeFrom) => {
    for (const order of orders) {
      const date = getOrderDate(order);
      if (!date) continue;
      const bucketIndex = Math.floor(
        (new Date(date).setHours(0, 0, 0, 0) -
          new Date(sourceRangeFrom).setHours(0, 0, 0, 0)) /
          86400000,
      );
      if (bucketIndex >= 0 && bucketIndex < targetBuckets.length) {
        targetBuckets[bucketIndex].ordersPaid += 1;
        targetBuckets[bucketIndex].revenueCents += Number(order.gmvCents || 0);
        targetBuckets[bucketIndex].quantity += (order.items || []).reduce(
          (sum, item) => sum + Number(item.quantity || 0),
          0,
        );
      }
    }
  };

  addCreated(currentBuckets, currentCreatedOrders, currentRange.from);
  addPaid(currentBuckets, currentPaidOrders, currentRange.from);
  addCreated(previousBuckets, previousCreatedOrders, new Date(currentRange.from.getTime() - days * 86400000));
  addPaid(previousBuckets, previousPaidOrders, new Date(currentRange.from.getTime() - days * 86400000));

  return currentBuckets.map((bucket, index) => ({
    label: bucket.label,
    currentRevenue: bucket.revenueCents / 100,
    previousRevenue: previousBuckets[index]?.revenueCents / 100 || 0,
    currentOrdersCreated: bucket.ordersCreated,
    previousOrdersCreated: previousBuckets[index]?.ordersCreated || 0,
    currentOrdersPaid: bucket.ordersPaid,
    previousOrdersPaid: previousBuckets[index]?.ordersPaid || 0,
    currentQuantity: bucket.quantity,
    previousQuantity: previousBuckets[index]?.quantity || 0,
  }));
}

async function overview(req, res) {
  try {
    const shop = await getActiveShopOrFail(req, res);
    if (!shop) return;

    const days = normalizeDaysParam(req.query.days);
    const ranges = getRangeFromDays(days);

    const [
      currentCreatedCount,
      previousCreatedCount,
      currentCreatedOrders,
      previousCreatedOrders,
      currentPaidOrders,
      previousPaidOrders,
    ] = await Promise.all([
      getOrdersCreatedCount(shop.id, ranges.current),
      getOrdersCreatedCount(shop.id, ranges.previous),
      listCreatedOrdersForRange(shop.id, ranges.current),
      listCreatedOrdersForRange(shop.id, ranges.previous),
      getPaidOrdersDetailed(shop.id, ranges.current),
      getPaidOrdersDetailed(shop.id, ranges.previous),
    ]);

    const currentMetrics = buildOverviewMetrics({
      paidOrders: currentPaidOrders,
      createdCount: currentCreatedCount,
      createdOrders: currentCreatedOrders,
    });
    const previousMetrics = buildOverviewMetrics({
      paidOrders: previousPaidOrders,
      createdCount: previousCreatedCount,
      createdOrders: previousCreatedOrders,
    });

    const currentProductMap = allocateProductsFromOrders(currentPaidOrders);
    const previousProductMap = allocateProductsFromOrders(previousPaidOrders);
    const productMetadataMap = await loadProductMetadataMap(shop.id, [
      ...currentProductMap.keys(),
      ...previousProductMap.keys(),
    ]);
    hydrateProductMap(currentProductMap, productMetadataMap);
    hydrateProductMap(previousProductMap, productMetadataMap);
    const currentProductMapActive = filterProductMapByActiveStatus(
      currentProductMap,
      productMetadataMap,
    );
    const previousProductMapActive = filterProductMapByActiveStatus(
      previousProductMap,
      productMetadataMap,
    );
    const movers = getMovers(currentProductMapActive, previousProductMapActive);

    const topSold = Array.from(currentProductMapActive.values())
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, 5)
      .map((row) => ({
        itemId: row.itemId,
        title: row.title,
        imageUrl: row.imageUrl,
        quantity: row.quantity,
        orders: row.orderCount,
        revenue: row.revenueCents / 100,
      }));

    const topRevenue = Array.from(currentProductMapActive.values())
      .sort((a, b) => b.revenueCents - a.revenueCents)
      .slice(0, 5)
      .map((row) => ({
        itemId: row.itemId,
        title: row.title,
        imageUrl: row.imageUrl,
        quantity: row.quantity,
        orders: row.orderCount,
        revenue: row.revenueCents / 100,
      }));

    const topUp = movers
      .filter((row) => row.revenueDelta > 0)
      .sort((a, b) => b.revenueDelta - a.revenueDelta)
      .slice(0, 5);

    const topDown = movers
      .filter((row) => row.revenueDelta < 0)
      .sort((a, b) => a.revenueDelta - b.revenueDelta)
      .slice(0, 5);

    const productsFalling = movers
      .filter((row) => row.revenueDelta < 0 || row.ordersDelta < 0)
      .sort((a, b) => a.revenueDelta - b.revenueDelta)
      .slice(0, 20);

    res.json({
      filters: [30, 60, 90],
      period: {
        days,
        current: {
          from: formatIsoDate(ranges.current.from),
          to: formatIsoDate(ranges.current.to),
        },
        previous: {
          from: formatIsoDate(ranges.previous.from),
          to: formatIsoDate(ranges.previous.to),
        },
      },
      overview: {
        current: currentMetrics,
        previous: previousMetrics,
        delta: {
          revenuePct: pctDelta(currentMetrics.revenue, previousMetrics.revenue),
          revenueValue: Number(
            (currentMetrics.revenue - previousMetrics.revenue).toFixed(2),
          ),
          revenueCreatedPct: pctDelta(
            currentMetrics.revenueCreated,
            previousMetrics.revenueCreated,
          ),
          revenueCreatedValue: Number(
            (
              currentMetrics.revenueCreated - previousMetrics.revenueCreated
            ).toFixed(2),
          ),
          ordersCreatedPct: pctDelta(
            currentMetrics.ordersCreated,
            previousMetrics.ordersCreated,
          ),
          ordersCreatedValue:
            currentMetrics.ordersCreated - previousMetrics.ordersCreated,
          ordersPaidPct: pctDelta(
            currentMetrics.ordersPaid,
            previousMetrics.ordersPaid,
          ),
          ordersPaidValue:
            currentMetrics.ordersPaid - previousMetrics.ordersPaid,
          ticketAveragePct: pctDelta(
            currentMetrics.ticketAverage,
            previousMetrics.ticketAverage,
          ),
          ticketAverageValue: Number(
            (
              currentMetrics.ticketAverage - previousMetrics.ticketAverage
            ).toFixed(2),
          ),
        },
        series: buildSeries(
          days,
          ranges.current,
          currentCreatedOrders,
          currentPaidOrders,
          previousCreatedOrders,
          previousPaidOrders,
        ),
      },
      rankings: {
        topSold,
        topRevenue,
        topUp,
        topDown,
        productsFalling,
      },
    });
  } catch (e) {
    console.error("metrics.overview failed:", e);
    res.status(500).json({
      error: "metrics_overview_failed",
      message: String(e?.message || e),
    });
  }
}

async function productCompare(req, res) {
  try {
    const shop = await getActiveShopOrFail(req, res);
    if (!shop) return;

    const itemId = String(req.params.itemId || "").trim();
    if (!/^\d+$/.test(itemId)) {
      return res.status(400).json({
        error: "item_id_invalid",
        message: "itemId inválido.",
      });
    }

    const days = normalizeDaysParam(req.query.days);
    const ranges = getRangeFromDays(days);
    const [currentOrders, previousOrders, product] = await Promise.all([
      listPaidOrdersDetailedForRange(shop.id, ranges.current, itemId),
      listPaidOrdersDetailedForRange(shop.id, ranges.previous, itemId),
      findProductDetailByShopAndItemId(shop.id, itemId),
    ]);

    const summarize = (orders, sourceFrom) => {
      const buckets = buildDayBuckets(sourceFrom, days);
      let revenueCents = 0;
      let quantity = 0;
      let ordersCount = 0;

      for (const order of orders) {
        const totalQty = (order.items || []).reduce(
          (sum, item) => sum + Number(item.quantity || 0),
          0,
        );
        const selectedQty = (order.items || [])
          .filter((item) => String(item.itemId) === itemId)
          .reduce((sum, item) => sum + Number(item.quantity || 0), 0);
        const allocatedRevenueCents =
          totalQty > 0
            ? Math.round((selectedQty / totalQty) * Number(order.gmvCents || 0))
            : 0;

        const date = getOrderDate(order);
        const bucketIndex = Math.floor(
          (new Date(date).setHours(0, 0, 0, 0) -
            new Date(sourceFrom).setHours(0, 0, 0, 0)) /
            86400000,
        );

        if (bucketIndex >= 0 && bucketIndex < buckets.length) {
          buckets[bucketIndex].revenueCents += allocatedRevenueCents;
          buckets[bucketIndex].ordersPaid += 1;
          buckets[bucketIndex].quantity += selectedQty;
        }

        revenueCents += allocatedRevenueCents;
        quantity += selectedQty;
        ordersCount += 1;
      }

      return {
        revenue: revenueCents / 100,
        quantity,
        orders: ordersCount,
        ticketAverage: ordersCount > 0 ? revenueCents / 100 / ordersCount : 0,
        series: buckets.map((bucket) => ({
          label: bucket.label,
          revenue: bucket.revenueCents / 100,
          orders: bucket.ordersPaid,
          quantity: bucket.quantity,
        })),
      };
    };

    const current = summarize(currentOrders, ranges.current.from);
    const previous = summarize(previousOrders, ranges.previous.from);
    const fallbackOrderItem =
      currentOrders
        .flatMap((order) => order.items || [])
        .find((item) => String(item.itemId) === itemId) ||
      previousOrders
        .flatMap((order) => order.items || [])
        .find((item) => String(item.itemId) === itemId) ||
      null;

    res.json({
      product: {
        itemId,
        title: product?.title || fallbackOrderItem?.itemName || `Item ${itemId}`,
        imageUrl: product?.images?.[0]?.url || fallbackOrderItem?.imageUrl || null,
      },
      period: {
        days,
        current: {
          from: formatIsoDate(ranges.current.from),
          to: formatIsoDate(ranges.current.to),
        },
        previous: {
          from: formatIsoDate(ranges.previous.from),
          to: formatIsoDate(ranges.previous.to),
        },
      },
      current,
      previous,
      delta: {
        revenuePct: pctDelta(current.revenue, previous.revenue),
        revenueValue: Number((current.revenue - previous.revenue).toFixed(2)),
        quantityPct: pctDelta(current.quantity, previous.quantity),
        quantityValue: current.quantity - previous.quantity,
        ordersPct: pctDelta(current.orders, previous.orders),
        ordersValue: current.orders - previous.orders,
        ticketAveragePct: pctDelta(current.ticketAverage, previous.ticketAverage),
        ticketAverageValue: Number(
          (current.ticketAverage - previous.ticketAverage).toFixed(2),
        ),
      },
    });
  } catch (e) {
    console.error("metrics.productCompare failed:", e);
    res.status(500).json({
      error: "metrics_product_compare_failed",
      message: String(e?.message || e),
    });
  }
}

module.exports = {
  overview,
  productCompare,
};
