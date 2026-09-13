"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "public", "tray-connection.js"), "utf8");
const appSource = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

test("Integrações lista cada conta ML e permite adicionar outra", () => {
  assert.match(source, /connections\.filter\(connection=>connection\.channel==="meli"\)/);
  assert.match(source, /Adicionar conta Mercado Livre/);
  assert.match(source, /data-refresh="meli"/);
});

test("Pedidos mostram canal legível e bloqueiam taxa ML sem conexão correspondente", () => {
  assert.match(appSource, /Mercado Livre/);
  assert.match(appSource, /conta não identificada|conta nao identificada/);
  assert.match(appSource, /data-fee-meli="\$\{o\.id\}"/);
  assert.doesNotMatch(appSource, /fee\("meli",b\.dataset\.feeMeli\)/);
});
