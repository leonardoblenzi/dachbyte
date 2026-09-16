"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { validateProductionEnvironment } = require("../../../scripts/preflight");

const strongSecret = "a-strong-secret-with-more-than-32-characters";

test("production runtime preflight requires app database and JWT but not migration credential", () => {
  const result = validateProductionEnvironment({ NODE_ENV: "production", HUB_LOGIN_MODE: "disabled" });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.includes("VOLT_CORE_APP_DATABASE_URL")));
  assert.ok(result.errors.some((item) => item.includes("VOLT_CORE_JWT_SECRET")));
  assert.equal(result.errors.some((item) => item.includes("VOLT_CORE_DIRECT_DATABASE_URL")), false);
});

test("production runtime accepts app-only database credential", () => {
  const result = validateProductionEnvironment({
    NODE_ENV: "production",
    VOLT_CORE_APP_DATABASE_URL: "postgres://volt_core_app:app-secret@example.invalid/volt",
    VOLT_CORE_JWT_SECRET: strongSecret,
    HUB_LOGIN_MODE: "disabled",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("production preflight accepts separate app NOBYPASS role URL and owner migration URL", () => {
  const result = validateProductionEnvironment({
    NODE_ENV: "production",
    VOLT_CORE_APP_DATABASE_URL: "postgres://volt_core_app:app-secret@example.invalid/volt",
    VOLT_CORE_DIRECT_DATABASE_URL: "postgres://neondb_owner:owner-secret@example.invalid/volt",
    VOLT_CORE_JWT_SECRET: strongSecret,
    HUB_LOGIN_MODE: "disabled",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("production preflight rejects using the owner role as the application role", () => {
  const result = validateProductionEnvironment({
    NODE_ENV: "production",
    VOLT_CORE_APP_DATABASE_URL: "postgres://neondb_owner:app-secret@example.invalid/volt",
    VOLT_CORE_DIRECT_DATABASE_URL: "postgres://neondb_owner:owner-secret@example.invalid/volt",
    VOLT_CORE_JWT_SECRET: strongSecret,
    HUB_LOGIN_MODE: "disabled",
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.includes("role da aplicacao deve ser diferente")));
});

test("development preflight keeps legacy database URL compatibility", () => {
  const result = validateProductionEnvironment({
    VOLT_CORE_DATABASE_URL: "postgres://example.invalid/volt",
    VOLT_CORE_JWT_SECRET: strongSecret,
    HUB_LOGIN_MODE: "disabled",
  });
  assert.equal(result.ok, true);
});

test("production preflight requires Hub credentials when Hub login is enabled", () => {
  const result = validateProductionEnvironment({
    NODE_ENV: "production",
    VOLT_CORE_APP_DATABASE_URL: "postgres://volt_core_app:app-secret@example.invalid/volt",
    VOLT_CORE_DIRECT_DATABASE_URL: "postgres://neondb_owner:owner-secret@example.invalid/volt",
    VOLT_CORE_JWT_SECRET: strongSecret,
    HUB_LOGIN_MODE: "fallback",
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.includes("HUB_BASE_URL")));
  assert.ok(result.errors.some((item) => item.includes("HUB_INTERNAL_TOKEN")));
});

test("production preflight rejects placeholder secrets", () => {
  const result = validateProductionEnvironment({
    NODE_ENV: "production",
    VOLT_CORE_APP_DATABASE_URL: "postgres://volt_core_app:app-secret@example.invalid/volt",
    VOLT_CORE_DIRECT_DATABASE_URL: "postgres://neondb_owner:owner-secret@example.invalid/volt",
    VOLT_CORE_JWT_SECRET: "change-me",
    HUB_LOGIN_MODE: "disabled",
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.includes("placeholder")));
});
