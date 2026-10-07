"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("sidebar de Precificação oferece Margem e Calculadora, nesta ordem", () => {
  const html = read("views/app.html");
  const group = html.match(/<div class="mg-nav__children" hidden>([^\n]*data-nav-path="\/margem"[^\n]*)<\/div>/)?.[1];
  assert.ok(group);
  assert.match(group, /data-nav-path="\/margem".*data-nav-path="\/calculadora"/);
  assert.doesNotMatch(group, /data-nav-path="\/custos"/);
});

test("Margem reúne as quatro abas internas na ordem do Meli", () => {
  const html = read("views/app.html");
  const tabs = html.match(/<nav class="mg-margin-tabs"[^>]*>(.*?)<\/nav>/s)?.[1];
  assert.ok(tabs);
  assert.match(tabs, /data-margin-tab="summary".*data-margin-tab="period".*data-margin-tab="equilibrium".*data-margin-tab="costs"/s);
  assert.match(html, /data-margin-panel="costs"/);
  assert.doesNotMatch(html, /data-page="\/custos"/);
});

test("link legado de custos abre a aba interna sem perder a navegação", () => {
  const routes = read("src/routes/index.js");
  const js = read("public/js/magalu-financial.js");
  assert.match(routes, /router\.get\("\/custos"[^\n]*\/magalu\/margem\?aba=costs/);
  assert.match(js, /URLSearchParams\(location\.search\).*get\("aba"\)/);
  assert.match(js, /"summary","period","equilibrium","costs"/);
});
