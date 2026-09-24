"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");
const gateway = () => fs.readFileSync(path.join(root, "apps", "gateway", "server.js"), "utf8");
const view = (fileName) => fs.readFileSync(path.join(root, "apps", "gateway", "views", "seller", fileName), "utf8");
const magaluPublicRoutes = () => fs.readFileSync(path.join(root, "apps", "seller-magalu", "src", "routes", "public.routes.js"), "utf8");

test("Gateway owns Magalu public pages and protected entry while seller-magalu owns OAuth callback", () => {
  const source = gateway();

  for (const route of [
    '"/seller/magalu"',
    '"/seller/magalu/termos"',
    '"/seller/magalu/privacidade"',
    '"/go/magalu"',
  ]) {
    assert.ok(source.includes(route), route);
  }
  assert.doesNotMatch(source, /magalu_oauth_not_configured/);
  assert.doesNotMatch(source, /app\.get\("\/magalu\/auth\/callback"/);

  const productRoutes = magaluPublicRoutes();
  assert.match(productRoutes, /router\.get\("\/auth\/callback",\s*oauthController\.callback\)/);
});

test("Magalu landing presents catalog, pricing, inventory, availability, and legal links", () => {
  const source = view("landing-magalu.html");

  for (const copy of ["Catálogo", "Preços", "Estoque", "Piloto"]) {
    assert.ok(source.includes(copy), copy);
  }
  for (const href of ['href="/seller/magalu/termos"', 'href="/seller/magalu/privacidade"']) {
    assert.ok(source.includes(href), href);
  }
});

test("Magalu terms explain OAuth tokens and revocation", () => {
  const source = view("legal-magalu-terms.html");

  assert.ok(source.includes("tokens OAuth"));
  assert.ok(source.includes("revogar"));
});

test("Magalu privacy notice names webhook and catalog, pricing, and inventory data", () => {
  const source = view("legal-magalu-privacy.html");

  assert.ok(source.includes("webhooks"));
  assert.ok(source.includes("dados de catálogo, preços e estoque"));
});

test("all Seller public landings load the global menu that exposes Magalu", () => {
  for (const fileName of [
    "landing-general.html",
    "landing-mercado-livre.html",
    "landing-shopee.html",
    "landing-tracking.html",
    "landing-magalu.html",
  ]) {
    assert.match(view(fileName), /landing-experience\.js/, fileName);
  }

  const shell = fs.readFileSync(path.join(root, "public", "brand", "dachbyte", "landing-experience.js"), "utf8");
  assert.match(shell, /label: 'Magalu', href: '\/seller\/magalu', login: '\/go\/magalu'/);
});

test("Magalu public journey mounts the canonical Seller global shell", () => {
  for (const [fileName, moduleName] of [
    ["landing-magalu.html", "Magalu"],
    ["legal-magalu-terms.html", "Seller"],
    ["legal-magalu-privacy.html", "Seller"],
  ]) {
    assert.match(
      view(fileName),
      new RegExp(`<body>\\s*<div data-dx-shell="seller" data-dx-module="${moduleName}"><\\/div><script src="\\/brand\\/dachbyte\\/landing-experience\\.js`),
      fileName,
    );
  }
});
