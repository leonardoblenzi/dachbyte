"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("taxa global positiva prevalece e zero preserva taxa legada", () => {
  const { resolveTaxRate } = require("../src/services/effectiveTax");
  assert.equal(resolveTaxRate({ globalRate: 10, legacyRate: 6 }), 10);
  assert.equal(resolveTaxRate({ globalRate: 0, legacyRate: 6 }), 6);
  assert.equal(resolveTaxRate({ globalRate: null, legacyRate: 6 }), 6);
});

test("requisição sem account_id recebe erro de validação, mesmo sem corpo", async () => {
  const { getTax } = require("../src/controllers/financialController");
  const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(payload) { this.payload = payload; return this; } };
  await getTax({ query: {}, magaluIdentity: { dachTenantId: "tenant-1" } }, response);
  assert.equal(response.statusCode, 400);
  assert.match(response.payload.message, /account_id/);
});

test("migração mantém histórico fiscal e de custo por conta e SKU", () => {
  const migrations = path.join(__dirname, "../db/migrations");
  const sql = fs.readdirSync(migrations).filter((name) => name.endsWith(".sql"))
    .map((name) => fs.readFileSync(path.join(migrations, name), "utf8")).join("\n");
  assert.match(sql, /magalu\.finance_settings\b/);
  assert.match(sql, /magalu\.finance_settings_history\b/);
  assert.match(sql, /magalu\.sku_cost_history\b/);
  for (const column of ["account_id", "sku", "previous_cost", "new_cost", "source", "changed_by", "created_at"]) {
    assert.match(sql, new RegExp(`\\b${column}\\b`));
  }
});

test("alíquota global inválida é rejeitada antes de consultar o banco", async () => {
  const { saveAccountTax } = require("../src/repositories/financialRepository");
  for (const rate of [null, "", -1, 101, "abc"]) {
    await assert.rejects(() => saveAccountTax(1, rate, "user-1"), { status: 422 });
  }
});

test("salvar alíquota registra o valor anterior na mesma transação", async () => {
  const db = require("../src/config/postgres");
  const previous = db.withClient;
  const calls = [];
  db.withClient = async (fn) => fn({ query: async (sql, params) => {
    calls.push({ sql, params });
    if (/select aliquota/.test(sql)) return { rows: [{ aliquota: "6" }] };
    if (/returning aliquota/.test(sql)) return { rows: [{ aliquota: "10", updated_at: "now" }] };
    return { rows: [] };
  } });
  try {
    const { saveAccountTax } = require("../src/repositories/financialRepository");
    const result = await saveAccountTax(1, 10, "user-1");
    assert.equal(result.aliquota, 10);
    assert.match(calls.map((call) => call.sql).join("\n"), /finance_settings_history/);
    assert.ok(calls.some((call) => call.params?.includes("user-1")));
    assert.equal(calls[0].sql, "BEGIN");
    assert.equal(calls.at(-1).sql, "COMMIT");
  } finally { db.withClient = previous; }
});

test("edição manual de custo registra histórico na mesma transação", async () => {
  const db = require("../src/config/postgres");
  const previous = db.withClient;
  const calls = [];
  db.withClient = async (fn) => fn({ query: async (sql, params) => {
    calls.push({ sql, params });
    if (/select s\.sku/.test(sql)) return { rows: [{ sku: "SKU-1", unit_cost: "5", tax_rate: "6", packaging_cost: "0", operational_cost: "0", other_cost: "0", notes: null }] };
    if (/returning \*/.test(sql)) return { rows: [{ sku: "SKU-1", unit_cost: "7" }] };
    return { rows: [] };
  } });
  try {
    const { upsertCost } = require("../src/repositories/financialRepository");
    await upsertCost(1, "SKU-1", { unit_cost: 7 }, { changedBy: "user-1", source: "manual" });
    assert.equal(calls[0].sql, "BEGIN");
    assert.equal(calls.at(-1).sql, "COMMIT");
    const history = calls.find((call) => /insert into magalu\.sku_cost_history/.test(call.sql));
    assert.ok(history);
    assert.ok(history.params.includes("user-1"));
    assert.ok(history.params.includes("manual"));
  } finally { db.withClient = previous; }
});
