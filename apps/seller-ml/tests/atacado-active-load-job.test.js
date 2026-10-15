"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

process.env.ML_DATABASE_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.REDIS_URL ||= "redis://127.0.0.1:6379";

const AtacadoJobsService = require("../services/atacadoJobsService");
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

test("scan continua apos pagina sem detalhes e para em cursor repetido", async () => {
  const calls = [];
  const snapshots = [];
  const pages = [
    {
      items: [],
      paging: {
        scanned: 2,
        total: 5,
        has_more: true,
        next_cursor: "CURSOR-1",
      },
    },
    {
      items: [{ id: "MLB3" }, { id: "MLB4" }],
      paging: {
        scanned: 2,
        total: 5,
        has_more: true,
        next_cursor: "CURSOR-1",
      },
    },
  ];

  const result = await AtacadoJobsService._test.scanActiveLoadPages({
    loadPage: async ({ cursor }) => {
      calls.push(cursor);
      return pages[calls.length - 1];
    },
    onPage: async (snapshot) => snapshots.push(snapshot),
  });

  assert.deepEqual(calls, [null, "CURSOR-1"]);
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[0].rows.length, 0);
  assert.equal(snapshots[0].processed, 2);
  assert.equal(snapshots[1].rows.length, 2);
  assert.equal(result.pages, 2);
  assert.equal(result.processed, 4);
  assert.equal(result.loaded, 2);
  assert.equal(result.errors, 2);
  assert.equal(result.total, 5);
  assert.equal(result.stop_reason, "repeated_cursor");
  assert.equal(result.complete, false);
  assert.match(
    jobsSource,
    /if \(scan\.complete !== true\) \{/,
  );
});

test("pagina ativa informa cobertura mesmo quando o bulk omite detalhes", () => {
  assert.match(serviceSource, /scanned: ids\.length/);
  assert.match(serviceSource, /missing: Math\.max\(0, ids\.length - rows\.length\)/);
  assert.match(serviceSource, /has_more: !!next_cursor && ids\.length > 0/);
});

test("reload recupera a carga ativa e continua consultando o mesmo job", () => {
  assert.match(uiSource, /sessionStorage\?\.setItem\(activeLoadStorageKey\(\), normalized\)/);
  assert.match(uiSource, /readPersistedActiveLoadJob\(\)/);
  assert.match(uiSource, /recoverActiveLoadJob\(\)/);
  assert.match(uiSource, /Retomando carga dos anúncios ativos/);
  assert.match(uiSource, /runningLoad = jobs\.find/);
});

test("carga cancelada nao e apresentada como carga concluida", () => {
  assert.match(uiSource, /function jobWasCanceled\(job\)/);
  assert.match(uiSource, /if \(canceled\) \{/);
  assert.match(uiSource, /Carga cancelada\./);
  assert.match(uiSource, /Ativos parciais/);
});

test("job de leitura dos ativos nunca oferece CSV de aplicacao", () => {
  assert.match(jobsSource, /hasCsv: !activeLoad && resultTotal > 0/);
  assert.match(
    uiSource,
    /if \(isActiveLoadJobPayload\(job\)\) return null;/,
  );
});
