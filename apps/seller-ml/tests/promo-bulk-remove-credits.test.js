"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const service = fs.readFileSync(path.join(__dirname, "../services/promoBulkRemoveAdapter.js"), "utf8");
const routes = fs.readFileSync(path.join(__dirname, "../routes/promocoesRoutes.js"), "utf8");
const client = fs.readFileSync(path.join(__dirname, "../public/js/remover-promocao.js"), "utf8");
const view = fs.readFileSync(path.join(__dirname, "../views/remover-promocao.html"), "utf8");
process.env.ML_DATABASE_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.REDIS_URL ||= "redis://127.0.0.1:6379";
const { _test } = require("../services/promoBulkRemoveAdapter");

test("remoção em lote tem cotação e confirmação antes do job", () => {
  assert.match(routes, /\/api\/promocoes\/jobs\/remove\/credits\/quote/);
  assert.match(client, /CreditOperationModal\.confirm/);
  assert.match(view, /credit-operation-modal\.js/);
});

test("remoção em lote reserva antes de enfileirar e liquida somente sucessos", () => {
  assert.match(service, /reserveCredits\(/);
  assert.match(service, /settleCredits\(/);
  assert.match(service, /consumedUnits:\s*billable/);
  assert.match(service, /promotions\.remove/);
});

test("remoção parcial cobra só sucessos e expõe gasto confirmado", async () => {
  const calls = [];
  const job = {
    data: { creditReservation: { reserved_credits: 2, credit_unit_scale: 100 } },
    async update(data) { this.data = data; },
  };
  await _test.settleRemoveJob(job, 1, {
    settle: async (_reservation, options) => {
      calls.push(options);
      return { status: "consumed", reserved_credits: 200, consumed_credits: 100, credit_unit_scale: 100 };
    },
  });
  assert.deepEqual(calls, [{ release: false, consumedUnits: 1 }]);
  assert.deepEqual(job.data.__meta.credit_settlement, {
    status: "confirmed", reserved_credits: 2, spent_credits: 1, released_credits: 1,
  });
});

test("item sem promoção ativa é ignorado, não faturável", () => {
  assert.deepEqual(_test.removeOutcomeFromResponse({ success: true, tinha_promocao: false }), {
    ok: true, changed: false,
  });
  assert.deepEqual(_test.removeOutcomeFromResponse({
    success: true, tinha_promocao: true, promocoes_removidas: ["DEAL-1"],
  }), { ok: true, changed: true });
});
