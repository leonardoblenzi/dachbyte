// @ts-check
"use strict";

/** @param {string | undefined} value */
function list(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

/**
 * Configuração do DACH Hub lida do ambiente.
 * Enquanto o produto estiver oculto, só empresas em HUB_ALLOWED_TENANTS (ou
 * administradores da plataforma) entram.
 */
function loadConfig(env = process.env) {
  return {
    databaseUrl: String(env.HUB_DATABASE_URL || env.DATABASE_URL || "").trim(),
    schema: "hub",
    suiteJwtSecret: String(env.SUITE_JWT_SECRET || "").trim(),
    allowedTenants: new Set(list(env.HUB_ALLOWED_TENANTS)),
    platformAdminEmails: new Set(list(env.HUB_PLATFORM_ADMIN_EMAILS).map((email) => email.toLowerCase())),
    tokenEncryptionKey: String(env.HUB_TOKEN_ENCRYPTION_KEY || "").trim(),
    publicBaseUrl: String(env.HUB_PUBLIC_BASE_URL || "https://dachbyte.tech/hub").replace(/\/+$/, ""),
    // Apps próprios do DACH Hub em cada marketplace (independentes dos módulos DACH).
    channels: {
      mercadolivre: { clientId: String(env.HUB_ML_APP_ID || "").trim(), clientSecret: String(env.HUB_ML_CLIENT_SECRET || "").trim() },
      magalu: { clientId: String(env.HUB_MAGALU_CLIENT_ID || "").trim(), clientSecret: String(env.HUB_MAGALU_CLIENT_SECRET || "").trim(), scopes: list(env.HUB_MAGALU_SCOPES) },
      shopee: { partnerId: String(env.HUB_SHOPEE_PARTNER_ID || "").trim(), partnerKey: String(env.HUB_SHOPEE_PARTNER_KEY || "").trim(), apiBase: String(env.HUB_SHOPEE_API_BASE || "https://partner.shopeemobile.com").trim() },
    },
  };
}

module.exports = { loadConfig, _test: { list } };
