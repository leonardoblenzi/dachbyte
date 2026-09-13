"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const ExcelJS = require("exceljs");

process.env.DATABASE_URL ||= "postgresql://audit-test:audit-test@127.0.0.1:5432/audit-test";

const db = require("../db/db");
const {
  exportAuthEventsXlsx,
  listAuthEvents,
  normalizeAuditIdentifiers,
} = require("../services/authAuditService");

test("normalizes and deduplicates MLB and promotion identifiers", () => {
  assert.deepEqual(
    normalizeAuditIdentifiers("mlb123, MLB456\nmlb123", /^MLB\d+$/i),
    ["MLB123", "MLB456"],
  );
  assert.deepEqual(
    normalizeAuditIdentifiers("p-mlb17679134; P-MLB99", /^P-MLB[A-Z0-9_-]+$/i),
    ["P-MLB17679134", "P-MLB99"],
  );
});

test("builds exact structured filters for MLB and promotion identifiers", async (t) => {
  const originalQuery = db.query;
  const calls = [];
  db.query = async (sql, params) => {
    calls.push({ sql, params });
    return calls.length === 1 ? { rows: [{ total: 1 }] } : { rows: [] };
  };
  t.after(() => {
    db.query = originalQuery;
  });

  const result = await listAuthEvents({
    mlb_ids: "mlb4575877101",
    promotion_ids: "p-mlb17679134",
    page: 1,
    limit: 25,
  });

  assert.equal(result.total, 1);
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /metadata \? 'mlb_id'/);
  assert.match(calls[0].sql, /metadata \? 'promotion_id'/);
  assert.deepEqual(calls[0].params, [["MLB4575877101"], ["P-MLB17679134"]]);
});

test("rejects an invalid identifier instead of returning every audit event", async () => {
  await assert.rejects(
    () => listAuthEvents({ mlb_ids: "4575877101" }),
    (error) => error?.statusCode === 400 && /MLB valido/i.test(error.message),
  );
});

test("exports audit events as XLSX with the applied filters", async (t) => {
  const originalQuery = db.query;
  const calls = [];
  db.query = async (sql, params) => {
    calls.push({ sql, params });
    if (calls.length === 1) return { rows: [{ total: 1 }] };
    return {
      rows: [
        {
          created_at: "2026-07-14T12:34:00.000Z",
          email: "usuario@teste.com",
          user_nome: "Usuario Teste",
          evento: "promotion_item_processed",
          status: "success",
          ip: "127.0.0.1",
          metadata: {
            accountLabel: "Conta Teste",
            mlb_id: "MLB123",
            promotion_id: "P-MLB456",
            promotion_name: "Promo Teste",
            promotion_type: "SMART",
            requested_percent: 23,
            real_applied_percent: 22.5,
            job_id: 99,
          },
        },
      ],
    };
  };
  t.after(() => {
    db.query = originalQuery;
  });

  const result = await exportAuthEventsXlsx({
    mlb_ids: "MLB123",
    promotion_ids: "P-MLB456",
  });

  assert.equal(result.exported, 1);
  assert.ok(Buffer.isBuffer(result.buffer));

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(result.buffer);
  const sheet = workbook.getWorksheet("Auditoria");
  assert.ok(sheet);
  assert.equal(sheet.getRow(1).getCell(1).value, "quando");
  assert.equal(sheet.getRow(2).getCell(8).value, "MLB123");
  assert.equal(sheet.getRow(2).getCell(9).value, "P-MLB456");
  assert.equal(sheet.getRow(2).getCell(16).value, 23);
  assert.equal(sheet.getRow(2).getCell(18).value, 22.5);
  assert.ok(sheet.autoFilter);
});
