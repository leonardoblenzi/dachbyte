"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { missingTerms } = require("../src/services/promoPricingService");
const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

const FULL = { target_margin: "17", commission_rate: "13", fixed_fee: "5", shipping: "0", pix_mode: "sem_datas", pix_margin: "16", pix_discount: "15", pix_seller_share: "7" };

test("cálculo exige os parâmetros sem os quais nenhum SKU pode ser elegível", () => {
  assert.deepEqual(missingTerms(FULL), []);
  assert.deepEqual(missingTerms({ ...FULL, shipping: "" }).map((item) => item.key), ["shipping"]);
  assert.deepEqual(missingTerms({ ...FULL, pix_margin: "", shipping: " " }).map((item) => item.key), ["shipping", "pix_margin"]);
  assert.deepEqual(missingTerms({ ...FULL, pix_mode: "", pix_margin: "", pix_discount: "", pix_seller_share: "" }), []);
  assert.deepEqual(missingTerms({ ...FULL, shipping: "0" }), []);
});

test("servidor recusa o cálculo sem parâmetros antes de enfileirar o recorte", () => {
  const controller = read("src/controllers/promoPriceController.js");
  assert.match(controller, /missing=missingTerms\(terms\);if\(missing\.length\)throw error\(/);
  assert.ok(controller.indexOf("missingTerms(terms)") < controller.indexOf("enqueuePromoPricingPreview(identity"));
});

test("tela valida os parâmetros, destaca o campo e orienta usar 0 no frete", () => {
  const html = read("views/app.html"), js = read("public/js/magalu-promocoes-massa.js");
  assert.doesNotMatch(html, /Deixe vazio se desconhecido|Frete vazio será tratado como desconhecido/);
  assert.match(html, /use 0 se o frete não sai do seu bolso/);
  assert.match(js, /async function calculate\(\)\{const missing=missingTermFields\(\);if\(missing\.length\)\{/);
  assert.match(js, /setAttribute\("aria-invalid","true"\)/);
});
