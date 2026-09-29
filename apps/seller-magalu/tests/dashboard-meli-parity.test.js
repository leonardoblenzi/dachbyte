"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("dashboard supports safe periods, comparison and local actionable priorities", () => {
  const controller = read("src/controllers/dashboardController.js");
  assert.match(controller, /PERIODS/);
  assert.match(controller, /comparison/);
  assert.match(controller, /priorities/);
  assert.match(controller, /margin_coverage/);
  assert.doesNotMatch(controller, /ads_cost|ads_revenue|roas/i);
});

test("dashboard UI follows the Meli decision hierarchy without invented Ads metrics", () => {
  const html = read("views/app.html");
  assert.match(html, /id="mg-dashboard-period"/);
  assert.match(html, /id="mg-dashboard-priorities"/);
  assert.match(html, /Comercial e resultado/);
  assert.match(html, /Sinais operacionais/);
  assert.match(html, /Integração de Ads pendente/);
  assert.doesNotMatch(html, /ROAS médio|Investimento Ads|Receita Ads/);
});
