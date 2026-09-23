"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

test("stock enqueue rejects a missing real accountKey instead of using credential metadata", async () => {
  let enqueued = false;
  const originalLoad = Module._load;
  Module._load = function mockControllerDependencies(request, parent, isMain) {
    if (request === "../services/estoqueAtualizacaoQueueService") return {
      enqueueStockUpdateJob: async () => { enqueued = true; },
    };
    if (request === "../services/authAuditService") return {
      getRequestIp: () => "127.0.0.1", getRequestUserAgent: () => "test",
    };
    return originalLoad.call(this, request, parent, isMain);
  };
  const controllerPath = require.resolve("../controllers/EstoqueAtualizacaoController");
  delete require.cache[controllerPath];
  const controller = require("../controllers/EstoqueAtualizacaoController");
  Module._load = originalLoad;
  let statusCode;
  let response;
  const res = {
    locals: { mlCreds: { meli_conta_id: "should-not-be-account-key" } },
    status(code) { statusCode = code; return this; },
    json(payload) { response = payload; return this; },
  };

  await controller.enqueue({ body: { changes: [{ mlb: "MLB123456789" }] }, user: {} }, res);

  assert.equal(enqueued, false);
  assert.equal(statusCode, 409);
  assert.match(response.error, /conta.*identificada/i);
});
