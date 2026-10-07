"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("Margem mantém a nota entre hero e filtros, como na hierarquia do ML", () => {
  const html = read("views/app.html");
  const margin = html.slice(html.indexOf('id="mg-financial-margin-page"'), html.indexOf('id="mg-financial-calculator-page"'));
  assert.match(margin, /mg-rich-hero mg-ui-hero[\s\S]*?mg-margin-context-note[\s\S]*?mg-margin-filter-card[\s\S]*?mg-margin-tabs/);
  assert.match(margin, /mg-margin-filter-note/);
});

test("CSS dedicado preserva a grade compacta sem deslocar o stylesheet canônico", () => {
  const html = read("views/app.html");
  assert.match(html, /magalu-margin-parity\.css[\s\S]*?magalu-canonical-ui\.css/);
  const css = read("public/css/magalu-margin-parity.css");
  assert.match(css, /\.mg-financial-page\s*\{/);
  assert.match(css, /\.mg-financial-page \.mg-margin-filters\s*\{[^}]*grid-template-columns:\s*repeat\(11,/s);
  assert.match(css, /#mg-financial-margin-page \.mg-ui-hero h1\s*\{[^}]*font-size:\s*22px/s);
  assert.match(css, /@media\s*\(max-width:\s*1280px\)/);
});
