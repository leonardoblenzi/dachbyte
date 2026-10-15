"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const routesSource = fs.readFileSync(path.join(root, "routes/atacadoRoutes.js"), "utf8");
const controllerSource = fs.readFileSync(path.join(root, "controllers/AtacadoController.js"), "utf8");
const jobsSource = fs.readFileSync(path.join(root, "services/atacadoJobsService.js"), "utf8");
const serviceSource = fs.readFileSync(path.join(root, "services/atacadoService.js"), "utf8");
const uiSource = fs.readFileSync(path.join(root, "public/js/atacado.js"), "utf8");

test("botao de ativos enfileira carga no backend em vez de paginar no navegador", () => {
  assert.match(routesSource, /"\/ativos\/jobs"/);
  assert.match(controllerSource, /enqueueActiveLoad/);
  assert.match(uiSource, /\/api\/atacado\/ativos\/jobs/);
  assert.doesNotMatch(uiSource, /\/api\/atacado\/ativos\?\$\{params\.toString\(\)\}/);
});

test("carga de ativos usa a fila do atacado como job somente de leitura", () => {
  assert.match(jobsSource, /kind: "atacado-load-active"/);
  assert.match(jobsSource, /"wholesale-active-load"/);
  assert.match(jobsSource, /activeLoad \|\| job\.data\?\.dryRun === true \? "read" : "write"/);
  assert.match(jobsSource, /activeLoad \? await runActiveLoadJob\(job\) : await runJob\(job\)/);
});

test("carga ativa nao reserva nem liquida creditos", () => {
  const activeEnqueue = jobsSource.match(
    /static async enqueueActiveLoad\([\s\S]*?\n  static async enqueue\(/,
  );
  assert.ok(activeEnqueue);
  assert.doesNotMatch(activeEnqueue[0], /reserveCredits|creditReservation/);
  assert.match(jobsSource, /if \(isActiveLoadJob\(job\?\.data\)\) return;/);
});

test("polling nao transfere milhares de resultados ate o job terminar", () => {
  assert.match(uiSource, /include_results=0/);
  assert.match(uiSource, /include_results=1/);
  assert.match(controllerSource, /includeResults: String\(req\.query\?\.include_results \|\| "1"\) !== "0"/);
});

test("scan continua pelo cursor mesmo quando uma pagina tiver detalhes ausentes", () => {
  assert.match(serviceSource, /scanned: ids\.length/);
  assert.match(serviceSource, /missing: Math\.max\(0, ids\.length - rows\.length\)/);
  assert.match(serviceSource, /has_more: !!next_cursor && ids\.length > 0/);
});
