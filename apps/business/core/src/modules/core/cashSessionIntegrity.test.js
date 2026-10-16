"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");
const source = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("cash-session integrity locks one open session and links all ledger writers", () => {
  const migration = source("db/017_cash_session_integrity.sql");
  const cashService = source("src/modules/core/runtime/services/cashService.js");
  const salesService = source("src/modules/core/runtime/services/salesService.js");
  const financeService = source("src/modules/core/runtime/services/financeService.js");

  assert.match(migration, /create unique index.*cash_sessions.*company_id.*where status = 'open'/is);
  assert.match(cashService, /async function resolveOpenCashSessionWithClient\(client, companyId, settings = \{\}\)/);
  assert.match(cashService, /status = 'open'[\s\S]*for update/i);
  assert.match(cashService, /error\.code === "23505"[\s\S]*CASH_SESSION_ALREADY_OPEN/);
  assert.match(cashService, /from volt_core\.company_configurations/);
  assert.match(cashService, /resolveOpenCashSessionWithClient\(client, companyId, \{[\s\S]*requireOpenCashSession: rules\.rows\[0\]\?\.settings\?\.requireOpenCashSession === true/);
  assert.match(salesService, /resolveOpenCashSessionWithClient/);
  assert.match(salesService, /session_id, type, source_type/);
  assert.ok((salesService.match(/resolveOpenCashSessionWithClient\(client, companyId, operationalRules\)/g) || []).length >= 4);
  assert.match(financeService, /resolveOpenCashSessionWithClient/);
  assert.match(financeService, /session_id, type, source_type/);
});
