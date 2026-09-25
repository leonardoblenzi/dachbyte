"use strict";

const magaluApiClient = require("./magaluApiClient");
const rateLimiter = require("./magaluRateLimiter");

function endpoint(resource, sku) {
  const normalized = encodeURIComponent(String(sku || "").trim());
  if (resource === "price") return `/seller/v1/portfolios/prices/${normalized}`;
  if (resource === "stock") return `/seller/v1/portfolios/stocks/${normalized}`;
  throw new Error(`Recurso Magalu inválido: ${resource}`);
}

function skuEndpoint(sku) {
  return `/seller/v1/portfolios/skus/${encodeURIComponent(String(sku || "").trim())}`;
}

async function writeResource(accountId, dachTenantId, resource, sku, payload, { exists, requestId } = {}) {
  const method = exists ? "PATCH" : "POST";
  await rateLimiter.waitFor(accountId, resource === "price" ? "price-write" : "stock-write");
  return magaluApiClient.request(endpoint(resource, sku), {
    method,
    accountId,
    dachTenantId,
    body: payload,
    requestId,
    attempts: 1,
    timeoutMs: 15_000,
  });
}

async function updateSku(accountId, dachTenantId, sku, payload, { requestId } = {}) {
  await rateLimiter.waitFor(accountId, "sku-write");
  return magaluApiClient.request(skuEndpoint(sku), {
    method: "PATCH",
    accountId,
    dachTenantId,
    body: payload,
    requestId,
    // Escrita assíncrona: nunca reenviar automaticamente após timeout/5xx.
    attempts: 1,
    timeoutMs: 15_000,
  });
}

module.exports = {
  writeResource,
  updateSku,
  _test: { endpoint, skuEndpoint },
};
