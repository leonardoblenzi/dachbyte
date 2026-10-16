"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const gateway = fs.readFileSync(path.join(root, "apps", "gateway", "server.js"), "utf8");
const auth = fs.readFileSync(path.join(root, "routes", "suiteAuthRoutes.js"), "utf8");
const portal = fs.readFileSync(path.join(root, "apps", "seller-ml", "views", "selecao-plataforma.html"), "utf8");

test("gateway exposes authenticated Seller portal endpoints", () => {
  assert.match(gateway, /\/api\/portal\/overview/);
  assert.match(gateway, /\/api\/portal\/checkout/);
  assert.match(gateway, /\/api\/portal\/renewal-intent/);
  assert.match(gateway, /readSuitePayload\(req\)/);
});

test("suite authentication tries identity-level portal login before module fallback", () => {
  assert.match(auth, /\/v1\/internal\/portal\/auth\/verify/);
  assert.match(auth, /\/v1\/internal\/portal\/overview/);
});

test("platform selection is a navigable SaaS shell instead of a hidden-card selector", () => {
  for (const view of ["home", "modules", "accounts", "plans", "company"]) {
    assert.match(portal, new RegExp('data-view(?:-target)?="' + view + '"'));
  }
  assert.match(portal, /Meus módulos/);
  assert.match(portal, /Explore outros módulos/);
  assert.match(portal, /Contas vinculadas/);
  assert.match(portal, /Planos e cobrança/);
  assert.match(portal, /\/api\/portal\/overview/);
  assert.match(portal, /data-activate-resource/);
  assert.match(portal, /Contratar plano/);
  assert.doesNotMatch(portal, /class="module-card"[^>]+data-module=/);
});
