"use strict";
process.env.MAGALU_ENCRYPTION_KEY = Buffer.alloc(32, 13).toString("base64");
process.env.MAGALU_SYNC_PAGE_SIZE = "100";
process.env.MAGALU_SYNC_DETAIL_CONCURRENCY = "2";
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const path = require("node:path");
const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
function clearModule(name) { try { delete require.cache[require.resolve(name)]; } catch (_) {} }
async function withLoadStubs(stubs, load, run) {
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    return original.call(this, request, parent, isMain);
  };
  try { return await run(load()); } finally { Module._load = original; }
}

test("full sync lista todos os status, mas só consulta preço e estoque dos publicados", async () => {
  const details = [], progress = [], canceled = [];
  const account = { id: 8, dach_tenant_id: "dach-8", status: "active" };
  clearModule("../src/services/catalogSyncService");
  await withLoadStubs({
    "../repositories/accountRepository": { findAccountById: async () => account, updateSellerProfile: async () => {}, setCatalogSyncState: async () => {} },
    "../repositories/catalogRepository": {
      countKnownSkus: async () => 3, upsertSku: async () => ({ inserted: true }),
      upsertPrice: async (_i, sku) => details.push(`p:${sku}`), upsertStock: async (_i, sku) => details.push(`s:${sku}`),
      markPriceMissing: async () => {}, markStockMissing: async () => {}, recordPriceError: async () => {}, recordStockError: async () => {},
      markUnseenSkusMissing: async () => 0,
    },
    "../repositories/syncRunRepository": {
      createRun: async ({ result }) => { progress.push(result); return { id: 44 }; },
      cancelStaleRuns: async (...args) => canceled.push(args), updateRunProgress: async (_id, data) => progress.push(data.result), finishRun: async (_id, data) => progress.push(data.result),
    },
    "./portfolioReadService": {
      getSeller: async () => ({ data: {} }),
      listSkus: async (_i, _t, { status }) => status === "PUBLISHED"
        ? { status: 200, data: { results: [{ sku: "A", status: "PUBLISHED", active: true }, { sku: "C" }], meta: { links: { next: null } } } }
        : status === "BLOCKED"
          ? { status: 200, data: { results: [{ sku: "B", status: "BLOCKED", active: true }], meta: { links: { next: null } } } }
          : { status: 200, data: { results: [{ sku: "D", status: "UNPUBLISHED", active: false }], meta: { links: { next: null } } } },
      getPrice: async () => ({ status: 200, data: { price: 1 } }), getStock: async () => ({ status: 200, data: { results: [] } }),
    },
  }, () => require("../src/services/catalogSyncService"), async (service) => {
    const result = await service.fullCatalogSync(8, { reason: "test" });
    assert.equal(result.scanned, 4);
    assert.deepEqual(details.sort(), ["p:A", "p:C", "s:A", "s:C"]);
    assert.deepEqual(canceled, [[8, "catalog_full", 44]]);
    assert.equal(progress[0].expected_total, 3);
    assert.equal(progress.at(-1).details_skipped, 2);
  });
});

test("painel converte execuções em cards com progresso e marca execuções presas", () => {
  clearModule("../src/repositories/processPanelRepository");
  const { _test } = require("../src/repositories/processPanelRepository");
  const now = Date.parse("2026-11-05T12:00:00Z");
  const running = _test.syncRow({ id: 1, sync_type: "catalog_full", status: "running", scanned_count: 100, failed_count: 2, result: { expected_total: 400, stage: "list:PUBLISHED", details_skipped: 5 }, started_at: "2026-11-05T11:30:00Z" }, now);
  assert.equal(running.kind, "sync");
  assert.equal(running.total_count, 400);
  assert.equal(running.pending_count, 300);
  assert.equal(running.details_skipped, 5);
  const stale = _test.syncRow({ id: 2, sync_type: "catalog_full", status: "running", scanned_count: 0, failed_count: 0, result: {}, started_at: "2026-10-08T17:24:40Z" }, now);
  assert.equal(stale.status, "canceled");
  assert.equal(stale.pending_count, 0);
  assert.ok(stale.error_message);
  const done = _test.syncRow({ id: 3, sync_type: "catalog_full", status: "partial", scanned_count: 55010, failed_count: 0, result: { expected_total: 54509 }, started_at: "2026-10-16T12:37:46Z", finished_at: "2026-10-16T14:22:52Z" }, now);
  assert.equal(done.pending_count, 0);
  assert.equal(done.total_count, 55010);
});

test("painel Processos aparece nas telas com sincronização e abre ao enfileirar", () => {
  const panel = read("public/js/magalu-process-panel.js"), app = read("public/js/magalu-app.js");
  for (const route of ["/integracoes", "/margem", "/promocoes", "/estoque", "/precos"]) assert.ok(panel.includes(`"${route}"`), route);
  assert.match(panel, /row\.kind === "sync" \? "Sincronizar catálogo"/);
  assert.match(app, /new CustomEvent\("magalu:processqueued", \{ detail: \{ kind: "sync" \} \}\)/);
  assert.match(read("src/repositories/syncRunRepository.js"), /status='canceled'/);
});

test("acompanhamento da sincronização sobrevive a queda de conexão", () => {
  const app = read("public/js/magalu-app.js");
  assert.match(app, /function transientSyncError\(error\)/);
  assert.match(app, /return !status \|\| status === 408 \|\| status === 429 \|\| status >= 500;/);
  assert.match(app, /window\.addEventListener\("online", done, \{ once: true \}\)/);
  assert.match(app, /if \(!transientSyncError\(error\)\) throw error;/);
});

test("sincronização em andamento a 0% aparece em Em andamento, não em Na fila", () => {
  const panel = read("public/js/magalu-process-panel.js");
  assert.match(panel, /const isRunning = row => row\.kind === "sync" \? row\.status === "running"/);
  assert.match(panel, /rows\.filter\(row => row\.kind !== "sync" && status\(row\)!=="Falhou"/);
});
