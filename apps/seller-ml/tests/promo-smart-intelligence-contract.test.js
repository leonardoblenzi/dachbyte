"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const routes = fs.readFileSync(path.join(root, "routes/promocoesRoutes.js"), "utf8");
const service = fs.readFileSync(path.join(root, "services/promoSmartOptimizerService.js"), "utf8");
const html = fs.readFileSync(path.join(root, "views/criar-promocao.html"), "utf8");
const browser = fs.readFileSync(path.join(root, "public/js/promo-intelligence.js"), "utf8");

test("rota de analise SMART aceita somente quick ou full", () => {
  assert.match(routes, /req\.body\?\.mode\s*\|\|\s*["']quick["']/);
  assert.match(routes, /\[["']quick["'],\s*["']full["']\]\.includes\(mode\)/);
  assert.match(routes, /mode deve ser quick ou full/);
});

test("rota SMART encaminha continuacao para o servico", () => {
  assert.match(routes, /resume_analysis_id/);
  assert.match(routes, /resumeAnalysisId,?/);
});

test("servico bloqueia oportunidades sem cobertura antes da reserva", () => {
  const filterIndex = service.indexOf("filterVerifiedOpportunities");
  const reserveIndex = service.indexOf("reserveCreditsForOptimization", filterIndex);
  assert.ok(filterIndex >= 0, "filtro de cobertura ausente");
  assert.ok(reserveIndex > filterIndex, "reserva ocorreu antes do filtro de cobertura");
});

test("interface oferece verificacao rapida, completa e cobertura", () => {
  assert.match(html, /id="btnRunSmartQuickAnalysis"/);
  assert.match(html, /id="btnRunSmartFullAnalysis"/);
  assert.match(html, /id="smartOptimizerCoverage"/);
  assert.match(html, /data-smart-filter="inconclusive"/);
});

test("browser envia o modo e seleciona somente oportunidades verificadas", () => {
  assert.match(browser, /JSON\.stringify\(body\)/);
  assert.match(browser, /classification\s*===\s*["']verified["']/);
  assert.match(browser, /coverage_verified\s*===\s*true/);
});

test("analise SMART permanece fora da cobranca", () => {
  const start = service.slice(service.indexOf("async startAnalysis"), service.indexOf("async getAnalysis"));
  assert.doesNotMatch(start, /reserveCreditsForOptimization/);
});

test("jobs de analise SMART aparecem no painel e podem ser cancelados", () => {
  assert.match(service, /\["analyze",\s*"optimize"\]\.includes\(job\.data\?\.kind\)/);
  assert.match(service, /job\.data\?\.kind === "analyze"/);
  assert.match(service, /Verificação SMART completa/);
  assert.match(service, /Verificação SMART rápida/);
});

test("relatorio SMART inclui aba de cobertura", () => {
  assert.match(service, /addWorksheet\("Cobertura"\)/);
  assert.match(service, /analysis\.coverage\?\.campaigns/);
});

test("checkpoint nao persiste credenciais", () => {
  const checkpointBlock = service.slice(service.indexOf("onCheckpoint:"), service.indexOf("return withCoverage"));
  assert.doesNotMatch(checkpointBlock, /access_token|refresh_token|mlCreds/);
});

test("limite de descoberta vira cobertura parcial em vez de conclusao silenciosa", () => {
  assert.match(service, /campaign_limit_reached/);
  assert.match(service, /truncated:\s*eligible\.length\s*>\s*ANALYSIS_MAX_CAMPAIGNS/);
});
