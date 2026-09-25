"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const files = {
  index: "src/routes/index.js",
  auth: "src/middlewares/masterAuth.js",
  routes: "src/routes/master.routes.js",
  repository: "src/repositories/masterRepository.js",
  service: "src/services/masterService.js",
  accountManagement: "src/repositories/accountManagementRepository.js",
  view: "views/master.html",
  js: "public/js/magalu-master.js",
  css: "public/css/magalu-master.css",
  queues: "src/config/queueNames.js",
};

test("Etapa 3 registra /magalu/master e API Master atrás de requireMagaluMaster", () => {
  const source = read(files.index);
  assert.match(source, /router\.get\("\/master",\s*requireMagaluMaster,\s*masterController\.page\)/);
  assert.match(source, /router\.use\("\/api\/master",\s*requireMagaluMaster,\s*masterRoutes\)/);
});

test("Master é Hub-first e só aceita platform_admin/module_master", () => {
  const source = read(files.auth);
  assert.match(source, /checkHubAccess\(identity,\s*\{\s*action:\s*"ACCESS magalu",\s*force:\s*true\s*\}\)/);
  assert.match(source, /platform_admin/);
  assert.match(source, /platform_module_master/);
  assert.match(source, /canDestroy:\s*reason === "platform_admin"/);
  assert.doesNotMatch(source, /magalu\.admin_users/i);
});

test("ação destrutiva de conta exige guarda adicional", () => {
  const source = read(files.routes);
  assert.match(source, /accounts\/:accountId\/unlink",\s*requireMagaluMasterDestructive/);
  assert.doesNotMatch(source, /reprocess/i);
});

test("UI e API Master não expõem ciphertext de token ou secret", () => {
  const combined = [files.repository, files.service, files.view, files.js].map(read).join("\n");
  assert.doesNotMatch(combined, /access_token_ciphertext/);
  assert.doesNotMatch(combined, /refresh_token_ciphertext/);
  assert.doesNotMatch(combined, /client_secret/i);
  assert.doesNotMatch(combined, /secret_ciphertext/);
});

test("Master Magalu não importa negócio do Seller ML", () => {
  const combined = [files.auth, files.routes, files.repository, files.service].map(read).join("\n");
  assert.doesNotMatch(combined, /seller-ml/i);
  assert.doesNotMatch(combined, /meli_/i);
  assert.doesNotMatch(combined, /\.\.\/\.\.\/seller-ml/i);
});

test("desvinculação cobre write_operations e mass_operation_items quando disponível", () => {
  const source = read(files.accountManagement);
  assert.match(source, /magalu\.write_operations/);
  assert.match(source, /magalu\.mass_operation_items/);
  assert.match(source, /schema_unknown/);
  for (const state of ["queued", "running", "dispatching", "accepted", "divergent", "uncertain"]) {
    assert.ok(source.includes(`"${state}"`), `estado bloqueador ausente: ${state}`);
  }
});

test("reverify permanece sem botão genérico de reprocessamento", () => {
  const service = read(files.service);
  const ui = read(files.js);
  assert.match(service, /\["uncertain",\s*"divergent"\]/);
  assert.match(service, /enqueueWriteOperation\(operation,\s*\{\s*reason:\s*"reverify"\s*\}\)/);
  assert.match(service, /mode:\s*"verification_only"/);
  assert.doesNotMatch(`${service}\n${ui}`, /reprocessar tudo/i);
});

test("workers são lidos no backend e filas futuras/ativadas permanecem explícitas", () => {
  const service = read(files.service);
  const queues = read(files.queues);
  const ui = read(files.js);
  assert.match(service, /magalu:worker:heartbeat/);
  assert.match(service, /queue\.getJobCounts/);
  assert.match(`${service}\n${queues}`, /magalu-sku-update/);
  assert.match(`${service}\n${queues}`, /magalu-audit-maintenance/);
  assert.doesNotMatch(ui, /ioredis|redis:\/\//i);
});

test("Auditoria e Retenção preservam os limites definidos para a evolução da Etapa 4", () => {
  const view = read(files.view);
  assert.match(view, /Auditoria/);
  assert.match(view, /Retenção/);
  assert.match(view, /15–30d/);
  assert.match(view, /30–60d/);
  assert.match(view, /90d/);
});
