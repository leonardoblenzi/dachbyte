"use strict";

const WINDOW_SECONDS = 14 * 24 * 60 * 60;
const EXCLUDED_STATUSES = new Set(["CANCELLED", "UNPAID", "IN_CANCEL", "TO_RETURN"]);

function previousClosedMonthWindow(now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("shopee_orders_measurement_time_invalid");
  }
  return {
    periodStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString(),
    periodEndExclusive: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
  };
}

async function countPaidOrders({ shopId, window, getList, getDetail }) {
  if (!getList || !getDetail) {
    const api = require("./ShopeeOrderService");
    getList ||= api.getOrderList;
    getDetail ||= api.getOrderDetail;
  }
  const id = String(shopId || "").trim();
  const start = Date.parse(window?.periodStart);
  const end = Date.parse(window?.periodEndExclusive);
  if (!id || !Number.isFinite(start) || !Number.isFinite(end) || end <= start ||
      start % 1000 !== 0 || end % 1000 !== 0) {
    throw new Error("shopee_orders_measurement_invalid");
  }
  const paidOrderSns = new Set();
  for (let from = start / 1000; from < end / 1000;) {
    const to = Math.min(from + WINDOW_SECONDS - 1, end / 1000 - 1);
    let cursor = "";
    const seenCursors = new Set();
    let pages = 0;
    while (true) {
      if (++pages > 10000) throw new Error("shopee_orders_pagination_incomplete");
      const payload = await getList({ shopId: id, timeFrom: from, timeTo: to,
        cursor, pageSize: 100, timeRangeField: "create_time" });
      if (payload?.error || !Array.isArray(payload?.response?.order_list) ||
          typeof payload?.response?.more !== "boolean") {
        throw new Error("shopee_orders_list_incomplete");
      }
      const sns = payload.response.order_list.map((order) => String(order?.order_sn || "").trim());
      if (sns.some((sn) => !sn)) throw new Error("shopee_orders_list_incomplete");
      for (let offset = 0; offset < sns.length; offset += 50) {
        const batch = sns.slice(offset, offset + 50);
        const details = await getDetail({ shopId: id, orderSnList: batch,
          responseOptionalFields: "pay_time" });
        if (details?.error || !Array.isArray(details?.response?.order_list)) {
          throw new Error("shopee_orders_details_incomplete");
        }
        const bySn = new Map(details.response.order_list.map((order) =>
          [String(order?.order_sn || "").trim(), order]));
        if (batch.some((sn) => !bySn.has(sn))) throw new Error("shopee_orders_details_incomplete");
        for (const sn of batch) {
          const order = bySn.get(sn);
          const status = String(order.order_status || "").toUpperCase();
          const payTime = Number(order.pay_time);
          if (!status || !Number.isFinite(payTime)) throw new Error("shopee_orders_details_incomplete");
          if (payTime > 0 && !EXCLUDED_STATUSES.has(status)) paidOrderSns.add(sn);
        }
      }
      if (!payload.response.more) break;
      const nextCursor = String(payload.response.next_cursor || "");
      if (sns.length === 0 || !nextCursor || nextCursor === cursor || seenCursors.has(nextCursor)) {
        throw new Error("shopee_orders_pagination_incomplete");
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    from = to + 1;
  }
  return paidOrderSns.size;
}

module.exports = { previousClosedMonthWindow, countPaidOrders };
