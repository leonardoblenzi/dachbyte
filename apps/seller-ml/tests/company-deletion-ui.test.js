"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(
  path.join(__dirname, "..", "views", "admin-empresas.html"),
  "utf8",
);
const js = fs.readFileSync(
  path.join(__dirname, "..", "public", "js", "admin-empresas.js"),
  "utf8",
);

test("exibe o impacto de auditoria e impede exclusao quando o preview bloqueia", () => {
  assert.match(html, /id="delete-impact-body"/);
  assert.match(js, /Eventos de auditoria removidos/);
  assert.match(js, /deleteImpact\.canDelete === false \|\| deleteImpact\.blocked/);
  assert.match(js, /Jobs ativos impedem a exclusao/);
  assert.match(js, /Falha ao inspecionar jobs/);
});

test("mantem a exclusao em cascata e trata bloqueio do servidor sem bypass", () => {
  assert.match(js, /body: JSON\.stringify\(\{ cascade: true \}\)/);
  assert.match(js, /e\.status === 409/);
  assert.match(js, /e\.status === 404/);
  assert.match(js, /await openDeleteEmpresa\(deletingId\)/);
});

test("disponibiliza historico Master paginado sem renderizar campos sensiveis", () => {
  for (const id of [
    "deletion-history-search",
    "deletion-history-from",
    "deletion-history-to",
    "deletion-history-operator",
    "deletion-history-body",
    "deletion-history-prev",
    "deletion-history-next",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(js, /\/api\/admin\/empresas\/deletion-receipts/);
  assert.match(js, /function renderDeletionHistory/);
  assert.match(js, /escapeHtml\(receipt\.empresa_nome/);
  assert.match(js, /escapeHtml\(receipt\.operator_email/);
  assert.doesNotMatch(js, /receipt\.(?:token|metadata|ip|user_agent)/);
});

test("atualiza a versao do script administrativo", () => {
  assert.match(html, /\/ml\/js\/admin-empresas\.js\?v=4/);
});
