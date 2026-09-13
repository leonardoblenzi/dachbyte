"use strict";

const {
  getOrCreateDefaultWorkspace,
  getWorkspaceById,
  queryRows,
  toNumber,
} = require("./databaseService");
const { getCatalogCacheSnapshot } = require("./catalogCacheService");

const DAY_MS = 24 * 60 * 60 * 1000;

function parsePeriod(period) {
  const raw = String(period || "current_month")
    .trim()
    .toLowerCase();
  if (["current_month", "this_month", "mes_atual"].includes(raw)) {
    return { mode: "current_month", label: "Mes atual" };
  }
  const match = raw.match(/^(\d+)(d|m|y)$/);

  if (!match) {
    return { mode: "current_month", label: "Mes atual" };
  }

  return {
    amount: Number(match[1]),
    unit: match[2],
    label: raw,
  };
}

function getPeriodRange(period) {
  const parsed = parsePeriod(period);
  if (parsed.mode === "current_month") {
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    const start = new Date(end.getFullYear(), end.getMonth(), 1);
    start.setHours(0, 0, 0, 0);
    const previousEnd = new Date(start.getTime() - 1);
    const previousStart = new Date(previousEnd.getTime() - (end.getTime() - start.getTime()));
    previousStart.setHours(0, 0, 0, 0);

    return {
      current: { start, end },
      previous: { start: previousStart, end: previousEnd },
      groupBy: "day",
      label: parsed.label,
    };
  }

  const end = new Date();
  const start = new Date(end);

  if (parsed.unit === "d") {
    start.setDate(start.getDate() - parsed.amount + 1);
  } else if (parsed.unit === "m") {
    start.setMonth(start.getMonth() - parsed.amount);
    start.setDate(start.getDate() + 1);
  } else {
    start.setFullYear(start.getFullYear() - parsed.amount);
    start.setDate(start.getDate() + 1);
  }

  start.setHours(0, 0, 0, 0);
  end.setHours(23, 59, 59, 999);

  const previousEnd = new Date(start.getTime() - 1);
  const previousStart = new Date(previousEnd);
  previousStart.setTime(previousEnd.getTime() - (end.getTime() - start.getTime()));
  previousStart.setHours(0, 0, 0, 0);

  return {
    current: { start, end },
    previous: { start: previousStart, end: previousEnd },
    groupBy: parsed.unit === "d" && parsed.amount <= 31 ? "day" : "month",
    label: parsed.label,
  };
}

function formatBucket(date, groupBy) {
  const normalized = new Date(date);

  if (groupBy === "month") {
    return `${normalized.getFullYear()}-${String(normalized.getMonth() + 1).padStart(2, "0")}`;
  }

  return `${normalized.getFullYear()}-${String(normalized.getMonth() + 1).padStart(2, "0")}-${String(normalized.getDate()).padStart(2, "0")}`;
}

function buildBuckets(start, end, groupBy) {
  const buckets = [];
  const cursor = new Date(start);

  while (cursor <= end) {
    buckets.push(formatBucket(cursor, groupBy));

    if (groupBy === "month") {
      cursor.setMonth(cursor.getMonth() + 1);
      cursor.setDate(1);
    } else {
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  return buckets;
}

function growthPercent(current, previous) {
  if (!previous) {
    return current > 0 ? 100 : 0;
  }

  return Number((((current - previous) / previous) * 100).toFixed(2));
}

function withinRange(dateValue, range) {
  if (!dateValue) return false;
  const date = new Date(dateValue);
  return date >= range.start && date <= range.end;
}

function sum(values) {
  return values.reduce((total, value) => total + Number(value || 0), 0);
}

function isApprovedOrderStatus(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (!normalized) return false;
  if (["cancelled", "returned", "refunded", "imported", "new", "pending"].includes(normalized)) {
    return false;
  }
  return [
    "approved",
    "received",
    "awaiting_invoice",
    "ready_to_ship",
    "shipped",
    "delivered",
    "invoiced",
  ].includes(normalized);
}

function isFinancialPaidStatus(status) {
  const normalized = String(status || "").trim().toLowerCase();
  return ["paid", "released", "settled", "completed", "approved", "done", "liquidated"].includes(normalized);
}

async function loadAnalyticsRows(workspaceId, currentRange, previousRange) {
  const start = previousRange.start.toISOString();
  const end = currentRange.end.toISOString();

  const [orders, financialEntries, orderItems, threads, freightQuotes, syncRuns] =
    await Promise.all([
      queryRows(
        `
          select
            "id",
            "status"::text as "status",
            "totalAmount",
            "importedAt",
            "approvedAt",
            "shippedAt",
            "deliveredAt",
            "cancelledAt",
            "createdAt"
          from "MadOrder"
          where "workspaceId" = $1
            and coalesce("approvedAt", "importedAt", "createdAt") between $2 and $3
        `,
        [workspaceId, start, end],
      ),
      queryRows(
        `
          select
            "status"::text as "status",
            "grossAmount",
            "feeAmount",
            "netAmount",
            coalesce("paidAt", "releaseDate", "createdAt") as "eventDate"
          from "MadFinancialEntry"
          where "workspaceId" = $1
            and coalesce("paidAt", "releaseDate", "createdAt") between $2 and $3
        `,
        [workspaceId, start, end],
      ),
      queryRows(
        `
          select
            oi."sku",
            oi."title",
            oi."quantity",
            oi."totalPrice",
            coalesce(o."approvedAt", o."importedAt", o."createdAt") as "eventDate",
            o."status"::text as "orderStatus"
          from "MadOrderItem" oi
          join "MadOrder" o on o."id" = oi."orderId"
          where o."workspaceId" = $1
            and coalesce(o."approvedAt", o."importedAt", o."createdAt") between $2 and $3
        `,
        [workspaceId, start, end],
      ),
      queryRows(
        `
          select
            "status"::text as "status",
            "unreadCount",
            coalesce("lastMessageAt", "createdAt") as "eventDate"
          from "MadMessageThread"
          where "workspaceId" = $1
            and coalesce("lastMessageAt", "createdAt") between $2 and $3
        `,
        [workspaceId, start, end],
      ),
      queryRows(
        `
          select
            "status"::text as "status",
            "quotedAmount",
            "responseTimeMs",
            "carrierName",
            coalesce("respondedAt", "requestedAt") as "eventDate"
          from "MadFreightQuote"
          where "workspaceId" = $1
            and coalesce("respondedAt", "requestedAt") between $2 and $3
        `,
        [workspaceId, start, end],
      ),
      queryRows(
        `
          select
            "domain"::text as "domain",
            "status"::text as "status",
            "itemsTotal",
            "itemsProcessed",
            "itemsFailed",
            "startedAt"
          from "MadSyncRun"
          where "workspaceId" = $1
            and "startedAt" between $2 and $3
        `,
        [workspaceId, start, end],
      ),
    ]);

  return { orders, financialEntries, orderItems, threads, freightQuotes, syncRuns };
}

function buildSeries(range, groupBy, rows, valueSelector, dateSelector) {
  const buckets = buildBuckets(range.start, range.end, groupBy);
  const map = new Map(buckets.map((bucket) => [bucket, 0]));

  rows.forEach((row) => {
    const dateValue = dateSelector(row);
    if (!withinRange(dateValue, range)) return;
    const bucket = formatBucket(dateValue, groupBy);
    map.set(bucket, (map.get(bucket) || 0) + valueSelector(row));
  });

  return buckets.map((bucket) => ({
    bucket,
    value: Number((map.get(bucket) || 0).toFixed(2)),
  }));
}

function buildProductGrowth(orderItems, currentRange, previousRange, productLookup = new Map(), limit = 8) {
  const grouped = new Map();

  orderItems
    .filter((item) => !["cancelled", "returned", "refunded"].includes(item.orderStatus))
    .forEach((item) => {
      const key = item.sku || item.title || "sem-sku";
      if (!grouped.has(key)) {
        grouped.set(key, {
          sku: item.sku,
          title: item.title,
          currentUnits: 0,
          currentRevenue: 0,
          previousUnits: 0,
          previousRevenue: 0,
        });
      }

      const current = grouped.get(key);
      const target = withinRange(item.eventDate, currentRange) ? "current" : withinRange(item.eventDate, previousRange) ? "previous" : null;

      if (!target) return;

      current[`${target}Units`] += Number(item.quantity || 0);
      current[`${target}Revenue`] += toNumber(item.totalPrice);
    });

  return Array.from(grouped.values())
    .map((entry) => ({
      ...entry,
      imageUrl: productLookup.get(String(entry.sku || "").trim())?.imageUrl || null,
      productName: productLookup.get(String(entry.sku || "").trim())?.title || entry.title || null,
      revenueGrowth: growthPercent(entry.currentRevenue, entry.previousRevenue),
      unitGrowth: growthPercent(entry.currentUnits, entry.previousUnits),
    }))
    .sort((left, right) => right.currentRevenue - left.currentRevenue)
    .slice(0, Number.isFinite(limit) ? limit : undefined);
}

function parseIdentifierList(value) {
  if (Array.isArray(value)) {
    return Array.from(
      new Set(
        value
          .map((item) => String(item || "").trim().toLowerCase())
          .filter(Boolean),
      ),
    );
  }

  return Array.from(
    new Set(
      String(value || "")
        .split(/[\n,;]+/)
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
}

function getCustomOrPresetRange(params = {}) {
  const dateFrom = String(params.dateFrom || "").trim();
  const dateTo = String(params.dateTo || "").trim();

  if (dateFrom && dateTo) {
    const start = new Date(`${dateFrom}T00:00:00`);
    const end = new Date(`${dateTo}T23:59:59.999`);
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && start <= end) {
      const spanMs = end.getTime() - start.getTime();
      const previousEnd = new Date(start.getTime() - 1);
      const previousStart = new Date(previousEnd.getTime() - spanMs);
      previousStart.setHours(0, 0, 0, 0);
      const totalDays = Math.max(1, Math.ceil((end.getTime() - start.getTime() + 1) / DAY_MS));

      return {
        current: { start, end },
        previous: { start: previousStart, end: previousEnd },
        groupBy: totalDays <= 45 ? "day" : "month",
        label: `${dateFrom}_${dateTo}`,
        source: "custom",
      };
    }
  }

  return {
    ...getPeriodRange(params.period || "current_month"),
    source: "preset",
  };
}

function getAnalyticsRange(params = {}) {
  const baseRange = getCustomOrPresetRange(params);
  const compareFrom = String(params.compareFrom || "").trim();
  const compareTo = String(params.compareTo || "").trim();

  if (compareFrom && compareTo) {
    const compareStart = new Date(`${compareFrom}T00:00:00`);
    const compareEnd = new Date(`${compareTo}T23:59:59.999`);
    if (!Number.isNaN(compareStart.getTime()) && !Number.isNaN(compareEnd.getTime()) && compareStart <= compareEnd) {
      return {
        ...baseRange,
        previous: {
          start: compareStart,
          end: compareEnd,
        },
        comparisonSource: "custom",
      };
    }
  }

  return {
    ...baseRange,
    comparisonSource: "preset",
  };
}

async function loadSalesReportRows(workspaceId, currentRange, previousRange) {
  const start = previousRange.start.toISOString();
  const end = currentRange.end.toISOString();

  const [orders, financialEntries, orderItems] = await Promise.all([
    queryRows(
      `
        select
          "id",
          "externalId",
          "externalCode",
          "status"::text as "status",
          "buyerName",
          "subtotalAmount",
          "freightAmount",
          "discountAmount",
          "totalAmount",
          "currency",
          "approvedAt",
          "importedAt",
          "deliveredAt",
          "createdAt"
        from "MadOrder"
        where "workspaceId" = $1
          and coalesce("approvedAt", "importedAt", "createdAt") between $2 and $3
      `,
      [workspaceId, start, end],
    ),
    queryRows(
      `
        select
          "id",
          "orderId",
          "externalId",
          "description",
          "status"::text as "status",
          "grossAmount",
          "feeAmount",
          "netAmount",
          coalesce("paidAt", "releaseDate", "createdAt") as "eventDate"
        from "MadFinancialEntry"
        where "workspaceId" = $1
          and coalesce("paidAt", "releaseDate", "createdAt") between $2 and $3
      `,
      [workspaceId, start, end],
    ),
    queryRows(
      `
        select
          oi."orderId",
          oi."sku",
          oi."title",
          oi."quantity",
          oi."totalPrice",
          coalesce(o."approvedAt", o."importedAt", o."createdAt") as "eventDate",
          o."status"::text as "orderStatus",
          o."externalId",
          o."externalCode",
          o."buyerName"
        from "MadOrderItem" oi
        join "MadOrder" o on o."id" = oi."orderId"
        where o."workspaceId" = $1
          and coalesce(o."approvedAt", o."importedAt", o."createdAt") between $2 and $3
      `,
      [workspaceId, start, end],
    ),
  ]);

  return { orders, financialEntries, orderItems };
}

function filterSalesDataset(rows, filters = {}) {
  const orderIds = parseIdentifierList(filters.orderIds);
  const productIds = parseIdentifierList(filters.productIds);
  const hasOrderFilter = orderIds.length > 0;
  const hasProductFilter = productIds.length > 0;
  const orderIdSet = new Set(orderIds);
  const productIdSet = new Set(productIds);
  const normalize = (value) => String(value || "").trim().toLowerCase();

  let filteredItems = rows.orderItems;
  if (hasProductFilter) {
    filteredItems = filteredItems.filter((item) =>
      productIdSet.has(normalize(item.sku)) ||
      productIdSet.has(normalize(item.title)),
    );
  }

  const matchedOrderIdsByProducts = new Set(filteredItems.map((item) => item.orderId));
  const filteredOrders = rows.orders.filter((order) => {
    const orderMatches =
      !hasOrderFilter ||
      [order.id, order.externalId, order.externalCode].some((value) => orderIdSet.has(normalize(value)));
    const productMatches = !hasProductFilter || matchedOrderIdsByProducts.has(order.id);
    return orderMatches && productMatches;
  });

  const allowedOrderIds = new Set(filteredOrders.map((order) => order.id));

  filteredItems = rows.orderItems.filter((item) => {
    if (!allowedOrderIds.has(item.orderId)) return false;
    if (!hasProductFilter) return true;
    return productIdSet.has(normalize(item.sku)) || productIdSet.has(normalize(item.title));
  });

  const filteredFinancialEntries = rows.financialEntries.filter((entry) => {
    if (!hasOrderFilter && !hasProductFilter) return true;
    return entry.orderId ? allowedOrderIds.has(entry.orderId) : false;
  });

  return {
    orders: filteredOrders,
    financialEntries: filteredFinancialEntries,
    orderItems: filteredItems,
    filters: {
      orderIds,
      productIds,
    },
  };
}

function buildOrderReportRows(currentOrders, currentFinancial, currentItems) {
  const financialByOrder = new Map();
  currentFinancial.forEach((entry) => {
    if (!entry.orderId) return;
    const current = financialByOrder.get(entry.orderId) || { grossAmount: 0, feeAmount: 0, netAmount: 0 };
    current.grossAmount += toNumber(entry.grossAmount);
    current.feeAmount += toNumber(entry.feeAmount);
    current.netAmount += toNumber(entry.netAmount);
    financialByOrder.set(entry.orderId, current);
  });

  const itemsByOrder = new Map();
  currentItems.forEach((item) => {
    if (!itemsByOrder.has(item.orderId)) {
      itemsByOrder.set(item.orderId, []);
    }
    itemsByOrder.get(item.orderId).push(item);
  });

  return currentOrders
    .map((order) => {
      const items = itemsByOrder.get(order.id) || [];
      const finance = financialByOrder.get(order.id) || { grossAmount: 0, feeAmount: 0, netAmount: 0 };
      return {
        id: order.id,
        externalId: order.externalId,
        externalCode: order.externalCode,
        buyerName: order.buyerName,
        status: order.status,
        eventDate: order.approvedAt || order.importedAt || order.createdAt,
        totalAmount: toNumber(order.totalAmount),
        subtotalAmount: toNumber(order.subtotalAmount),
        freightAmount: toNumber(order.freightAmount),
        discountAmount: toNumber(order.discountAmount),
        grossAmount: Number(finance.grossAmount.toFixed(2)),
        feeAmount: Number(finance.feeAmount.toFixed(2)),
        netAmount: Number(finance.netAmount.toFixed(2)),
        itemCount: items.length,
        units: sum(items.map((item) => Number(item.quantity || 0))),
        skus: Array.from(new Set(items.map((item) => item.sku).filter(Boolean))),
      };
    })
    .sort((left, right) => new Date(right.eventDate || 0) - new Date(left.eventDate || 0));
}

function csvEscape(value) {
  const stringValue = String(value ?? "");
  if (/[",\n;]/.test(stringValue)) {
    return `"${stringValue.replaceAll('"', '""')}"`;
  }
  return stringValue;
}

function buildSalesReportCsv(report) {
  const lines = [[
    "section",
    "primary",
    "secondary",
    "status",
    "date",
    "value1",
    "value2",
    "value3",
    "value4",
    "notes",
  ]];

  lines.push(["filters", "period", report.period.label, report.period.source, "", report.filters.orderIds.join(" | "), report.filters.productIds.join(" | "), "", "", ""]);
  lines.push(["summary", "orders", "", "", "", report.kpis.orders, report.kpis.ordersGrowth, "", "", ""]);
  lines.push(["summary", "grossRevenue", "", "", "", report.kpis.grossRevenue, report.kpis.grossRevenueGrowth, "", "", ""]);
  lines.push(["summary", "netRevenue", "", "", "", report.kpis.netRevenue, report.kpis.netRevenueGrowth, "", "", ""]);
  lines.push(["summary", "feeAmount", "", "", "", report.kpis.feeAmount, report.kpis.feeAmountGrowth, "", "", ""]);
  lines.push(["summary", "marginRate", "", "", "", report.kpis.marginRate, report.kpis.marginRateGrowth, "", "", ""]);
  lines.push(["summary", "avgTicket", "", "", "", report.kpis.avgTicket, report.kpis.avgTicketGrowth, "", "", ""]);

  (report.series.revenue || []).forEach((item) => {
    lines.push(["revenue_series", item.bucket, "", "", item.bucket, item.value, "", "", "", ""]);
  });

  (report.series.orders || []).forEach((item) => {
    lines.push(["orders_series", item.bucket, "", "", item.bucket, item.value, "", "", "", ""]);
  });

  (report.products.growth || []).forEach((item) => {
    lines.push([
      "product_growth",
      item.sku || "Sem SKU",
      item.title || "",
      "",
      "",
      Number(item.currentRevenue || 0).toFixed(2),
      Number(item.revenueGrowth || 0).toFixed(2),
      Number(item.currentUnits || 0).toFixed(0),
      Number(item.unitGrowth || 0).toFixed(2),
      "",
    ]);
  });

  (report.orders.rows || []).forEach((item) => {
    lines.push([
      "orders",
      item.externalId || item.id,
      item.buyerName || "",
      item.status || "",
      item.eventDate || "",
      Number(item.totalAmount || 0).toFixed(2),
      Number(item.netAmount || 0).toFixed(2),
      Number(item.itemCount || 0).toFixed(0),
      Number(item.units || 0).toFixed(0),
      (item.skus || []).join(" | "),
    ]);
  });

  return lines.map((row) => row.map(csvEscape).join(",")).join("\n");
}

async function getSalesReport(params = {}) {
  const workspace =
    params.workspaceId && String(params.workspaceId).trim()
      ? await getWorkspaceById(String(params.workspaceId).trim())
      : await getOrCreateDefaultWorkspace();

  const range = getCustomOrPresetRange(params);
  const rawRows = await loadSalesReportRows(workspace.id, range.current, range.previous);
  const rows = filterSalesDataset(rawRows, params);
  const currentOrders = rows.orders.filter((row) => withinRange(row.approvedAt || row.importedAt || row.createdAt, range.current));
  const previousOrders = rows.orders.filter((row) => withinRange(row.approvedAt || row.importedAt || row.createdAt, range.previous));
  const currentFinancial = rows.financialEntries.filter((row) => withinRange(row.eventDate, range.current));
  const previousFinancial = rows.financialEntries.filter((row) => withinRange(row.eventDate, range.previous));
  const currentItems = rows.orderItems.filter((row) => withinRange(row.eventDate, range.current));

  const grossRevenueCurrent = sum(currentOrders.map((row) => toNumber(row.totalAmount)));
  const grossRevenuePrevious = sum(previousOrders.map((row) => toNumber(row.totalAmount)));
  const feeAmountCurrent = sum(currentFinancial.map((row) => toNumber(row.feeAmount)));
  const feeAmountPrevious = sum(previousFinancial.map((row) => toNumber(row.feeAmount)));
  const netRevenueCurrent = sum(currentFinancial.map((row) => toNumber(row.netAmount)));
  const netRevenuePrevious = sum(previousFinancial.map((row) => toNumber(row.netAmount)));
  const avgTicketCurrent = currentOrders.length ? grossRevenueCurrent / currentOrders.length : 0;
  const avgTicketPrevious = previousOrders.length ? grossRevenuePrevious / previousOrders.length : 0;
  const marginRateCurrent = grossRevenueCurrent ? (netRevenueCurrent / grossRevenueCurrent) * 100 : 0;
  const marginRatePrevious = grossRevenuePrevious ? (netRevenuePrevious / grossRevenuePrevious) * 100 : 0;
  const financialRevenueSeries = buildSeries(range.current, range.groupBy, currentFinancial, (row) => toNumber(row.netAmount), (row) => row.eventDate);
  const orderRevenueSeries = buildSeries(range.current, range.groupBy, currentOrders, (row) => toNumber(row.totalAmount), (row) => row.approvedAt || row.importedAt || row.createdAt);
  const financialSeriesTotal = sum(financialRevenueSeries.map((item) => toNumber(item.value)));
  const revenueSeries = financialSeriesTotal > 0 ? financialRevenueSeries : orderRevenueSeries;

  return {
    workspace,
    period: {
      label: range.label,
      source: range.source,
      groupBy: range.groupBy,
      current: {
        start: range.current.start.toISOString(),
        end: range.current.end.toISOString(),
      },
      previous: {
        start: range.previous.start.toISOString(),
        end: range.previous.end.toISOString(),
      },
    },
    filters: rows.filters,
    kpis: {
      orders: currentOrders.length,
      ordersGrowth: growthPercent(currentOrders.length, previousOrders.length),
      grossRevenue: Number(grossRevenueCurrent.toFixed(2)),
      grossRevenueGrowth: growthPercent(grossRevenueCurrent, grossRevenuePrevious),
      feeAmount: Number(feeAmountCurrent.toFixed(2)),
      feeAmountGrowth: growthPercent(feeAmountCurrent, feeAmountPrevious),
      netRevenue: Number(netRevenueCurrent.toFixed(2)),
      netRevenueGrowth: growthPercent(netRevenueCurrent, netRevenuePrevious),
      marginRate: Number(marginRateCurrent.toFixed(2)),
      marginRateGrowth: growthPercent(marginRateCurrent, marginRatePrevious),
      avgTicket: Number(avgTicketCurrent.toFixed(2)),
      avgTicketGrowth: growthPercent(avgTicketCurrent, avgTicketPrevious),
    },
    series: {
      revenue: revenueSeries,
      orders: buildSeries(range.current, range.groupBy, currentOrders, () => 1, (row) => row.approvedAt || row.importedAt || row.createdAt),
    },
    products: {
      growth: buildProductGrowth(rows.orderItems, range.current, range.previous, new Map(), 50),
    },
    orders: {
      rows: buildOrderReportRows(currentOrders, currentFinancial, currentItems),
    },
  };
}

function classifyAbc(cumulativePercent) {
  if (cumulativePercent <= 80) return "A";
  if (cumulativePercent <= 95) return "B";
  return "C";
}

function resolveAbcBusinessProfile(revenueClass, unitsClass) {
  if (revenueClass === "A" && unitsClass === "A") {
    return "Produto estrategico";
  }
  if (revenueClass === "C" && unitsClass === "A") {
    return "Produto de giro";
  }
  if (revenueClass === "A" && unitsClass === "C") {
    return "Produto premium";
  }
  if (revenueClass === "C" && unitsClass === "C") {
    return "Produto pouco relevante";
  }
  return "Produto intermediario";
}

function rankAbcEntries(entries, metricKey) {
  const sorted = [...entries]
    .map((entry) => ({
      ...entry,
      metricValue: Number(entry?.[metricKey] || 0),
    }))
    .sort((left, right) => {
      if (right.metricValue !== left.metricValue) return right.metricValue - left.metricValue;
      return String(left.sku || left.title || "").localeCompare(String(right.sku || right.title || ""));
    });

  const totalMetric = sorted.reduce((total, row) => total + Number(row.metricValue || 0), 0);
  let cumulative = 0;
  const counts = { classA: 0, classB: 0, classC: 0 };
  const byKey = new Map();

  const rows = sorted.map((row, index) => {
    const participation = totalMetric > 0 ? (Number(row.metricValue || 0) / totalMetric) * 100 : 0;
    cumulative += participation;
    const cumulativeRounded = Number(cumulative.toFixed(2));
    const abcClass = classifyAbc(cumulativeRounded);
    if (abcClass === "A") counts.classA += 1;
    if (abcClass === "B") counts.classB += 1;
    if (abcClass === "C") counts.classC += 1;
    const rankRow = {
      rank: index + 1,
      participation: Number(participation.toFixed(2)),
      cumulative: cumulativeRounded,
      abcClass,
      metricValue: Number(row.metricValue.toFixed(2)),
    };
    byKey.set(row._key, rankRow);
    return {
      ...row,
      ...rankRow,
    };
  });

  return {
    rows,
    byKey,
    summary: {
      totalSkus: rows.length,
      totalMetric: Number(totalMetric.toFixed(2)),
      classA: counts.classA,
      classB: counts.classB,
      classC: counts.classC,
      metric: metricKey,
    },
  };
}

function buildAbcRows(orderItems, metric = "revenue") {
  const selectedMetric = String(metric || "revenue").trim().toLowerCase();
  const grouped = new Map();

  orderItems
    .filter((item) => !["cancelled", "returned", "refunded"].includes(item.orderStatus))
    .forEach((item) => {
      const key = item.sku || item.title || `sem-sku-${grouped.size + 1}`;
      if (!grouped.has(key)) {
        grouped.set(key, {
          _key: key,
          sku: item.sku || null,
          title: item.title || "Sem titulo",
          revenue: 0,
          units: 0,
          orders: new Set(),
        });
      }

      const current = grouped.get(key);
      current.revenue += toNumber(item.totalPrice);
      current.units += Number(item.quantity || 0);
      if (item.orderId) current.orders.add(item.orderId);
    });

  const baseRows = Array.from(grouped.values()).map((entry) => ({
    _key: entry._key,
    sku: entry.sku,
    title: entry.title,
    revenue: Number(entry.revenue.toFixed(2)),
    units: entry.units,
    orders: entry.orders.size,
  }));

  const revenueRanking = rankAbcEntries(baseRows, "revenue");
  const unitsRanking = rankAbcEntries(baseRows, "units");
  const selectedRanking = selectedMetric === "units" ? unitsRanking : revenueRanking;

  const crossMatrix = new Map();
  const profileDistribution = new Map();

  const combinedRows = baseRows.map((row) => {
    const revenue = revenueRanking.byKey.get(row._key) || {};
    const units = unitsRanking.byKey.get(row._key) || {};
    const selected = selectedRanking.byKey.get(row._key) || {};
    const crossClass = `${revenue.abcClass || "C"}${units.abcClass || "C"}`;
    const businessProfile = resolveAbcBusinessProfile(revenue.abcClass, units.abcClass);

    crossMatrix.set(crossClass, (crossMatrix.get(crossClass) || 0) + 1);
    profileDistribution.set(businessProfile, (profileDistribution.get(businessProfile) || 0) + 1);

    return {
      sku: row.sku,
      title: row.title,
      revenue: row.revenue,
      units: row.units,
      orders: row.orders,
      metric: selectedMetric,
      rank: selected.rank || 0,
      metricValue: Number(selected.metricValue || 0),
      participation: Number(selected.participation || 0),
      cumulative: Number(selected.cumulative || 0),
      abcClass: selected.abcClass || "C",
      revenueRank: revenue.rank || 0,
      revenueAbcClass: revenue.abcClass || "C",
      revenueParticipation: Number(revenue.participation || 0),
      revenueCumulative: Number(revenue.cumulative || 0),
      unitsRank: units.rank || 0,
      unitsAbcClass: units.abcClass || "C",
      unitsParticipation: Number(units.participation || 0),
      unitsCumulative: Number(units.cumulative || 0),
      crossClass,
      businessProfile,
    };
  }).sort((left, right) => {
    if (left.rank && right.rank && left.rank !== right.rank) return left.rank - right.rank;
    if (right.metricValue !== left.metricValue) return right.metricValue - left.metricValue;
    return String(left.sku || left.title || "").localeCompare(String(right.sku || right.title || ""));
  });

  const crossSummary = Array.from(crossMatrix.entries())
    .map(([combination, count]) => ({ combination, count }))
    .sort((left, right) => right.count - left.count);

  const profileSummary = Array.from(profileDistribution.entries())
    .map(([profile, count]) => ({ profile, count }))
    .sort((left, right) => right.count - left.count);

  return {
    rows: combinedRows,
    summary: selectedRanking.summary,
    metric: selectedMetric,
    curves: {
      revenue: revenueRanking.summary,
      units: unitsRanking.summary,
    },
    cross: {
      matrix: crossSummary,
      profiles: profileSummary,
    },
  };
}

async function getAbcCurve(params = {}) {
  const workspace =
    params.workspaceId && String(params.workspaceId).trim()
      ? await getWorkspaceById(String(params.workspaceId).trim())
      : await getOrCreateDefaultWorkspace();

  const range = getCustomOrPresetRange(params);
  const rows = await loadSalesReportRows(workspace.id, range.current, range.previous);
  const filtered = filterSalesDataset(rows, params);
  const currentItems = filtered.orderItems.filter((row) => withinRange(row.eventDate, range.current));
  const abc = buildAbcRows(currentItems, params.metric || "revenue");
  const maxRows = Math.max(1, Math.min(500, Number.parseInt(String(params.limit || 200), 10) || 200));

  return {
    workspace,
    period: {
      label: range.label,
      source: range.source,
      current: {
        start: range.current.start.toISOString(),
        end: range.current.end.toISOString(),
      },
    },
    filters: filtered.filters,
    metric: abc.metric,
    summary: abc.summary,
    curves: abc.curves,
    cross: abc.cross,
    items: abc.rows.slice(0, maxRows),
  };
}

function buildStatusDistribution(rows, fieldName) {
  const map = new Map();

  rows.forEach((row) => {
    const key = String(row[fieldName] || "unknown");
    map.set(key, (map.get(key) || 0) + 1);
  });

  return Array.from(map.entries())
    .map(([status, count]) => ({ status, count }))
    .sort((left, right) => right.count - left.count);
}

async function getAnalyticsOverview(params = {}) {
  const workspace =
    params.workspaceId && String(params.workspaceId).trim()
      ? await getWorkspaceById(String(params.workspaceId).trim())
      : await getOrCreateDefaultWorkspace();
  const period = getAnalyticsRange(params);
  const rows = await loadAnalyticsRows(
    workspace.id,
    period.current,
    period.previous,
  );
  const snapshot = getCatalogCacheSnapshot(workspace.id);
  const productLookup = new Map();
  (snapshot.products || []).forEach((product) => {
    const sku = String(product?.sku || "").trim();
    if (!sku) return;
    const primaryImage =
      Array.isArray(product.images) &&
      (product.images.find((image) => image?.isPrimary) || product.images[0]);
    productLookup.set(sku, {
      imageUrl: primaryImage?.url || null,
      title: product.title || null,
    });
  });

  const currentOrders = rows.orders.filter((row) => withinRange(row.approvedAt || row.importedAt || row.createdAt, period.current));
  const previousOrders = rows.orders.filter((row) => withinRange(row.approvedAt || row.importedAt || row.createdAt, period.previous));
  const currentApprovedOrders = currentOrders.filter((row) => isApprovedOrderStatus(row.status));
  const previousApprovedOrders = previousOrders.filter((row) => isApprovedOrderStatus(row.status));
  const currentFinancial = rows.financialEntries.filter((row) => withinRange(row.eventDate, period.current));
  const previousFinancial = rows.financialEntries.filter((row) => withinRange(row.eventDate, period.previous));
  const currentPaidFinancial = currentFinancial.filter((row) => isFinancialPaidStatus(row.status));
  const previousPaidFinancial = previousFinancial.filter((row) => isFinancialPaidStatus(row.status));
  const currentThreads = rows.threads.filter((row) => withinRange(row.eventDate, period.current));
  const currentQuotes = rows.freightQuotes.filter((row) => withinRange(row.eventDate, period.current));
  const currentSyncs = rows.syncRuns.filter((row) => withinRange(row.startedAt, period.current));

  const orderRevenueCurrent = sum(currentOrders.map((row) => toNumber(row.totalAmount)));
  const orderRevenuePrevious = sum(previousOrders.map((row) => toNumber(row.totalAmount)));
  const approvedRevenueCurrent = sum(currentApprovedOrders.map((row) => toNumber(row.totalAmount)));
  const approvedRevenuePrevious = sum(previousApprovedOrders.map((row) => toNumber(row.totalAmount)));
  const feeAmountCurrent = sum(currentFinancial.map((row) => toNumber(row.feeAmount)));
  const feeAmountPrevious = sum(previousFinancial.map((row) => toNumber(row.feeAmount)));
  const netRevenueCurrent = sum(currentFinancial.map((row) => toNumber(row.netAmount)));
  const netRevenuePrevious = sum(previousFinancial.map((row) => toNumber(row.netAmount)));
  const paidRevenueCurrent = sum(currentPaidFinancial.map((row) => toNumber(row.netAmount)));
  const paidRevenuePrevious = sum(previousPaidFinancial.map((row) => toNumber(row.netAmount)));
  const paidCoverageRateCurrent = approvedRevenueCurrent
    ? (paidRevenueCurrent / approvedRevenueCurrent) * 100
    : 0;
  const paidCoverageRatePrevious = approvedRevenuePrevious
    ? (paidRevenuePrevious / approvedRevenuePrevious) * 100
    : 0;
  const avgTicketCurrent = currentOrders.length ? orderRevenueCurrent / currentOrders.length : 0;
  const marginRateCurrent = orderRevenueCurrent
    ? (netRevenueCurrent / orderRevenueCurrent) * 100
    : 0;
  const marginRatePrevious = orderRevenuePrevious
    ? (netRevenuePrevious / orderRevenuePrevious) * 100
    : 0;
  const deliveredCount = currentOrders.filter((row) => row.status === "delivered").length;
  const cancelledCount = currentOrders.filter((row) => row.status === "cancelled").length;
  const quoteWithinSla = currentQuotes.filter((row) => Number(row.responseTimeMs || 0) > 0 && Number(row.responseTimeMs || 0) <= 1500).length;
  const syncHealthy = currentSyncs.filter((row) => ["success", "partial"].includes(row.status)).length;
  const pendingThreads = currentThreads.filter((row) => ["open", "waiting_seller", "waiting_marketplace"].includes(row.status)).length;
  const unreadMessages = sum(currentThreads.map((row) => Number(row.unreadCount || 0)));

  const financialRevenueSeries = buildSeries(
    period.current,
    period.groupBy,
    currentFinancial,
    (row) => toNumber(row.netAmount),
    (row) => row.eventDate,
  );

  const orderRevenueSeries = buildSeries(
    period.current,
    period.groupBy,
    currentOrders,
    (row) => toNumber(row.totalAmount),
    (row) => row.approvedAt || row.importedAt || row.createdAt,
  );

  const financialSeriesTotal = sum(financialRevenueSeries.map((item) => toNumber(item.value)));
  const revenueSeries = financialSeriesTotal > 0 ? financialRevenueSeries : orderRevenueSeries;

  const orderSeries = buildSeries(
    period.current,
    period.groupBy,
    currentOrders,
    () => 1,
    (row) => row.approvedAt || row.importedAt || row.createdAt,
  );

  return {
    workspace,
    period: {
      label: period.label,
      groupBy: period.groupBy,
      source: period.source || "preset",
      comparisonSource: period.comparisonSource || "preset",
      current: {
        start: period.current.start.toISOString(),
        end: period.current.end.toISOString(),
      },
      previous: {
        start: period.previous.start.toISOString(),
        end: period.previous.end.toISOString(),
      },
    },
    kpis: {
      orders: currentOrders.length,
      ordersGrowth: growthPercent(currentOrders.length, previousOrders.length),
      grossRevenue: Number(orderRevenueCurrent.toFixed(2)),
      grossRevenueGrowth: growthPercent(orderRevenueCurrent, orderRevenuePrevious),
      approvedRevenue: Number(approvedRevenueCurrent.toFixed(2)),
      approvedRevenueGrowth: growthPercent(approvedRevenueCurrent, approvedRevenuePrevious),
      feeAmount: Number(feeAmountCurrent.toFixed(2)),
      feeAmountGrowth: growthPercent(feeAmountCurrent, feeAmountPrevious),
      netRevenue: Number(netRevenueCurrent.toFixed(2)),
      netRevenueGrowth: growthPercent(netRevenueCurrent, netRevenuePrevious),
      paidRevenue: Number(paidRevenueCurrent.toFixed(2)),
      paidRevenueGrowth: growthPercent(paidRevenueCurrent, paidRevenuePrevious),
      paidCoverageRate: Number(paidCoverageRateCurrent.toFixed(2)),
      paidCoverageRateGrowth: growthPercent(paidCoverageRateCurrent, paidCoverageRatePrevious),
      marginRate: Number(marginRateCurrent.toFixed(2)),
      marginRateGrowth: growthPercent(marginRateCurrent, marginRatePrevious),
      avgTicket: Number(avgTicketCurrent.toFixed(2)),
      avgTicketGrowth: growthPercent(avgTicketCurrent, previousOrders.length ? orderRevenuePrevious / previousOrders.length : 0),
    },
    quality: {
      deliveryRate: currentOrders.length ? Number(((deliveredCount / currentOrders.length) * 100).toFixed(2)) : 0,
      cancellationRate: currentOrders.length ? Number(((cancelledCount / currentOrders.length) * 100).toFixed(2)) : 0,
      freightSlaRate: currentQuotes.length ? Number(((quoteWithinSla / currentQuotes.length) * 100).toFixed(2)) : 0,
      syncHealthRate: currentSyncs.length ? Number(((syncHealthy / currentSyncs.length) * 100).toFixed(2)) : 0,
      pendingThreads,
      unreadMessages,
    },
    distributions: {
      orderStatus: buildStatusDistribution(currentOrders, "status"),
      financialStatus: buildStatusDistribution(currentFinancial, "status"),
      threadStatus: buildStatusDistribution(currentThreads, "status"),
    },
    series: {
      revenue: revenueSeries,
      orders: orderSeries,
    },
    products: {
      growth: buildProductGrowth(rows.orderItems, period.current, period.previous, productLookup),
    },
  };
}

async function getMonthlyProjection(params = {}) {
  const workspace =
    params.workspaceId && String(params.workspaceId).trim()
      ? await getWorkspaceById(String(params.workspaceId).trim())
      : await getOrCreateDefaultWorkspace();
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  const previousMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const previousMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);

  const [orders, financialEntries, previousFinancialEntries] = await Promise.all([
    queryRows(
      `
        select "totalAmount", coalesce("approvedAt", "importedAt", "createdAt") as "eventDate"
        from "MadOrder"
        where "workspaceId" = $1
          and coalesce("approvedAt", "importedAt", "createdAt") between $2 and $3
      `,
      [workspace.id, monthStart.toISOString(), monthEnd.toISOString()],
    ),
    queryRows(
      `
        select "netAmount", "feeAmount", "status"::text as "status", coalesce("paidAt", "releaseDate", "createdAt") as "eventDate"
        from "MadFinancialEntry"
        where "workspaceId" = $1
          and coalesce("paidAt", "releaseDate", "createdAt") between $2 and $3
      `,
      [workspace.id, monthStart.toISOString(), monthEnd.toISOString()],
    ),
    queryRows(
      `
        select "netAmount", "feeAmount", "status"::text as "status", coalesce("paidAt", "releaseDate", "createdAt") as "eventDate"
        from "MadFinancialEntry"
        where "workspaceId" = $1
          and coalesce("paidAt", "releaseDate", "createdAt") between $2 and $3
      `,
      [workspace.id, previousMonthStart.toISOString(), previousMonthEnd.toISOString()],
    ),
  ]);

  const elapsedDays = Math.max(1, now.getDate());
  const totalDays = monthEnd.getDate();
  const orderGross = sum(orders.map((row) => toNumber(row.totalAmount)));
  const feeAmount = sum(financialEntries.map((row) => toNumber(row.feeAmount)));
  const netRevenue = sum(financialEntries.map((row) => toNumber(row.netAmount)));
  const paidRevenueCurrent = sum(
    financialEntries
      .filter((row) => isFinancialPaidStatus(row.status))
      .map((row) => toNumber(row.netAmount)),
  );
  const paidRevenueLastMonth = sum(
    previousFinancialEntries
      .filter((row) => isFinancialPaidStatus(row.status))
      .map((row) => toNumber(row.netAmount)),
  );
  const previousNetRevenue = sum(previousFinancialEntries.map((row) => toNumber(row.netAmount)));
  const paidRevenueCurrentBase = paidRevenueCurrent > 0 ? paidRevenueCurrent : netRevenue;
  const paidRevenueLastMonthBase = paidRevenueLastMonth > 0 ? paidRevenueLastMonth : previousNetRevenue;
  const projectedPaidRevenue = (paidRevenueCurrentBase / elapsedDays) * totalDays;
  const paidRevenueTarget = paidRevenueLastMonthBase * 1.15;
  const targetAttainmentRate = paidRevenueTarget > 0
    ? (projectedPaidRevenue / paidRevenueTarget) * 100
    : (projectedPaidRevenue > 0 ? 100 : 0);
  const marginRate = orderGross ? (netRevenue / orderGross) * 100 : 0;

  return {
    workspace,
    month: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`,
    elapsedDays,
    totalDays,
    current: {
      orders: orders.length,
      grossRevenue: Number(orderGross.toFixed(2)),
      feeAmount: Number(feeAmount.toFixed(2)),
      netRevenue: Number(netRevenue.toFixed(2)),
      paidRevenue: Number(paidRevenueCurrentBase.toFixed(2)),
      marginRate: Number(marginRate.toFixed(2)),
    },
    projected: {
      orders: Math.round((orders.length / elapsedDays) * totalDays),
      grossRevenue: Number(((orderGross / elapsedDays) * totalDays).toFixed(2)),
      feeAmount: Number(((feeAmount / elapsedDays) * totalDays).toFixed(2)),
      netRevenue: Number(((netRevenue / elapsedDays) * totalDays).toFixed(2)),
      paidRevenue: Number(projectedPaidRevenue.toFixed(2)),
      marginRate: Number(marginRate.toFixed(2)),
    },
    target: {
      paidRevenueLastMonth: Number(paidRevenueLastMonthBase.toFixed(2)),
      paidRevenue: Number(paidRevenueTarget.toFixed(2)),
      attainmentRate: Number(targetAttainmentRate.toFixed(2)),
      formula: "(faturamento pago atual / dia atual do mes) * total de dias do mes",
    },
  };
}

module.exports = {
  getAnalyticsOverview,
  getMonthlyProjection,
  getPeriodRange,
  getSalesReport,
  buildSalesReportCsv,
  getAbcCurve,
};
