"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const pricing = require("../src/services/promoPricingService");
const previews = require("../src/repositories/promoPricingPreviewRepository");
const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const row = (sku, cost) => ({ sku, unit_cost: String(cost), list_price: "5000", price: "5000", price_present: true, tax_rate: "10", status: "PUBLISHED", active: true, price_synced_at: new Date().toISOString() });
const BASE = { target_margin: "17", commission_rate: "13", fixed_fee: "5", pix_discount: "15", pix_seller_share: "7" };

// Precos do chat de precificacao (D'Rossi): comissao 13% + R$ 5, imposto 10%, Pix 15% (7% seller).
const CHAT = [
  ["77731-67075", 219.86, 50, 479.9, 407.92, 15.41],
  ["77831-67159", 259.24, 50, 549.9, 467.42, 15.55],
  ["77855-67183", 171.18, 50, 399.9, 339.92, 16.18],
  ["77831-67169", 285.0, 50, 589.9, 501.42, 15.02],
  ["77831-67167", 282.53, 50, 589.9, 501.42, 15.48],
  ["77831-67165", 273.23, 50, 569.9, 484.42, 15.07],
  ["77831-67163", 275.69, 50, 579.9, 492.92, 15.68],
  ["114445", 161.97, 0, 289.9, 246.42, 15.07],
  ["114415", 219.9, 0, 399.9, 339.92, 16.53],
  ["111201", 128.4, 0, 239.9, 203.92, 17.2],
  ["114355", 190.3775, 0, 339.9, 288.92, 15.19],
];

test("Pix com datas: anunciado termina em 9,90 e atende 15% no Pix e 17% sem Pix", () => {
  for (const [sku, cost, shipping, price, pix, pixMargin] of CHAT) {
    const result = pricing.evaluate(row(sku, cost), { ...BASE, shipping: String(shipping), pix_mode: "com_datas", pix_margin: "15" });
    assert.equal(result.suggested_price, price, sku);
    assert.equal(result.pix_price, pix, sku);
    assert.ok(Math.abs(result.pix_margin - pixMargin) <= 0.011, `${sku} margem Pix ${result.pix_margin}`);
    assert.ok(result.estimated_margin >= 17, sku);
    assert.equal(result.eligible, true, sku);
  }
});

test("Pix sem datas: preco final no Pix termina em 9,99 (sofa Arezzo)", () => {
  const result = pricing.evaluate(row("sofa", 635), { ...BASE, shipping: "0", pix_mode: "sem_datas", pix_margin: "16" });
  assert.equal(result.pix_price, 959.99);
  assert.equal(result.suggested_price, 1129.4);
  assert.ok(result.pix_margin >= 16);
  assert.ok(result.estimated_margin >= 17);
});

test("sem Pix o calculo continua o de antes e preco editado abaixo do minimo fica pendente", () => {
  const plain = pricing.evaluate(row("x", 219.86), { target_margin: "17", commission_rate: "13", fixed_fee: "5", shipping: "50" });
  assert.equal(plain.suggested_price, 458.1);
  assert.equal(plain.pix_price, null);
  const low = pricing.evaluate(row("x", 219.86), { ...BASE, shipping: "50", pix_mode: "com_datas", pix_margin: "15" }, { price: "460" });
  assert.equal(low.eligible, false);
  assert.match(low.issues.join(";"), /margens com e sem Pix/);
  const share = pricing.evaluate(row("x", 100), { ...BASE, shipping: "0", pix_mode: "com_datas", pix_margin: "15", pix_seller_share: "20" });
  assert.match(share.issues.join(";"), /Participação no Pix maior que o desconto/);
});

test("revisao aceita os campos do Pix e a tela mostra Pix (cliente) e Margem no Pix", () => {
  const terms = previews.validateTerms({ ...BASE, shipping: "50", pix_mode: "sem_datas", pix_margin: "16" });
  assert.equal(terms.pix_mode, "sem_datas");
  assert.equal(terms.pix_seller_share, "7");
  assert.throws(() => previews.validateTerms({ pix_mode: "outro" }), /modo de preço Pix inválido/);
  const html = read("views/app.html");
  assert.match(html, /id="mg-promo-pix-mode"/);
  assert.match(html, /<th>Pix \(cliente\)<\/th><th>Margem no Pix<\/th>/);
  const js = read("public/js/magalu-promocoes-massa.js");
  assert.match(js, /pix_mode:\$\("mg-promo-pix-mode"\)\?\.value/);
  assert.match(js, /PIX_MARGIN_DEFAULT=\{sem_datas:"16",com_datas:"15"\}/);
});
