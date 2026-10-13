"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("Magalu navigation uses the Meli-equivalent vocabulary and every declared route has a page", () => {
  const html = read("views/app.html");
  const client = read("public/js/magalu-app.js");

  assert.match(html, /<strong>Precificação<\/strong>/);
  for (const pathName of ["/", "/gestao-skus", "/pedidos", "/precos", "/estoque", "/margem", "/calculadora", "/contas", "/integracoes"]) {
    assert.match(client, new RegExp(`"${pathName}"`));
    const escaped = pathName === "/" ? "\\/" : pathName.replaceAll("/", "\\/");
    assert.match(html, new RegExp(`data-page="${escaped}"`));
  }
  for (const [pathName, page] of [["/usuarios", "mg-users-page"], ["/plano", "mg-plan-page"], ["/ajuda", "mg-help-page"]]) {
    assert.match(client, new RegExp(`"${pathName}":\\s*\\{[^}]*page:\\s*"${page}"`));
  }
});
