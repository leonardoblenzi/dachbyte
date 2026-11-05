"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("todas as telas usam o cabeçalho canônico no padrão compacto da Margem de venda", () => {
  const html = read("views/app.html"), account = read("public/js/magalu-account.js"), css = read("public/css/magalu-canonical-ui.css");
  assert.doesNotMatch(html, /class="mg-page-head"/);
  assert.doesNotMatch(account, /class="mg-page-head"/);
  assert.match(css, /\.mg-ui-hero h1, \.mg-ui-hero__title \{[^}]*font: 800 22px\/1\.04/);
  assert.match(css, /padding: 15px 20px;/);
  assert.match(css, /\.mg-page-head\.mg-ui-hero \{[^}]*padding: 15px 20px!important/);
});

test("telas compartilham a geometria, campos e abas da Margem nos dois temas", () => {
  const css = read("public/css/magalu-canonical-ui.css");
  assert.match(css, /\.mg-content > section\[data-page\] \{ width: calc\(100% - 40px\); margin-top: 26px; \}/);
  assert.match(css, /min-height: 38px; font-size: 11px; border-radius: 10px;/);
  assert.match(css, /\.mg-workspace-nav \{[^}]*border-radius: 18px; background: var\(--mg-surface, var\(--mg-ui-surface\)\)/);
  assert.match(css, /\.mg-app\[data-theme="dark"\]/);
});

test("Estoque mostra cabeçalho, depois abas e filtros em card, como a Margem", () => {
  const html = read("views/app.html");
  const stock = html.slice(html.indexOf('id="mg-stock-page"'), html.indexOf('data-stock-panel="update"'));
  assert.ok(stock.indexOf("mg-ui-hero") < stock.indexOf("mg-workspace-nav"));
  assert.match(stock, /class="mg-analysis-toolbar mg-ui-filter-card"/);
  assert.match(read("public/js/magalu-stock-price.js"), /page\.dataset\.workspace=name/);
});
