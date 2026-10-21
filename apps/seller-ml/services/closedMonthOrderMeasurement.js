"use strict";

function previousClosedMonthWindow(now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("ml_orders_measurement_time_invalid");
  }
  const periodEndExclusive = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  // ML orders/search currently ignores minutes/seconds/milliseconds in date
  // filters. The last whole hour avoids including orders from the next month.
  const searchEndInclusive = new Date(periodEndExclusive.getTime() - 60 * 60 * 1000);
  return {
    periodStart: periodStart.toISOString(),
    periodEndExclusive: periodEndExclusive.toISOString(),
    searchEndInclusive: searchEndInclusive.toISOString(),
  };
}

async function fetchPaidOrdersTotal(input) {
  const token = String(input.accessToken || "").trim();
  const sellerId = Number(input.sellerId);
  const window = input.window;
  const fetchImpl = input.fetchImpl || globalThis.fetch;
  if (!token || !Number.isSafeInteger(sellerId) || sellerId <= 0 ||
      !window?.periodStart || !window?.searchEndInclusive || typeof fetchImpl !== "function") {
    throw new Error("ml_orders_measurement_invalid");
  }
  const url = new URL("https://api.mercadolibre.com/orders/search");
  url.searchParams.set("seller", String(sellerId));
  url.searchParams.set("order.status", "paid");
  url.searchParams.set("order.date_created.from", window.periodStart);
  url.searchParams.set("order.date_created.to", window.searchEndInclusive);
  url.searchParams.set("limit", "1");
  url.searchParams.set("offset", "0");
  let response;
  try {
    response = await fetchImpl(url.toString(), {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
  } catch (_) {
    throw new Error("ml_orders_search_unavailable");
  }
  if (!response.ok) throw new Error(`ml_orders_search_${response.status}`);
  const body = await response.json().catch(() => null);
  const total = body?.paging?.total;
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error("ml_orders_total_unavailable");
  }
  return total;
}

function rangeForPaidOrders(value) {
  const total = Number(value);
  if (!Number.isSafeInteger(total) || total < 0) throw new Error("ml_orders_total_invalid");
  if (total <= 30) return "up_to_30";
  if (total <= 200) return "from_31_to_200";
  if (total <= 700) return "from_201_to_700";
  if (total <= 1500) return "from_701_to_1500";
  if (total <= 3000) return "from_1501_to_3000";
  return "contact_sales";
}

module.exports = { previousClosedMonthWindow, fetchPaidOrdersTotal, rangeForPaidOrders };
