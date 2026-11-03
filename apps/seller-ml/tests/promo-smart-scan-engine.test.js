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

test("coletor nao para em pagina composta somente por duplicados", async () => {
  const pages = [
    { rows: [{ id: "A" }], total: 3, returnedLimit: 1 },
    { rows: [{ id: "A" }], total: 3, returnedLimit: 1 },
    { rows: [{ id: "B" }], total: 3, returnedLimit: 1 },
  ];
  const result = await Engine.collectPages({
    maxPages: 10,
    rowKey: (row) => row.id,
    fetchPage: async ({ page }) => pages[page],
  });

  assert.deepEqual(result.rows.map((row) => row.id), ["A", "B"]);
  assert.equal(result.coverage.state, "complete");
  assert.equal(result.coverage.reason, "declared_total_reached");
  assert.equal(result.coverage.pages, 3);
});

test("coletor marca limite de paginas como parcial", async () => {
  const result = await Engine.collectPages({
    maxPages: 1,
    rowKey: (row) => row.id,
    fetchPage: async () => ({ rows: [{ id: "A" }], total: 2, returnedLimit: 1 }),
  });

  assert.equal(result.coverage.state, "partial");
  assert.equal(result.coverage.reason, "page_budget_reached");
  assert.equal(result.coverage.expected, 2);
  assert.equal(result.coverage.collected, 1);
});

test("coletor publica checkpoint apos cada pagina", async () => {
  const checkpoints = [];
  await Engine.collectPages({
    maxPages: 2,
    rowKey: (row) => row.id,
    fetchPage: async ({ page }) => page === 0
      ? { rows: [{ id: "A" }], total: 1, returnedLimit: 1 }
      : { rows: [], total: 1, returnedLimit: 1 },
    onCheckpoint: async (checkpoint) => checkpoints.push(checkpoint),
  });

  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].coverage, "complete");
  assert.equal(checkpoints[0].collected, 1);
});

test("coletor retoma linhas e offset de checkpoint anterior", async () => {
  const calls = [];
  const result = await Engine.collectPages({
    maxPages: 2,
    seedRows: [{ id: "A" }],
    offset: 1,
    scannedCount: 1,
    total: 2,
    rowKey: (row) => row.id,
    fetchPage: async (cursor) => {
      calls.push(cursor);
      return { rows: [{ id: "B" }], total: 2, returnedLimit: 1 };
    },
  });

  assert.equal(calls[0].offset, 1);
  assert.deepEqual(result.rows.map((row) => row.id), ["A", "B"]);
  assert.equal(result.coverage.state, "complete");
});

test("otimizacao aceita somente oportunidades com cobertura verificada", () => {
  const rows = [
    { id: "safe", classification: "verified", coverage_verified: true },
    { id: "review", classification: "review", coverage_verified: true },
    { id: "partial", classification: "verified", coverage_verified: false },
  ];
  assert.deepEqual(
    Engine.filterVerifiedOpportunities(rows, new Set(["safe", "review", "partial"])).map((row) => row.id),
    ["safe"],
  );
});

test("pool limita concorrencia e preserva ordem dos resultados", async () => {
  let active = 0;
  let peak = 0;
  const results = await Engine.mapWithConcurrency([1, 2, 3, 4], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, value % 2 ? 4 : 1));
    active -= 1;
    return value * 10;
  });
  assert.equal(peak, 2);
  assert.deepEqual(results, [10, 20, 30, 40]);
});
