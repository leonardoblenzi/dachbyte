"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const integrationSource = fs.readFileSync(path.join(root, "public", "tray-connection.js"), "utf8");
const appSource = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const reconciliationSource = fs.readFileSync(path.join(root, "public", "orders-reconciliation.js"), "utf8");

test("Shopee integrações mostram todas as lojas e usam o connectionId de cada ação", () => {
  assert.match(integrationSource, /connections\.filter\(connection\s*=>\s*connection\.channel\s*===\s*"shopee"\)/);
  assert.match(integrationSource, /Adicionar loja Shopee/);
  assert.match(integrationSource, /data-refresh="\$\{channel\}"/);
  assert.match(integrationSource, /data-disconnect="\$\{channel\}"/);
  assert.match(integrationSource, /connectionId:\s*button\.dataset\.connectionId/);
  assert.match(integrationSource, /params\.get\("connected"\)\s*===\s*"shopee"/);
  assert.match(integrationSource, /params\.get\("shopee"\)\s*===\s*"error"/);
  assert.doesNotMatch(integrationSource, /firstConnection\("shopee"\)/);
  assert.doesNotMatch(integrationSource, /(?:token_cipher|refresh_token_cipher|partner_key|access_token)/i);
});

test("Pedidos sincronizam a loja Shopee selecionada e consultam taxa pelo UUID interno", () => {
  assert.match(appSource, /id="syncShopeeConnection"/);
  assert.match(appSource, /api\("\/integrations\/"\)/);
  assert.match(appSource, /"\/orders\/sync\/shopee"/);
  assert.match(appSource, /const connectionId=\$\("#syncShopeeConnection"\)\.value/);
  assert.match(appSource, /data-fee-shopee="\$\{o\.id\}"/);
  assert.match(appSource, /Shopee\s*\/\s*loja/);
  assert.match(appSource, /ID da loja Shopee/);
  assert.doesNotMatch(appSource, /data-fee-shopee="\$\{escapeHtml\(o\.marketplace_order_id\)\}"/);
});

test("Reconciliação Shopee exige uma loja conectada e identifica contas ausentes", () => {
  assert.match(reconciliationSource, /Shopee\s*\/\s*loja/);
  assert.match(reconciliationSource, /ID da loja Shopee/);
  assert.match(reconciliationSource, /\["meli", "shopee"\]\.includes\(marketplace\)/);
  assert.match(reconciliationSource, /conta n[aã]o identificada/);
});
