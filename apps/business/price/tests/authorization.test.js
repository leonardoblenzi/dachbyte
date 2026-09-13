"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { hasPermission } = require("../src/permissions");
const { assertLoginAllowed, recordLoginFailure, clearLoginFailures } = require("../src/auth");
const { connectionStatus } = require("../src/integrations/tokenStore");

test("viewer e analyst nao recebem permissoes de escrita", () => {
  assert.equal(hasPermission({ role: "viewer" }, "orders.read"), true);
  assert.equal(hasPermission({ role: "viewer" }, "products.manage"), false);
  assert.equal(hasPermission({ role: "viewer" }, "cash.manage"), false);
  assert.equal(hasPermission({ role: "analyst" }, "reports.read"), true);
  assert.equal(hasPermission({ role: "analyst" }, "pricing.simulate"), true);
  assert.equal(hasPermission({ role: "analyst" }, "pricing.manage"), false);
  assert.equal(hasPermission({ role: "owner" }, "integrations.manage"), true);
});

test("rate limit conta falhas e pode ser limpo apos login valido", () => {
  const request = { ip: "203.0.113.10" };
  clearLoginFailures(request);
  assert.doesNotThrow(() => assertLoginAllowed(request));
  for (let index = 0; index < 10; index += 1) recordLoginFailure(request);
  assert.throws(
    () => assertLoginAllowed(request),
    (error) => error.code === "login_rate_limited" && error.statusCode === 429,
  );
  clearLoginFailures(request);
  assert.doesNotThrow(() => assertLoginAllowed(request));
});

test("Authorization Hub deriva estados operacionais sem expor tokens", () => {
  const now = Date.parse("2026-08-10T12:00:00Z");
  assert.equal(connectionStatus({ status: "active" }, now), "connected");
  assert.equal(connectionStatus({ status: "disconnected" }, now), "disconnected");
  assert.equal(connectionStatus({ status: "revoked" }, now), "revoked");
  assert.equal(connectionStatus({ status: "active", last_error: "refresh failed" }, now), "error");
  assert.equal(connectionStatus({
    status: "active",
    refresh_expires_at: "2026-08-10T11:59:00Z",
  }, now), "reauthorization_required");
  assert.equal(connectionStatus({
    status: "active",
    token_expires_at: "2026-08-10T12:30:00Z",
  }, now), "expiring");
  assert.equal(connectionStatus({
    status: "active",
    token_expires_at: "2026-08-10T14:00:00Z",
  }, now), "connected");
});
