"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");

test("filter waits for the exact margin job before loading results", () => {
  const source = read("public/js/magalu-financial.js");
  assert.match(source, /MagaluLoadingOverlay\?\.show/);
  assert.match(source, /\/margins\/sync\/\$\{encodeURIComponent\(jobId\)\}/);
  assert.match(source, /if\s*\(status\.state\s*===\s*["']completed["']\)/);
  assert.match(source, /MagaluLoadingOverlay\?\.hide/);
});

test("loading supports indeterminate remote operations", () => {
  const source = read("public/js/magalu-loading.js");
  assert.match(source, /indeterminate/);
  assert.match(source, /mg-loading__percent/);
});

test("changing account or clearing filters invalidates an in-flight margin result", () => {
  const source = read("public/js/magalu-financial.js");
  assert.match(source, /function resetMarginFilters\(\)\{state\.marginRequest\+\+;/);
});
