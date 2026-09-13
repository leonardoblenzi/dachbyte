"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildConfiguration } = require("./templateEngine");
const { getTemplateBySegment } = require("./templates");
const { __test: persistentTest } = require("./persistentCoreService");
const { registerBuiltInExtensions } = require("../../extensions/registerBuiltIns");
const {
  hasCapability,
  isPermissionEnabled,
  resolveCapabilities,
  withEffectiveConfiguration,
} = require("./capabilities/capabilityResolver");

registerBuiltInExtensions();

function configuration(segmentKey = "general", overrides = {}) {
  const base = buildConfiguration({
    companyId: "company-platform",
    planKey: "starter",
    requestedBy: "test",
    template: getTemplateBySegment(segmentKey),
  });
  return withEffectiveConfiguration({ ...base, overrides: { ...base.overrides, ...overrides } });
}

test("general template exposes Volt Core without forcing a vertical or paid service", () => {
  const config = configuration("general");
  assert.ok(config.modules.includes("finance"));
  assert.ok(!config.modules.includes("fiscal"));
  assert.ok(config.screens.includes("finance"));
  assert.ok(config.screens.includes("services"));
  assert.ok(!config.screens.includes("fiscal"));
  assert.ok(!config.capabilities.some((item) => item.startsWith("optical.")));
  assert.ok(config.capabilities.includes("services.catalog"));
  assert.ok(config.availableModules.some((module) => module.key === "sales"));
  assert.ok(config.availableScreens.some((screen) => screen.key === "services"));
});

test("optical template resolves the vertical as capabilities plus shared dependencies", () => {
  const config = configuration("optical");
  assert.equal(hasCapability(config, "optical.prescriptions"), true);
  assert.equal(hasCapability(config, "optical.orders"), true);
  assert.equal(hasCapability(config, "optical.sales_pdv"), true);
  assert.ok(config.modules.includes("service_orders"));
  assert.ok(config.modules.includes("sales"));
});

test("module overrides are effective and remove invalid dependent modules and screens", () => {
  const config = configuration("optical", { disabledModules: ["sales"] });
  assert.equal(config.modules.includes("sales"), false);
  assert.equal(config.modules.includes("optical_prescriptions"), false);
  assert.equal(config.modules.includes("payments"), false);
  assert.equal(config.screens.includes("sales"), false);
  assert.equal(config.screens.includes("optical_prescriptions"), false);
});

test("commercially owned modules cannot be enabled through a generic module override", () => {
  const base = configuration("general");
  const resolved = resolveCapabilities({
    ...base,
    modules: ["companies", "users"],
    overrides: { ...base.overrides, enabledModules: ["optical_prescriptions"] },
  });
  assert.ok(!resolved.modules.includes("optical_prescriptions"));
  assert.ok(!resolved.capabilities.includes("optical.orders"));
});

test("commercial product state is authoritative over generic module overrides", () => {
  const active = configuration("optical", { disabledModules: ["optical_prescriptions"] });
  assert.equal(isPermissionEnabled(active, "optical_prescriptions:read"), true);

  const suspendedCommercial = {
    ...active.commercial,
    products: active.commercial.products.map((product) => (
      product.key === "vertical.optical" ? { ...product, status: "suspended", active: false, accessible: false } : product
    )),
  };
  const suspended = withEffectiveConfiguration({ ...active, commercial: suspendedCommercial });
  assert.equal(isPermissionEnabled(suspended, "optical_prescriptions:read"), false);
  assert.equal(isPermissionEnabled(suspended, "customers:read"), true);
});


test("sale idempotency fingerprint is stable and ignores transport metadata", () => {
  const base = {
    idempotencyKey: "sale-123",
    actorUserId: "user-a",
    customerId: "customer-1",
    items: [{ productId: "product-1", quantity: 1 }],
    payments: [{ method: "pix", amount: 100 }],
  };
  const replay = {
    payments: [{ amount: 100, method: "pix" }],
    items: [{ quantity: 1, productId: "product-1" }],
    customerId: "customer-1",
    actorUserId: "user-b",
    idempotencyKey: "different-transport-key",
  };
  assert.equal(persistentTest.saleIdempotencyFingerprint(base), persistentTest.saleIdempotencyFingerprint(replay));
  assert.notEqual(
    persistentTest.saleIdempotencyFingerprint(base),
    persistentTest.saleIdempotencyFingerprint({ ...base, items: [{ productId: "product-1", quantity: 2 }] }),
  );
});
