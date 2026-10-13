"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("financial sync is a protected explicit action after filtering", () => {
  const routes = read("src/routes/uxAnalytics.routes.js");
  const controller = read("src/controllers/uxAnalyticsController.js");
  const client = read("public/js/magalu-financial.js");
  assert.match(routes, /router\.post\("\/margins\/sync",controller\.syncMargins\)/);
  assert.match(controller, /const a=await accountFor\(req\)/);
  assert.match(client, /margins\/sync/);
  assert.match(client, /method:"POST"/);
});
