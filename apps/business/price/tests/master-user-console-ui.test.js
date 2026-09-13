"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const appSource = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

test("master user console ui selects a company and provisions with a manual temporary password", () => {
  assert.match(appSource, /data-manage-users/);
  assert.match(appSource, /masterTenantUsers/);
  assert.match(appSource, /\/admin\/tenants\/\$\{tenant\.id\}\/users/);
  assert.match(appSource, /email:\$\("#masterUserEmail"\)\.value/);
  assert.match(appSource, /fullName:\$\("#masterUserName"\)\.value/);
  assert.match(appSource, /role:\$\("#masterUserRole"\)\.value/);
  assert.match(appSource, /temporaryPassword:\$\("#masterUserPassword"\)\.value/);
  assert.match(appSource, /\$\("#masterUserPassword"\)\.value=""/);
  assert.match(appSource, /encerrar[aá] as sess[oõ]es atuais/i);
});

test("master user console ui does not restore legacy tenant provisioning or expose a temporary password", () => {
  assert.doesNotMatch(appSource, /\/api\/users["']/);
  assert.doesNotMatch(appSource, /tenantId:\$\("#masterUser/);
  assert.doesNotMatch(appSource, /state\.[^\n]*temporaryPassword/i);
  assert.doesNotMatch(appSource, /value="\$\{[^}]*temporaryPassword/);
  assert.doesNotMatch(appSource, /toast\([^)]*temporaryPassword/);
});

test("README explains the Master console's manual temporary-password workflow", () => {
  const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");

  assert.match(readme, /Console do Admin Master/);
  assert.match(readme, /Gerenciar usu[aá]rios/i);
  assert.match(readme, /senha tempor[aá]ria.*manualmente/i);
  assert.match(readme, /n[aã]o envia e-?mail automaticamente/i);
  assert.match(readme, /primeiro acesso/i);
  assert.match(readme, /encerra as sess[oõ]es/i);
});
