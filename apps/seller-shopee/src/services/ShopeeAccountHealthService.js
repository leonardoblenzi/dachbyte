const { requestShopeeAuthed } = require("./ShopeeAuthedHttp");

async function getShopPerformance({ shopId }) {
  return requestShopeeAuthed({
    method: "get",
    path: "/api/v2/account_health/get_shop_performance",
    shopId: String(shopId),
  });
}

async function getMetricSourceDetail({
  shopId,
  metricId,
  pageNo = 1,
  pageSize = 10,
}) {
  return requestShopeeAuthed({
    method: "get",
    path: "/api/v2/account_health/get_metric_source_detail",
    shopId: String(shopId),
    query: {
      metric_id: Number(metricId),
      page_no: Number(pageNo),
      page_size: Number(pageSize),
    },
  });
}

async function getLateOrders({ shopId, pageNo = 1, pageSize = 10 }) {
  return requestShopeeAuthed({
    method: "get",
    path: "/api/v2/account_health/get_late_orders",
    shopId: String(shopId),
    query: {
      page_no: Number(pageNo),
      page_size: Number(pageSize),
    },
  });
}

module.exports = {
  getShopPerformance,
  getMetricSourceDetail,
  getLateOrders,
};
