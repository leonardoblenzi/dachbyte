"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("dashboard supports safe periods, comparison and local actionable priorities", () => {
  const controller = read("src/controllers/dashboardController.js");
  const orders = read("src/repositories/orderRepository.js");
  const financial = read("src/repositories/financialRepository.js");
  assert.match(controller, /PERIODS/);
  assert.match(controller, /comparison/);
  assert.match(controller, /priorities/);
  assert.match(controller, /margin_coverage/);
  assert.match(orders, /Math\.min\(60,/);
  assert.match(orders, /offsetDays=0/);
  assert.match(orders, /purchased_at<now\(\)-\(\$3::int \* interval '1 day'\)/);
  assert.match(controller, /orderRepository\.stats\(account\.id,period\.days,period\.days\)/);
  assert.match(financial, /s\.is_present and p\.price is not null and c\.unit_cost is not null/);
  assert.doesNotMatch(controller, /ads_cost|ads_revenue|roas/i);
});

test("dashboard UI follows the Meli decision hierarchy without invented Ads metrics", () => {
  const html = read("views/app.html");
  const client = read("public/js/magalu-app.js");
  assert.match(html, /id="mg-dashboard-period"/);
  assert.match(html, /id="mg-dashboard-priorities"/);
  assert.match(html, /Comercial e resultado/);
  assert.match(html, /Sinais operacionais/);
  assert.match(html, /id="mg-dashboard-orders-period"/);
  assert.match(html, /id="kpi-orders-period-label"/);
  assert.match(html, /id="kpi-gmv-period-label"/);
  assert.match(client, /mg-dashboard-orders-period/);
  assert.doesNotMatch(client, /mg-dashboard-orders-7d/);
  assert.match(client, /renderDashboard\(data\)/);
  assert.match(client, /const requestId=\+\+state\.dashboardRequestId/);
  assert.match(client, /requestId !== state\.dashboardRequestId/);
  assert.match(client, /state\.dashboardPeriod !== requestedPeriod/);
  assert.doesNotMatch(client, /nos últimos 7 dias/);
  assert.match(html, /Integração de Ads pendente/);
  assert.doesNotMatch(html, /ROAS médio|Investimento Ads|Receita Ads/);
});
