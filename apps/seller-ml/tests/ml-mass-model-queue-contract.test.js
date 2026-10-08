"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const service = fs.readFileSync(path.join(root, "services", "modeloMassaJobsService.js"), "utf8");
const controller = fs.readFileSync(path.join(root, "controllers", "ModeloMassaController.js"), "utf8");
const worker = fs.readFileSync(path.join(root, "worker.js"), "utf8");

test("modelo em massa usa Bull e Redis em vez de Map em memoria", () => {
  assert.match(service, /new Bull\(QUEUE_NAME/);
  assert.match(service, /getSharedRedis\("modelo-massa:jobs"\)/);
  assert.doesNotMatch(service, /const\s+JOBS\s*=\s*new Map\(/);
});

test("modelo em massa usa governor e liquida somente unidades faturaveis", () => {
  assert.match(service, /waitForHeavyOperationLease/);
  assert.match(service, /lane:\s*job\.data\?\.dryRun === true \? "read" : "write"/);
  assert.match(service, /const billableUnits = massModelBillableUnits/);
  assert.match(service, /consumedUnits:\s*billableUnits > 0 \? billableUnits : null/);
  assert.ok(service.includes('"mass-model.validate"'));
  assert.ok(service.includes('"mass-model.apply"'));
  assert.match(service, /massModelBillingIdempotencyKey/);
});

test("controller aguarda operacoes persistentes e worker inicia a fila", () => {
  assert.match(controller, /await ModeloMassaJobsService\.listRecent/);
  assert.match(controller, /await ModeloMassaJobsService\.jobDetail/);
  assert.match(controller, /await ModeloMassaJobsService\.cancelJob/);
  assert.match(controller, /await ModeloMassaJobsService\.getJobCsv/);
  assert.match(worker, /ModeloMassaJobsService\.initWorker\(\)/);
});
