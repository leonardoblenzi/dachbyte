"use strict";

// Regra de preço por conta/anúncio (Marketplaces, fase 1): validação, cálculo e texto.
const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizePriceRule, computePrice, effectivePriceRule, describePriceRule, priceRuleFromRow, toNumber, DEFAULT_PRICE_RULE, _test } = require("../src/modules/pricing/rules");

const rule = (input) => {
  const { rule: clean, error } = normalizePriceRule(input);
  assert.equal(error, null);
  return clean;
};

test("valida a regra vinda da tela (vírgula decimal, limites e opções)", () => {
  assert.deepEqual(rule({ base: "promo_or_sale", adjust: "pct", value: "12,5", rounding: "90", showFrom: "sale", minPrice: "199,90" }),
    { base: "promo_or_sale", adjust: "pct", value: 12.5, rounding: "90", showFrom: "sale", minPrice: 199.9 });
  assert.equal(rule({ adjust: "amount", value: "-4" }).value, -4, "desconto em R$ é valor negativo");
  assert.equal(rule({ adjust: "pct", value: "", minPrice: "0" }).minPrice, null, "mínimo zero = sem mínimo");
  assert.match(normalizePriceRule({ base: "lucro" }).error, /partida/);
  assert.match(normalizePriceRule({ adjust: "pct", value: "-100" }).error, /percentual/);
  assert.match(normalizePriceRule({ adjust: "fixed", value: "0" }).error, /preço fixo/);
  assert.match(normalizePriceRule({ adjust: "pct", value: "doze" }).error, /numérico/);
  assert.match(normalizePriceRule({ minPrice: "-1" }).error, /mínimo/);
  assert.match(normalizePriceRule({ rounding: "95" }).error, /Arredondamento/);
});

test("lê números em formato brasileiro e internacional", () => {
  assert.equal(toNumber("1.234,56"), 1234.56);
  assert.equal(toNumber("R$ 99,90"), 99.9);
  assert.equal(toNumber("100.5"), 100.5);
  assert.equal(toNumber(""), null);
});

test("acréscimo e desconto em % e em R$, em centavos exatos", () => {
  assert.equal(computePrice({ salePrice: 1190.9, rule: rule({ adjust: "pct", value: "12" }) }).price, 1333.81);
  assert.equal(computePrice({ salePrice: 100, rule: rule({ adjust: "pct", value: "-10" }) }).price, 90);
  assert.equal(computePrice({ salePrice: 1389.9, rule: rule({ adjust: "amount", value: "4" }) }).price, 1393.9);
  assert.equal(computePrice({ salePrice: 0.1, rule: rule({ adjust: "pct", value: "0" }) }).price, 0.1, "sem erro de ponto flutuante");
  assert.equal(computePrice({ salePrice: 80 }).price, 80, "sem regra: preço de venda");
});

test("preço fixo ignora o preço de partida", () => {
  const result = computePrice({ salePrice: null, rule: rule({ adjust: "fixed", value: "1393,90" }) });
  assert.deepEqual([result.price, result.fromPrice, result.reason], [1393.9, null, null]);
});

test("promocional se houver: usa a promoção e manda o preço de venda ajustado como preço de", () => {
  const r = rule({ base: "promo_or_sale", adjust: "pct", value: "10" });
  const promo = computePrice({ salePrice: 200, promoPrice: 150, rule: r });
  assert.deepEqual([promo.price, promo.fromPrice, promo.baseUsed], [165, 220, "promo"]);
  const noPromo = computePrice({ salePrice: 200, promoPrice: null, rule: r });
  assert.deepEqual([noPromo.price, noPromo.fromPrice, noPromo.baseUsed], [220, null, "sale"]);
  const promoNotLower = computePrice({ salePrice: 200, promoPrice: 250, rule: r });
  assert.equal(promoNotLower.baseUsed, "sale", "promoção maior que o preço de venda é ignorada");
  const hidden = computePrice({ salePrice: 200, promoPrice: 150, rule: rule({ base: "promo_or_sale", showFrom: "none" }) });
  assert.equal(hidden.fromPrice, null);
});

test("arredonda para cima até o final ,90 ou ,99", () => {
  assert.equal(_test.roundEnding(133381, "90"), 133390);
  assert.equal(_test.roundEnding(133395, "90"), 133490);
  assert.equal(_test.roundEnding(133390, "90"), 133390, "já no final fica igual");
  assert.equal(_test.roundEnding(133300, "99"), 133399);
  assert.equal(computePrice({ salePrice: 1190.9, rule: rule({ adjust: "pct", value: "12", rounding: "90" }) }).price, 1333.9);
});

test("preço mínimo segura o desconto", () => {
  const result = computePrice({ salePrice: 100, rule: rule({ adjust: "pct", value: "-30", minPrice: "79,90" }) });
  assert.deepEqual([result.price, result.minApplied], [79.9, true]);
});

test("sem o preço de partida no cadastro, não calcula (e diz o motivo)", () => {
  assert.equal(computePrice({ salePrice: null, rule: rule({}) }).reason, "no_sale_price");
  assert.equal(computePrice({ salePrice: 100, cost: null, rule: rule({ base: "cost", value: "80" }) }).reason, "no_cost");
  assert.equal(computePrice({ salePrice: 10, rule: rule({ adjust: "amount", value: "-10" }) }).reason, "non_positive");
  assert.equal(computePrice({ cost: 50, rule: rule({ base: "cost", value: "80" }) }).price, 90, "custo + 80%");
});

test("regra do anúncio vence a da conta; sem nenhuma vale o preço de venda", () => {
  const account = rule({ value: "12" }), listing = rule({ adjust: "fixed", value: "99" });
  assert.equal(effectivePriceRule(account, listing).source, "listing");
  assert.equal(effectivePriceRule(account, null).source, "account");
  assert.deepEqual(effectivePriceRule(null, null), { rule: { ...DEFAULT_PRICE_RULE }, source: "default" });
});

test("texto curto da regra para as tabelas", () => {
  assert.equal(describePriceRule(null), "Preço de venda");
  assert.equal(describePriceRule(rule({ base: "promo_or_sale", value: "12", rounding: "90" })), "Preço promocional (se houver) + 12% · final ,90");
  assert.equal(describePriceRule(rule({ adjust: "amount", value: "4" })), "Preço de venda + R$ 4,00");
  assert.equal(describePriceRule(rule({ adjust: "pct", value: "-7,5", minPrice: "1234,5" })), "Preço de venda − 7,5% · mínimo R$ 1.234,50");
  assert.equal(describePriceRule(rule({ adjust: "fixed", value: "1393,9" })), "Preço fixo R$ 1.393,90");
});

test("linha do banco vira regra", () => {
  assert.deepEqual(priceRuleFromRow({ base: "sale", adjust: "pct", value: "12.0000", rounding: "none", show_from: "sale", min_price: null }),
    { base: "sale", adjust: "pct", value: 12, rounding: "none", showFrom: "sale", minPrice: null });
  assert.equal(priceRuleFromRow(null), null);
});
