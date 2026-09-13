const test = require("node:test");
const assert = require("node:assert/strict");

const rules = require("../public/js/logistics-center-rules");

test("exposes the browser logistics rule helpers", () => {
  assert.equal(typeof rules.normalizeKinds, "function");
  assert.equal(typeof rules.toggleTargetKind, "function");
  assert.equal(typeof rules.validateKinds, "function");
  assert.equal(typeof rules.parseMappingKinds, "function");
});

test("selecting heavy removes SPX and asks for seller", () => {
  const result = rules.toggleTargetKind(["spx"], "heavy");

  assert.deepEqual(result.targetKinds, ["heavy"]);
  assert.deepEqual(result.removedKinds, ["spx"]);
  assert.equal(result.sellerPromptRequired, true);
});

test("validates seller as required and blocks SPX with heavy", () => {
  const missingSeller = rules.validateKinds(["spx"]);
  const conflicting = rules.validateKinds(["seller", "spx", "heavy"]);

  assert.equal(missingSeller.ok, false);
  assert.equal(missingSeller.errors[0].code, "seller_required");
  assert.equal(conflicting.ok, false);
  assert.equal(conflicting.errors[0].code, "spx_heavy_conflict");
});

test("spreadsheet accepts Grande/Pesado with seller", () => {
  const parsed = rules.parseMappingKinds(
    "Entrega de Item Grande/Pesado, Logistica do vendedor",
  );

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.kinds.sort(), ["heavy", "seller"]);
});

test("spreadsheet rejects Grande/Pesado without seller", () => {
  const parsed = rules.parseMappingKinds("Grande/Pesado");

  assert.equal(parsed.ok, false);
  assert.equal(parsed.errors[0].code, "seller_required");
});
