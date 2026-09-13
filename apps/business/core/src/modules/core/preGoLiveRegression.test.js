"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const db = require("../../../db/db");
const runtime = require("./persistentCoreService");

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", "..", "..", relativePath), "utf8");
}

test("master user creation requires an explicit company selection", () => {
  const modalConfig = source("src/client/modals/config.js");
  const modalFields = source("src/client/modals/ActionModalSections.jsx");

  assert.match(modalConfig, /name: "companyId"[\s\S]*placeholder: "Selecione a empresa"/);
  assert.match(modalFields, /field\.placeholder \? <option value="" disabled>\{field\.placeholder\}<\/option> : null/);
});

test("persistent cash closing accepts pt-BR counted amount and persists explicit zero difference", async () => {
  const originalWithClient = db.withClient;
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ text, params });
      if (text === "begin" || text === "commit" || text === "rollback") return { rowCount: 0, rows: [] };
      if (text.includes("from volt_core.cash_sessions") && text.includes("for update")) {
        return {
          rowCount: 1,
          rows: [{ id: "cas-1", number: 3, status: "open", opening_amount: "1000.00", opened_at: "2026-08-10T10:00:00.000Z", notes: null }],
        };
      }
      if (text.includes("from volt_core.cash_movements")) {
        return { rowCount: 1, rows: [{ total: "106.87" }] };
      }
      if (text.startsWith("update volt_core.cash_sessions")) {
        return {
          rowCount: 1,
          rows: [{ id: "cas-1", number: 3, status: "closed", openingAmount: "1000.00", expectedAmount: "1106.87", countedAmount: "1106.87", differenceAmount: "0.00" }],
        };
      }
      if (text.startsWith("insert into volt_core.events")) return { rowCount: 1, rows: [{ id: 9001 }] };
      if (text.startsWith("insert into volt_core.integration_outbox_events")) return { rowCount: 1, rows: [{ id: params[0] }] };
      if (text.startsWith("insert into volt_core.audit_logs")) return { rowCount: 1, rows: [] };
      throw new Error(`Unexpected SQL in cash close regression test: ${text}`);
    },
  };

  db.withClient = async (fn) => fn(client);
  try {
    const closed = await runtime.closeCashSession("company-a", "cas-1", {
      countedAmount: "R$ 1.106,87",
      actorUserId: "master-1",
    });
    assert.equal(closed.status, "closed");
    const update = calls.find((call) => call.text.startsWith("update volt_core.cash_sessions"));
    assert.ok(update);
    assert.deepEqual(update.params.slice(0, 5), ["company-a", "cas-1", 1106.87, 1106.87, 0]);
    assert.ok(calls.some((call) => call.text.startsWith("insert into volt_core.audit_logs")));
  } finally {
    db.withClient = originalWithClient;
  }
});

test("cash summary ignores historical sessions and starts from the currently open session", async () => {
  const cashService = require("./runtime/services/cashService");
  const originalWithClient = db.withClient;
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ text, params });
      if (text.includes("from volt_core.cash_sessions") && text.includes("status = 'open'")) {
        return { rowCount: 1, rows: [{ id: "cas-new", number: 9, status: "open", opening_amount: "50.00", opened_at: "2026-08-10T18:00:00.000Z" }] };
      }
      if (text.includes("from volt_core.cash_movements")) {
        assert.deepEqual(params, ["company-a", "cas-new", "2026-08-10T18:00:00.000Z"]);
        return { rowCount: 1, rows: [{ total: "0.00", movementCount: 0 }] };
      }
      throw new Error(`Unexpected SQL in cash summary regression test: ${text}`);
    },
  };
  db.withClient = async (fn) => fn(client);
  try {
    const summary = await cashService.getCashSummary("company-a");
    assert.equal(summary.balance, 50);
    assert.equal(summary.expectedAmount, 50);
    assert.equal(summary.openingAmount, 50);
    assert.equal(summary.sessionId, "cas-new");
    assert.equal(summary.movementCount, 0);
    assert.ok(calls.every((call) => !/where company_id = \$1;$/.test(call.text)));
  } finally {
    db.withClient = originalWithClient;
  }
});

test("manual cash movement is transactionally attached to the open session", async () => {
  const cashService = require("./runtime/services/cashService");
  const originalWithClient = db.withClient;
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ text, params });
      if (text === "begin" || text === "commit" || text === "rollback") return { rowCount: 0, rows: [] };
      if (text.includes("from volt_core.cash_sessions") && text.includes("for update")) {
        assert.deepEqual(params, ["company-a", "cas-open"]);
        return { rowCount: 1, rows: [{ id: "cas-open" }] };
      }
      if (text.startsWith("insert into volt_core.cash_movements")) {
        assert.equal(params[1], "company-a");
        assert.equal(params[2], "cas-open");
        assert.equal(params[3], "entry");
        assert.equal(params[5], 20);
        return { rowCount: 1, rows: [{ id: params[0], sessionId: params[2], type: params[3], amount: params[5] }] };
      }
      if (text.startsWith("insert into volt_core.events")) return { rowCount: 1, rows: [{ id: 9002 }] };
      if (text.startsWith("insert into volt_core.integration_outbox_events")) return { rowCount: 1, rows: [{ id: params[0] }] };
      throw new Error(`Unexpected SQL in cash movement regression test: ${text}`);
    },
  };

  db.withClient = async (fn) => fn(client);
  try {
    const movement = await cashService.createCashMovement("company-a", {
      sessionId: "cas-open",
      amount: "20,00",
      type: "entry",
      paymentMethod: "cash",
    });
    assert.equal(movement.sessionId, "cas-open");
    assert.equal(movement.amount, 20);
    assert.ok(calls.some((call) => call.text === "commit"));
  } finally {
    db.withClient = originalWithClient;
  }
});

test("manual cash movement is rejected when there is no open session", async () => {
  const cashService = require("./runtime/services/cashService");
  const originalWithClient = db.withClient;
  let inserted = false;
  let rolledBack = false;
  const client = {
    async query(sql) {
      const text = String(sql).replace(/\s+/g, " ").trim();
      if (text === "begin") return { rowCount: 0, rows: [] };
      if (text === "rollback") { rolledBack = true; return { rowCount: 0, rows: [] }; }
      if (text.includes("from volt_core.cash_sessions") && text.includes("for update")) return { rowCount: 0, rows: [] };
      if (text.startsWith("insert into volt_core.cash_movements")) inserted = true;
      return { rowCount: 0, rows: [] };
    },
  };

  db.withClient = async (fn) => fn(client);
  try {
    await assert.rejects(
      () => cashService.createCashMovement("company-a", { amount: "20,00", type: "entry" }),
      (error) => error.code === "CASH_SESSION_NOT_OPEN" && error.statusCode === 409,
    );
    assert.equal(inserted, false);
    assert.equal(rolledBack, true);
  } finally {
    db.withClient = originalWithClient;
  }
});

test("receivable due date correction persists event and audit before committing", async () => {
  const financeService = require("./runtime/services/financeService");
  const originalWithClient = db.withClient;
  const calls = [];
  const before = {
    id: "rec-38",
    customerId: "customer-jonas",
    saleId: "sale-38",
    type: "store_credit",
    status: "open",
    dueDate: "2026-09-10",
    amount: "1399.00",
    paidAmount: "0.00",
    description: "Venda 38",
    metadata: {},
  };
  const client = {
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ text, params });
      if (["begin", "commit", "rollback"].includes(text)) return { rowCount: 0, rows: [] };
      if (text.includes("from volt_core.receivables") && text.includes("for update")) {
        assert.deepEqual(params, ["company-a", "rec-38"]);
        return { rowCount: 1, rows: [before] };
      }
      if (text.startsWith("update volt_core.receivables")) {
        assert.deepEqual(params.slice(0, 3), ["company-a", "rec-38", "2026-08-30"]);
        return { rowCount: 1, rows: [{ ...before, dueDate: "2026-08-30" }] };
      }
      if (text.startsWith("insert into volt_core.events")) return { rowCount: 1, rows: [{ id: 9003 }] };
      if (text.startsWith("insert into volt_core.integration_outbox_events")) return { rowCount: 1, rows: [{ id: params[0] }] };
      if (text.startsWith("insert into volt_core.audit_logs")) return { rowCount: 1, rows: [] };
      throw new Error(`Unexpected SQL in receivable due date correction test: ${text}`);
    },
  };

  db.withClient = async (fn) => fn(client);
  try {
    const updated = await financeService.updateReceivableDueDate("company-a", "rec-38", {
      dueDate: "2026-08-30",
      reason: "Correcao conforme data operacional da venda 38",
      actorUserId: "master-1",
    });
    assert.equal(updated.dueDate, "2026-08-30");
    const event = calls.find((call) => call.text.startsWith("insert into volt_core.events"));
    const audit = calls.find((call) => call.text.startsWith("insert into volt_core.audit_logs"));
    assert.ok(event);
    assert.match(event.params[2], /receivableId/);
    assert.ok(audit);
    assert.equal(audit.params[1], "master-1");
    assert.equal(audit.params[2], "receivable.due_date_updated");
    assert.match(audit.params[7], /2026-09-10/);
    const update = calls.find((call) => call.text.startsWith("update volt_core.receivables"));
    const metadata = JSON.parse(update.params[3]);
    assert.equal(metadata.originalDueDate, "2026-09-10");
    assert.equal(metadata.currentDueDateSource, "administrative_correction");
    assert.equal(metadata.dueDateCorrections.length, 1);
    assert.equal(metadata.dueDateCorrections[0].reason, "Correcao conforme data operacional da venda 38");
    assert.equal(calls.at(-1).text, "commit");
  } finally {
    db.withClient = originalWithClient;
  }
});

test("receivable due date correction rejects missing reason, invalid dates and settled records", async () => {
  const financeService = require("./runtime/services/financeService");
  await assert.rejects(
    () => financeService.updateReceivableDueDate("company-a", "rec-1", { dueDate: "2026-08-30", reason: "", actorUserId: "master-1" }),
    (error) => error.code === "RECEIVABLE_DUE_DATE_REASON_REQUIRED" && error.statusCode === 400,
  );
  await assert.rejects(
    () => financeService.updateReceivableDueDate("company-a", "rec-1", { dueDate: "2026-02-31", reason: "Data incorreta", actorUserId: "master-1" }),
    (error) => error.code === "RECEIVABLE_DUE_DATE_INVALID" && error.statusCode === 400,
  );

  const originalWithClient = db.withClient;
  let updated = false;
  const client = {
    async query(sql) {
      const text = String(sql).replace(/\s+/g, " ").trim();
      if (["begin", "rollback"].includes(text)) return { rowCount: 0, rows: [] };
      if (text.includes("from volt_core.receivables") && text.includes("for update")) {
        return { rowCount: 1, rows: [{ id: "rec-paid", status: "paid", dueDate: "2026-09-10", amount: "1399.00", paidAmount: "1399.00" }] };
      }
      if (text.startsWith("update volt_core.receivables")) updated = true;
      return { rowCount: 0, rows: [] };
    },
  };
  db.withClient = async (fn) => fn(client);
  try {
    await assert.rejects(
      () => financeService.updateReceivableDueDate("company-a", "rec-paid", {
        dueDate: "2026-08-30",
        reason: "Tentativa de correcao posterior",
        actorUserId: "master-1",
      }),
      (error) => error.code === "RECEIVABLE_DUE_DATE_NOT_EDITABLE" && error.statusCode === 409,
    );
    assert.equal(updated, false);
  } finally {
    db.withClient = originalWithClient;
  }
});

test("sale receivables preserve customer-agreed dates and identify automatic fallback explicitly", () => {
  const salesService = require("./runtime/services/salesService");
  const soldAt = "2026-07-31T15:00:00.000Z";
  assert.equal(salesService.__test.defaultReceivableDueDate(soldAt), "2026-08-30");
  assert.deepEqual(
    salesService.__test.resolveReceivableDueDateDetails({ dueDate: "2026-09-15", dueDateSource: "customer_agreement" }, soldAt),
    { dueDate: "2026-09-15", source: "customer_agreement" },
  );
  assert.deepEqual(
    salesService.__test.resolveReceivableDueDateDetails({ dueDate: "2099-01-01", dueDateSource: "automatic_30_days" }, soldAt),
    { dueDate: "2026-08-30", source: "automatic_30_days" },
  );
  assert.equal(
    salesService.__test.resolveReceivableDueDate({ firstDueDate: "2026-09-20" }, soldAt),
    "2026-09-20",
  );
  assert.equal(salesService.__test.resolveReceivableDueDate({}, soldAt), "2026-08-30");
  assert.throws(
    () => salesService.__test.resolveReceivableDueDate({ dueDate: "2026-02-31", dueDateSource: "customer_agreement" }, soldAt),
    (error) => error.code === "PAYMENT_DUE_DATE_INVALID" && error.statusCode === 400,
  );

  const opticalState = source("src/client/extensions/optical/opticalSaleState.js");
  const genericState = source("src/client/modals/actionModalState.js");
  assert.match(opticalState, /DUE_DATE_SALE_PAYMENTS\.has\(payment\.method\) && payment\.dueDateAuto/);
  assert.match(opticalState, /name === "dueDate"[^\n]+dueDateAuto: false/);
  assert.match(opticalState, /dueDateSource:[\s\S]*automatic_30_days[\s\S]*customer_agreement/);
  assert.match(genericState, /name === "soldAt"[\s\S]*payment\.dueDateAuto === true/);
  assert.match(genericState, /name === "dueDate"[^\n]+dueDateAuto: false/);
  assert.match(genericState, /dueDateSource:[\s\S]*automatic_30_days[\s\S]*customer_agreement/);
});

test("receivable correction modal imports every lucide icon it renders", () => {
  const modalConfig = source("src/client/modals/config.js");
  const lucideImport = modalConfig.match(/import\s*\{([\s\S]*?)\}\s*from\s*["']lucide-react["']/)?.[1] || "";
  const importedIcons = new Set(lucideImport.split(",").map((item) => item.trim()).filter(Boolean));
  const renderedIcons = [...modalConfig.matchAll(/\bicon:\s*([A-Z][A-Za-z0-9_]*)/g)].map((match) => match[1]);
  const missingIcons = [...new Set(renderedIcons.filter((icon) => !importedIcons.has(icon)))];
  assert.deepEqual(missingIcons, []);
  assert.match(modalConfig, /CalendarClock/);
});

test("manual optical due date remains manual when the sale date changes", () => {
  const opticalState = source("src/client/extensions/optical/opticalSaleState.js");
  assert.match(opticalState, /if \(name === "dueDate"\) return \{ \.\.\.payment, dueDate: value, dueDateAuto: false \}/);
  assert.match(opticalState, /DUE_DATE_SALE_PAYMENTS\.has\(payment\.method\) && payment\.dueDateAuto[\s\S]*saleDefaultDueDate\(value\)/);
});

test("installment dates clamp to the last valid day while preserving the original anchor day", () => {
  const salesService = require("./runtime/services/salesService");
  assert.equal(salesService.__test.addMonthsToDate("2026-01-31", 0), "2026-01-31");
  assert.equal(salesService.__test.addMonthsToDate("2026-01-31", 1), "2026-02-28");
  assert.equal(salesService.__test.addMonthsToDate("2026-01-31", 2), "2026-03-31");
  assert.equal(salesService.__test.addMonthsToDate("2026-03-31", 1), "2026-04-30");
  assert.equal(salesService.__test.addMonthsToDate("2026-05-31", 1), "2026-06-30");
  assert.equal(salesService.__test.addMonthsToDate("2028-01-31", 1), "2028-02-29");
});

test("receivable mapping and sale details preserve original versus corrected due dates", () => {
  const mapper = source("src/client/workspace/mapWorkspaceToAppData.js");
  const main = source("src/client/main.jsx");
  assert.match(mapper, /originalDueDate: dateInputValue\(receivable\.metadata\?\.originalDueDate/);
  assert.match(mapper, /currentDueDateSource: receivable\.metadata\?\.currentDueDateSource/);
  assert.match(main, /Recebiveis vinculados/);
  assert.match(main, /Vencimento atual:/);
  assert.match(main, /Original:/);
  assert.match(main, /Motivo da correcao:/);
});

test("persistent cash closing rejects an empty counted amount before update", async () => {
  const originalWithClient = db.withClient;
  let updated = false;
  const client = {
    async query(sql) {
      const text = String(sql).replace(/\s+/g, " ").trim();
      if (text === "begin" || text === "rollback") return { rowCount: 0, rows: [] };
      if (text.includes("from volt_core.cash_sessions") && text.includes("for update")) {
        return { rowCount: 1, rows: [{ id: "cas-1", status: "open", opening_amount: "0", opened_at: "2026-08-10T10:00:00.000Z" }] };
      }
      if (text.startsWith("update volt_core.cash_sessions")) updated = true;
      return { rowCount: 0, rows: [] };
    },
  };
  db.withClient = async (fn) => fn(client);
  try {
    await assert.rejects(
      () => runtime.closeCashSession("company-a", "cas-1", { countedAmount: "" }),
      (error) => error.code === "CASH_COUNTED_AMOUNT_REQUIRED" && error.statusCode === 400,
    );
    assert.equal(updated, false);
  } finally {
    db.withClient = originalWithClient;
  }
});

test("currency formatter parses localized payment strings before formatting", () => {
  const text = source("src/client/core/formatters.js");
  assert.match(text, /typeof value === "number" \? value : parseMoney\(value\)/);
  assert.doesNotMatch(text, /\.format\(Number\(value \|\| 0\)\)/);
});

test("optical prescription number inputs allow negative quarter steps and bounded axes", () => {
  const renderer = source("src/client/modals/ActionModalSections.jsx");
  const config = source("src/client/extensions/optical/modalConfig.js");
  const coreConfig = source("src/client/modals/config.js");
  assert.match(renderer, /min=\{field\.min\}/);
  assert.match(renderer, /step=\{field\.step\}/);
  assert.doesNotMatch(renderer, /field\.type === "number" \? "0"/);
  assert.match(config, /rightSpherical[^\n]+step: "0\.25"/);
  assert.match(config, /leftCylindrical[^\n]+step: "0\.25"/);
  assert.match(config, /rightAxis[^\n]+min: "0"[^\n]+max: "180"[^\n]+step: "1"/);
  assert.match(coreConfig, /countedAmount: formatMoneyInput\(payload\.expected \|\| 0\)/);
});

test("native date fields report their value through the input event", () => {
  const renderer = source("src/client/modals/ActionModalSections.jsx");
  assert.match(renderer, /onInput=\{field\.type === "date" \? \(event\) => onValueChange\(field\.name, event\.currentTarget\.value\) : undefined\}/);
  assert.match(renderer, /onChange=\{field\.type === "date" \? undefined : \(event\) => onValueChange\(field\.name, event\.target\.value\)\}/);
});

test("client modal validates explicit numeric ranges and keeps server request id on failures", () => {
  const state = source("src/client/modals/actionModalState.js");
  const api = source("src/client/core/api.js");
  assert.match(state, /field\.min !== undefined && number < Number\(field\.min\)/);
  assert.match(state, /field\.max !== undefined && number > Number\(field\.max\)/);
  assert.match(api, /error\.requestId = requestId/);
  assert.match(api, /response\.status >= 500 && requestId/);
});

test("cash close and displayed balance share the same open-session calculation", () => {
  const runtimeSource = source("src/modules/core/runtime/services/cashService.js");
  const migration = source("db/013_cash_session_hardening.sql");
  assert.match(runtimeSource, /calculateSessionSummaryWithClient/);
  assert.match(runtimeSource, /session_id = \$2/);
  assert.match(runtimeSource, /session_id is null and operational_at >= \$3/);
  assert.doesNotMatch(runtimeSource, /from volt_core\.cash_movements\s+where company_id = \$1;[\s\S]*return result\.rows\[0\]/);
  assert.match(migration, /add column if not exists counted_amount numeric\(14,2\)/i);
  assert.match(migration, /add column if not exists difference_amount numeric\(14,2\)/i);
  assert.match(migration, /add column if not exists closed_by text/i);
  assert.match(migration, /add column if not exists closed_at timestamptz/i);
});

test("cash client uses the workspace session summary instead of historical totals", () => {
  const main = source("src/client/main.jsx");
  const mapper = source("src/client/workspace/mapWorkspaceToAppData.js");
  const handler = source("src/client/actions/handlers/shared.js");
  assert.match(mapper, /sessionId: row\.sessionId \|\| null/);
  assert.match(mapper, /hasWorkspaceField\(workspace, "cashSummary"\).*next\.cashSummary\s*=\s*\{/s);
  assert.match(main, /const currentRows = getCurrentCashRows\(cashRows, cashSummary, cashSessions\)/);
  assert.match(main, /const balance = openSession \? Number\(cashSummary\.balance/);
  assert.match(main, /hideAction=\{!openSession\}/);
  assert.match(handler, /workspace\?\.cashSummary\?\.sessionId/);
});
test("product lookup behaves as a floating popover and optical grid aligns fields at the top", () => {
  const renderer = source("src/client/modals/ActionModalSections.jsx");
  const styles = source("src/client/styles.css");
  assert.match(renderer, /const \[lookupOpen, setLookupOpen\] = React\.useState\(false\)/);
  assert.match(renderer, /onFocus=\{\(\) => setLookupOpen\(true\)\}/);
  assert.match(renderer, /setLookupOpen\(false\)/);
  assert.match(styles, /\.modal-lookup\s*\{[^}]*position:\s*relative/s);
  assert.match(styles, /\.modal-lookup__results\s*\{[^}]*position:\s*absolute/s);
  assert.match(styles, /\.optical-fields-grid\s*\{[^}]*align-items:\s*start;[^}]*align-content:\s*start;/s);
});

test("optical sale keeps OP and OS creation, listing and cancellation in one persisted lifecycle", () => {
  const saleHooks = source("src/extensions/optical/backend/saleHooks.js");
  const opticalService = source("src/extensions/optical/backend/opticalService.js");
  const dataQuery = source("src/modules/core/runtime/services/dataQueryService.js");
  const mapper = source("src/client/workspace/mapWorkspaceToAppData.js");
  assert.match(saleHooks, /createOpticalOrderWithClient\(client, companyId, sale, customer, items, optical, actorUserId\)/);
  assert.match(opticalService, /insert into volt_core\.optical_orders/);
  assert.match(opticalService, /insert into volt_core\.service_orders/);
  assert.match(opticalService, /sale_id,prescription_id,laboratory_id,optical_order_id/);
  assert.match(opticalService, /update volt_core\.optical_orders set service_order_id=\$3/);
  assert.match(dataQuery, /data: \{ serviceOrders: result\.rows \}/);
  assert.match(mapper, /if \(hasWorkspaceField\(workspace, "serviceOrders"\)\) next\.serviceOrders/);
  assert.match(mapper, /recordId: order\.id/);
  assert.match(saleHooks, /update volt_core\.optical_orders set status = 'canceled'/);
  assert.match(saleHooks, /update volt_core\.service_orders set status = 'canceled'/);
});

test("sales editing preserves financial integrity and inventory lookup uses the persisted catalog", () => {
  const salesService = source("src/modules/core/runtime/services/salesService.js");
  const saleHooks = source("src/extensions/optical/backend/saleHooks.js");
  const routes = source("src/routes/core.routes.js");
  const modalConfig = source("src/client/modals/config.js");
  const modalState = source("src/client/modals/actionModalState.js");
  const salesPage = source("src/client/main.jsx");
  assert.match(salesService, /async function updateSale\(companyId, saleId, input = \{\}\)/);
  assert.match(salesService, /SALE_EDIT_HAS_SETTLED_RECEIVABLE/);
  assert.match(saleHooks, /SALE_EDIT_OPTICAL_REQUIRES_CANCELLATION/);
  assert.match(salesService, /source_type in \('sale', 'sale_edit', 'sale_edit_reversal'\)/);
  assert.match(salesService, /replaceExisting: true/);
  assert.match(routes, /router\.patch\("\/runtime\/companies\/:companyId\/sales\/:saleId"/);
  assert.match(modalConfig, /saleEdit:\s*\{/);
  assert.match(modalConfig, /type: "product_lookup", resource: "products"/);
  assert.match(modalState, /\["customer_lookup", "product_lookup"\]\.includes\(field\.type\)/);
  assert.match(salesPage, /onAction\("saleEdit", sale\)/);
});

test("inventory adjustments remain adjustments regardless of whether they increase or decrease stock", () => {
  const mapper = source("src/client/workspace/mapWorkspaceToAppData.js");
  const queries = source("src/modules/core/runtime/services/dataQueryService.js");

  assert.match(mapper, /movement\.type === "adjustment" \? "Ajuste" : Number\(movement\.quantity \|\| 0\) < 0 \? "Saida" : "Entrada"/);
  assert.match(queries, /\$3='saida' and m\.quantity<0 and m\.type<>'adjustment'/);
});

test("delivery payment persists a reserved order and postpones financial settlement", () => {
  const migration = source("db/016_delivery_payment_sales.sql");
  const salesService = source("src/modules/core/runtime/services/salesService.js");
  const dataQuery = source("src/modules/core/runtime/services/dataQueryService.js");
  const controller = source("src/controllers/RuntimeController.js");
  const routes = source("src/routes/core.routes.js");

  assert.match(migration, /payment_timing text not null default 'immediate'/i);
  assert.match(migration, /promised_delivery_date date/i);
  assert.match(migration, /delivered_at timestamptz/i);
  assert.match(salesService, /function isDeliveryPayment\(input = \{\}\)/);
  assert.match(salesService, /async function completeSaleDelivery\(companyId, saleId, input = \{\}\)/);
  assert.match(salesService, /"pending_delivery"/);
  assert.match(salesService, /sale\.afterDeliveryCompleted/);
  assert.match(dataQuery, /payment_timing as "paymentTiming"/);
  assert.match(dataQuery, /promised_delivery_date as "promisedDeliveryDate"/);
  assert.match(controller, /async function completeSaleDelivery\(req, res\)/);
  assert.match(routes, /sales\/:saleId\/complete-delivery/);
});

test("optical delivery settles only ready orders and delivers the linked service order", () => {
  const manifest = source("src/extensions/optical/manifest.js");
  const saleHooks = source("src/extensions/optical/backend/saleHooks.js");

  assert.match(manifest, /sale\.afterDeliveryCompleted/);
  assert.match(saleHooks, /async function afterDeliveryCompleted\(\{ client, companyId, sale, actorUserId \}\)/);
  assert.match(saleHooks, /OPTICAL_ORDER_NOT_READY_FOR_DELIVERY/);
  assert.match(saleHooks, /update volt_core\.optical_orders set status = 'delivered'/);
  assert.match(saleHooks, /update volt_core\.service_orders set status = 'delivered'/);
  assert.match(saleHooks, /insertWorkflowEventWithClient/);
});

test("delivery payment UI contract creates orders and settles them from pedidos", () => {
  const saleState = source("src/client/extensions/optical/opticalSaleState.js");
  const pdv = source("src/client/extensions/optical/OpticalSalesPdvView.jsx");
  const handlers = source("src/client/actions/handlers/catalog.js");
  const main = source("src/client/main.jsx");

  assert.match(saleState, /paymentTiming: draft\.paymentTiming \|\| "immediate"/);
  assert.match(saleState, /promisedDeliveryDate: draft\.paymentTiming === "delivery" \? draft\.promisedDate : null/);
  assert.match(pdv, /Pagar na entrega/);
  assert.match(pdv, /O pagamento sera informado na retirada/);
  assert.match(main, /Concluir pedido/);
  assert.match(handlers, /complete-delivery/);
});

test("clinical prescription uses distance and near zones with shared ADD and D.P.", () => {
  const saleState = source("src/client/extensions/optical/opticalSaleState.js");
  const pdv = source("src/client/extensions/optical/OpticalSalesPdvView.jsx");
  const opticalService = source("src/modules/core/runtime/services/opticalService.js");

  assert.match(saleState, /function buildPrescriptionPayload\(prescription = \{\}\)/);
  assert.match(saleState, /const sharedAddition = addition \|\| rightAddition \|\| leftAddition \|\| null/);
  assert.match(saleState, /rightAddition: sharedAddition/);
  assert.match(saleState, /leftAddition: sharedAddition/);
  assert.match(saleState, /metadata:[\s\S]*near:[\s\S]*spherical:[\s\S]*cylindrical:[\s\S]*axis:/);
  assert.match(pdv, /prescription-clinical-grid/);
  assert.match(pdv, /prescription-addition/);
  assert.match(pdv, /Longe/);
  assert.match(pdv, /Perto/);
  assert.match(pdv, /D\.P\./);
  assert.doesNotMatch(pdv, /OpticalMeasurementsStep/);
  assert.doesNotMatch(pdv, /title="Medidas"/);
  assert.doesNotMatch(pdv, /nearRightAddition/);
  assert.doesNotMatch(saleState, /measurementsMode: draft\.measurementsMode/);
  assert.doesNotMatch(opticalService, /optical\.measurementsMode === "later"/);
});

test("optical PDV shows one selected context card instead of duplicating lookup results", () => {
  const pdv = source("src/client/extensions/optical/OpticalSalesPdvView.jsx");

  assert.match(pdv, /const visibleResults = !selectedProduct && productQuery\.trim\(\) \? visibleProducts\.slice\(0, 8\) : \[\]/);
  assert.match(pdv, /const visibleCustomers = !customer && normalizedQuery/);
  assert.match(pdv, /Trocar produto/);
  assert.match(pdv, /Trocar cliente/);
});

test("optical sale draft storage is scoped and resilient", async () => {
  const storageSource = source("src/client/extensions/optical/opticalSaleDraftStorage.js");
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(storageSource).toString("base64")}`;
  const draftStorage = await import(moduleUrl);
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const scope = { companyId: "company-a", operatorId: "user-a" };
  const draft = { customerId: "customer-a", cart: [{ id: "product-a" }] };

  draftStorage.writeOpticalSaleDraft(storage, scope, draft);
  assert.deepEqual(draftStorage.readOpticalSaleDraft(storage, scope), draft);
  assert.equal(draftStorage.readOpticalSaleDraft(storage, { companyId: "company-b", operatorId: "user-a" }), null);

  values.set(draftStorage.opticalSaleDraftKey(scope), "invalid-json");
  assert.equal(draftStorage.readOpticalSaleDraft(storage, scope), null);

  draftStorage.clearOpticalSaleDraft(storage, scope);
  assert.equal(draftStorage.readOpticalSaleDraft(storage, scope), null);
});

test("optical PDV restores, saves and explicitly clears the scoped draft", () => {
  const controller = source("src/client/extensions/optical/OpticalSalesPdv.jsx");
  const view = source("src/client/extensions/optical/OpticalSalesPdvView.jsx");
  const main = source("src/client/main.jsx");

  assert.match(controller, /readOpticalSaleDraft\(storage, scope\)/);
  assert.match(controller, /writeOpticalSaleDraft\(storage, draftScope, draft\)/);
  assert.match(controller, /clearOpticalSaleDraft\(storage, draftScope\)/);
  assert.match(controller, /onClearDraft=\{clearDraft\}/);
  assert.match(view, /Limpar venda/);
  assert.match(main, /draftScope:[\s\S]*companyId: selectedCompanyId[\s\S]*operatorId:/);
});

test("delivery date belongs to delivery checkout instead of customer section", () => {
  const pdv = source("src/client/extensions/optical/OpticalSalesPdvView.jsx");
  const customerSection = pdv.slice(pdv.indexOf("function OpticalSaleCustomer"), pdv.indexOf("function OpticalSalePendingSteps"));
  const checkoutSection = pdv.slice(pdv.indexOf("function OpticalSaleCheckout"), pdv.indexOf("function OpticalSaleReview"));

  assert.match(customerSection, /title="Cliente"/);
  assert.doesNotMatch(customerSection, /Cliente e entrega|Previsao de entrega|promisedDate/);
  assert.match(checkoutSection, /isPaymentOnDelivery[\s\S]*Previsao de entrega \*[\s\S]*type="date"/);
  assert.match(checkoutSection, /value=\{draft\.promisedDate\}/);
  assert.match(checkoutSection, /onFieldChange\("promisedDate", event\.target\.value\)/);
});

test("orders keep a simple business status while delivery and finance stay independent", () => {
  const main = source("src/client/main.jsx");
  const dataQuery = source("src/modules/core/runtime/services/dataQueryService.js");
  const orders = main.slice(main.indexOf("function saleOperationalStatus"), main.indexOf("function receivableDueDateSourceLabel"));
  const statusPill = main.slice(main.indexOf("function StatusPill"), main.indexOf("function FormGrid"));

  assert.match(orders, /"Cliente", "Itens", "Entrega", "Status", "Total", "Financeiro", "Acoes"/);
  assert.match(orders, /return "Em andamento"/);
  assert.match(orders, /return "Concluido"/);
  assert.match(orders, /return "Cancelado"/);
  assert.match(orders, /Pronto para retirada/);
  assert.match(orders, /Marcar como pronto/);
  assert.match(orders, /Concluir pedido/);
  assert.match(orders, /Financeiro do pedido/);
  assert.match(orders, /Ver em Recebiveis/);
  assert.match(orders, /receivableReceive/);
  assert.match(orders, /vencidos/);
  assert.match(orders, /a receber/);
  assert.doesNotMatch(orders, /function OrderProgressSelect/);
  assert.match(orders, /<MoreOptionsMenu/);
  assert.match(orders, /secondarySaleActions/);
  assert.match(dataQuery, /\["em andamento", "s\.status='pending_delivery'"\]/);
  assert.match(dataQuery, /\["em_andamento", "s\.status='pending_delivery'"\]/);
  assert.match(dataQuery, /\["a receber",/);
  assert.match(dataQuery, /\["a_receber",/);
  assert.match(dataQuery, /\["vencidos",/);
  assert.match(dataQuery, /\["vencido",/);
  assert.match(statusPill, /"concluido"/);
  assert.match(statusPill, /"cancelado"/);
});

test("future-delivery sales reserve stock until fulfillment and cancellation releases it", () => {
  const migration = source("db/019_stock_reservations.sql");
  const sales = source("src/modules/core/runtime/services/salesService.js");
  const reservations = source("src/modules/core/runtime/services/stockReservationService.js");
  assert.match(migration, /create table if not exists volt_core\.stock_reservations/i);
  assert.match(migration, /status text not null default 'active'/i);
  assert.match(migration, /force row level security/i);
  assert.match(sales, /item\.product\.trackStock && !deliveryPayment/);
  assert.match(sales, /createSaleReservationsWithClient/);
  assert.match(sales, /consumeSaleReservationsWithClient/);
  assert.match(sales, /releaseSaleReservationsWithClient/);
  assert.match(reservations, /INSUFFICIENT_AVAILABLE_STOCK/);
  assert.match(reservations, /STOCK_RESERVATION_MISSING_OR_INCONSISTENT/);
  assert.match(reservations, /source_type,source_id[\s\S]*'sale'/);
});

test("inventory exposes physical, reserved and available stock plus reservation history", () => {
  const query = source("src/modules/core/runtime/services/dataQueryService.js");
  const mapper = source("src/client/workspace/mapWorkspaceToAppData.js");
  const main = source("src/client/main.jsx");
  const registry = source("src/client/extensions/registry.js");
  assert.match(query, /reservedStockQuantity/);
  assert.match(query, /availableStockQuantity/);
  assert.match(query, /listStockReservationsPage/);
  assert.match(mapper, /physicalStock:/);
  assert.match(mapper, /reservedStock:/);
  assert.match(mapper, /availableStock:/);
  assert.match(main, /label: "Reservas"/);
  assert.match(main, /"Fisico", "Reservado", "Disponivel", "Minimo"/);
  assert.match(registry, /stockReservations: Object\.freeze\(\{ path: "stock-reservations", paged: true \}\)/);
});

test("orders use domain actions instead of exposing the optical workflow as a status selector", () => {
  const main = source("src/client/main.jsx");
  const opticalMapper = source("src/client/extensions/optical/workspaceMapper.js");
  const opticalService = source("src/extensions/optical/backend/opticalService.js");
  const opticalRoutes = source("src/extensions/optical/backend/routes.js");
  const opticalHook = source("src/extensions/optical/backend/saleHooks.js");
  assert.doesNotMatch(main, /function OrderProgressSelect/);
  assert.doesNotMatch(main, /<select aria-label=\{`Andamento do pedido/);
  assert.match(main, /opticalMarkReady/);
  assert.match(main, /Marcar como pronto/);
  assert.match(main, /Concluir pedido/);
  assert.match(opticalMapper, /workflowProgress/);
  assert.match(opticalMapper, /fulfillmentReady: current === "ready"/);
  assert.match(opticalService, /async function markOpticalOrderReady/);
  assert.match(opticalService, /source: "operator_mark_ready"/);
  assert.match(opticalRoutes, /optical-orders\/:opticalOrderId\/mark-ready/);
  assert.match(opticalHook, /sale\.afterDeliveryCompleted|afterDeliveryCompleted/);
});

test("payments and receivables expose pending balance, overdue and upcoming controls", () => {
  const query = source("src/modules/core/runtime/services/dataQueryService.js");
  const mapper = source("src/client/workspace/mapWorkspaceToAppData.js");
  const main = source("src/client/main.jsx");
  const salesUi = source("src/client/core/sales.js");
  const paymentMethods = source("src/modules/core/paymentMethods.js");
  assert.match(query, /"overdueAmount"/);
  assert.match(query, /"dueTodayAmount"/);
  assert.match(query, /"next7Amount"/);
  assert.match(query, /"balanceAmount"/);
  assert.match(mapper, /balanceValue: formatCurrency\(balanceAmount\)/);
  assert.match(mapper, /status: isOverdue \? "Vencido"/);
  assert.match(main, /id: "pending", label: "Pendentes"/);
  assert.match(main, /title="A receber"/);
  assert.match(main, /title="Vencido"/);
  assert.match(main, /"Valor", "Recebido", "Saldo"/);
  assert.match(salesUi, /store_credit", label: "Crediario \/ Carne"/);
  assert.match(salesUi, /INSTALLMENT_SALE_PAYMENTS = new Set\(\["credit_card", "store_credit", "check", "boleto"\]\)/);
  assert.match(paymentMethods, /key: "boleto"[\s\S]*behavior: "receivable"[\s\S]*allowsInstallments: true/);
});
