"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const appSource = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
const usersSource = fs.readFileSync(path.join(__dirname, "..", "public", "users.js"), "utf8");
const masterUsersSource = appSource.slice(
  appSource.indexOf("async function masterTenantUsers"),
  appSource.lastIndexOf("async function admin"),
);
const adminSource = appSource.slice(
  appSource.lastIndexOf("async function admin"),
  appSource.indexOf("async function modulePage"),
);

test("Admin Master and selected-company users use the prototype administration presentation", () => {
  assert.match(adminSource, /class="pagehead"/);
  assert.match(masterUsersSource, /class="card section"/);
  assert.match(usersSource, /class="table"/);
  assert.match(adminSource, /data-manage-users/);
});

test("administration presentation preserves temporary-password safety", () => {
  assert.match(masterUsersSource, /Redefinir a senha tempor.ria encerrar. as sess.es atuais/);
  assert.doesNotMatch(appSource, /temporaryPassword[^\n]*toast/i);
});
