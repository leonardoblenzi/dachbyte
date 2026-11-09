"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const prices = require("../src/repositories/promoPriceRepository");
const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

test("Apenas estoque > 0 restringe o recorte (contagem, páginas do job, lista e exportação)", () => {
  const withStock = prices.filters({ accountId: 2, publication: "PUBLISHED", activity: "active", stock: "positive" });
  assert.ok(withStock.where.some((clause) => /from magalu\.stocks st where st\.account_id=s\.account_id and st\.sku=s\.sku and st\.is_present=true and st\.quantity>0/.test(clause)));
  const all = prices.filters({ accountId: 2, publication: "PUBLISHED", activity: "active" });
  assert.ok(!all.where.some((clause) => /magalu\.stocks/.test(clause)));
  assert.throws(() => prices.filters({ accountId: 2, stock: "zero" }), /Filtro de estoque inválido/);
});

test("tela de precificação envia o filtro de estoque junto com os demais", () => {
  const html = read("views/app.html"), js = read("public/js/magalu-promocoes-massa.js");
  assert.match(html, /<input id="mg-promo-in-stock" type="checkbox"><span>Apenas estoque&nbsp;&gt;&nbsp;0<\/span>/);
  assert.match(js, /stock:\$\("mg-promo-in-stock"\)\?\.checked\?"positive":""/);
});
