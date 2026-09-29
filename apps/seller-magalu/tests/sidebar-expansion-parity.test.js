"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const css = (file) => fs.readFileSync(path.join(__dirname, "..", "public", "css", file), "utf8");

test("submenu aberto do Magalu ocupa a largura interna do grupo, como no ML", () => {
  const base = css("magalu-app.css");
  const parity = css("magalu-ml-parity.css");

  assert.doesNotMatch(base, /\.mg-nav__children\s*\{[^}]*padding\s*:\s*[^;}]*44px/);
  assert.match(parity, /\.mg-nav__children\s*\{[^}]*padding-inline\s*:\s*0\s*!important/);
  assert.match(parity, /\.mg-nav__item\s*\{[^}]*min-height\s*:\s*42px/);
});
