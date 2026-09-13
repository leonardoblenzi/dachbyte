const { requestShopeeAuthed } = require("./ShopeeAuthedHttp");

async function getConversionReport({
  shopId,
  pageNo,
  pageSize,
  orderStatus,
  orderCompletedTimeStart,
  orderCompletedTimeEnd,
}) {
  return requestShopeeAuthed({
    method: "get",
    path: "/api/v2/ams/get_conversion_report",
    shopId: String(shopId),
    query: {
      page_no: pageNo,
      page_size: pageSize,
      ...(orderStatus ? { order_status: orderStatus } : {}),
      ...(orderCompletedTimeStart
        ? { order_completed_time_start: Number(orderCompletedTimeStart) }
        : {}),
      ...(orderCompletedTimeEnd
        ? { order_completed_time_end: Number(orderCompletedTimeEnd) }
        : {}),
    },
  });
}

async function getProductPerformance({
  shopId,
  periodType,
  startDate,
  endDate,
  pageNo,
  pageSize,
  orderType,
  channel,
  itemId,
}) {
  const path =
    process.env.SHOPEE_AMS_PRODUCT_PERFORMANCE_PATH ||
    "/api/v2/ams/get_product_performance";

  return requestShopeeAuthed({
    method: "get",
    path,
    shopId: String(shopId),
    query: {
      period_type: String(periodType || ""),
      start_date: String(startDate || ""),
      end_date: String(endDate || ""),
      page_no: Math.max(1, Number(pageNo || 1)),
      page_size: Math.max(1, Math.min(100, Number(pageSize || 50))),
      ...(orderType ? { order_type: String(orderType) } : {}),
      ...(channel ? { channel: String(channel) } : {}),
      ...(itemId ? { item_id: String(itemId) } : {}),
    },
  });
}

module.exports = {
  getConversionReport,
  getProductPerformance,
};
