"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");

test("Magalu shell exposes one loading overlay for every API request", () => {
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
