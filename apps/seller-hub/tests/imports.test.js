"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { MagaluConnector } = require("../src/connectors/magalu/MagaluConnector");
const { ShopeeConnector } = require("../src/connectors/shopee/ShopeeConnector");
const { createImportsService } = require("../src/modules/imports/service");
const { validateListingRecord } = require("../src/connectors/contract");
const { hmacSha256Hex } = require("../src/platform/crypto");

/** fetch falso por função: recebe a URL e devolve { status, body }. */
function routeFetch(handler) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: new URL(String(url)), init });
    const { status = 200, body = {} } = handler(new URL(String(url))) || { status: 404, body: { error: "not_found" } };
    return { ok: status < 400, status, text: async () => JSON.stringify(body) };
  };
  return { impl, calls };
}

test("Magalu: percorre PUBLISHED → UNPUBLISHED → BLOCKED e busca preço/estoque só do publicado", async () => {
  const pages = { PUBLISHED: [Array.from({ length: 100 }, (_, i) => ({ sku: `P${i}`, title: `Prod ${i}`, status: "PUBLISHED" })), [{ sku: "P100", status: "PUBLISHED" }]], UNPUBLISHED: [[{ sku: "U1", status: "UNPUBLISHED" }]], BLOCKED: [[]] };
  const { impl, calls } = routeFetch((url) => {
    if (url.pathname === "/seller/v1/portfolios/skus") {
      const status = url.searchParams.get("status");
      return { body: { results: pages[status][Number(url.searchParams.get("_offset")) / 100] || [] } };
    }
    if (url.pathname.startsWith("/seller/v1/portfolios/prices/")) return { body: { results: [{ price: 19990, normalizer: 100 }] } };
    if (url.pathname.startsWith("/seller/v1/portfolios/stocks/")) return { body: { results: [{ type: "AVAILABLE", quantity: 3 }, { type: "RESERVED", quantity: 9 }] } };
    return null;
  });
  const magalu = new MagaluConnector({ clientId: "c", clientSecret: "s", fetchImpl: impl });
  const seen = [];
  let cursor = null, guard = 0;
  do {
    const page = await magalu.listListings({ accessToken: "TK" }, { cursor });
    seen.push(...page.listings);
    cursor = page.nextCursor;
  } while (cursor && ++guard < 10);
  assert.equal(cursor, null);
  assert.equal(seen.length, 102);
  assert.ok(seen.every((r) => validateListingRecord(r).length === 0));
  assert.deepEqual([seen[0].price, seen[0].stock], [199.9, 3]);
  const unpublished = seen.find((r) => r.listingId === "U1");
  assert.deepEqual([unpublished.price, unpublished.stock], [null, null]);
  assert.ok(!calls.some((c) => c.url.pathname.endsWith("/U1")), "não publicado não busca preço/estoque");
  assert.equal(calls[0].init.headers.authorization, "Bearer TK");
  assert.equal(calls[0].url.searchParams.get("_limit"), "100");
});

test("Shopee: chamadas da loja assinadas, detalhes em lote e um registro por modelo", async () => {
  const { impl, calls } = routeFetch((url) => {
    if (url.pathname === "/api/v2/product/get_item_list") {
      return url.searchParams.get("item_status") === "NORMAL"
        ? { body: { response: { item: [{ item_id: 1 }, { item_id: 2 }], has_next_page: false } } }
        : { body: { response: { item: [], has_next_page: false } } };
    }
    if (url.pathname === "/api/v2/product/get_item_base_info") {
      return { body: { response: { item_list: [
        { item_id: 1, item_name: "Mesa", item_sku: "MESA-1", item_status: "NORMAL", has_model: false, price_info: [{ current_price: 99.9 }], stock_info_v2: { summary_info: { total_available_stock: 4 } } },
        { item_id: 2, item_name: "Cadeira", item_sku: "CAD", item_status: "NORMAL", has_model: true },
      ] } } };
    }
    if (url.pathname === "/api/v2/product/get_model_list") {
      return { body: { response: { model: [
        { model_id: 21, model_sku: "CAD-PRETA", price_info: [{ current_price: 50 }], stock_info_v2: { summary_info: { total_available_stock: 2 } } },
        { model_id: 22, model_sku: "", price_info: [{ current_price: 50 }] },
      ] } } };
    }
    return null;
  });
  const shopee = new ShopeeConnector({ partnerId: "999", partnerKey: "key", fetchImpl: impl, now: () => 1700000000 });
  const account = { accessToken: "AT", externalAccountId: "555" };
  const first = await shopee.listListings(account, {});
  assert.equal(first.listings.length, 3);
  assert.ok(first.listings.every((r) => validateListingRecord(r).length === 0));
  assert.deepEqual(first.listings.map((r) => [r.listingId, r.variationId]), [["1", ""], ["2", "21"], ["2", "22"]]);
  assert.ok(first.nextCursor, "ainda falta o status UNLIST");
  const second = await shopee.listListings(account, { cursor: first.nextCursor });
  assert.equal(second.nextCursor, null);
  const listCall = calls[0].url;
  assert.equal(listCall.searchParams.get("shop_id"), "555");
  assert.equal(listCall.searchParams.get("sign"), hmacSha256Hex("key", "999/api/v2/product/get_item_list1700000000AT555"));
  assert.equal(calls[1].url.searchParams.get("item_id_list"), "1,2");
});

test("Shopee: erro da API vira exceção com o código da Shopee", async () => {
  const { impl } = routeFetch(() => ({ body: { error: "error_auth", message: "Invalid access_token." } }));
  const shopee = new ShopeeConnector({ partnerId: "1", partnerKey: "k", fetchImpl: impl });
  await assert.rejects(() => shopee.listListings({ accessToken: "x", externalAccountId: "1" }), (e) => e.code === "error_auth");
});

/** Repositório de importações em memória. */
function memoryRepo({ account = { id: 5, channel: "mercadolivre", externalAccountId: "123" } } = {}) {
  const runs = new Map();
  let nextId = 1;
  return {
    runs,
    progressCalls: [],
    async findConnectedAccount(tenantId, accountId) { return tenantId === "t1" && accountId === account.id ? account : null; },
    async createRun({ accountId, trigger }) {
      const active = [...runs.values()].find((r) => r.accountId === accountId && ["queued", "running"].includes(r.status));
      if (active) return { run: active, created: false };
      const run = { id: nextId++, accountId, trigger, status: "queued" };
      runs.set(run.id, run);
      return { run, created: true };
    },
    async markRunning(runId, tenantId) {
      const run = runs.get(runId);
      if (!run || run.status !== "queued" || tenantId !== "t1") return null;
      run.status = "running";
      return account;
    },
    async progress(runId, totals) { this.progressCalls.push({ runId, ...totals }); },
    async finish(runId, result) { Object.assign(runs.get(runId), result); },
    async getRun(_tenantId, runId) { return runs.get(runId) || null; },
  };
}

function fakeConnectors(connector, capabilities = { listings: true }) {
  return { has: () => true, definition: () => ({ capabilities }), get: () => connector };
}

const identity = { tenantId: "t1", userId: "u1" };

test("pedir importação: enfileira uma vez e não duplica enquanto estiver ativa", async () => {
  const repository = memoryRepo();
  const queued = [];
  const service = createImportsService({ repository, catalog: { applyListings: async () => ({}) }, connectors: fakeConnectors({}), tokens: { getAccessToken: async () => ({}) }, queue: { mode: "test", enqueue: async (job) => { queued.push(job); } } });
  const first = await service.requestImport({ identity, accountId: 5 });
  const again = await service.requestImport({ identity, accountId: 5 });
  assert.equal(first.created, true);
  assert.equal(again.created, false);
  assert.equal(again.run.id, first.run.id);
  assert.deepEqual(queued, [{ runId: first.run.id, tenantId: "t1", accountId: 5 }]);
  await assert.rejects(() => service.requestImport({ identity: { tenantId: "outra" }, accountId: 5 }), (e) => e.code === "account_not_found");
});

test("canal sem leitura de anúncios ou fila fora do ar não deixa execução presa", async () => {
  const noListings = createImportsService({ repository: memoryRepo(), catalog: {}, connectors: fakeConnectors({}, { listings: false }), tokens: {}, queue: { mode: "test", enqueue: async () => {} } });
  await assert.rejects(() => noListings.requestImport({ identity, accountId: 5 }), (e) => e.code === "listings_not_supported");

  const repository = memoryRepo();
  const broken = createImportsService({ repository, catalog: {}, connectors: fakeConnectors({}), tokens: {}, queue: { mode: "test", enqueue: async () => { throw new Error("redis fora"); } } });
  await assert.rejects(() => broken.requestImport({ identity, accountId: 5 }), (e) => e.code === "queue_unavailable");
  assert.equal(repository.runs.get(1).status, "failed", "execução não fica 'na fila' para sempre");
});

test("executar importação: página a página, token a cada página, progresso e conclusão", async () => {
  const repository = memoryRepo();
  const pages = { null: { listings: [{ listingId: "A" }, { listingId: "B" }], nextCursor: "c2" }, c2: { listings: [{ listingId: "C" }], nextCursor: null } };
  const cursors = [];
  const connector = { async listListings(account, { cursor }) { cursors.push([account.accessToken, cursor]); return pages[String(cursor)]; } };
  let tokenCalls = 0;
  const applied = [];
  const service = createImportsService({
    repository, connectors: fakeConnectors(connector),
    tokens: { getAccessToken: async () => ({ accessToken: `T${++tokenCalls}`, externalAccountId: "123" }) },
    catalog: { applyListings: async ({ listings }) => { applied.push(listings.length); return { listingsSeen: listings.length, linkedAuto: listings.length - 1, unlinked: 1 }; } },
    queue: { mode: "test", enqueue: async () => {} },
  });
  const { run } = await service.requestImport({ identity, accountId: 5 });
  const result = await service.runImport({ runId: run.id, tenantId: "t1", accountId: 5 });
  assert.deepEqual(cursors, [["T1", null], ["T2", "c2"]]);
  assert.deepEqual(applied, [2, 1]);
  assert.equal(repository.progressCalls.length, 2);
  assert.deepEqual({ ...repository.runs.get(run.id) }, { id: run.id, accountId: 5, trigger: "manual", status: "succeeded", pages: 2, listingsSeen: 3, linkedAuto: 1, unlinked: 2 });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(await service.runImport({ runId: run.id, tenantId: "t1", accountId: 5 }), { skipped: true }, "job repetido não roda de novo");
});

test("executar importação: erro do canal ou página repetida encerram como falha, guardando o progresso", async () => {
  const repository = memoryRepo();
  const connector = { async listListings(_a, { cursor }) { return cursor ? { listings: [], nextCursor: "mesmo" } : { listings: [{ listingId: "A" }], nextCursor: "mesmo" }; } };
  const service = createImportsService({
    repository, connectors: fakeConnectors(connector), tokens: { getAccessToken: async () => ({ accessToken: "T" }) },
    catalog: { applyListings: async ({ listings }) => ({ listingsSeen: listings.length, linkedAuto: 0, unlinked: listings.length }) },
    queue: { mode: "test", enqueue: async () => {} },
  });
  const { run } = await service.requestImport({ identity, accountId: 5 });
  await assert.rejects(() => service.runImport({ runId: run.id, tenantId: "t1", accountId: 5 }), /mesma página/);
  const saved = repository.runs.get(run.id);
  assert.equal(saved.status, "failed");
  assert.equal(saved.listingsSeen, 1);
  assert.match(saved.error, /mesma página/);

  const repo2 = memoryRepo();
  const expired = createImportsService({
    repository: repo2, connectors: fakeConnectors(connector), catalog: {}, queue: { mode: "test", enqueue: async () => {} },
    tokens: { getAccessToken: async () => { throw Object.assign(new Error("A conexão desta conta expirou."), { code: "reconnect_required" }); } },
  });
  const r2 = (await expired.requestImport({ identity, accountId: 5 })).run;
  await assert.rejects(() => expired.runImport({ runId: r2.id, tenantId: "t1", accountId: 5 }), (e) => e.code === "reconnect_required");
  assert.equal(repo2.runs.get(r2.id).status, "failed");
});
