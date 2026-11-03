"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const Engine = require("../services/promoSmartScanEngine");

test("normaliza somente os modos quick e full", () => {
  assert.equal(Engine.normalizeMode("quick"), "quick");
  assert.equal(Engine.normalizeMode("FULL"), "full");
  assert.equal(Engine.normalizeMode(), "quick");
  assert.throws(() => Engine.normalizeMode("turbo"), /modo/i);
});

test("quick prioriza campanhas ativas e com sobreposicao", () => {
  const campaigns = [
    { id: "future", status: "pending", start_date: "2026-12-01", finish_date: "2026-12-31" },
    { id: "isolated", status: "started", start_date: "2026-08-01", finish_date: "2026-08-31" },
    { id: "active-a", status: "started", start_date: "2026-11-01", finish_date: "2026-11-30" },
    { id: "active-b", status: "started", start_date: "2026-11-10", finish_date: "2026-12-10" },
  ];

  assert.deepEqual(
    Engine.planCampaigns(campaigns, { mode: "quick", now: "2026-11-03T12:00:00Z" }).map((row) => row.id),
    ["active-a", "active-b", "isolated", "future"],
  );
});

test("full preserva todas as campanhas relevantes na ordem recebida", () => {
  const campaigns = [{ id: "a", status: "started" }, { id: "b", status: "pending" }];
  assert.deepEqual(Engine.planCampaigns(campaigns, { mode: "full" }).map((row) => row.id), ["a", "b"]);
});

test("pagina curta continua enquanto total declarado estiver pendente", () => {
  assert.deepEqual(
    Engine.nextPage({ rowsCount: 12, collectedCount: 12, total: 90, offset: 0, returnedLimit: 50 }),
    { done: false, strategy: "offset", offset: 50 },
  );
});

test("cursor repetido encerra como inconclusivo", () => {
  const result = Engine.nextPage({
    rowsCount: 50,
    collectedCount: 50,
    nextCursor: "same",
    seenCursors: new Set(["same"]),
  });
  assert.deepEqual(result, { done: true, coverage: "inconclusive", reason: "repeated_cursor" });
});

test("pagina contendo apenas duplicados ainda avanca quando total esta pendente", () => {
  const result = Engine.nextPage({
    rowsCount: 50,
    collectedCount: 50,
    addedCount: 0,
    total: 150,
    offset: 50,
    returnedLimit: 50,
  });
  assert.deepEqual(result, { done: false, strategy: "offset", offset: 100 });
});

test("pagina terminal vazia sem total comprova o fim", () => {
  assert.deepEqual(Engine.nextPage({ rowsCount: 0, collectedCount: 25, offset: 25 }), {
    done: true,
    coverage: "complete",
    reason: "empty_terminal_page",
  });
});

test("resposta sem total nem continuacao fica indeterminada", () => {
  assert.deepEqual(Engine.nextPage({ rowsCount: 12, collectedCount: 12, offset: 0 }), {
    done: true,
    coverage: "indeterminate",
    reason: "no_continuation_evidence",
  });
});
