"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

for (const screen of [
  { name: "modelo-massa", js: "modelo-massa.js" },
  { name: "caracteristicas", js: "caracteristicas.js" },
  { name: "validar-dimensoes", js: "validar-dimensoes.js" },
]) {
  test(`${screen.name} confirma cotacao no modal compartilhado antes do job`, () => {
    const view = fs.readFileSync(path.join(root, "views", `${screen.name}.html`), "utf8");
    const source = fs.readFileSync(path.join(root, "public", "js", screen.js), "utf8");
    assert.match(view, /credit-operation-modal\.css/);
    assert.match(view, /credit-operation-modal\.js/);
    assert.match(source, /window\.CreditOperationModal\.confirm\(/);
    assert.doesNotMatch(source, /return window\.confirm\(lines\.join/);
  });
}

test("clonagem individual mostra liquidação no resultado sem criar job", () => {
  const controller = fs.readFileSync(path.join(root, "controllers", "ClonarAnuncioController.js"), "utf8");
  const source = fs.readFileSync(path.join(root, "public", "js", "clonar-anuncio.js"), "utf8");
  assert.match(controller, /credit_settlement: creditSettlement/);
  assert.match(source, /creditSettlementMessage\(response\?\.credit_settlement\)/);
  assert.doesNotMatch(source, /JobsPanel\.addLocalJob/);
});

test("sincronização manual de custos aparece no painel de jobs e recupera após reload", () => {
  const view = fs.readFileSync(path.join(root, "views", "financeiro-ml-margem.html"), "utf8");
  const source = fs.readFileSync(path.join(root, "public", "js", "financeiro-ml-custos.js"), "utf8");
  assert.match(view, /id="bulkJobsPanel"/);
  assert.match(view, /jobs-panel\.js/);
  assert.match(source, /JobsPanel\?\.addLocalJob/);
  assert.match(source, /sessionStorage/);
  assert.match(source, /\/api\/account\/current/);
  assert.doesNotMatch(source, /financeiro-ml-cost-sync:\$\{String\(window\.__ACCOUNT__/);
});

test("promoções compartilham confirmação assíncrona de créditos", () => {
  const view = fs.readFileSync(path.join(root, "views", "criar-promocao.html"), "utf8");
  const http = fs.readFileSync(path.join(root, "public", "js", "promo-http.js"), "utf8");
  const actions = fs.readFileSync(path.join(root, "public", "js", "promo-actions.js"), "utf8");
  const bulk = fs.readFileSync(path.join(root, "public", "js", "promo-bulk.js"), "utf8");
  assert.match(view, /credit-operation-modal\.css/);
  assert.match(view, /credit-operation-modal\.js/);
  assert.match(http, /window\.CreditOperationModal\.confirm\(|global\.CreditOperationModal\.confirm\(/);
  assert.match(actions, /await global\.PromoHttp\?\.confirmCreditQuote/);
  assert.match(bulk, /await window\.PromoHttp\?\.confirmCreditQuote/);
});

test("aplicação de promoções não prossegue quando a cotação falha", () => {
  for (const file of ["promo-actions.js", "promo-bulk.js"]) {
    const source = fs.readFileSync(path.join(root, "public", "js", file), "utf8");
    assert.doesNotMatch(source, /previa de creditos indisponivel; seguindo em shadow/);
    assert.match(source, /Não foi possível consultar os créditos/);
  }
});

test("SMART faz cotação nova ao confirmar otimização", () => {
  const source = fs.readFileSync(path.join(root, "public", "js", "promo-intelligence.js"), "utf8");
  assert.match(source, /async function confirmOptimization\([\s\S]*credits\/quote[\s\S]*CreditOperationModal\.confirm\([\s\S]*\/optimize/);
});

test("filtro mantém preço atual e confirma pelo modal compartilhado", () => {
  const view = fs.readFileSync(path.join(root, "views", "filtro-anuncios.html"), "utf8");
  const source = fs.readFileSync(path.join(root, "public", "js", "filtro-anuncios.js"), "utf8");
  assert.match(view, /credit-operation-modal\.css/);
  assert.match(view, /credit-operation-modal\.js/);
  assert.match(source, /window\.CreditOperationModal\.confirm\(/);
  assert.match(source, /API_CREDITS_QUOTE/);
});

test("gestão de anúncios confirma crédito após o gate de segurança e antes da fila", () => {
  const view = fs.readFileSync(path.join(root, "views", "excluir-anuncio.html"), "utf8");
  const source = fs.readFileSync(path.join(root, "public", "js", "excluir-anuncio.js"), "utf8");
  assert.match(view, /credit-operation-modal\.css/);
  assert.match(view, /credit-operation-modal\.js/);
  assert.match(source, /async function startOperation\([\s\S]*CreditOperationModal\.confirm\([\s\S]*ExclusaoBulk\.enqueue/);
});

test("prazo confirma consulta e aplicação com cotação no modal compartilhado", () => {
  const view = fs.readFileSync(path.join(root, "views", "prazo.html"), "utf8");
  const lookup = fs.readFileSync(path.join(root, "public", "js", "prazo.js"), "utf8");
  const apply = fs.readFileSync(path.join(root, "public", "js", "prazo-bulk.js"), "utf8");
  assert.match(view, /credit-operation-modal\.css/);
  assert.match(view, /credit-operation-modal\.js/);
  assert.match(lookup, /window\.CreditOperationModal\.confirm\(/);
  assert.match(apply, /window\.CreditOperationModal\.confirm\(/);
  assert.match(apply, /async function enqueue[\s\S]*fetchPrazoCreditQuote[\s\S]*QUEUE\.push/);
});

test("estoque confirma varredura e atualização com modal compartilhado", () => {
  const view = fs.readFileSync(path.join(root, "views", "estoque-alerta.html"), "utf8");
  const scan = fs.readFileSync(path.join(root, "public", "js", "estoque-alerta.js"), "utf8");
  const apply = fs.readFileSync(path.join(root, "public", "js", "estoque-atualizacao.js"), "utf8");
  assert.match(view, /credit-operation-modal\.css/);
  assert.match(view, /credit-operation-modal\.js/);
  assert.match(scan, /window\.CreditOperationModal\.confirm\(/);
  assert.match(apply, /window\.CreditOperationModal\.confirm\(/);
});

for (const screen of [
  { name: "financeiro-ml-margem", js: "financeiro-ml-custos.js" },
  { name: "clonar-anuncio", js: "clonar-anuncio.js" },
]) {
  test(`${screen.name} confirma operação paga com modal compartilhado`, () => {
    const view = fs.readFileSync(path.join(root, "views", `${screen.name}.html`), "utf8");
    const source = fs.readFileSync(path.join(root, "public", "js", screen.js), "utf8");
    assert.match(view, /credit-operation-modal\.css/);
    assert.match(view, /credit-operation-modal\.js/);
    assert.match(source, /window\.CreditOperationModal\.confirm\(/);
  });
}
