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
  assert.match(first, /^ml:heavy-operation:write:lock:[a-f0-9]{40}$/);
  assert.match(_test.metaKey("123456"), /^ml:heavy-operation:write:meta:[a-f0-9]{40}$/);
  assert.notEqual(_test.lockKey("123456", "read"), first);
  assert.match(_test.lockKey("123456", "read"), /^ml:heavy-operation:read:lock:[a-f0-9]{40}$/);
});

test("heavy operation governor rejects missing or default account", () => {
  assert.throws(() => _test.normalizeAccountKey(""), /heavy_operation_account_required/);
  assert.throws(() => _test.normalizeAccountKey("default"), /heavy_operation_account_required/);
  assert.equal(_test.normalizeAccountKey("  123  "), "123");
});


test("heavy operation governor normalizes lanes", () => {
  assert.equal(_test.normalizeLane("read"), "read");
  assert.equal(_test.normalizeLane("READ"), "read");
  assert.equal(_test.normalizeLane("write"), "write");
  assert.equal(_test.normalizeLane("anything"), "write");
});
