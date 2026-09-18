"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("DACH Ads uses its own shell while preserving the Seller interaction pattern", () => {
  const html = read("apps/ads/public/app.html");
  const css = read("apps/ads/public/ads-shell.css");
  const js = read("apps/ads/public/ads-shell.js");

  assert.match(html, /data-dachbyte-line="ads"/);
  assert.match(html, /ads-shell__sidebar/);
  assert.match(html, /ads-shell__topbar/);
  assert.match(html, /id="ads-theme-toggle"/);
  assert.match(css, /font-family: "Manrope"/);
  assert.match(css, /body\.theme-dark\.ads-shell-ready/);
  assert.match(css, /--ads-brand: #7567f2/);
  assert.match(js, /dach_ads_theme_mode/);
  assert.match(js, /White Mode/);
  assert.doesNotMatch(html, /ml-shell__/);
});

test("canonical DACHBYTE tokens know the Ads product line", () => {
  const tokens = read("public/brand/dachbyte/tokens.css");
  const theme = read("public/brand/dachbyte/theme.css");
  assert.match(tokens, /data-dachbyte-line="ads"/);
  assert.match(theme, /data-dachbyte-app="ads"/);
});
