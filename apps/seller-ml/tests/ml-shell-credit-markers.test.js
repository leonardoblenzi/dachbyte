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
  const re = new RegExp('\\\\{ id: "' + id + '"[^\\\\n]+\\\\}');
  const match = shellJs.match(re);
  assert.ok(match, "nav entry ausente: " + id);
  return match[0];
}

test("navbar marca somente areas que possuem operacoes com creditos", () => {
  for (const id of CREDIT_NAV_IDS) {
    assert.match(navEntry(id), /credits:\\s*true/, "credit marker ausente: " + id);
  }

  for (const id of FREE_NAV_IDS) {
    assert.doesNotMatch(navEntry(id), /credits:\\s*true/, "area gratuita marcada: " + id);
  }
});

test("marker usa SVG minimalista e tooltip explicativo", () => {
  assert.match(shellJs, /coins:\\s*\\n\\s*\'<svg/);
  assert.match(shellJs, /class="ml-shell__credit-marker"/);
  assert.match(shellJs, /Esta área possui ações que consomem créditos/);
  assert.match(shellJs, /data-consumes-credits="true"/);
});

test("CSS mantem marker pequeno, dourado e compativel com tema escuro", () => {
  assert.match(shellCss, /\\.ml-shell__credit-marker\\{/);
  assert.match(shellCss, /width:\\s*16px/);
  assert.match(shellCss, /height:\\s*16px/);
  assert.match(shellCss, /color:\\s*#b88712/);
  assert.match(shellCss, /body\\.theme-dark \\.ml-shell__credit-marker/);
});

test("assets do shell recebem cache bust apos marker de creditos", () => {
  assert.match(baseJs, /ml-shell\\.css\\?v=29/);
  assert.match(baseJs, /ml-shell\\.js\\?v=37/);
});
