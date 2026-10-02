"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { _test } = require("../services/mlHeavyOperationGovernor");

test("heavy operation governor creates stable account-scoped keys", () => {
  const first = _test.lockKey("123456");
  const second = _test.lockKey("123456");
  const other = _test.lockKey("654321");

  assert.equal(first, second);
  assert.notEqual(first, other);
  assert.match(first, /^ml:heavy-operation:lock:[a-f0-9]{40}$/);
  assert.match(_test.metaKey("123456"), /^ml:heavy-operation:meta:[a-f0-9]{40}$/);
});

test("heavy operation governor rejects missing or default account", () => {
  assert.throws(() => _test.normalizeAccountKey(""), /heavy_operation_account_required/);
  assert.throws(() => _test.normalizeAccountKey("default"), /heavy_operation_account_required/);
  assert.equal(_test.normalizeAccountKey("  123  "), "123");
});
