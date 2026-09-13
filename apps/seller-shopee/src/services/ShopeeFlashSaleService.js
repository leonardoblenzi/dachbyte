const { requestShopeeAuthed } = require("./ShopeeAuthedHttp");

async function getTimeSlots({ shopId, startTime, endTime }) {
  return requestShopeeAuthed({
    method: "get",
    path: "/api/v2/shop_flash_sale/get_time_slot_id",
    shopId: String(shopId),
    query: {
      start_time: Number(startTime),
      end_time: Number(endTime),
    },
  });
}

async function createFlashSale({ shopId, timeslotId }) {
  return requestShopeeAuthed({
    method: "post",
    path: "/api/v2/shop_flash_sale/create_shop_flash_sale",
    shopId: String(shopId),
    body: {
      timeslot_id: Number(timeslotId),
    },
  });
}

async function getItemCriteria({ shopId }) {
  return requestShopeeAuthed({
    method: "get",
    path: "/api/v2/shop_flash_sale/get_item_criteria",
    shopId: String(shopId),
  });
}

async function addFlashSaleItems({ shopId, flashSaleId, items }) {
  return requestShopeeAuthed({
    method: "post",
    path: "/api/v2/shop_flash_sale/add_shop_flash_sale_items",
    shopId: String(shopId),
    body: {
      flash_sale_id: Number(flashSaleId),
      items,
    },
  });
}

async function getFlashSaleList({
  shopId,
  type = 0,
  offset = 0,
  limit = 20,
  startTime,
  endTime,
}) {
  return requestShopeeAuthed({
    method: "get",
    path: "/api/v2/shop_flash_sale/get_shop_flash_sale_list",
    shopId: String(shopId),
    query: {
      type: Number(type),
      offset: Number(offset),
      limit: Number(limit),
      ...(startTime ? { start_time: Number(startTime) } : {}),
      ...(endTime ? { end_time: Number(endTime) } : {}),
    },
  });
}

async function getFlashSale({ shopId, flashSaleId }) {
  return requestShopeeAuthed({
    method: "get",
    path: "/api/v2/shop_flash_sale/get_shop_flash_sale",
    shopId: String(shopId),
    query: {
      flash_sale_id: Number(flashSaleId),
    },
  });
}

async function getFlashSaleItems({
  shopId,
  flashSaleId,
  offset = 0,
  limit = 100,
}) {
  return requestShopeeAuthed({
    method: "get",
    path: "/api/v2/shop_flash_sale/get_shop_flash_sale_items",
    shopId: String(shopId),
    query: {
      flash_sale_id: Number(flashSaleId),
      offset: Number(offset),
      limit: Number(limit),
    },
  });
}

async function updateFlashSale({ shopId, flashSaleId, status }) {
  return requestShopeeAuthed({
    method: "post",
    path: "/api/v2/shop_flash_sale/update_shop_flash_sale",
    shopId: String(shopId),
    body: {
      flash_sale_id: Number(flashSaleId),
      status: Number(status),
    },
  });
}

async function updateFlashSaleItems({ shopId, flashSaleId, items }) {
  return requestShopeeAuthed({
    method: "post",
    path: "/api/v2/shop_flash_sale/update_shop_flash_sale_items",
    shopId: String(shopId),
    body: {
      flash_sale_id: Number(flashSaleId),
      items,
    },
  });
}

async function deleteFlashSale({ shopId, flashSaleId }) {
  return requestShopeeAuthed({
    method: "post",
    path: "/api/v2/shop_flash_sale/delete_shop_flash_sale",
    shopId: String(shopId),
    body: {
      flash_sale_id: Number(flashSaleId),
    },
  });
}

async function deleteFlashSaleItems({ shopId, flashSaleId, itemIds }) {
  return requestShopeeAuthed({
    method: "post",
    path: "/api/v2/shop_flash_sale/delete_shop_flash_sale_items",
    shopId: String(shopId),
    body: {
      flash_sale_id: Number(flashSaleId),
      item_ids: itemIds.map((id) => Number(id)),
    },
  });
}

module.exports = {
  getTimeSlots,
  createFlashSale,
  getItemCriteria,
  addFlashSaleItems,
  getFlashSaleList,
  getFlashSale,
  getFlashSaleItems,
  updateFlashSale,
  updateFlashSaleItems,
  deleteFlashSale,
  deleteFlashSaleItems,
};
