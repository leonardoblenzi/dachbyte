"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "apps", "seller-ml", "views", "selecao-plataforma.html"), "utf8");

test("Sair e Suporte ficam acessiveis em qualquer largura pelo menu do usuario", () => {
  assert.match(source, /id="user-menu-button"[^>]*aria-haspopup="menu"/);
  assert.match(source, /id="user-menu-logout"/);
  assert.match(source, /\$\("#user-menu-logout"\)\.addEventListener\("click",logout\)/);
  assert.match(source, /id="user-menu-support"/);
  assert.doesNotMatch(source, /davanttisuite\.com\.br/, "suporte nao aponta para o dominio antigo");
});

test("menu lateral recolhido mostra rotulos em vez de esconder o texto", () => {
  const collapsed = source.slice(source.indexOf("@media(max-width:1120px)"));
  assert.doesNotMatch(collapsed.slice(0, 600), /\.nav__item\{[^}]*font-size:0/);
});

test("papel aparece em portugues e contagens respeitam singular e plural", () => {
  assert.match(source, /operator:"Operador"/);
  assert.match(source, /\$\("#user-role"\)\.textContent=roleLabel\(o\.user\?\.role\)/);
  assert.match(source, /countLabel\(module\.accounts\?\.total,"conta","contas"\)/);
});

test("acoes de cobranca so aparecem para quem gerencia a cobranca", () => {
  assert.match(source, /function canBill\(\)\{ return state\.overview\?\.user\?\.can_manage_billing===true; \}/);
  assert.match(source, /const manage=canBill\(\)\?/);
  assert.match(source, /\$\("#renew-selected"\)\.hidden=!canBill\(\)/);
  assert.match(source, /if\(!canBill\(\)\)\{ state\.invoices=\[\]/, "sem permissao nao consulta faturas");
  assert.match(source, /As faturas ficam visíveis apenas para quem gerencia a cobrança/);
});
