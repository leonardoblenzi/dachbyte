"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("standard-login migration is in the directory enumerated by the migration runner", () => {
  const dbDirectory = path.join(__dirname, "..", "db");
  const rootMigration = path.join(dbDirectory, "011_standard_login.sql");
  const nestedMigration = path.join(dbDirectory, "migrations", "011_standard_login.sql");

  assert.equal(fs.existsSync(rootMigration), true);
  assert.equal(fs.existsSync(nestedMigration), false);
});
