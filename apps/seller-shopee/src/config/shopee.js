const env = require("./env");

module.exports = {
  SHOPEE_API_BASE: env.SHOPEE_API_BASE,
  PARTNER_ID: env.SHOPEE_PARTNER_ID, // number agora
  PARTNER_KEY: env.SHOPEE_PARTNER_KEY,
  REDIRECT_URL: env.SHOPEE_REDIRECT_URL,
  DISCOUNT_API_BASE:
    env.SHOPEE_DISCOUNT_API_BASE || "https://openplatform.shopee.com.br",
};
