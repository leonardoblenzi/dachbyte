"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");

test("Magalu shell exposes one loading overlay for interactive API requests", () => {
  const html = fs.readFileSync(path.join(root, "views", "app.html"), "utf8");
  const app = fs.readFileSync(path.join(root, "public", "js", "magalu-app.js"), "utf8");
  const loader = fs.readFileSync(path.join(root, "public", "js", "magalu-loading.js"), "utf8");
  assert.match(html, /magalu-loading\.css/);
  assert.match(html, /magalu-loading\.js[\s\S]*magalu-app\.js/);
  assert.match(app, /MagaluLoadingOverlay\?\.show/);
  assert.match(app, /MagaluLoadingOverlay\?\.hide/);
  assert.match(loader, /window\.MagaluLoadingOverlay/);
  assert.match(loader, /Carregando dados da conta Magalu/);
});

test("catalog sync polling stays inline instead of reopening the global loader", () => {
  const app = fs.readFileSync(path.join(root, "public", "js", "magalu-app.js"), "utf8");
  assert.match(app, /syncStarting/);
  assert.match(app, /fetchJson\(`\/magalu\/api\/catalog\/status\?account_id=\$\{accountId\}`,\s*\{\s*loading:\s*["']none["']\s*\}\)/);
  assert.match(app, /already_running/);
});
