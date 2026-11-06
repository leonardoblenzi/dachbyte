"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const shell = require("../../shared/seller-ui/seller-shell");

const css = fs.readFileSync(path.join(__dirname, "../../shared/seller-ui/seller-shell.css"), "utf8");

test("item ativo do menu é o caminho mais específico", () => {
  const groups = [
    { id: "overview", label: "Visão geral", items: [{ label: "Painel", path: "/hub/" }] },
    { id: "catalog", label: "Catálogo", items: [{ label: "Produtos", path: "/hub/catalogo" }, { label: "Pendências", path: "/hub/pendencias" }] },
  ];
  assert.equal(shell._test.findActive(groups, "/hub/pendencias").item.label, "Pendências");
  assert.equal(shell._test.findActive(groups, "/hub/catalogo/123").item.label, "Produtos");
  assert.equal(shell._test.findActive(groups, "/hub").item.label, "Painel");
  assert.equal(shell._test.findActive(groups, "/outro"), null);
});

test("escape de texto evita HTML injetado no menu", () => {
  assert.equal(shell._test.esc('<b>"x"</b>'), "&lt;b&gt;&quot;x&quot;&lt;/b&gt;");
});

test("tema Violeta define as cores de marca no claro e no escuro", () => {
  assert.match(css, /:root\[data-seller-theme="violet"\]\{[^}]*--seller-brand-500: #7550e3/);
  assert.match(css, /:root\[data-seller-theme="violet"\]\[data-theme="dark"\]\{[^}]*--seller-brand-500: #9c82f5/);
  assert.match(css, /--seller-accent: #22c7a9/);
});

test("padrão ML: gaveta no celular, menu recolhível e barra compacta com menu mais", () => {
  assert.match(css, /body\.seller-shell-mobile-open \.seller-shell__sidebar\{ transform: translateX\(0\); \}/);
  assert.match(css, /body\.seller-shell-collapsed \.seller-shell\{ grid-template-columns: var\(--seller-sidebar-collapsed-width\)/);
  assert.match(css, /body\.seller-shell-more-open \.seller-shell__actions\{ display: grid; \}/);
  assert.match(css, /\.seller-shell__link\.is-active::after/);
});
