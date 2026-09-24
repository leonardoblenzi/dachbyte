"use strict";

const crypto = require("node:crypto");

const PRICE_WRITE_SCOPE = "open:portfolio-prices-seller:write";
const STOCK_WRITE_SCOPE = "open:portfolio-stocks-seller:write";

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function money(value) {
  const parsed = number(value);
  if (parsed === null) return null;
  return Math.round((parsed + Number.EPSILON) * 100) / 100;
}

function integer(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function normalizeResource(value) {
  const resource = String(value || "").trim().toLowerCase();
  if (!['price','stock'].includes(resource)) {
    const error = new Error("Recurso de escrita Magalu inválido.");
    error.code = "MAGALU_WRITE_RESOURCE_INVALID";
    error.status = 400;
    throw error;
  }
  return resource;
}

function buildPricePayload(input = {}) {
  const price = money(input.price);
  const listPrice = money(input.list_price ?? input.listPrice);
  if (price === null || price <= 0) {
    const error = new Error("Preço deve ser maior que zero.");
    error.code = "MAGALU_PRICE_INVALID";
    error.status = 422;
    throw error;
  }
  if (listPrice === null || listPrice <= 0) {
    const error = new Error("Preço de lista deve ser maior que zero.");
    error.code = "MAGALU_LIST_PRICE_INVALID";
    error.status = 422;
    throw error;
  }
  if (price > listPrice) {
    const error = new Error("O preço de venda não pode ser maior que o preço de lista.");
    error.code = "MAGALU_PRICE_ABOVE_LIST_PRICE";
    error.status = 422;
    throw error;
  }
  return { price, list_price: listPrice };
}

function buildStockPayload(input = {}) {
  const quantity = integer(input.quantity);
  if (quantity === null || quantity < 0) {
    const error = new Error("Estoque deve ser um número inteiro maior ou igual a zero.");
    error.code = "MAGALU_STOCK_INVALID";
    error.status = 422;
    throw error;
  }
  return { quantity };
}

function buildPayload(resource, input) {
  return normalizeResource(resource) === "price"
    ? buildPricePayload(input)
    : buildStockPayload(input);
}

function currentFromRemote(resource, payload, parser) {
  if (resource === "price") {
    const fields = parser.priceFields(payload || {});
    return { price: money(fields.price), list_price: money(fields.listPrice) };
  }
  return { quantity: integer(parser.stockQuantity(payload || {})) };
}

function equals(resource, left = {}, right = {}) {
  if (resource === "price") {
    return money(left.price) === money(right.price)
      && money(left.list_price ?? left.listPrice) === money(right.list_price ?? right.listPrice);
  }
  return integer(left.quantity) === integer(right.quantity);
}

function scopeFor(resource) {
  return normalizeResource(resource) === "price" ? PRICE_WRITE_SCOPE : STOCK_WRITE_SCOPE;
}

function hasScope(scopes, scope) {
  return new Set((Array.isArray(scopes) ? scopes : []).map((item) => String(item || "").trim())).has(scope);
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value).sort().reduce((acc, key) => {
    acc[key] = stableObject(value[key]);
    return acc;
  }, {});
}

function requestHash(resource, sku, before, requested) {
  return crypto.createHash("sha256").update(JSON.stringify(stableObject({
    resource: normalizeResource(resource),
    sku: String(sku || "").trim(),
    before: before || {},
    requested: requested || {},
  }))).digest("hex");
}

module.exports = {
  PRICE_WRITE_SCOPE,
  STOCK_WRITE_SCOPE,
  normalizeResource,
  buildPricePayload,
  buildStockPayload,
  buildPayload,
  currentFromRemote,
  equals,
  scopeFor,
  hasScope,
  requestHash,
  _test: { money, integer, stableObject },
};
