"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");

test("Seller selector exposes only shared Seller modules", () => {
  const source = fs.readFileSync(path.join(root, "apps/seller-ml/views/selecao-plataforma.html"), "utf8");
  const cards = Array.from(source.matchAll(/class="module-card" href="[^"]+" data-module="([^"]+)"/g), (match) => match[1]);

  assert.deepEqual(cards, ["ml", "shopee", "tracking"]);
  assert.doesNotMatch(source, /dach_ads:/);
  assert.doesNotMatch(source, /davanttilog:/);
  assert.doesNotMatch(source, /madeiramadeira:/);
  assert.doesNotMatch(source, /skuleader:/);
});

test("independent modules retain protected Gateway entry routes", () => {
  const source = fs.readFileSync(path.join(root, "apps/gateway/server.js"), "utf8");

  assert.match(source, /\/go\/ads/);
  assert.match(source, /\/go\/davanttilog/);
  assert.match(source, /\/go\/madeiramadeira/);
  assert.match(source, /\/go\/skuleader/);
});
