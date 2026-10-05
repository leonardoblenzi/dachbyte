"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const shellJs = fs.readFileSync(path.join(root, "public/js/ml-shell.js"), "utf8");
const shellCss = fs.readFileSync(path.join(root, "public/css/ml-shell.css"), "utf8");
const baseJs = fs.readFileSync(path.join(root, "public/js/ml-base.js"), "utf8");

const CREDIT_NAV_IDS = [
  "consulta-anuncios",
  "estoque-alerta",
  "excluir-massa",
  "modelo-massa",
  "caracteristicas",
  "validar-dimensoes",
  "prazo-producao",
  "atacado",
  "central-promocoes",
  "remover-promocoes",
  "financeiro-margem-ml",
];

const FREE_NAV_IDS = [
  "cadastro-anuncios",
  "publicidade",
  "ranking-anuncios",
  "curva-abc",
  "analise-mercado",
  "logistica",
];

function navEntry(id) {
  const marker = '{ id: "' + id + '"';
  const line = shellJs.split("\n").find((value) => value.includes(marker));
  assert.ok(line, "nav entry ausente: " + id);
  return line;
}

test("navbar marca somente areas que possuem operacoes com creditos", () => {
  for (const id of CREDIT_NAV_IDS) {
    assert.ok(
      navEntry(id).includes("credits: true"),
      "credit marker ausente: " + id,
    );
  }

  for (const id of FREE_NAV_IDS) {
    assert.equal(
      navEntry(id).includes("credits: true"),
      false,
      "area gratuita marcada: " + id,
    );
  }
});

test("marker usa SVG minimalista e tooltip explicativo", () => {
  assert.ok(shellJs.includes("coins:"));
  assert.ok(shellJs.includes('class="ml-shell__credit-marker"'));
  assert.ok(shellJs.includes("Esta área possui ações que consomem créditos"));
  assert.ok(shellJs.includes('data-consumes-credits="true"'));
});

test("CSS mantem marker pequeno, dourado e compativel com tema escuro", () => {
  assert.ok(shellCss.includes(".ml-shell__credit-marker{"));
  assert.ok(shellCss.includes("width: 16px"));
  assert.ok(shellCss.includes("height: 16px"));
  assert.ok(shellCss.includes("color: #b88712"));
  assert.ok(shellCss.includes("body.theme-dark .ml-shell__credit-marker"));
});

test("assets do shell recebem cache bust apos marker de creditos", () => {
  assert.ok(baseJs.includes("/css/ml-shell.css?v=29"));
  assert.ok(baseJs.includes("/js/ml-shell.js?v=37"));
});
