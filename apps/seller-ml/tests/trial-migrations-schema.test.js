"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("trial migrations target the ML schema without relying on the runner search path", () => {
  const migrationDir = path.join(__dirname, "..", "db");
  const oauth = readFileSync(path.join(migrationDir, "078_public_seller_onboarding.sql"), "utf8");
  const measurement = readFileSync(path.join(migrationDir, "079_ml_closed_month_order_measurements.sql"), "utf8");

  assert.match(oauth, /CREATE TABLE IF NOT EXISTS ml\.public_trial_oauth_sessions\b/);
  for (const table of ["empresas", "usuarios", "meli_contas"]) {
    assert.match(oauth, new RegExp(`REFERENCES ml\\.${table}\\(id\\)`));
  }
  assert.match(oauth, /ON ml\.public_trial_oauth_sessions\b/);

  assert.match(measurement, /CREATE TABLE IF NOT EXISTS ml\.ml_closed_month_order_measurements\b/);
  assert.match(measurement, /REFERENCES ml\.meli_contas\(id\)/);
  assert.match(measurement, /ON ml\.ml_closed_month_order_measurements\b/);
});
