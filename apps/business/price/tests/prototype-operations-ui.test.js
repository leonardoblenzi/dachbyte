"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

function read(relative) {
  return fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
}

const source = read("public/app.js");
const reconciliation = read("public/orders-reconciliation.js");

test("operations renderers use the shared prototype presentation contracts", () => {
  assert.match(source, /async function dashboard[\s\S]*?class="pagehead"/);
  assert.match(source, /async function dashboard[\s\S]*?class="grid kpis"/);
  assert.match(source, /async function dashboard[\s\S]*?class="card section"/);
  assert.match(source, /async function orders[\s\S]*?class="toolbar"/);
  assert.match(source, /async function orders[\s\S]*?class="filter"/);
  assert.match(source, /async function orders[\s\S]*?class="table"/);
  assert.match(source, /async function commissions[\s\S]*?class="pagehead"/);
  assert.match(source, /async function commissions[\s\S]*?class="card section"/);
  assert.match(source, /async function commissions[\s\S]*?class="filter"/);
  assert.match(source, /async function integrations[\s\S]*?class="card section"/);
  assert.match(source, /async function integrations[\s\S]*?class:"metric-row integration"/);
});

test("operations pages retain manual actions and never schedule Tray sync", () => {
  for (const contract of [
    "/dashboard/",
    "/orders/?",
    "/orders/sync/tray",
    "data-hydrate",
    "data-link",
    "data-profit",
    "data-fee-meli",
    "data-fee-shopee",
    "/integrations/",
    "/integrations/tray/connect",
    "/integrations/meli/connect",
    "/integrations/shopee/connect",
    "data-refresh",
    "data-disconnect",
    "/commissions/",
  ]) {
    assert.ok(source.includes(contract), `missing existing operation: ${contract}`);
  }
  assert.match(reconciliation, /#syncTray/);
  assert.match(reconciliation, /#unmatchedOrders/);
  assert.match(reconciliation, /\/orders\/sync\/status/);
  assert.doesNotMatch(source, /setInterval\([\s\S]*sync\/tray/);
  assert.doesNotMatch(reconciliation, /setInterval\([\s\S]*sync\/tray/);
});

test("integration chip color follows the authoritative connection status", () => {
  assert.match(source, /const statusClasses=\{connected:"green",expiring:"amber",reauthorization_required:"amber",error:"red",revoked:"red",disconnected:"blue"\}/);
  assert.match(source, /const status=statusClasses\[conn\?\.connection_status\]\|\|"blue"/);
  assert.doesNotMatch(source, /const status=conn\?\.last_error\?"red":conn\?"green":"amber"/);
});
