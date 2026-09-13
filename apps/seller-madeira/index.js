"use strict";

const path = require("path");

function resolvePackage(packageName) {
  return require.resolve(packageName, {
    paths: [process.cwd(), path.join(process.cwd(), "apps", "seller-shopee"), __dirname],
  });
}

function normalizeWindowsDatabaseUrl() {
  if (!process.env.MAD_DATABASE_URL) {
    return;
  }

  try {
    const connectionUrl = new URL(process.env.MAD_DATABASE_URL);
    if (
      process.platform === "win32" &&
      connectionUrl.searchParams.get("channel_binding") === "require"
    ) {
      connectionUrl.searchParams.set("channel_binding", "disable");
    }

    if (
      connectionUrl.searchParams.get("sslmode") === "require" &&
      !connectionUrl.searchParams.has("uselibpqcompat")
    ) {
      connectionUrl.searchParams.set("uselibpqcompat", "true");
    }

    process.env.MAD_DATABASE_URL = connectionUrl.toString();
  } catch (_error) {}
}

try {
  // Carrega o .env local antes de montar a app para expor as variaveis ao modulo.
  const dotenvPath = resolvePackage("dotenv");
  // eslint-disable-next-line import/no-dynamic-require, global-require
  require(dotenvPath).config({ path: path.join(__dirname, ".env"), quiet: true });
} catch (_error) {}

normalizeWindowsDatabaseUrl();

const createApp = require("./src/app");

async function createMadeiraMadeiraApp() {
  return createApp();
}

module.exports = createMadeiraMadeiraApp;
