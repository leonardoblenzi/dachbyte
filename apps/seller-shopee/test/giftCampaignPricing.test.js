"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { buildGiftCampaignPreview } = require("../src/services/GiftCampaignPricingService");

const settings = {
  targetMarginRate: 0.2,
  engineMode: "SAFE",
  feeRules: [{ maxCents: null, commissionRate: 0.1, fixedFeeCents: 0 }],
  coupons: [],
  psychologicalEndings: [0],
};

test("provisiona somente o CMV do brinde mais caro para cada principal", () => {
  const result = buildGiftCampaignPreview({
    mainItems: [{ key: "10:0", costCents: 10000 }],
    giftItems: [{ key: "20:0", costCents: 900 }, { key: "21:0", costCents: 1750 }],
    settings, calibration: null, targetMarginRate: 0.2,
    startAt: "2026-09-10T12:00:00.000Z", useMaxDuration: true,
    maximumDurationDays: 30, now: new Date("2026-09-03T12:00:00.000Z"),
  });

  assert.equal(result.giftProvisionCents, 1750);
  assert.equal(result.lines[0].costCents, 10000);
  assert.equal(result.lines[0].giftProvisionCents, 1750);
  assert.equal(result.lines[0].costWithGiftCents, 11750);
  assert.equal(result.period.endAt, "2026-10-10T12:00:00.000Z");
});

test("rejeita término acima do máximo quando o período máximo não está ativo", () => {
  assert.throws(() => buildGiftCampaignPreview({
    mainItems: [{ key: "10:0", costCents: 10000 }], giftItems: [{ key: "20:0", costCents: 900 }],
    settings, calibration: null, targetMarginRate: 0.2,
    startAt: "2026-09-10T12:00:00.000Z", endAt: "2026-11-10T12:00:00.000Z",
    useMaxDuration: false, maximumDurationDays: 30, now: new Date("2026-09-03T12:00:00.000Z"),
  }), /período máximo/i);
});

test("calcula o preço usando o CMV provisionado sem alterar o principal", () => {
  const result = buildGiftCampaignPreview({
    mainItems: [{ key: "10:0", costCents: 10000 }],
    giftItems: [{ key: "20:0", costCents: 1750 }],
    settings, calibration: null, targetMarginRate: 0.2,
    startAt: "2026-09-10T12:00:00.000Z", useMaxDuration: true,
    maximumDurationDays: 30, now: new Date("2026-09-03T12:00:00.000Z"),
  });

  assert.equal(result.lines[0].suggestedPriceCents, 16800);
  assert.equal(result.lines[0].marginRate, 0.2005952380952381);
  assert.equal(result.summary.suggestedPriceCents, 16800);
});

test("rejeita itens selecionados sem CMV positivo", () => {
  assert.throws(() => buildGiftCampaignPreview({
    mainItems: [{ key: "10:0", costCents: 0 }],
    giftItems: [{ key: "20:0", costCents: 900 }],
    settings, calibration: null, targetMarginRate: 0.2,
    startAt: "2026-09-10T12:00:00.000Z", useMaxDuration: true,
    maximumDurationDays: 30, now: new Date("2026-09-03T12:00:00.000Z"),
  }), /CMV positivo/i);
});

test("rejeita CMV fracionado em centavos", () => {
  assert.throws(() => buildGiftCampaignPreview({
    mainItems: [{ key: "10:0", costCents: 100.5 }],
    giftItems: [{ key: "20:0", costCents: 900 }],
    settings, calibration: null, targetMarginRate: 0.2,
    startAt: "2026-09-10T12:00:00.000Z", useMaxDuration: true,
    maximumDurationDays: 30, now: new Date("2026-09-03T12:00:00.000Z"),
  }), /CMV positivo/i);
});