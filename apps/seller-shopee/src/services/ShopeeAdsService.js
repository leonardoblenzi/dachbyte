const axios = require("axios");
const shopeeAds = require("../config/shopeeAds");
const { hmacSha256Hex } = require("../utils/crypto"); // ajuste pro seu helper real

function buildSignBase({ path, partnerId, timestamp, accessToken, shopId }) {
  // padrão v2: partner_id + path + timestamp + access_token + shop_id
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

async function shopeeAdsGet({ path, accessToken, shopId, query }) {
  const partnerId = Number(shopeeAds.PARTNER_ID);
  const timestamp = Math.floor(Date.now() / 1000);

  const sign = signV2({
    path,
    partnerId,
    timestamp,
    accessToken,
    shopId,
    partnerKey: shopeeAds.PARTNER_KEY,
  });

  const url = `${shopeeAds.SHOPEE_ADS_API_BASE}${path}`;

  const params = {
    partner_id: partnerId,
    timestamp,
    access_token: accessToken,
    shop_id: Number(shopId),
    sign,
    ...(query || {}),
  };

  try {
    const resp = await axios.get(url, { params, timeout: 60_000 });
    return resp.data;
  } catch (err) {
    console.error("[ShopeeAds] GET failed", {
      url,
      path,
      shop_id: params.shop_id,
      partner_id: params.partner_id,
      timestamp: params.timestamp,
      status: err?.response?.status,
      data: err?.response?.data,
    });
    throw err;
  }
}

async function get_total_balance({ accessToken, shopId }) {
  return shopeeAdsGet({
    path: "/api/v2/ads/get_total_balance",
    accessToken,
    shopId,
  });
}

async function get_shop_toggle_info({ accessToken, shopId }) {
  return shopeeAdsGet({
    path: "/api/v2/ads/get_shop_toggle_info",
    accessToken,
    shopId,
  });
}

async function get_all_cpc_ads_daily_performance({
  accessToken,
  shopId,
  startDate,
  endDate,
}) {
  return shopeeAdsGet({
    path: "/api/v2/ads/get_all_cpc_ads_daily_performance",
    accessToken,
    shopId,
    query: {
      start_date: startDate, // formato "DD-MM-YYYY"
      end_date: endDate,
    },
  });
}

async function get_product_level_campaign_id_list({
  accessToken,
  shopId,
  adType = "",
  offset = 0,
  limit = 5000,
}) {
  adType = adType === "all" ? "" : adType;

  return shopeeAdsGet({
    path: "/api/v2/ads/get_product_level_campaign_id_list",
    accessToken,
    shopId,
    query: {
      ad_type: adType, // "", "auto", "manual"
      offset,
      limit,
    },
  });
}

async function get_product_campaign_daily_performance({
  accessToken,
  shopId,
  startDate,
  endDate,
  campaignIdList,
}) {
  return shopeeAdsGet({
    path: "/api/v2/ads/get_product_campaign_daily_performance",
    accessToken,
    shopId,
    query: {
      start_date: startDate, // "DD-MM-YYYY"
      end_date: endDate, // "DD-MM-YYYY"
      campaign_id_list: campaignIdList.join(","), // max 100
    },
  });
}

async function get_product_campaign_hourly_performance({
  accessToken,
  shopId,
  performanceDate,
  campaignIdList,
}) {
  return shopeeAdsGet({
    path: "/api/v2/ads/get_product_campaign_hourly_performance",
    accessToken,
    shopId,
    query: {
      performance_date: performanceDate, // "DD-MM-YYYY"
      campaign_id_list: campaignIdList.join(","), // max 100
    },
  });
}

async function get_product_level_campaign_setting_info({
  accessToken,
  shopId,
  infoTypeList,
  campaignIdList,
}) {
  return shopeeAdsGet({
    path: "/api/v2/ads/get_product_level_campaign_setting_info",
    accessToken,
    shopId,
    query: {
      info_type_list: infoTypeList.join(","), // ex: [1,2,3,4]
      campaign_id_list: campaignIdList.join(","), // max 100
    },
  });
}

async function shopeeAdsPost({ path, accessToken, shopId, query, body }) {
  const partnerId = Number(shopeeAds.PARTNER_ID);
  const timestamp = Math.floor(Date.now() / 1000);

  const sign = signV2({
    path,
    partnerId,
    timestamp,
    accessToken,
    shopId,
    partnerKey: shopeeAds.PARTNER_KEY,
  });

  const url = `${shopeeAds.SHOPEE_ADS_API_BASE}${path}`;

  const params = {
    partner_id: partnerId,
    timestamp,
    access_token: accessToken,
    shop_id: Number(shopId),
    sign,
    ...(query || {}),
  };

  try {
    const resp = await axios.post(url, body || {}, { params, timeout: 60_000 });
    return resp.data;
  } catch (err) {
    console.error("[ShopeeAds] POST failed", {
      url,
      path,
      shop_id: params.shop_id,
      partner_id: params.partner_id,
      timestamp: params.timestamp,
      status: err?.response?.status,
      data: err?.response?.data,
    });
    throw err;
  }
}

async function get_cpc_item_performance({ accessToken, shopId, payload }) {
  const path =
    shopeeAds.CPC_ITEM_PERFORMANCE_PATH ||
    process.env.SHOPEE_ADS_CPC_ITEM_PERFORMANCE_PATH;

  if (!path) {
    const err = new Error(
      "CPC item performance path não configurado (CPC_ITEM_PERFORMANCE_PATH / SHOPEE_ADS_CPC_ITEM_PERFORMANCE_PATH).",
    );
    err.statusCode = 500;
    throw err;
  }

  return shopeeAdsPost({
    path,
    accessToken,
    shopId,
    body: payload,
  });
}

async function get_gms_item_performance({ accessToken, shopId, payload }) {
  return shopeeAdsPost({
    path: "/api/v2/ads/get_gms_item_performance",
    accessToken,
    shopId,
    body: payload,
  });
}

async function get_gms_campaign_performance({ accessToken, shopId, payload }) {
  return shopeeAdsPost({
    path: "/api/v2/ads/get_gms_campaign_performance",
    accessToken,
    shopId,
    body: payload,
  });
}

async function edit_manual_product_ads({ accessToken, shopId, payload }) {
  return shopeeAdsPost({
    path: "/api/v2/ads/edit_manual_product_ads",
    accessToken,
    shopId,
    body: payload,
  });
}

async function edit_gms_item_product_campaign({ accessToken, shopId, payload }) {
  return shopeeAdsPost({
    path: "/api/v2/ads/edit_gms_item_product_campaign",
    accessToken,
    shopId,
    body: payload,
  });
}

async function get_recommended_keyword_list({
  accessToken,
  shopId,
  itemId,
  inputKeyword,
}) {
  return shopeeAdsGet({
    path: "/api/v2/ads/get_recommended_keyword_list",
    accessToken,
    shopId,
    query: {
      item_id: String(itemId), // evita problemas de Number
      ...(inputKeyword ? { input_keyword: String(inputKeyword) } : {}),
    },
  });
}
async function get_all_cpc_ads_hourly_performance({
  accessToken,
  shopId,
  performanceDate, // "DD-MM-YYYY"
}) {
  return shopeeAdsGet({
    path: "/api/v2/ads/get_all_cpc_ads_hourly_performance",
    accessToken,
    shopId,
    query: {
      performance_date: performanceDate,
    },
  });
}
module.exports = {
  get_total_balance,
  get_shop_toggle_info,
  get_all_cpc_ads_daily_performance,
  get_all_cpc_ads_hourly_performance,
  get_product_level_campaign_id_list,
  get_product_campaign_daily_performance,
  get_product_campaign_hourly_performance,
  get_product_level_campaign_setting_info,
  get_cpc_item_performance,
  get_gms_item_performance,
  get_gms_campaign_performance,
  edit_manual_product_ads,
  edit_gms_item_product_campaign,
  get_recommended_keyword_list,
};
