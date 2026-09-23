"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const service = require("../services/EstoqueAtualizacaoService");
const {
  normalizeRequestedChange,
  flattenItem,
  preflightChange,
  buildPutPayload,
  summarizeResults,
  ownershipMatches,
} = service._test;

test("a fila referencia o servico de estoque com o nome exato do arquivo", () => {
  const queueSource = fs.readFileSync(
    path.join(__dirname, "../services/EstoqueAtualizacaoQueueService.js"),
    "utf8"
  );

  assert.match(queueSource, /require\("\.\/EstoqueAtualizacaoService"\)/);
});

test("monta payload simples com available_quantity", () => {
  const payload = buildPutPayload([
    { target_type: "item", requested_stock: 12 },
  ]);
  assert.deepEqual(payload, { available_quantity: 12 });
});

test("monta payload de variacoes preservando IDs", () => {
  const payload = buildPutPayload([
    { target_type: "variation", variation_id: "1234567890", requested_stock: 4 },
    { target_type: "variation", variation_id: "1234567891", requested_stock: 7 },
  ]);
  assert.deepEqual(payload, {
    variations: [
      { id: 1234567890, available_quantity: 4 },
      { id: 1234567891, available_quantity: 7 },
    ],
  });
});

test("bloqueia seller multi-origem antes da escrita", () => {
  const change = normalizeRequestedChange({
    mlb: "MLB123456789",
    current_stock: 3,
    new_stock: 8,
  });
  const current = flattenItem({
    id: "MLB123456789",
    title: "Produto",
    status: "active",
    available_quantity: 3,
    seller_id: 10,
  })[0];
  const result = preflightChange(change, current, {
    sellerId: "10",
    multiOrigin: true,
  });
  assert.equal(result.status, "blocked_multi_origin");
  assert.equal(result.write_applied, false);
});

test("bloqueia estoque Full", () => {
  const change = normalizeRequestedChange({
    mlb: "MLB123456789",
    current_stock: 3,
    new_stock: 8,
  });
  const current = flattenItem({
    id: "MLB123456789",
    title: "Produto Full",
    status: "active",
    available_quantity: 3,
    seller_id: 10,
    shipping: { logistic_type: "fulfillment" },
  })[0];
  const result = preflightChange(change, current, {
    sellerId: "10",
    multiOrigin: false,
  });
  assert.equal(result.status, "blocked_fulfillment");
});

test("nao sobrescreve estoque que mudou depois da revisao", () => {
  const change = normalizeRequestedChange({
    mlb: "MLB123456789",
    current_stock: 3,
    new_stock: 8,
  });
  const current = flattenItem({
    id: "MLB123456789",
    title: "Produto",
    status: "active",
    available_quantity: 5,
    seller_id: 10,
  })[0];
  const result = preflightChange(change, current, {
    sellerId: "10",
    multiOrigin: false,
  });
  assert.equal(result.status, "stale");
  assert.equal(result.actual_current_stock, 5);
  assert.equal(result.write_applied, false);
});

test("rejeita alteracao sem snapshot de estoque antes de ficar pronta", () => {
  const change = normalizeRequestedChange({
    mlb: "MLB123456789",
    new_stock: 8,
  });
  const current = flattenItem({
    id: "MLB123456789",
    title: "Produto",
    status: "active",
    available_quantity: 3,
    seller_id: 10,
  })[0];

  const result = preflightChange(change, current, { sellerId: "10", multiOrigin: false });

  assert.equal(result.status, "invalid");
  assert.match(result.message, /snapshot|estoque atual/i);
});

test("falha fechado quando o item nao informa seller", () => {
  assert.equal(ownershipMatches({ seller_id: null }, "10"), false);
  assert.equal(ownershipMatches({ seller: {} }, "10"), false);
});

test("resume aplicados, divergencias e erros separadamente", () => {
  const summary = summarizeResults([
    { status: "applied", retryable: false },
    { status: "applied", retryable: false },
    { status: "divergent", retryable: false },
    { status: "error", retryable: true },
    { status: "blocked_multi_origin", retryable: false },
    { status: "stale", retryable: false },
  ]);
  assert.equal(summary.total, 6);
  assert.equal(summary.applied, 2);
  assert.equal(summary.divergent, 1);
  assert.equal(summary.errors, 1);
  assert.equal(summary.blocked, 1);
  assert.equal(summary.stale, 1);
  assert.equal(summary.retryable, 1);
});
