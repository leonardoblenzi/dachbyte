// @ts-check
"use strict";

const { channelSettingsFromEnv } = require("../connectors/channels");

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
    // Piloto: só estas empresas podem ativar a escrita de estoque nos canais. Vazio = ninguém escreve.
    writeTenants: new Set(list(env.HUB_WRITE_TENANTS)),
    platformAdminEmails: new Set(list(env.HUB_PLATFORM_ADMIN_EMAILS).map((email) => email.toLowerCase())),
    // Fila em segundo plano (BullMQ). Vazio = importação roda no próprio processo (desenvolvimento).
    redisUrl: String(env.HUB_REDIS_URL || env.REDIS_URL || "").trim(),
    tokenEncryptionKey: String(env.HUB_TOKEN_ENCRYPTION_KEY || "").trim(),
    publicBaseUrl: String(env.HUB_PUBLIC_BASE_URL || "https://dachbyte.tech/hub").replace(/\/+$/, ""),
    // Apps/credenciais próprios do DACH Hub em cada canal (independentes dos módulos DACH).
    // Cada canal declara as suas variáveis em src/connectors/channels.js.
    channels: channelSettingsFromEnv(env),
  };
}

module.exports = { loadConfig, _test: { list } };
