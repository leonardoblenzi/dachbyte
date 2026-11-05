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
  for (const pathName of ["/", "/gestao-skus", "/pedidos", "/precos", "/estoque", "/promocoes", "/margem", "/calculadora", "/contas", "/integracoes"]) {
    assert.match(client, new RegExp(`"${pathName}"`));
    const escaped = pathName === "/" ? "\\/" : pathName.replaceAll("/", "\\/");
    assert.match(html, new RegExp(`data-page="${escaped}"`));
  }
  for (const [pathName, page] of [["/usuarios", "mg-users-page"], ["/plano", "mg-plan-page"], ["/ajuda", "mg-help-page"]]) {
    assert.match(client, new RegExp(`"${pathName}":\\s*\\{[^}]*page:\\s*"${page}"`));
  }
});

test("every Magalu frontend page is served by a backend entry route", () => {
  const client = read("public/js/magalu-app.js");
  const backend = read("src/routes/index.js");
  const declared = [...client.matchAll(/^    "(\/[^\"]*)": \{ title:/gm)].map((match) => match[1]);
  const entryRoutes = backend.match(/for \(const route of \[([^\]]+)\]\)/)?.[1] || "";
  for (const route of declared) {
    if (route === "/" || route === "/catalogo" || route === "/sincronizacao") continue;
    assert.ok(entryRoutes.includes(`"${route}"`), `${route} lacks a backend entry route`);
  }
});

test("promo pricing lives under Promoções and old URL redirects to its new entry",()=>{
  const html=read("views/app.html"),backend=read("src/routes/index.js"),client=read("public/js/magalu-app.js");
  const promotions=html.match(/<section class="mg-nav__group" data-group="promotions">([\s\S]*?)<\/section>/)?.[1]||"";
  assert.match(promotions,/data-nav-path="\/promocoes"[^>]*>Campanhas/);
  assert.doesNotMatch(promotions,/data-nav-path="\/precificacao-promocional"/);
  assert.doesNotMatch(client,/"\/precificacao-promocional": \{ title:/);
  assert.match(backend,/router\.get\("\/promocoes-em-massa"[^\n]*\/magalu\/promocoes\?aba=precificacao/);
  assert.match(backend,/router\.get\("\/precificacao-promocional"[^\n]*\/magalu\/promocoes\?aba=precificacao/);
});
