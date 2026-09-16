"use strict";

const express = require("express");
const fs = require("fs");
const { createRequire } = require("module");
const path = require("path");

function loadEnvironment(rootDir) {
  try {
    require("dotenv").config({ path: path.join(rootDir, ".env") });
  } catch (_error) {
    // dotenv is optional in production.
  }

  const secret = (...values) => values.find((value) => String(value || "").length >= 16);

  process.env.DATABASE_URL = process.env.VOLT_STOCK_DATABASE_URL || process.env.DATABASE_URL;
  process.env.JWT_SECRET = secret(
    process.env.VOLT_STOCK_JWT_SECRET,
    process.env.JWT_SECRET,
    process.env.SUITE_JWT_SECRET,
    process.env.ML_JWT_SECRET,
    process.env.VOLT_CORE_JWT_SECRET,
  );
  process.env.JWT_REFRESH_SECRET = secret(
    process.env.VOLT_STOCK_JWT_REFRESH_SECRET,
    process.env.JWT_REFRESH_SECRET,
    process.env.JWT_SECRET,
  );
  process.env.QR_HMAC_SECRET = secret(
    process.env.VOLT_STOCK_QR_HMAC_SECRET,
    process.env.QR_HMAC_SECRET,
    process.env.JWT_SECRET,
  );
}


function normalizeNextRequestUrl(originalUrl) {
  const canonicalBase = String(process.env.NEXT_PUBLIC_VOLTSTOCK_BASE_PATH || "/business/stock").replace(/\/+$/, "");
  const legacyBase = "/voltstock";
  const value = String(originalUrl || "/");
  if (value === legacyBase) return canonicalBase || "/";
  if (value.startsWith(`${legacyBase}/`)) return `${canonicalBase}${value.slice(legacyBase.length)}` || "/";
  return value;
}

function resolveApiBuild(rootDir) {
  const apiBuildPath = path.join(rootDir, "apps", "api", "dist", "server.js");
  if (!fs.existsSync(apiBuildPath)) {
    throw new Error(
      "build da API nao encontrado em business/volt_stock/apps/api/dist/server.js",
    );
  }
  return require(apiBuildPath);
}

function resolveNext(rootDir) {
  const webRequire = createRequire(
    path.join(rootDir, "apps", "web", "package.json"),
  );
  return webRequire("next");
}

async function createVoltStockApp() {
  const rootDir = __dirname;
  loadEnvironment(rootDir);

  const webDir = path.join(rootDir, "apps", "web");
  const router = express.Router();
  const { buildServer } = resolveApiBuild(rootDir);
  const fastifyApp = await buildServer();

  await fastifyApp.ready();

  router.use("/api", (req, res) => {
    fastifyApp.server.emit("request", req, res);
  });

  const next = resolveNext(rootDir);
  const nextApp = next({
    dev: String(process.env.NODE_ENV || "").toLowerCase() !== "production",
    dir: webDir,
  });
  const handle = nextApp.getRequestHandler();
  await nextApp.prepare();

  router.use((req, res) => {
    // Next.js is compiled with the canonical basePath. Legacy /voltstock URLs
    // are normalized only for the upstream Next handler; the public alias is
    // still accepted by the edge during the migration window.
    req.url = normalizeNextRequestUrl(req.originalUrl);
    return handle(req, res);
  });

  return router;
}

module.exports = createVoltStockApp;
