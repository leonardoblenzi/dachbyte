"use strict";

const { calculateV7Price } = require("./PricingV7Engine");

function asPositiveCents(value) {
  const cents = Number(value);
  return Number.isFinite(cents) && Number.isInteger(cents) && cents > 0 ? cents : null;
}

function asDate(value, label) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} inválida`);
  return date;
}

function resolvePeriod({ startAt, endAt, useMaxDuration, maximumDurationDays, now }) {
  const durationDays = Number(maximumDurationDays);
  if (!Number.isInteger(durationDays) || durationDays < 1) throw new Error("maximumDurationDays deve ser ao menos 1");
  const start = asDate(startAt, "Data de início");
  const current = now == null ? new Date() : asDate(now, "Data atual");
  if (start <= current) throw new Error("A data de início deve estar no futuro");
  const maximumEnd = new Date(start.getTime());
  maximumEnd.setUTCDate(maximumEnd.getUTCDate() + durationDays);
  const resolvedEnd = useMaxDuration ? maximumEnd : asDate(endAt, "Data de término");
  if (resolvedEnd <= start) throw new Error("A data de término deve ser posterior ao início");
  if (resolvedEnd > maximumEnd) throw new Error("O período máximo permitido foi excedido");
  return { startAt: start.toISOString(), endAt: resolvedEnd.toISOString() };
}

function buildGiftCampaignPreview({ mainItems, giftItems, settings, calibration, targetMarginRate, startAt, endAt, useMaxDuration, maximumDurationDays, now } = {}) {
  if (!Array.isArray(mainItems) || mainItems.length === 0) throw new Error("Selecione ao menos um item principal");
  if (!Array.isArray(giftItems) || giftItems.length === 0) throw new Error("Selecione ao menos um brinde");
  if (mainItems.some((item) => !asPositiveCents(item?.costCents)) || giftItems.some((item) => !asPositiveCents(item?.costCents))) throw new Error("Todos os itens selecionados devem ter CMV positivo");
  const period = resolvePeriod({ startAt, endAt, useMaxDuration, maximumDurationDays, now });
  const giftProvisionCents = Math.max(...giftItems.map((item) => Math.max(0, Number(item.costCents) || 0)));
  const lines = mainItems.map((main) => {
    const costCents = Number(main.costCents);
    const costWithGiftCents = costCents + giftProvisionCents;
    const pricing = calculateV7Price({ costCents: costWithGiftCents, logisticsCostCents: 0, otherFixedCostCents: 0, targetMarginRate, settings, calibration });
    const selected = pricing.selected || {};
    return { key: main.key, costCents, giftProvisionCents, costWithGiftCents, suggestedPriceCents: selected.priceCents ?? null, marginRate: selected.marginRate ?? null, warnings: Array.isArray(pricing.warnings) ? [...pricing.warnings] : [] };
  });
  const priceableLines = lines.filter((line) => line.suggestedPriceCents != null);
  const summary = {
    costCents: lines.reduce((total, line) => total + line.costCents, 0),
    giftProvisionCents,
    costWithGiftCents: lines.reduce((total, line) => total + line.costWithGiftCents, 0),
    suggestedPriceCents: priceableLines.reduce((total, line) => total + line.suggestedPriceCents, 0),
    marginRate: priceableLines.length ? priceableLines.reduce((total, line) => total + line.marginRate, 0) / priceableLines.length : null,
  };
  return { period, giftProvisionCents, lines, summary };
}

module.exports = { buildGiftCampaignPreview };
