"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const portal = readFileSync(path.join(__dirname, "..", "views", "selecao-plataforma.html"), "utf8");
const { renderPriceNotice } = require("../public/js/portal-price-notice");

const notice = { status: "sent", oldRangeCode: "up_to_30",
  newRangeCode: "from_31_to_200", oldMonthlyPriceCents: 4900,
  newMonthlyPriceCents: 9900, measurementPeriodStart: "2026-09-01",
  measurementPeriodEnd: "2026-09-30", measuredOrders: 150,
  earliestEffectiveOn: "2026-11-25", deliveredAt: "2026-10-15T12:00:00Z" };

test("sent notice shows current and future price without implying immediate change", () => {
  const html = renderPriceNotice(notice);
  assert.match(html, /R\$\s*49,00/);
  assert.match(html, /R\$\s*99,00/);
  assert.match(html, /25\/11\/2026/);
  assert.match(html, /Aumento comunicado/);
  assert.match(html, /valor atual continua/);
});

test("failed notice makes the blocked increase explicit and escapes account data", () => {
  const html = renderPriceNotice({ ...notice, status: "failed", newRangeCode: "<script>" });
  assert.match(html, /Aviso não entregue/);
  assert.match(html, /aumento não será aplicado/);
  assert.doesNotMatch(html, /<script>/);
});

test("account drawer reserves a visible price notice slot and reads Hub notice", () => {
  assert.match(portal, /id="account-price-notice"/);
  assert.match(portal, /resource\.price_notice/);
  assert.match(portal, /portal-price-notice\.js/);
});
