"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("Etapa 6 expõe painel de saúde por conta no Master", () => {
  const routes = read("src/routes/master.routes.js");
  for (const marker of [
    "/integrations/accounts/:accountId/diagnose",
    "/integrations/accounts/:accountId/oauth/refresh",
    "/integrations/accounts/:accountId/oauth/reconnect",
    "/integrations/accounts/:accountId/hub/reconcile",
    "/integrations/accounts/:accountId/webhooks/reconcile",
  ]) assert.match(routes, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("diagnóstico de webhook remoto é read-only", () => {
  const service = read("src/services/integrationHealthService.js");
  assert.match(service, /\/v0\/onboarding\/signup\?_limit=100/);
  assert.match(service, /method:\s*"GET"/);
  assert.doesNotMatch(service, /method:\s*"PUT"[\s\S]{0,150}onboarding\/signup/);
  assert.doesNotMatch(service, /method:\s*"DELETE"[\s\S]{0,150}onboarding\/signup/);
  assert.match(service, /mode:"read_only_remote"/);
});

test("reconciliação de webhook não altera status nem secrets", () => {
  const repo = read("src/repositories/integrationHealthRepository.js");
  const reconcile = repo.slice(repo.indexOf("async function recordWebhookReconcile"));
  assert.match(reconcile, /last_synced_at=now\(\)/);
  assert.match(reconcile, /master_reconcile/);
  assert.doesNotMatch(reconcile, /set\s+status\s*=/i);
  assert.doesNotMatch(reconcile, /secret_ciphertext\s*=/i);
});

test("respostas de saúde não selecionam ciphertext ou segredo", () => {
  const repo = read("src/repositories/integrationHealthRepository.js");
  assert.doesNotMatch(repo, /access_token_ciphertext/);
  assert.doesNotMatch(repo, /refresh_token_ciphertext/);
  assert.doesNotMatch(repo, /secret_ciphertext/);
  const browser = read("public/js/magalu-master-integrations.js");
  assert.doesNotMatch(browser, /access_token|refresh_token|client_secret|secret_ciphertext/i);
});

test("ações Master revalidam Hub com force true", () => {
  const service = read("src/services/integrationHealthService.js");
  assert.match(service, /checkHubAccess\(identity, \{ action, resourceKey: resourceKeyForAccount\(account\), force: true \}\)/);
  assert.match(service, /checkHubAccess\(identity, \{ action: "READ magalu", resourceKey, force: true \}\)/);
  assert.match(service, /checkHubAccess\(identity, \{ action: "WRITE magalu", resourceKey, force: true \}\)/);
});

test("OAuth Master usa estado vinculado a conta e tenant esperados", () => {
  const migration = read("db/migrations/008_master_integration_health.sql");
  assert.match(migration, /flow_mode/);
  assert.match(migration, /target_account_id/);
  assert.match(migration, /expected_magalu_tenant_id/);
  const oauth = read("src/services/magaluOAuthService.js");
  assert.match(oauth, /MAGALU_MASTER_RECONNECT_SUBJECT_MISMATCH/);
  assert.match(oauth, /MAGALU_MASTER_RECONNECT_ACCOUNT_MISMATCH/);
});

test("callback Master mantém validação Hub e ownership", () => {
  const controller = read("src/controllers/oauthController.js");
  assert.match(controller, /masterReconnect/);
  assert.match(controller, /platform_admin/);
  assert.match(controller, /platform_module_master/);
  assert.match(controller, /checkAccountAccess\(targetIdentity, account, \{ force:true, action:"ACCESS magalu" \}\)/);
});

test("detecção de scopes usa configuração efetiva e SKU write", () => {
  const service = read("src/services/integrationHealthService.js");
  assert.match(service, /env\.MAGALU_OAUTH_SCOPES/);
  assert.match(service, /env\._SKU_WRITE_SCOPE/);
  assert.match(service, /reconnect_required/);
});

test("browser nunca acessa Redis diretamente", () => {
  const browser = read("public/js/magalu-master-integrations.js");
  assert.doesNotMatch(browser, /ioredis|redis:\/\/|new Redis/i);
  assert.match(browser, /\/magalu\/api\/master/);
});

test("Foundation e heartbeat avançam para a Etapa 8", () => {
  assert.match(read("src/routes/api.routes.js"), /stage:8,revision:"8\.0"/);
  assert.match(read("src/worker.js"), /stage:8/);
});

test("UI Master carrega módulo independente de integrações", () => {
  const html = read("views/master.html");
  assert.match(html, /magalu-master-integrations\.css/);
  assert.match(html, /magalu-master-integrations\.js/);
  assert.match(html, /integration-health-grid/);
  assert.match(html, /integration-accounts-body/);
});

test("Etapa 6 não cria segundo motor de operações massivas", () => {
  const service = read("src/services/integrationHealthService.js");
  const repo = read("src/repositories/integrationHealthRepository.js");
  assert.doesNotMatch(service + repo, /create table|mass_operation_items|sku_mass_previews/i);
});
