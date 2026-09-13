const env = require("./env");

module.exports = {
  SHOPEE_ADS_API_BASE:
    env.SHOPEE_ADS_API_BASE || "https://openplatform.shopee.com.br",
  PARTNER_ID: env.SHOPEE_ADS_PARTNER_ID || env.SHOPEE_PARTNER_ID,
  PARTNER_KEY: env.SHOPEE_ADS_PARTNER_KEY || env.SHOPEE_PARTNER_KEY,
  REDIRECT_URL: env.SHOPEE_REDIRECT_URL,

  // Path do endpoint Shopee Ads que retorna performance por item (CPC).
  // Exemplo esperado: "/api/v2/ads/SEU_ENDPOINT_AQUI"
  CPC_ITEM_PERFORMANCE_PATH: env.SHOPEE_ADS_CPC_ITEM_PERFORMANCE_PATH || "",
};
