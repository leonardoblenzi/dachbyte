"use strict";

const {
  groupAdsSpendByItemIds,
  listAccountsForSalesSummary,
  listCreatedOrdersForRange,
  listDetailedPaidOrdersForRange,
  listOperationalStatusCounts,
  listPaidOrdersForRange,
  listProductTitlesByItemIdsForShops,
  listProductsWithRatingsByShopIds,
  listReadyToShipOrders,
} = require("../repositories/salesSummarySqlRepository");
const { sendSalesSummaryEmail } = require("./inviteEmailService");
const { pickActiveRecipients } = require("./accountRecipients");
const { syncOrdersForShop } = require("./OrderSyncService");
const { tzOffsetToMinutes } = require("../utils/timezone");

const REPORT_TIMEZONE = process.env.SALES_SUMMARY_TZ || "America/Sao_Paulo";
const REPORT_TZ_OFFSET = process.env.SHOPEE_REPORT_TZ_OFFSET || "-03:00";

const PAID_REPORT_EXCLUDED_STATUSES = ["CANCELLED", "UNPAID", "IN_CANCEL"];
const CANCELLED_ORDER_STATUSES = new Set(["CANCELLED", "IN_CANCEL"]);
const RETURNED_ORDER_STATUSES = new Set(["RETURNED", "TO_RETURN"]);
const OPERATION_STATUSES = [
  "READY_TO_SHIP",
  "PROCESSED",
  "SHIPPED",
  "TO_CONFIRM_RECEIVE",
];
const REPORT_DASHBOARD_DAYS = 30;
const SAC_RESPONSE_RATE_TARGET_PCT = Number(
  process.env.SALES_SUMMARY_SAC_RESPONSE_TARGET_PCT || 90,
);
const SHOP_RATING_TARGET = Number(
  process.env.SALES_SUMMARY_SHOP_RATING_TARGET || 4.5,
);
const ADS_ACOS_TARGET_PCT = Number(
  process.env.SALES_SUMMARY_ADS_ACOS_TARGET_PCT || 25,
);
const ACCOUNT_HEALTH_TARGETS = {
  paidRatePct: Number(process.env.SALES_SUMMARY_HEALTH_PAID_RATE_TARGET || 90),
  cancelRatePct: Number(
    process.env.SALES_SUMMARY_HEALTH_CANCEL_RATE_TARGET || 2,
  ),
  returnRatePct: Number(
    process.env.SALES_SUMMARY_HEALTH_RETURN_RATE_TARGET || 1,
  ),
};

const REPORT_TYPES = {
  daily_24h: {
    subject: "Resumo de vendas 24h",
    filePrefix: "relatorio-24h",
    tags: ["sales-summary-24h", "shopee-report"],
    syncOrdersBeforeSend: true,
    syncRangeDays: 3,
    title: "Confira seu resumo de vendas das ultimas 24h",
    intro:
      "Segue o resumo das ultimas 24h da sua operacao Shopee. O CSV completo com os pedidos do periodo esta em anexo.",
    badgeLabel: "As suas vendas nas ultimas 24h",
    ordersLabel: "Pedidos nas ultimas 24h",
    salesLabel: "GMV pago nas ultimas 24h",
    ordersCompareLabel: "Crescimento de pedidos vs 24h anteriores",
    salesCompareLabel: "Crescimento de vendas vs 24h anteriores",
    tableTitle: "Pedidos listados nas ultimas 24h",
    emptyTableText: "Nenhum pedido encontrado nas ultimas 24h.",
    buildPeriods(now) {
      const currentEnd = new Date(now);
      const currentStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const previousEnd = new Date(currentStart);
      const previousStart = new Date(
        currentStart.getTime() - 24 * 60 * 60 * 1000,
      );

      return {
        current: { from: currentStart, to: currentEnd },
        previous: { from: previousStart, to: previousEnd },
      };
    },
  },
  weekend: {
    subject: "Resumo de vendas fim de semana",
    filePrefix: "relatorio-fim-de-semana",
    tags: ["sales-summary-weekend", "shopee-report"],
    title: "Confira seu resumo de vendas do fim de semana",
    intro:
      "Segue o fechamento do fim de semana, cobrindo sexta as 18h ate segunda as 08h, com comparacao contra o ultimo fim de semana equivalente.",
    badgeLabel: "As suas vendas do fim de semana",
    ordersLabel: "Pedidos no fim de semana",
    salesLabel: "GMV pago no fim de semana",
    ordersCompareLabel: "Crescimento de pedidos vs fim de semana anterior",
    salesCompareLabel: "Crescimento de vendas vs fim de semana anterior",
    tableTitle: "Pedidos do fim de semana",
    emptyTableText: "Nenhum pedido encontrado neste fim de semana.",
    buildPeriods(now) {
      const localToday = getLocalDateParts(now);
      const monday = addLocalDays(localToday, -((localToday.weekday + 6) % 7));

      const currentEnd = buildDateAtLocalTime(monday, 8, 0);
      const currentStart = buildDateAtLocalTime(
        addLocalDays(monday, -3),
        18,
        0,
      );
      const previousEnd = buildDateAtLocalTime(addLocalDays(monday, -7), 8, 0);
      const previousStart = buildDateAtLocalTime(
        addLocalDays(monday, -10),
        18,
        0,
      );

      return {
        current: { from: currentStart, to: currentEnd },
        previous: { from: previousStart, to: previousEnd },
      };
    },
  },
  weekly_7d: {
    subject: "Resumo de vendas 7 dias",
    filePrefix: "relatorio-7-dias",
    tags: ["sales-summary-weekly", "shopee-report"],
    title: "Confira seu resumo dos ultimos 7 dias fechados",
    intro:
      "Segue o relatorio com as vendas desde sexta-feira 00:00 da semana anterior ate sexta-feira 00:00 da semana atual, totalizando 7 dias fechados.",
    badgeLabel: "As suas vendas dos ultimos 7 dias",
    ordersLabel: "Pedidos no periodo",
    salesLabel: "GMV pago no periodo",
    ordersCompareLabel: "Crescimento de pedidos vs 7 dias anteriores",
    salesCompareLabel: "Crescimento de vendas vs 7 dias anteriores",
    tableTitle: "Pedidos do periodo de 7 dias",
    emptyTableText: "Nenhum pedido encontrado nesta janela de 7 dias.",
    buildPeriods(now) {
      const localToday = getLocalDateParts(now);
      const friday = addLocalDays(localToday, -((localToday.weekday + 2) % 7));

      const currentEnd = buildDateAtLocalTime(friday, 0, 0);
      const currentStart = buildDateAtLocalTime(addLocalDays(friday, -7), 0, 0);
      const previousEnd = new Date(currentStart);
      const previousStart = buildDateAtLocalTime(
        addLocalDays(friday, -14),
        0,
        0,
      );

      return {
        current: { from: currentStart, to: currentEnd },
        previous: { from: previousStart, to: previousEnd },
      };
    },
  },
  monthly: {
    subject: "Resumo mensal de vendas",
    filePrefix: "relatorio-mensal",
    tags: ["sales-summary-monthly", "shopee-report"],
    title: "Confira o fechamento mensal da sua operacao",
    intro:
      "Segue o relatorio mensal com o mes fechado anterior, incluindo pedidos feitos, pedidos pagos, faturamento, ticket medio, cancelamentos, devolucoes e comparativo completo contra o mes anterior.",
    badgeLabel: "Fechamento mensal",
    ordersLabel: "Pedidos pagos no mes",
    salesLabel: "Faturamento pago no mes",
    ordersCompareLabel: "Pedidos pagos vs mes anterior",
    salesCompareLabel: "Faturamento pago vs mes anterior",
    tableTitle: "Pedidos do mes fechado",
    emptyTableText: "Nenhum pedido encontrado no mês fechado.",
    hideOperations: true,
    buildPeriods(now) {
      const localToday = getLocalDateParts(now);
      const currentMonthStart = buildDateAtLocalTime(
        { year: localToday.year, month: localToday.month, day: 1 },
        0,
        0,
      );
      const previousMonthCursor = addLocalDays(
        { year: localToday.year, month: localToday.month, day: 1 },
        -1,
      );
      const previousMonthStart = buildDateAtLocalTime(
        {
          year: previousMonthCursor.year,
          month: previousMonthCursor.month,
          day: 1,
        },
        0,
        0,
      );
      const twoMonthsAgoCursor = addLocalDays(
        {
          year: previousMonthCursor.year,
          month: previousMonthCursor.month,
          day: 1,
        },
        -1,
      );
      const twoMonthsAgoStart = buildDateAtLocalTime(
        {
          year: twoMonthsAgoCursor.year,
          month: twoMonthsAgoCursor.month,
          day: 1,
        },
        0,
        0,
      );

      return {
        current: { from: previousMonthStart, to: currentMonthStart },
        previous: { from: twoMonthsAgoStart, to: previousMonthStart },
      };
    },
  },
};

function pad2(value) {
  return String(value).padStart(2, "0");
}

function toLocalShiftedDate(date) {
  const offsetMin = tzOffsetToMinutes(REPORT_TZ_OFFSET);
  return new Date(date.getTime() + offsetMin * 60 * 1000);
}

function getLocalDateParts(date) {
  const shifted = toLocalShiftedDate(date);

  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
  };
}

function addLocalDays(parts, deltaDays) {
  const base = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0, 0),
  );
  base.setUTCDate(base.getUTCDate() + deltaDays);

  return {
    year: base.getUTCFullYear(),
    month: base.getUTCMonth() + 1,
    day: base.getUTCDate(),
    weekday: base.getUTCDay(),
  };
}

function buildDateAtLocalTime(parts, hour = 0, minute = 0) {
  return new Date(
    `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}T${pad2(hour)}:${pad2(minute)}:00.000${REPORT_TZ_OFFSET}`,
  );
}

function startOfLocalDay(date) {
  const parts = getLocalDateParts(date);
  return buildDateAtLocalTime(parts, 0, 0);
}

function addUtcDays(date, deltaDays) {
  return new Date(date.getTime() + deltaDays * 24 * 60 * 60 * 1000);
}

function formatPeriodDate(date) {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: REPORT_TIMEZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatPeriodLabel(range) {
  return `${formatPeriodDate(range.from)} -> ${formatPeriodDate(range.to)}`;
}

function formatMonthLabel(range) {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: REPORT_TIMEZONE,
    month: "long",
    year: "numeric",
  }).format(range.from);
}

function formatPercentChange(current, previous) {
  const cur = Number(current || 0);
  const prev = Number(previous || 0);

  if (!prev) {
    return cur > 0 ? "Novo" : "0%";
  }

  const pct = ((cur - prev) / prev) * 100;
  const decimals = Math.abs(pct) < 10 ? 1 : 0;
  const value = pct.toFixed(decimals);

  return `${pct > 0 ? "+" : ""}${value}%`;
}

function formatPercentValue(value) {
  return `${Number(value || 0).toFixed(1)}%`;
}

function formatRoundedPercentValue(value) {
  if (value == null || value === "") return "--%";
  if (!Number.isFinite(Number(value))) return "--%";
  return `${Math.round(Number(value))}%`;
}

function toCurrencyCents(value) {
  return Number(value || 0);
}

function formatMoneyLabel(cents) {
  return (Number(cents || 0) / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function formatCountLabel(value) {
  return Number(value || 0).toLocaleString("pt-BR");
}

function formatCsvMoney(cents) {
  return (Number(cents || 0) / 100).toFixed(2);
}

function slugify(value) {
  return String(value || "conta")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function csvEscape(value) {
  const str = String(value ?? "");
  if (!/[",\n;]/.test(str)) return str;
  return `"${str.replace(/"/g, '""')}"`;
}

function buildCsvAttachment({ accountName, filePrefix, orders }) {
  const rows = [
    ["empresa", "shop_id_shopee", "pedido", "status", "gmv", "criado_em"],
    ...orders.map((order) => [
      accountName || "DAVANTTI",
      String(order.shopShopeeId || ""),
      String(order.orderSn || ""),
      String(order.orderStatus || ""),
      formatCsvMoney(order.gmvCents),
      order.orderDate
        ? new Intl.DateTimeFormat("pt-BR", {
            timeZone: REPORT_TIMEZONE,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          }).format(new Date(order.orderDate))
        : "",
    ]),
  ]
    .map((line) => line.map(csvEscape).join(";"))
    .join("\n");

  return {
    name: `${filePrefix}-${slugify(accountName)}.csv`,
    content: Buffer.from(rows, "utf8").toString("base64"),
  };
}

function mapOrderRow(order) {
  return {
    orderSn: order.orderSn,
    orderStatus: order.orderStatus,
    gmvCents: toCurrencyCents(order.gmvCents),
    orderDate: order.shopeeCreateTime || order.createdAt || null,
    shopShopeeId: order.shop?.shopId ? String(order.shop.shopId) : "",
  };
}

async function loadOrdersForRange(shopIds, range) {
  const orders = await listPaidOrdersForRange(shopIds, range, "DESC");
  return orders.map(mapOrderRow);
}

async function loadCreatedOrdersForRange(shopIds, range) {
  const orders = await listCreatedOrdersForRange(shopIds, range, "DESC");
  return orders.map(mapOrderRow);
}

async function loadOperationalSummary(shopIds, now) {
  const [statusRows, readyOrders] = await Promise.all([
    listOperationalStatusCounts(shopIds, OPERATION_STATUSES),
    listReadyToShipOrders(shopIds),
  ]);

  const countByStatus = new Map(
    statusRows.map((row) => [String(row.orderStatus || ""), row.total]),
  );

  const dayStart = startOfLocalDay(now);
  const nextDayStart = addUtcDays(dayStart, 1);
  const weekEnd = addUtcDays(dayStart, 7);

  const shipping = {
    overdue: 0,
    today: 0,
    week: 0,
    later: 0,
  };

  for (const order of readyOrders) {
    const shipByDate = order.shipByDate;
    if (!shipByDate) {
      shipping.later += 1;
      continue;
    }

    if (shipByDate < now) {
      shipping.overdue += 1;
    } else if (shipByDate < nextDayStart) {
      shipping.today += 1;
    } else if (shipByDate < weekEnd) {
      shipping.week += 1;
    } else {
      shipping.later += 1;
    }
  }

  return {
    shipping,
    status: {
      readyToShip: Number(countByStatus.get("READY_TO_SHIP") || 0),
      processed: Number(countByStatus.get("PROCESSED") || 0),
      shipped: Number(countByStatus.get("SHIPPED") || 0),
      toConfirmReceive: Number(countByStatus.get("TO_CONFIRM_RECEIVE") || 0),
    },
  };
}

function countOrdersByStatuses(orders, statuses) {
  return orders.reduce((sum, order) => {
    const status = String(order?.orderStatus || "").toUpperCase();
    return sum + (statuses.has(status) ? 1 : 0);
  }, 0);
}

function sumGmvCents(orders) {
  return orders.reduce(
    (sum, order) => sum + toCurrencyCents(order?.gmvCents),
    0,
  );
}

function getOrderDate(order) {
  return order?.shopeeCreateTime || order?.createdAt || null;
}

function getLastNDaysRange(now, days) {
  const current = now instanceof Date ? now : new Date();
  const currentParts = getLocalDateParts(current);
  const fromParts = addLocalDays(currentParts, -(Number(days || 1) - 1));

  return {
    from: buildDateAtLocalTime(fromParts, 0, 0),
    to: new Date(current),
  };
}

function getCurrentMonthRange(now) {
  const current = now instanceof Date ? now : new Date();
  const parts = getLocalDateParts(current);

  return {
    from: buildDateAtLocalTime(
      { year: parts.year, month: parts.month, day: 1 },
      0,
      0,
    ),
    to: new Date(current),
  };
}

function toLocalIsoDay(date) {
  const shifted = toLocalShiftedDate(new Date(date));
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(
    shifted.getUTCDate(),
  )}`;
}

function formatShortLocalDay(date) {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: REPORT_TIMEZONE,
    day: "2-digit",
    month: "2-digit",
  }).format(new Date(date));
}

function buildRevenueSeries(orders, range, days) {
  const safeDays = Math.max(1, Number(days || 1));
  const buckets = Array.from({ length: safeDays }, (_, index) => {
    const date = addUtcDays(range.from, index);
    return {
      key: toLocalIsoDay(date),
      label: formatShortLocalDay(date),
      revenueCents: 0,
    };
  });

  const bucketIndexByKey = new Map(
    buckets.map((bucket, index) => [bucket.key, index]),
  );

  for (const order of orders || []) {
    const orderDate = getOrderDate(order);
    if (!orderDate) continue;
    const key = toLocalIsoDay(orderDate);
    const bucketIndex = bucketIndexByKey.get(key);
    if (bucketIndex == null) continue;
    buckets[bucketIndex].revenueCents += toCurrencyCents(order?.gmvCents);
  }

  return buckets;
}

function allocateProductsFromDetailedOrders(orders = []) {
  const byItemId = new Map();

  for (const order of orders) {
    const items = Array.isArray(order?.items) ? order.items : [];
    const totalQty = items.reduce(
      (sum, item) => sum + Number(item?.quantity || 0),
      0,
    );
    const orderRevenueCents = toCurrencyCents(order?.gmvCents);

    for (const item of items) {
      if (item?.itemId == null) continue;

      const itemId = String(item.itemId);
      const qty = Number(item?.quantity || 0);
      const allocatedRevenueCents =
        totalQty > 0 ? Math.round((qty / totalQty) * orderRevenueCents) : 0;

      if (!byItemId.has(itemId)) {
        byItemId.set(itemId, {
          itemId,
          title:
            item?.product?.title ||
            item?.itemName ||
            item?.productTitle ||
            `Item ${itemId}`,
          quantity: 0,
          revenueCents: 0,
        });
      }

      const row = byItemId.get(itemId);
      row.quantity += qty;
      row.revenueCents += allocatedRevenueCents;
    }
  }

  return byItemId;
}

async function loadDetailedProductMetadataMap(shopIds, orders = []) {
  const itemIds = Array.from(
    new Set(
      orders.flatMap((order) =>
        (Array.isArray(order?.items) ? order.items : [])
          .map((item) => String(item?.itemId || "").trim())
          .filter((itemId) => /^\d+$/.test(itemId)),
      ),
    ),
  );

  if (!itemIds.length) return new Map();

  const products = await listProductTitlesByItemIdsForShops(shopIds, itemIds);

  return new Map(
    products.map((product) => [String(product.itemId), product.title || null]),
  );
}

function hydrateDetailedProductMap(productMap, metadataMap) {
  for (const [itemId, row] of productMap.entries()) {
    const title = metadataMap.get(String(itemId));
    if (!title) continue;
    if (!row.title || row.title === `Item ${itemId}`) {
      row.title = title;
    }
  }

  return productMap;
}

function buildTopProducts(orders, limit = 5) {
  return Array.from(allocateProductsFromDetailedOrders(orders).values())
    .sort((a, b) => {
      if (b.quantity !== a.quantity) return b.quantity - a.quantity;
      return b.revenueCents - a.revenueCents;
    })
    .slice(0, limit)
    .map((row) => ({
      itemId: row.itemId,
      title: row.title,
      quantity: row.quantity,
      revenueCents: row.revenueCents,
    }));
}

async function loadDetailedPaidOrdersForRange(shopIds, range) {
  return listDetailedPaidOrdersForRange(shopIds, range);
}

async function loadShopRatingSummary(shopIds) {
  const products = await listProductsWithRatingsByShopIds(shopIds);

  let weightedStars = 0;
  let totalRatings = 0;

  for (const product of products) {
    const star = Number(product?.ratingStar);
    const count = Number(product?.ratingCount || 0);
    if (!Number.isFinite(star) || count <= 0) continue;
    weightedStars += star * count;
    totalRatings += count;
  }

  return {
    average:
      totalRatings > 0 ? Number((weightedStars / totalRatings).toFixed(2)) : null,
    totalRatings,
    productsWithRatings: products.length,
  };
}

async function loadDashboardInsights(shopIds, now) {
  const last30Range = getLastNDaysRange(now, REPORT_DASHBOARD_DAYS);
  const currentMonthRange = getCurrentMonthRange(now);

  const [
    last30PaidOrders,
    last30CreatedOrders,
    currentMonthPaidOrders,
    operational,
    ratingSummary,
  ] = await Promise.all([
    loadDetailedPaidOrdersForRange(shopIds, last30Range),
    loadCreatedOrdersForRange(shopIds, last30Range),
    loadDetailedPaidOrdersForRange(shopIds, currentMonthRange),
    loadOperationalSummary(shopIds, now),
    loadShopRatingSummary(shopIds),
  ]);
  const productMetadataMap = await loadDetailedProductMetadataMap(shopIds, [
    ...last30PaidOrders,
    ...currentMonthPaidOrders,
  ]);
  const last30ProductMap = hydrateDetailedProductMap(
    allocateProductsFromDetailedOrders(last30PaidOrders),
    productMetadataMap,
  );
  const currentMonthProductMap = hydrateDetailedProductMap(
    allocateProductsFromDetailedOrders(currentMonthPaidOrders),
    productMetadataMap,
  );

  const last30Stats = collectMonthlyStats(last30CreatedOrders, last30PaidOrders);
  const mtdRevenuePaidCents = sumGmvCents(currentMonthPaidOrders);
  const last30ActiveItemsCount = last30ProductMap.size;
  const revenueSeries = buildRevenueSeries(
    last30PaidOrders,
    last30Range,
    REPORT_DASHBOARD_DAYS,
  );
  const topProducts = Array.from(last30ProductMap.values())
    .sort((a, b) => {
      if (b.quantity !== a.quantity) return b.quantity - a.quantity;
      return b.revenueCents - a.revenueCents;
    })
    .slice(0, 5)
    .map((row) => ({
      itemId: row.itemId,
      title: row.title,
      quantity: row.quantity,
      revenueCents: row.revenueCents,
    }));

  const cancelRatePct = last30Stats.createdCount
    ? Number(
        ((last30Stats.cancelledCount / last30Stats.createdCount) * 100).toFixed(1),
      )
    : 0;
  const returnRatePct = last30Stats.createdCount
    ? Number(
        ((last30Stats.returnedCount / last30Stats.createdCount) * 100).toFixed(1),
      )
    : 0;

  const accountHealthMetrics = [
    {
      key: "paid_rate",
      label: "Operacao consistente",
      value: last30Stats.paidRatePct,
      valueLabel: formatRoundedPercentValue(last30Stats.paidRatePct),
      targetLabel: `Meta >= ${Math.round(ACCOUNT_HEALTH_TARGETS.paidRatePct)}%`,
      ok: last30Stats.paidRatePct >= ACCOUNT_HEALTH_TARGETS.paidRatePct,
    },
    {
      key: "cancel_rate",
      label: "Cancelamento",
      value: cancelRatePct,
      valueLabel: formatRoundedPercentValue(cancelRatePct),
      targetLabel: `Meta <= ${ACCOUNT_HEALTH_TARGETS.cancelRatePct.toFixed(1)}%`,
      ok: cancelRatePct <= ACCOUNT_HEALTH_TARGETS.cancelRatePct,
    },
    {
      key: "return_rate",
      label: "Devolucao",
      value: returnRatePct,
      valueLabel: formatRoundedPercentValue(returnRatePct),
      targetLabel: `Meta <= ${ACCOUNT_HEALTH_TARGETS.returnRatePct.toFixed(1)}%`,
      ok: returnRatePct <= ACCOUNT_HEALTH_TARGETS.returnRatePct,
    },
    {
      key: "overdue_shipping",
      label: "Pedidos atrasados",
      value: Number(operational?.shipping?.overdue || 0),
      valueLabel: formatCountLabel(operational?.shipping?.overdue || 0),
      targetLabel: "Meta = 0",
      ok: Number(operational?.shipping?.overdue || 0) === 0,
    },
  ];

  const accountHealthScore = accountHealthMetrics.filter(
    (metric) => metric.ok,
  ).length;
  const accountHealthTotal = accountHealthMetrics.length;
  const accountHealthOutOfTargetCount =
    accountHealthTotal - accountHealthScore;

  const responseRatePct = null;
  const hasResponseRatePct =
    responseRatePct != null &&
    responseRatePct !== "" &&
    Number.isFinite(Number(responseRatePct));
  const sacMetrics = [
    {
      key: "response_rate",
      label: "Taxa de resposta",
      value: responseRatePct,
      valueLabel: formatRoundedPercentValue(responseRatePct),
      targetLabel: `Meta >= ${Math.round(SAC_RESPONSE_RATE_TARGET_PCT)}%`,
      ok:
        hasResponseRatePct &&
        Number(responseRatePct) >= SAC_RESPONSE_RATE_TARGET_PCT,
      available: hasResponseRatePct,
    },
    {
      key: "shop_rating",
      label: "Shop Rating",
      value: ratingSummary.average,
      valueLabel:
        ratingSummary.average == null
          ? "--"
          : Number(ratingSummary.average).toFixed(2).replace(".", ","),
      targetLabel: `Meta >= ${SHOP_RATING_TARGET.toFixed(2).replace(".", ",")}`,
      ok:
        ratingSummary.average != null &&
        Number(ratingSummary.average) >= SHOP_RATING_TARGET,
      available: ratingSummary.average != null,
    },
  ];

  const sacMetricsMonitored = sacMetrics.filter((metric) => metric.available).length;
  const sacOutOfTargetCount = sacMetrics.filter(
    (metric) => metric.available && !metric.ok,
  ).length;
  const sacHealthyCount = sacMetrics.filter(
    (metric) => metric.available && metric.ok,
  ).length;
  const sacScorePct =
    sacMetricsMonitored > 0
      ? Number(((sacHealthyCount / sacMetricsMonitored) * 100).toFixed(0))
      : null;

  const revenueByItemId = currentMonthProductMap;

  const adsSpendRows = await groupAdsSpendByItemIds(shopIds, currentMonthRange);

  const adsOutsideTarget = adsSpendRows
    .map((row) => {
      const itemId = String(row.itemId);
      const spendCents = Number(row?.expense || 0);
      const revenueCents = Number(revenueByItemId.get(itemId)?.revenueCents || 0);
      const acosPct =
        revenueCents > 0 ? Number(((spendCents / revenueCents) * 100).toFixed(1)) : null;
      const outsideTarget =
        spendCents > 0 &&
        (revenueCents <= 0 ||
          (acosPct != null && Number(acosPct) > ADS_ACOS_TARGET_PCT));

      return {
        itemId,
        spendCents,
        revenueCents,
        acosPct,
        outsideTarget,
      };
    })
    .filter((row) => row.outsideTarget);

  return {
    updatedAtLabel: new Intl.DateTimeFormat("pt-BR", {
      timeZone: REPORT_TIMEZONE,
      hour: "2-digit",
      minute: "2-digit",
    }).format(now),
    range30dLabel: formatPeriodLabel(last30Range),
    revenueSeries,
    topProducts,
    operationKpis: [
      {
        label: "Faturamento pago MTD",
        value: formatMoneyLabel(mtdRevenuePaidCents),
        meta: "mes atual",
      },
      {
        label: "Pedidos pagos 30d",
        value: formatCountLabel(last30PaidOrders.length),
        meta: "janela de 30 dias",
      },
      {
        label: "Ticket medio",
        value: formatMoneyLabel(last30Stats.ticketAverageCents),
        meta: "por pedido pago",
      },
      {
        label: "Anuncios com vendas",
        value: formatCountLabel(last30ActiveItemsCount),
        meta: "itens ativos com giro",
      },
    ],
    qualitySac: {
      scorePct: sacScorePct,
      responseRatePct,
      responseRateTargetPct: SAC_RESPONSE_RATE_TARGET_PCT,
      shopRating: ratingSummary.average,
      shopRatingTarget: SHOP_RATING_TARGET,
      totalRatings: ratingSummary.totalRatings,
      metricsMonitored: sacMetricsMonitored,
      outOfTargetCount: sacOutOfTargetCount,
      metrics: sacMetrics,
    },
    accountHealth: {
      score: accountHealthScore,
      total: accountHealthTotal,
      scorePct: Math.round((accountHealthScore / accountHealthTotal) * 100),
      outOfTargetCount: accountHealthOutOfTargetCount,
      metrics: accountHealthMetrics,
    },
    ads: {
      outsideTargetCount: adsOutsideTarget.length,
      outsideTargetSingleItemId:
        adsOutsideTarget.length === 1 ? adsOutsideTarget[0].itemId : null,
      targetLabel: `ACOS <= ${ADS_ACOS_TARGET_PCT.toFixed(0)}%`,
      targetExplanation:
        `Meta usada: o gasto em ads deve ficar em no maximo ${ADS_ACOS_TARGET_PCT.toFixed(0)}% do faturamento pago do item no mes atual. Se o item tem gasto e nenhuma venda paga, ele tambem entra como fora da meta.`,
    },
  };
}

async function syncOrdersBeforeReport({ account, spec }) {
  if (!spec?.syncOrdersBeforeSend) {
    return {
      attempted: false,
      synced: 0,
      failed: 0,
      errors: [],
    };
  }

  const syncRangeDays = Math.min(
    Math.max(Number(spec.syncRangeDays || 3) || 3, 1),
    30,
  );
  const shops = Array.isArray(account?.shops) ? account.shops : [];
  const results = [];

  for (const shop of shops) {
    if (!shop?.shopId) continue;

    try {
      const result = await syncOrdersForShop({
        shopeeShopId: String(shop.shopId),
        rangeDays: syncRangeDays,
      });
      results.push({
        shopId: String(shop.shopId),
        ok: true,
        result,
      });
    } catch (error) {
      results.push({
        shopId: String(shop.shopId),
        ok: false,
        error: String(error?.message || error),
      });
    }
  }

  return {
    attempted: true,
    rangeDays: syncRangeDays,
    synced: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    errors: results
      .filter((item) => !item.ok)
      .map((item) => ({ shopId: item.shopId, error: item.error })),
  };
}

function collectMonthlyStats(createdOrders, paidOrders) {
  const createdCount = createdOrders.length;
  const paidCount = paidOrders.length;
  const revenueCreatedCents = sumGmvCents(createdOrders);
  const revenuePaidCents = sumGmvCents(paidOrders);
  const ticketAverageCents = paidCount
    ? Math.round(revenuePaidCents / paidCount)
    : 0;
  const paidRatePct = createdCount ? (paidCount / createdCount) * 100 : 0;
  const cancelledCount = countOrdersByStatuses(
    createdOrders,
    CANCELLED_ORDER_STATUSES,
  );
  const returnedCount = countOrdersByStatuses(
    createdOrders,
    RETURNED_ORDER_STATUSES,
  );

  return {
    createdCount,
    paidCount,
    revenueCreatedCents,
    revenuePaidCents,
    ticketAverageCents,
    paidRatePct,
    cancelledCount,
    returnedCount,
  };
}

function buildMonthlyComparisonMetrics(currentStats, previousStats) {
  const createMetric = ({
    key,
    label,
    currentValue,
    previousValue,
    currentLabel,
    previousLabel,
  }) => {
    const maxValue = Math.max(
      Number(currentValue || 0),
      Number(previousValue || 0),
      0,
    );

    return {
      key,
      label,
      currentValue,
      previousValue,
      currentLabel,
      previousLabel,
      growthLabel: formatPercentChange(currentValue, previousValue),
      currentPct:
        maxValue > 0 ? (Number(currentValue || 0) / maxValue) * 100 : 0,
      previousPct:
        maxValue > 0 ? (Number(previousValue || 0) / maxValue) * 100 : 0,
    };
  };

  return [
    createMetric({
      key: "orders_created",
      label: "Pedidos feitos",
      currentValue: currentStats.createdCount,
      previousValue: previousStats.createdCount,
      currentLabel: formatCountLabel(currentStats.createdCount),
      previousLabel: formatCountLabel(previousStats.createdCount),
    }),
    createMetric({
      key: "orders_paid",
      label: "Pedidos pagos",
      currentValue: currentStats.paidCount,
      previousValue: previousStats.paidCount,
      currentLabel: formatCountLabel(currentStats.paidCount),
      previousLabel: formatCountLabel(previousStats.paidCount),
    }),
    createMetric({
      key: "revenue_created",
      label: "Faturamento feito",
      currentValue: currentStats.revenueCreatedCents,
      previousValue: previousStats.revenueCreatedCents,
      currentLabel: formatMoneyLabel(currentStats.revenueCreatedCents),
      previousLabel: formatMoneyLabel(previousStats.revenueCreatedCents),
    }),
    createMetric({
      key: "revenue_paid",
      label: "Faturamento pago",
      currentValue: currentStats.revenuePaidCents,
      previousValue: previousStats.revenuePaidCents,
      currentLabel: formatMoneyLabel(currentStats.revenuePaidCents),
      previousLabel: formatMoneyLabel(previousStats.revenuePaidCents),
    }),
    createMetric({
      key: "ticket_average",
      label: "Ticket medio",
      currentValue: currentStats.ticketAverageCents,
      previousValue: previousStats.ticketAverageCents,
      currentLabel: formatMoneyLabel(currentStats.ticketAverageCents),
      previousLabel: formatMoneyLabel(previousStats.ticketAverageCents),
    }),
    createMetric({
      key: "paid_rate",
      label: "Taxa pedidos feitos > pagos",
      currentValue: currentStats.paidRatePct,
      previousValue: previousStats.paidRatePct,
      currentLabel: formatPercentValue(currentStats.paidRatePct),
      previousLabel: formatPercentValue(previousStats.paidRatePct),
    }),
    createMetric({
      key: "cancelled",
      label: "Cancelamentos",
      currentValue: currentStats.cancelledCount,
      previousValue: previousStats.cancelledCount,
      currentLabel: formatCountLabel(currentStats.cancelledCount),
      previousLabel: formatCountLabel(previousStats.cancelledCount),
    }),
    createMetric({
      key: "returned",
      label: "Devolucoes",
      currentValue: currentStats.returnedCount,
      previousValue: previousStats.returnedCount,
      currentLabel: formatCountLabel(currentStats.returnedCount),
      previousLabel: formatCountLabel(previousStats.returnedCount),
    }),
  ];
}

function buildMonthlyCards(currentStats, previousStats) {
  return [
    {
      label: "Pedidos feitos",
      value: formatCountLabel(currentStats.createdCount),
      growthLabel: formatPercentChange(
        currentStats.createdCount,
        previousStats.createdCount,
      ),
    },
    {
      label: "Pedidos pagos",
      value: formatCountLabel(currentStats.paidCount),
      growthLabel: formatPercentChange(
        currentStats.paidCount,
        previousStats.paidCount,
      ),
    },
    {
      label: "Faturamento feito",
      value: formatMoneyLabel(currentStats.revenueCreatedCents),
      growthLabel: formatPercentChange(
        currentStats.revenueCreatedCents,
        previousStats.revenueCreatedCents,
      ),
    },
    {
      label: "Faturamento pago",
      value: formatMoneyLabel(currentStats.revenuePaidCents),
      growthLabel: formatPercentChange(
        currentStats.revenuePaidCents,
        previousStats.revenuePaidCents,
      ),
    },
    {
      label: "Ticket medio",
      value: formatMoneyLabel(currentStats.ticketAverageCents),
      growthLabel: formatPercentChange(
        currentStats.ticketAverageCents,
        previousStats.ticketAverageCents,
      ),
    },
    {
      label: "Taxa pedidos feitos > pagos",
      value: formatPercentValue(currentStats.paidRatePct),
      growthLabel: formatPercentChange(
        currentStats.paidRatePct,
        previousStats.paidRatePct,
      ),
    },
    {
      label: "Cancelamentos",
      value: formatCountLabel(currentStats.cancelledCount),
      growthLabel: formatPercentChange(
        currentStats.cancelledCount,
        previousStats.cancelledCount,
      ),
    },
    {
      label: "Devolucoes",
      value: formatCountLabel(currentStats.returnedCount),
      growthLabel: formatPercentChange(
        currentStats.returnedCount,
        previousStats.returnedCount,
      ),
    },
  ];
}

function buildReportPayload({
  spec,
  periods,
  currentPaidOrders,
  previousPaidOrders,
  currentCreatedOrders,
  previousCreatedOrders,
  operational,
  dashboard,
}) {
  const isMonthly = spec === REPORT_TYPES.monthly;
  const currentRevenuePaidCents = sumGmvCents(currentPaidOrders);
  const previousRevenuePaidCents = sumGmvCents(previousPaidOrders);

  let monthly = null;
  if (isMonthly) {
    const currentStats = collectMonthlyStats(
      currentCreatedOrders,
      currentPaidOrders,
    );
    const previousStats = collectMonthlyStats(
      previousCreatedOrders,
      previousPaidOrders,
    );

    monthly = {
      cards: buildMonthlyCards(currentStats, previousStats),
      comparisonMetrics: buildMonthlyComparisonMetrics(
        currentStats,
        previousStats,
      ),
    };
  }

  return {
    meta: {
      title: spec.title,
      intro: spec.intro,
      badgeLabel: spec.badgeLabel,
      ordersLabel: spec.ordersLabel,
      salesLabel: spec.salesLabel,
      ordersCompareLabel: spec.ordersCompareLabel,
      salesCompareLabel: spec.salesCompareLabel,
      tableTitle: spec.tableTitle,
      emptyTableText: spec.emptyTableText,
      hideOperations: Boolean(spec.hideOperations),
      isMonthly,
    },
    period: {
      currentLabel: isMonthly
        ? formatMonthLabel(periods.current)
        : formatPeriodLabel(periods.current),
      previousLabel: isMonthly
        ? formatMonthLabel(periods.previous)
        : formatPeriodLabel(periods.previous),
    },
    summary: {
      ordersCount: currentPaidOrders.length,
      gmvCents: currentRevenuePaidCents,
      ordersGrowthLabel: formatPercentChange(
        currentPaidOrders.length,
        previousPaidOrders.length,
      ),
      salesGrowthLabel: formatPercentChange(
        currentRevenuePaidCents,
        previousRevenuePaidCents,
      ),
    },
    shipping: operational?.shipping || null,
    status: operational?.status || null,
    monthly,
    dashboard: dashboard || null,
    orders: (isMonthly ? currentCreatedOrders : currentPaidOrders).slice(0, 10),
  };
}

async function sendReportForAccount({
  account,
  spec,
  reportType,
  now,
  skipSyncBeforeSend = false,
}) {
  const recipients = pickActiveRecipients(account.users);
  if (!recipients.length || !account.shops.length) {
    return { reportType, skipped: true, reason: "Sem destinatarios ou lojas." };
  }

  const syncSummary = skipSyncBeforeSend
    ? {
        attempted: false,
        skipped: true,
        synced: 0,
        failed: 0,
        errors: [],
        reason: "Sync ignorado manualmente nesta execucao.",
      }
    : await syncOrdersBeforeReport({ account, spec });
  if (syncSummary.attempted && syncSummary.synced === 0 && syncSummary.failed > 0) {
    return {
      reportType,
      accountId: account.id,
      accountName: account.name,
      skipped: true,
      reason: "Falha ao sincronizar pedidos antes do envio do relatorio.",
      syncSummary,
    };
  }

  const shopIds = account.shops.map((shop) => shop.id);
  const periods = spec.buildPeriods(now);
  const isMonthly = spec === REPORT_TYPES.monthly;

  const [
    currentPaidOrders,
    previousPaidOrders,
    currentCreatedOrders,
    previousCreatedOrders,
    operational,
    dashboard,
  ] = await Promise.all([
    loadOrdersForRange(shopIds, periods.current),
    loadOrdersForRange(shopIds, periods.previous),
    isMonthly
      ? loadCreatedOrdersForRange(shopIds, periods.current)
      : Promise.resolve([]),
    isMonthly
      ? loadCreatedOrdersForRange(shopIds, periods.previous)
      : Promise.resolve([]),
    spec.hideOperations
      ? Promise.resolve(null)
      : loadOperationalSummary(shopIds, now),
    loadDashboardInsights(shopIds, now),
  ]);

  const report = buildReportPayload({
    spec,
    periods,
    currentPaidOrders,
    previousPaidOrders,
    currentCreatedOrders,
    previousCreatedOrders,
    operational,
    dashboard,
  });

  const attachment = buildCsvAttachment({
    accountName: account.name,
    filePrefix: spec.filePrefix,
    orders: isMonthly ? currentCreatedOrders : currentPaidOrders,
  });

  let sent = 0;
  let skipped = 0;
  const errors = [];

  for (const recipient of recipients) {
    try {
      const delivery = await sendSalesSummaryEmail({
        toEmail: recipient.email,
        toName: recipient.name,
        companyName: account.name,
        report,
        attachment,
        subject: `${spec.subject} - ${account.name || "DAVANTTI"}`,
        tags: spec.tags,
      });

      if (delivery?.sent) {
        sent += 1;
      } else {
        skipped += 1;
      }
    } catch (error) {
      errors.push({
        email: recipient.email,
        error: String(error?.message || error),
      });
    }
  }

  return {
    reportType,
    accountId: account.id,
    accountName: account.name,
    syncSummary,
    recipients: recipients.length,
    sent,
    skipped,
    errors,
  };
}

async function sendPendingSalesSummaryEmails(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const reportType =
    typeof options.reportType === "string" && REPORT_TYPES[options.reportType]
      ? options.reportType
      : "daily_24h";
  const accountNameFilter = String(options.accountName || "").trim();
  const skipSyncBeforeSend = Boolean(options.skipSyncBeforeSend);

  const spec = REPORT_TYPES[reportType];
  const accounts = await listAccountsForSalesSummary(accountNameFilter);

  const results = [];
  for (const account of accounts) {
    results.push(
      await sendReportForAccount({
        account,
        spec,
        reportType,
        now,
        skipSyncBeforeSend,
      }),
    );
  }

  return {
    ok: true,
    reportType,
    processedAt: now.toISOString(),
    accounts: results,
    totals: {
      accounts: results.length,
      sent: results.reduce((sum, item) => sum + Number(item.sent || 0), 0),
      skipped: results.reduce(
        (sum, item) => sum + Number(item.skipped || 0),
        0,
      ),
      errors: results.reduce(
        (sum, item) => sum + Number(item.errors?.length || 0),
        0,
      ),
    },
  };
}

module.exports = {
  REPORT_TYPES,
  sendPendingSalesSummaryEmails,
};
