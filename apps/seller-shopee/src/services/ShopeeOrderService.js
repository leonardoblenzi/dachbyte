const { requestShopeeAuthed } = require("./ShopeeAuthedHttp");

async function getOrderList({
  shopId,
  timeFrom,
  timeTo,
  pageNo,
  pageSize,
  timeRangeField = "create_time",
}) {
  return requestShopeeAuthed({
    method: "get",
    path: "/api/v2/order/get_order_list",
    shopId: String(shopId),
    query: {
      time_range_field: String(timeRangeField),
      time_from: Number(timeFrom),
      time_to: Number(timeTo),
      page_no: Number(pageNo),
      page_size: Number(pageSize),
    },
  });
}

async function getOrderDetail({
  shopId,
  orderSnList,
  responseOptionalFields = "total_amount,pay_time",
}) {
  if (!Array.isArray(orderSnList) || !orderSnList.length) {
    const err = new Error("orderSnList deve ser um array não vazio.");
    err.statusCode = 400;
    throw err;
  }
  if (orderSnList.length > 50) {
    const err = new Error("orderSnList: máximo 50 order_sn por chamada.");
    err.statusCode = 400;
    throw err;
  }

  return requestShopeeAuthed({
    method: "get",
    path: "/api/v2/order/get_order_detail",
    shopId: String(shopId),
    query: {
      order_sn_list: orderSnList.map(String).join(","),
      response_optional_fields: String(responseOptionalFields),
    },
  });
}

module.exports = {
  getOrderList,
  getOrderDetail,
};
