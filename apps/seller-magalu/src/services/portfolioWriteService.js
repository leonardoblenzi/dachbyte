"use strict";

const magaluApiClient = require("./magaluApiClient");
const rateLimiter = require("./magaluRateLimiter");

function endpoint(resource, sku) {
  const normalized = encodeURIComponent(String(sku || "").trim());
  if (resource === "price") return `/seller/v1/portfolios/prices/${normalized}`;
  if (resource === "stock") return `/seller/v1/portfolios/stocks/${normalized}`;
  throw new Error(`Recurso Magalu inválido: ${resource}`);
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
    // Escrita nunca recebe retry automático: POST/PATCH aceitos são assíncronos (202)
    // e um timeout não prova que o provedor não recebeu a operação.
    attempts: 1,
    timeoutMs: 15_000,
  });
}

module.exports = { writeResource, _test: { endpoint } };
