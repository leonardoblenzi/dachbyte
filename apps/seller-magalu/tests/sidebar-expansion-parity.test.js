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

test("botão de menu móvel não aparece sem função no desktop", () => {
  const parity = css("magalu-ml-parity.css");
  assert.match(parity, /\.mg-menu-btn\s*\{\s*display\s*:\s*none\s*!important/);
  assert.match(parity, /@media\s*\(max-width\s*:\s*900px\)[\s\S]*?\.mg-menu-btn\s*\{\s*display\s*:\s*inline-grid\s*!important/);
});

test("sidebar desktop permanece na janela e conteúdo acompanha a largura recolhida", () => {
  const parity = css("magalu-ml-parity.css");
  assert.match(parity, /@media\s*\(min-width\s*:\s*901px\)\s*\{[^}]*\.mg-sidebar\s*\{[^}]*position\s*:\s*fixed\s*!important/);
  assert.match(parity, /\.mg-main\s*\{[^}]*grid-column\s*:\s*2\s*!important/);
  assert.match(parity, /body\.mg-shell-collapsed\s+\.mg-sidebar\s*\{[^}]*width\s*:\s*var\(--mg-shell-sidebar-collapsed-width\)/);
});

test("mudança de largura alterna entre barra recolhida e menu móvel", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "js", "magalu-app.js"), "utf8");
  assert.match(app, /function syncSidebarViewport\(/);
  assert.match(app, /window\.addEventListener\("resize",\s*syncSidebarViewport\)/);
  assert.match(app, /desktop\s*&&\s*readJsonStorage\(STORAGE_COLLAPSED, false\)/);
});
