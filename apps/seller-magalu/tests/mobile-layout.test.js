"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const css = fs.readFileSync(path.join(__dirname, "..", "public", "css", "magalu-canonical-ui.css"), "utf8");
const mobile = css.slice(css.indexOf("Mobile: telas cabem no celular"));

test("pedidos nao estica a pagina alem da largura do celular", () => {
  assert.ok(mobile.length > 40, "bloco mobile presente");
  assert.match(mobile, /\.mg-orders-page, \.mg-product-page \{ grid-template-columns: minmax\(0, 1fr\)!important; \}/);
});

test("filtros de margem e pedidos ficam em duas colunas no celular", () => {
  assert.match(mobile, /\.mg-margin-filters \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)!important; \}/);
  assert.match(mobile, /\.mg-orders-filters \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)!important; \}/);
  assert.match(mobile, /\.mg-orders-field :is\(input, select\), \.mg-margin-field :is\(input, select\) \{ min-width: 0!important;/);
});

test("seletor de periodo usa a linha inteira e Processos nao cobre o conteudo", () => {
  assert.match(mobile, /\.mg-page-actions > \.mg-period-selector \{ flex: 1 1 100%;/);
  assert.match(mobile, /#mg-process-toggle \{[^}]*min-height: 34px/);
  assert.match(mobile, /\.mg-content \{ padding-bottom: 72px!important; \}/);
});
