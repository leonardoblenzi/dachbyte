"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

test("compra de creditos comeca oculta e permanece oculta para conta ilimitada", () => {
  const html = fs.readFileSync(path.join(root, "views/conta-creditos.html"), "utf8");
  const js = fs.readFileSync(path.join(root, "public/js/conta-creditos.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "public/css/conta-creditos.css"), "utf8");

  assert.match(html, /id="credits-topup-panel" hidden/);
  assert.match(js, /topupPanel\.hidden = unlimited/);
  assert.match(js, /resource\.consumption_model === "unlimited"/);
  assert.match(css, /#credits-topup-panel\[hidden\]\s*\{\s*display:\s*none/);
});
