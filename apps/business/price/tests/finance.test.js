"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizeFeeResult } = require("../src/finance/fees");
const { calculateProfit, extractOrderItems, allocateItems } = require("../src/finance/profit");

test("normaliza fees ML sem duplicar sale_fee e marketplace_fee", () => {
  const normalized = normalizeFeeResult({
    channel: "meli",
    orderId: "ML-1",
    summary: { saleFee: 18, marketplaceFee: 18, shippingSellerCost: 7 },
  });
  assert.equal(normalized.totalAmount, 25);
  assert.deepEqual(normalized.components.map((item) => item.type), ["commission", "shipping"]);
  assert.equal(normalized.fingerprint.length, 64);
});

test("snapshot de fees distingue a conta vinculada ao pedido", () => {
  const input = { channel: "meli", orderId: "ML-1", summary: { saleFee: 18 } };
  const first = normalizeFeeResult({ ...input, connectionId: "account-a" });
  const second = normalizeFeeResult({ ...input, connectionId: "account-b" });
  assert.notEqual(first.fingerprint, second.fingerprint);
});

test("normaliza escrow Shopee incluindo rebate de frete", () => {
  const normalized = normalizeFeeResult({
    channel: "shopee",
    orderId: "SP-1",
    summary: { commissionFee: 10, serviceFee: 2, sellerTransactionFee: 1, actualShippingFee: 8, shopeeShippingRebate: 3 },
  });
  assert.equal(normalized.totalAmount, 18);
});

test("calcula margem esperada e realizada com origem dos componentes", () => {
  const result = calculateProfit({
    grossAmount: 200,
    expectedFeeAmount: 30,
    feeComponents: [{ type: "commission", amount: 25, sourceType: "API" }],
    input: { costAmount: 80, shippingAmount: 10, adsAmount: 5, taxAmount: 12, packagingAmount: 3 },
  });
  assert.equal(result.expectedContribution, 60);
  assert.equal(result.realizedContribution, 65);
  assert.equal(result.contributionAmount, 65);
  assert.equal(result.calculationType, "realized");
  assert.equal(result.components.find((item) => item.type === "cost").sourceType, "MANUAL");
});

test("sem fee real mantém cálculo como esperado", () => {
  const result = calculateProfit({ grossAmount: 100, expectedFeeAmount: 15, input: { costAmount: 40 } });
  assert.equal(result.calculationType, "expected");
  assert.equal(result.realizedContribution, null);
  assert.equal(result.contributionAmount, 45);
});

test("extrai itens Tray e rateia custos proporcionalmente ao bruto", () => {
  const items = extractOrderItems({ ProductsSold: [
    { ProductSold: { reference: "A", quantity: 2, price: 30, name: "Produto A" } },
    { ProductSold: { reference: "B", quantity: 1, price: 40, name: "Produto B" } },
  ] });
  const allocated = allocateItems(items, { grossAmount: 100, contributionAmount: 50 });
  assert.equal(allocated[0].grossAmount, 60);
  assert.equal(allocated[0].contributionAmount, 30);
  assert.equal(allocated[1].contributionAmount, 20);
});

test("custos atribuidos de marketing entram na margem com sua origem", () => {
  const result = calculateProfit({ grossAmount: 100, expectedFeeAmount: 10, input: { costAmount: 40 }, extraComponents: [
    { type: "ads", amount: 12, sourceType: "IMPORT", sourceRef: "campaign:date" },
    { type: "affiliate", amount: 3, sourceType: "API", sourceRef: "affiliate:1" },
  ] });
  assert.equal(result.contributionAmount, 35);
  assert.equal(result.components.find((item) => item.sourceRef === "campaign:date").sourceType, "IMPORT");
});
