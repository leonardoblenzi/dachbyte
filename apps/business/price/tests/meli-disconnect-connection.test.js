"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "integrations.routes.js"), "utf8");

test("disconnect ML usa connectionId parametrizado quando informado", () => {
  assert.match(source, /const connectionId=String\(req\.body\?\.connectionId\|\|""\)\|\|null/);
  assert.match(source, /WHERE channel=\$1 AND id=\$2/);
  assert.match(source, /\[channel,connectionId\]/);
});
