const axios = require("axios");
const shopee = require("../config/shopee");
const { hmacSha256Hex } = require("../utils/crypto");

const API_BASE = "https://openplatform.shopee.com.br";
const DISCOUNT_ENDPOINT = "/api/v2/discount";

/**
 * ShopeeDiscountService
 * Integração com Shopee Discount API v2
 */

function buildSignBase({ path, partnerId, timestamp, accessToken, shopId }) {
  return `${partnerId}${path}${timestamp}${accessToken}${shopId}`;
}

function signV2({
  path,
  partnerId,
  timestamp,
  accessToken,
  shopId,
  partnerKey,
}) {
  const base = buildSignBase({
    path,
    partnerId,
    timestamp,
    accessToken,
    shopId,
  });
  return hmacSha256Hex(String(partnerKey), base);
}

async function callDiscountAPI({
  method = "GET",
  path,
  accessToken,
  shopId,
  data = null,
  query = {},
}) {
  const partnerId = Number(shopee.PARTNER_ID);
  const timestamp = Math.floor(Date.now() / 1000);

  const sign = signV2({
    path,
    partnerId,
    timestamp,
    accessToken,
    shopId,
    partnerKey: shopee.PARTNER_KEY,
  });

  const url = `${API_BASE}${path}`;

  const headers = {
    "Content-Type": "application/json",
  };

  const params = {
    partner_id: partnerId,
    timestamp,
    access_token: accessToken,
    shop_id: Number(shopId),
    sign,
    ...query,
  };

  try {
    const response = await axios({
      method,
      url,
      params,
      data,
      headers,
      timeout: 30000,
    });

    return { success: true, data: response.data };
  } catch (error) {
    const errorData = error.response?.data || { error: error.message };
    return { success: false, error: errorData };
  }
}

/**
 * Adicionar desconto na Shopee
 * POST /api/v2/discount/add_discount
 */
async function addDiscount({ accessToken, shopId, campaign }) {
  const path = `${DISCOUNT_ENDPOINT}/add_discount`;

  const payload = {
    discount_name: campaign.name,
    start_time: Math.floor(new Date(campaign.startTime).getTime() / 1000),
    end_time: Math.floor(new Date(campaign.endTime).getTime() / 1000),
  };

  if (campaign.description) {
    payload.discount_desc = campaign.description;
  }

  return await callDiscountAPI({
    method: "POST",
    path,
    accessToken,
    shopId,
    data: payload,
  });
}

/**
 * Adicionar itens ao desconto (produtos)
 * POST /api/v2/discount/add_discount_item
 */
async function addDiscountItems({ accessToken, shopId, discountId, items }) {
  const path = `${DISCOUNT_ENDPOINT}/add_discount_item`;

  const payload = {
    discount_id: Number(discountId),
    item_list: items.map((item) => ({
      item_id: Number(item.itemId),
      model_id: Number(item.modelId) || 0,
      item_promotion_price: item.promotionPrice || 0, // em centavos
      ...(item.purchaseLimit > 0 && { purchase_limit: item.purchaseLimit }),
    })),
  };

  return await callDiscountAPI({
    method: "POST",
    path,
    accessToken,
    shopId,
    data: payload,
  });
}

/**
 * Atualizar desconto
 * POST /api/v2/discount/update_discount
 */
async function updateDiscount({ accessToken, shopId, discountId, updates }) {
  const path = `${DISCOUNT_ENDPOINT}/update_discount`;

  const payload = {
    discount_id: Number(discountId),
  };

  if (updates.name) payload.discount_name = updates.name;
  if (updates.description) payload.discount_desc = updates.description;
  if (updates.startTime) {
    payload.start_time = Math.floor(
      new Date(updates.startTime).getTime() / 1000,
    );
  }
  if (updates.endTime) {
    payload.end_time = Math.floor(new Date(updates.endTime).getTime() / 1000);
  }

  return await callDiscountAPI({
    method: "POST",
    path,
    accessToken,
    shopId,
    data: payload,
  });
}

/**
 * Encerrar desconto
 * POST /api/v2/discount/end_discount
 */
async function endDiscount({ accessToken, shopId, discountId }) {
  const path = `${DISCOUNT_ENDPOINT}/end_discount`;

  return await callDiscountAPI({
    method: "POST",
    path,
    accessToken,
    shopId,
    data: {
      discount_id: Number(discountId),
    },
  });
}

/**
 * Deletar desconto (rascunho only)
 * POST /api/v2/discount/delete_discount
 */
async function deleteDiscount({ accessToken, shopId, discountId }) {
  const path = `${DISCOUNT_ENDPOINT}/delete_discount`;

  return await callDiscountAPI({
    method: "POST",
    path,
    accessToken,
    shopId,
    data: {
      discount_id: Number(discountId),
    },
  });
}

/**
 * Obter informações de desconto
 * GET /api/v2/discount/get_discount
 */
async function getDiscount({
  accessToken,
  shopId,
  discountId,
  pageNo = 1,
  pageSize = 100,
}) {
  const path = `${DISCOUNT_ENDPOINT}/get_discount`;

  const query = {
    discount_id: Number(discountId),
    page_no: pageNo,
    page_size: pageSize,
  };

  return await callDiscountAPI({
    method: "GET",
    path,
    accessToken,
    shopId,
    query,
  });
}

/**
 * Listar descontos da loja
 * GET /api/v2/discount/get_discount_list
 */
async function listDiscounts({
  accessToken,
  shopId,
  pageNo = 1,
  pageSize = 100,
  status = "all",
}) {
  const path = `${DISCOUNT_ENDPOINT}/get_discount_list`;

  const query = {
    page_no: pageNo,
    page_size: pageSize,
    discount_status: status, // "upcoming" | "ongoing" | "expired" | "all"
  };

  return await callDiscountAPI({
    method: "GET",
    path,
    accessToken,
    shopId,
    query,
  });
}

/**
 * Atualizar item do desconto
 * POST /api/v2/discount/update_discount_item
 */
async function updateDiscountItem({
  accessToken,
  shopId,
  discountId,
  itemId,
  modelId = 0,
  updates,
}) {
  const path = `${DISCOUNT_ENDPOINT}/update_discount_item`;

  const payload = {
    discount_id: Number(discountId),
    item_id: Number(itemId),
    model_id: Number(modelId) || 0,
  };

  if (updates.promotionPrice !== undefined) {
    payload.item_promotion_price = updates.promotionPrice;
  }
  if (updates.purchaseLimit !== undefined) {
    payload.purchase_limit = updates.purchaseLimit;
  }

  return await callDiscountAPI({
    method: "POST",
    path,
    accessToken,
    shopId,
    data: payload,
  });
}

/**
 * Remover item do desconto
 * POST /api/v2/discount/delete_discount_item
 */
async function removeDiscountItem({
  accessToken,
  shopId,
  discountId,
  itemId,
  modelId = 0,
}) {
  const path = `${DISCOUNT_ENDPOINT}/delete_discount_item`;

  const payload = {
    discount_id: Number(discountId),
    item_id: Number(itemId),
    model_id: Number(modelId) || 0,
  };

  return await callDiscountAPI({
    method: "POST",
    path,
    accessToken,
    shopId,
    data: payload,
  });
}

module.exports = {
  addDiscount,
  addDiscountItems,
  updateDiscount,
  updateDiscountItem,
  endDiscount,
  deleteDiscount,
  getDiscount,
  listDiscounts,
  removeDiscountItem,
};
