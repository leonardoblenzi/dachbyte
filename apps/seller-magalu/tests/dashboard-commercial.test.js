"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("commercial dashboard has a dedicated Hub-first API endpoint", () => {
  const routes = read("src/routes/api.routes.js");
  const controller = read("src/controllers/dashboardController.js");
  assert.match(routes, /router\.get\("\/dashboard",dashboardController\.status\)/);
  assert.match(controller, /checkAccountAccess/);
  assert.match(controller, /catalogRepository\.stats/);
  assert.match(controller, /orderRepository\.stats/);
});

test("dashboard communicates actual commerce metrics and keeps Ads as an honest pending integration", () => {
  const html = read("views/app.html");
  const client = read("public/js/magalu-app.js");
  assert.match(html, /id="kpi-orders-30d"/);
  assert.match(html, /id="kpi-gmv-30d"/);
  assert.match(html, /Integração de Ads pendente/);
  assert.match(client, /\/magalu\/api\/dashboard/);
});

test("order aggregates include ticket average for the selected commercial window", () => {
  const repository = read("src/repositories/orderRepository.js");
  assert.match(repository, /ticket_average_30d/);
  assert.match(repository, /purchased_at>=now\(\)-\(\$2::int \* interval '1 day'\)/);
});
