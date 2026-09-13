const assert = require("node:assert/strict");
const test = require("node:test");
const { _test } = require("../src/services/ShopeeAddOnDealService");

test("monta campanha de brinde com gasto mínimo e um brinde por pedido", () => {
  const body = _test.buildGiftDealPayload({
    name: "Brinde Setembro",
    startAt: "2026-09-10T12:00:00.000Z",
    endAt: "2026-10-10T12:00:00.000Z",
    minSpendCents: 19990,
  });

  assert.equal(body.promotion_type, 1);
  assert.equal(body.purchase_min_spend, 199.9);
  assert.equal(body.per_gift_num, 1);
  assert.equal(body.start_time, 1789041600);
});

test("rejeita resposta Shopee sem identificador de campanha", () => {
  assert.throws(() => _test.extractAddOnDealId({ response: {} }), /identificador/i);
});
