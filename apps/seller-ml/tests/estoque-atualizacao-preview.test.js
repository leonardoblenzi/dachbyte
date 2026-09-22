"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const service = require("../services/estoqueAtualizacaoPreviewService");
const {
  flattenItem,
  evaluatePreviewChange,
  summarizePreview,
} = service._test;

test("flattenItem cria uma linha para anuncio simples", () => {
  const rows = flattenItem({
    id: "MLB123456789",
    title: "Produto simples",
    status: "active",
    available_quantity: 7,
    seller_custom_field: "SKU-001",
    seller_id: 123,
    variations: [],
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].row_key, "MLB123456789:item");
  assert.equal(rows[0].target_type, "item");
  assert.equal(rows[0].sku, "SKU-001");
  assert.equal(rows[0].current_stock, 7);
});

test("flattenItem separa estoque e SKU por variacao", () => {
  const rows = flattenItem({
    id: "MLB123456789",
    title: "Produto com cores",
    status: "active",
    available_quantity: 9,
    seller_id: 123,
    variations: [
      {
        id: 111,
        available_quantity: 3,
        seller_custom_field: "SKU-CINZA",
        attribute_combinations: [{ id: "COLOR", value_name: "Cinza" }],
      },
      {
        id: 222,
        available_quantity: 6,
        seller_custom_field: "SKU-PRETO",
        attribute_combinations: [{ id: "COLOR", value_name: "Preto" }],
      },
    ],
  });

  assert.equal(rows.length, 2);
  assert.equal(rows[0].row_key, "MLB123456789:111");
  assert.equal(rows[0].sku, "SKU-CINZA");
  assert.equal(rows[0].variation_label, "Cinza");
  assert.equal(rows[0].current_stock, 3);
  assert.equal(rows[1].row_key, "MLB123456789:222");
  assert.equal(rows[1].current_stock, 6);
});

test("preview marca stale quando estoque mudou desde o carregamento", () => {
  const current = {
    row_key: "MLB123456789:item",
    mlb: "MLB123456789",
    title: "Produto",
    sku: "SKU-1",
    item_status: "active",
    target_type: "item",
    current_stock: 8,
  };

  const result = evaluatePreviewChange(
    {
      mlb: "MLB123456789",
      current_stock: 5,
      new_stock: 10,
    },
    current,
  );

  assert.equal(result.status, "stale");
  assert.equal(result.actual_current_stock, 8);
  assert.equal(result.can_apply_later, false);
});

test("preview marca ready quando valor mudou e estoque continua igual", () => {
  const current = {
    row_key: "MLB123456789:111",
    mlb: "MLB123456789",
    variation_id: "111",
    title: "Produto",
    sku: "SKU-1",
    item_status: "active",
    target_type: "variation",
    current_stock: 4,
  };

  const result = evaluatePreviewChange(
    {
      mlb: "MLB123456789",
      variation_id: "111",
      expected_current_stock: 4,
      new_stock: 9,
    },
    current,
  );

  assert.equal(result.status, "ready");
  assert.equal(result.difference, 5);
  assert.equal(result.can_apply_later, true);
});

test("preview bloqueia anuncio fora de active", () => {
  const current = {
    row_key: "MLB123456789:item",
    mlb: "MLB123456789",
    item_status: "paused",
    target_type: "item",
    current_stock: 4,
  };

  const result = evaluatePreviewChange(
    {
      mlb: "MLB123456789",
      expected_current_stock: 4,
      new_stock: 9,
    },
    current,
  );

  assert.equal(result.status, "blocked");
  assert.equal(result.can_apply_later, false);
});

test("summarizePreview contabiliza estados", () => {
  const summary = summarizePreview([
    { status: "ready" },
    { status: "ready" },
    { status: "stale" },
    { status: "unchanged" },
    { status: "blocked" },
  ]);

  assert.deepEqual(summary, {
    total: 5,
    ready: 2,
    unchanged: 1,
    stale: 1,
    blocked: 1,
    blocked_multi_origin: 0,
    blocked_fulfillment: 0,
    blocked_capability: 0,
    blocked_up_conflict: 0,
    invalid: 0,
    not_found: 0,
  });
});


test("preview bloqueia conta multi-origem antes da confirmacao", () => {
  const current = {
    row_key: "MLB123456789:item",
    mlb: "MLB123456789",
    item_status: "active",
    target_type: "item",
    current_stock: 4,
  };
  const result = evaluatePreviewChange(
    { mlb: "MLB123456789", expected_current_stock: 4, new_stock: 9 },
    current,
    { multiOrigin: true },
  );
  assert.equal(result.status, "blocked_multi_origin");
  assert.equal(result.can_apply_later, false);
});
