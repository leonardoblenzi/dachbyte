"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("legacy branding adapter exposes the platform branding object", () => {
  const platformBranding = require("../platform/branding");
  const legacyBranding = require("../lib/dachbyteBrand");

  assert.strictEqual(legacyBranding, platformBranding);
  assert.equal(platformBranding.DACHBYTE_BRAND.name, "DachByte");
  assert.equal(platformBranding.DACHBYTE_BRAND.seller, "Dach Seller");
  assert.equal(platformBranding.DACHBYTE_BRAND.products.core, "Dach Core");
  assert.equal(platformBranding.DACHBYTE_BRAND.products.stock, "Dach Stock");
  assert.equal(platformBranding.DACHBYTE_BRAND.products.chat, "Dach Chat");
  assert.equal(platformBranding.DACHBYTE_BRAND.products.price, "Dach Price");
  assert.equal(platformBranding.DACHBYTE_BRAND.products.hub, "Dach Hub");
  assert.equal(platformBranding.DACHBYTE_BRAND.products.ads, "Dach Ads");
  assert.ok(Object.isFrozen(platformBranding.DACHBYTE_BRAND));
});

test("support facade is safe to import before SAC database configuration", () => {
  const support = require("../platform/support");
  const legacyWidget = require("../lib/supportWidgetInjector");

  assert.equal(typeof support.getService, "function");
  assert.equal(typeof support.getEmailService, "function");
  assert.equal(typeof support.getDatabase, "function");
  assert.equal(typeof support.createWidgetInjector(), "function");
  assert.equal(typeof legacyWidget.createSupportWidgetInjector, "function");
});
