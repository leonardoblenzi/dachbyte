"use strict";

const magaluApiClient = require("./magaluApiClient");
const rateLimiter = require("./magaluRateLimiter");

function pathSku(sku, suffix="") {
  const base = `/seller/v1/portfolios/skus/${encodeURIComponent(String(sku || "").trim())}`;
  return `${base}${suffix}`;
}
async function readSku(account, sku) {
  await rateLimiter.waitFor(account.id, "sku-read");
  return magaluApiClient.request(pathSku(sku), { method:"GET", accountId:account.id, dachTenantId:account.dach_tenant_id, attempts:4, timeoutMs:15000 });
}
async function validationInfo(account, sku) {
  await rateLimiter.waitFor(account.id, "sku-read");
  return magaluApiClient.request(pathSku(sku, "/validation-info"), { method:"GET", accountId:account.id, dachTenantId:account.dach_tenant_id, attempts:4, timeoutMs:15000 });
}
async function patchActive(account, sku, active, requestId) {
  await rateLimiter.waitFor(account.id, "sku-write");
  return magaluApiClient.request(pathSku(sku), {
    method:"PATCH", accountId:account.id, dachTenantId:account.dach_tenant_id,
    attempts:1, timeoutMs:15000, requestId, body:{ active:active === true },
  });
}
module.exports = { readSku, validationInfo, patchActive, _test:{ pathSku } };
