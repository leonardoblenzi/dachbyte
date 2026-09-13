"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { applyPromotionSnapshot } = require("../services/filtroPromoSnapshot");

test("persists the best active promotion for CSV reuse", () => {
  const rows = [{
    mlb: "MLB1",
    current_price_cents: 8000,
    original_price_cents: 10000,
  }];
  const promotions = new Map([["MLB1", {
    promo_pct: 20,
    promo_name: "Oferta Smart",
    promo_id: "SMART-1",
    promo_status: "started",
  }]]);

  applyPromotionSnapshot(rows, promotions);

  assert.equal(rows[0].promo_active, true);
  assert.equal(rows[0].promo_pct, 20);
  assert.equal(rows[0].promo_base_price, 100);
  assert.equal(rows[0].promo_current_price, 80);
  assert.equal(rows[0].promo_snapshot_source, "seller_promotions");
});

test("marks rows without an active promotion as resolved", () => {
  const rows = [{ mlb: "MLB2", current_price_cents: 5000 }];

  applyPromotionSnapshot(rows, new Map());

  assert.equal(rows[0].promo_active, false);
  assert.equal(rows[0].promo_status, "sem_promocao");
  assert.equal(rows[0].promo_base_price, 50);
  assert.equal(rows[0].promo_current_price, null);
});

test("uses related item ids and selects the greatest discount", () => {
  const rows = [{
    mlb: "MLB-PARENT",
    related_item_ids: ["MLB-A", "MLB-B"],
    current_price_cents: 7000,
  }];
  const promotions = new Map([
    ["MLB-A", { promo_pct: 10, promo_id: "A" }],
    ["MLB-B", { promo_pct: 30, promo_id: "B" }],
  ]);

  applyPromotionSnapshot(rows, promotions);

  assert.equal(rows[0].promo_id, "B");
  assert.equal(rows[0].promo_pct, 30);
  assert.equal(rows[0].promo_base_price, 100);
});

test("uses exact sale price only for a campaign promotion", () => {
  const rows = [{
    mlb: "MLB3",
    current_price_cents: 9000,
    original_price_cents: 10000,
  }];
  const campaigns = new Map([["MLB3", {
    promo_pct: 10,
    promo_id: "CAMPAIGN-3",
    promo_name: "Campanha",
    promo_status: "started",
  }]]);
  const exact = new Map([["MLB3", {
    promo_active: true,
    promo_pct: 15,
    current_price: 85,
    original_price: 100,
    promo_id: "SALE-PRICE-3",
    promo_source: "sale_price",
  }]]);

  applyPromotionSnapshot(rows, campaigns, exact);

  assert.equal(rows[0].promo_active, true);
  assert.equal(rows[0].promo_pct, 15);
  assert.equal(rows[0].promo_current_price, 85);
  assert.equal(rows[0].promo_base_price, 100);
  assert.equal(rows[0].current_price_cents, 8500);
  assert.equal(rows[0].promo_snapshot_source, "sale_price");
});

test("keeps campaign evidence when exact sale price is unavailable", () => {
  const rows = [{ mlb: "MLB4", current_price_cents: 7500 }];
  const campaigns = new Map([["MLB4", {
    promo_pct: 25,
    promo_id: "CAMPAIGN-4",
  }]]);
  const exact = new Map([["MLB4", { promo_active: false }]]);

  applyPromotionSnapshot(rows, campaigns, exact);

  assert.equal(rows[0].promo_active, true);
  assert.equal(rows[0].promo_id, "CAMPAIGN-4");
  assert.equal(rows[0].promo_pct, 25);
});
