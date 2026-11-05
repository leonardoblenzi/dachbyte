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

test("menu lateral no padrao do Seller: icones, recolher e gaveta no celular", () => {
  for (const view of ["home", "modules", "accounts", "plans", "company"]) {
    assert.match(source, new RegExp(`data-view-target="${view}" title="[^"]+"><span class="nav__icon"><svg`), view);
  }
  assert.match(source, /class="nav__copy"><strong>Início<\/strong><small>/);
  assert.match(source, /id="sidebar-toggle"[^>]*aria-label="Recolher menu"/);
  assert.match(source, /id="menu-toggle"[^>]*aria-controls="portal-sidebar"/);
  assert.match(source, /dachbyte:portal:sidebar-collapsed/);
  assert.match(source, /\.app\.is-menu-open \.sidebar\{transform:none\}/);
  assert.match(source, /setView\(btn\.dataset\.viewTarget\);setMenuOpen\(false\)/, "escolher um item fecha a gaveta");
  assert.doesNotMatch(source, /nav__dot/, "pontinhos antigos sairam");
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
