"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("Magalu standalone starter uses stable /magalu prefix", () => {
  assert.match(read("apps/seller-magalu/start.js"), /mountPath:\s*["']\/magalu["']/);
});

test("VPS routes /magalu to dedicated web service and keeps isolated worker", () => {
  const compose = read("infra/compose.vps.yml");
  const caddy = read("infra/Caddyfile");
  assert.match(compose, /seller-magalu-web:/);
  assert.match(compose, /seller-magalu-worker:/);
  assert.match(compose, /apps\/seller-magalu\/start\.js/);
  assert.match(compose, /apps\/seller-magalu\/src\/worker\.js/);
  assert.match(caddy, /path \/magalu \/magalu\/\*/);
  assert.match(caddy, /reverse_proxy seller-magalu-web:3000/);
});

test("Gateway and suite selection expose Magalu as a Hub-controlled module", () => {
  const gateway = read("apps/gateway/server.js");
  const suiteAuth = read("routes/suiteAuthRoutes.js");
  const selection = read("apps/seller-ml/views/selecao-plataforma.html");
  assert.match(gateway, /app\.get\("\/go\/magalu"/);
  assert.match(gateway, /bootstrapMagaluSession/);
  assert.match(suiteAuth, /\{ id: "magalu", hubModule: "magalu" \}/);
  assert.match(selection, /data-module="magalu"/);
  assert.match(selection, /href="\/go\/magalu"/);
});

test("public Seller pages are owned by Gateway instead of seller-ml", () => {
  for (const file of [
    "landing-general.html",
    "landing-mercado-livre.html",
    "landing-shopee.html",
    "landing-tracking.html",
    "landing-magalu.html",
    "legal-magalu-terms.html",
    "legal-magalu-privacy.html",
  ]) {
    assert.equal(fs.existsSync(path.join(root, "apps/gateway/views/seller", file)), true, file);
  }
  const gateway = read("apps/gateway/server.js");
  assert.match(gateway, /path\.join\(__dirname, "views", "seller"\)/);
});


test("Magalu public surface is owned by Gateway and shared DACHBYTE Seller assets", () => {
  const gateway = read("apps/gateway/server.js");
  assert.match(gateway, /path\.join\(__dirname, "views", "seller"\)/);
  const shell = read("public/brand/dachbyte/landing-experience.js");
  assert.match(shell, /label: 'Magalu', href: '\/seller\/magalu', login: '\/go\/magalu'/);
});
