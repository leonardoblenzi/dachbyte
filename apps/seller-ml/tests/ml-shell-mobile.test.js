"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const shellJs = fs.readFileSync(path.join(root, "public/js/ml-shell.js"), "utf8");
const shellCss = fs.readFileSync(path.join(root, "public/css/ml-shell.css"), "utf8");
const jobsPanel = fs.readFileSync(path.join(root, "public/js/jobs-panel.js"), "utf8");

test("topbar no celular: acoes secundarias ficam no menu 'mais'", () => {
  const more = shellJs.slice(shellJs.indexOf('id="shell-topbar-more"'), shellJs.indexOf('id="shell-alerts"'));
  for (const id of ["btn-credits-wallet", "btn-theme-toggle", "btn-status", "btn-help", "btn-logout-account"]) {
    assert.ok(more.includes(`id="${id}"`), `${id} dentro do menu mais`);
  }
  assert.match(shellJs, /id="btn-topbar-more"[^>]*aria-controls="shell-topbar-more"/);
  assert.match(shellJs, /body\.classList\.toggle\("ml-shell-more-open", open\)/);
  assert.match(shellJs, /event\.key !== "Escape"/);
});

test("no desktop o menu 'mais' nao muda a barra", () => {
  assert.match(shellCss, /\.ml-shell__topbar-more\{display:contents\}/);
  assert.match(shellCss, /\.ml-shell__more-toggle,\s*\.ml-shell__more-label\{display:none\}/);
});

test("celular: barra compacta, icone do menu visivel e telas sem estourar a largura", () => {
  const mobile = shellCss.slice(shellCss.indexOf("MOBILE — topbar compacta"));
  assert.match(mobile, /\.ml-shell__mobile-toggle > svg[\s\S]*?width:20px;height:20px/);
  assert.match(mobile, /body\.ml-shell-more-open \.ml-shell__topbar-more\{display:grid\}/);
  assert.match(mobile, /\.promo-module-view[\s\S]*?grid-template-columns:minmax\(0,1fr\)!important/);
  assert.match(mobile, /\.car-search-wrap\{min-width:0;width:100%\}/);
  assert.match(mobile, /:is\(main, \.page-wrap, \.ads-page, \.ac-page, \.wrap, \.promo-remove-page\)/, "sem o espaco vazio de 76px no topo");
});

test("painel de processos abre minimizado no celular", () => {
  assert.match(jobsPanel, /let collapsed = typeof window !== "undefined" && window\.matchMedia\?\.\("\(max-width: 760px\)"\)\.matches === true;/);
});
