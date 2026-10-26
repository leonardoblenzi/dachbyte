"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const sellerRoot = path.resolve(__dirname, "..");
const gatewayRoot = path.resolve(sellerRoot, "..", "gateway");
const portal = readFileSync(path.join(sellerRoot, "views", "selecao-plataforma.html"), "utf8");
const gateway = readFileSync(path.join(gatewayRoot, "server.js"), "utf8");

test("contracting shows measured ML/Shopee range without an editable sales estimate", () => {
  assert.match(portal, /module\.catalog_plans\|\|\[\]/);
  assert.match(portal, /formatMoney\(range\.monthly_price_cents\)/);
  assert.match(portal, /count>3000/);
  assert.match(portal, /Mais de 3\.000 pedidos/);
  assert.match(portal, /Aguardando apuração/);
  assert.match(portal, /resource\?\.recommended_range_code/);
  assert.doesNotMatch(portal, /id="purchase-orders"/);
  assert.doesNotMatch(portal, /credits_5000|credits_15000|R\$ 11,00/);
});

test("public Seller landings do not serve the retired static checkout page", () => {
  assert.doesNotMatch(gateway, /sendSellerLanding\("landing\.html"\)/);
  for (const file of ["landing-general.html", "landing-mercado-livre.html", "landing-shopee.html"]) {
    const html = readFileSync(path.join(gatewayRoot, "views", "seller", file), "utf8");
    assert.doesNotMatch(html, /R\$ 11,00|créditos\/mês|Acima de 1\.500 vendas: \+/i);
  }
});

test("portal inline script remains valid JavaScript", () => {
  const scripts = [...portal.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1]).filter(Boolean);
  assert.ok(scripts.length > 0);
  for (const source of scripts) new vm.Script(source);
});
