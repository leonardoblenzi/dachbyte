// @ts-check
"use strict";

const { channelSettingsFromEnv } = require("../connectors/channels");

/** @param {string | undefined} value */
function list(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

/**
 * Configuração do DACH Hub lida do ambiente.
 * Quem entra: equipe da plataforma, empresas em HUB_ALLOWED_TENANTS (reserva)
 * ou quem o hub de acessos liberar no módulo dach_hub.
 */
function loadConfig(env = process.env) {
  return {
    databaseUrl: String(env.HUB_DATABASE_URL || env.DATABASE_URL || "").trim(),
    schema: "hub",
    suiteJwtSecret: String(env.SUITE_JWT_SECRET || "").trim(),
    // Sessão própria do Hub (/hub/login). Sem HUB_SESSION_SECRET, usa o segredo da suíte com audiência própria.
    sessionSecret: String(env.HUB_SESSION_SECRET || env.SUITE_JWT_SECRET || "").trim(),
    secureCookies: String(env.NODE_ENV || "").toLowerCase() === "production",
    // Hub de acessos: confere a senha e libera o módulo do DACH Hub (mesmas variáveis dos módulos DACH).
    accessHub: {
      baseUrl: String(env.HUB_BASE_URL || "").trim().replace(/\/+$/, ""),
      token: String(env.HUB_INTERNAL_TOKEN || "").trim(),
      module: String(env.HUB_ACCESS_MODULE || "dach_hub").trim() || "dach_hub",
    },
    // Reserva enquanto o produto dach_hub não está no hub de acessos: empresas daqui entram sem consultar.
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
