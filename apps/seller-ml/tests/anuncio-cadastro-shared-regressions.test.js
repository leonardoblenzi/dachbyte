"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (name) => fs.readFileSync(path.join(__dirname, "..", name), "utf8");

test("Cadastro adiciona seu scheduler sem remover schedulers, gate e rotas compartilhadas", () => {
  const app = read("app.js");
  for (const symbol of [
    "startAutomationReportScheduler",
    "startReportRetentionCleanup",
    "startAnuncioDraftCleanupScheduler",
    "app.use(hubBillingGate)",
    'safeUse("billingRoutes", "./routes/billingRoutes", "/api/billing")',
    'safeUse("automationReportRoutes", "./routes/automationReportRoutes", "/api/account/automations/reports")',
  ]) assert.ok(app.includes(symbol), `app.js deve preservar ${symbol}`);
});

test("Cadastro não substitui rotas e permissões globais por funcionalidades alheias", () => {
  const htmlRoutes = read("routes/htmlRoutes.js");
  const access = read("services/companyAccessService.js");
  const packageJson = read("package.json");
  for (const route of ["/publicidade/product-ads", "/conta/contas", "/conta/creditos", "/conta/regularizar", "/conta/automacoes"]) {
    assert.ok(htmlRoutes.includes(route), `rota compartilhada ausente: ${route}`);
  }
  assert.ok(access.includes("ml.inteligencia.analise_mercado"));
  assert.equal(packageJson.includes('"@google/genai"'), false, "dependência sem uso não deve entrar no pacote de Cadastro");
});
