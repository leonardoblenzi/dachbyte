"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");
const gateway = () => fs.readFileSync(path.join(root, "apps", "gateway", "server.js"), "utf8");
const view = (fileName) => fs.readFileSync(path.join(root, "apps", "seller-ml", "views", fileName), "utf8");

test("gateway publishes the public Magalu landing, legal, and OAuth callback routes without a client secret", () => {
  const source = gateway();

  for (const route of [
    '"/seller/magalu"',
    '"/seller/magalu/termos"',
    '"/seller/magalu/privacidade"',
    '"/magalu/auth/callback"',
  ]) {
    assert.ok(source.includes(route), route);
  }
  assert.ok(source.includes("magalu_oauth_not_configured"));
  assert.doesNotMatch(source, /MAGALU_CLIENT_SECRET/);
});

test("Magalu landing presents catalog, pricing, inventory, availability, and legal links", () => {
  const source = view("landing-magalu.html");

  for (const copy of ["Catálogo", "Preços", "Estoque", "Em breve"]) {
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

test("all Seller public landings link to the Magalu landing", () => {
  for (const fileName of [
    "landing-general.html",
    "landing-mercado-livre.html",
    "landing-shopee.html",
    "landing-tracking.html",
    "landing-magalu.html",
  ]) {
    assert.ok(view(fileName).includes('href="/seller/magalu"'), fileName);
  }
});

test("Magalu public journey mounts the canonical Seller global shell", () => {
  for (const fileName of [
    "landing-magalu.html",
    "legal-magalu-terms.html",
    "legal-magalu-privacy.html",
  ]) {
    assert.match(
      view(fileName),
      /<body>\s*<div data-dx-shell="seller" data-dx-module="Seller"><\/div>/,
      fileName,
    );
  }
});
