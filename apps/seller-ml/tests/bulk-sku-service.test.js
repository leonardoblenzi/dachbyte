"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { rowsFromItem, replaceSku, assertAccount, loadLiveItems, buildPreviewRows, exportRows, previewWorkbook, confirmPreview, listJobs } = require("../services/bulkSkuService");
const { exportWorkbook, parseWorkbook } = require("../services/bulkSkuWorkbookService");

test("item rows expose SKU, EAN and readable variation without changing the source", () => {
  const item = { id: "MLB123456", seller_id: 99, attributes: [{ id: "GTIN", value_name: "07891234567890" }], variations: [{ id: 987, attribute_combinations: [{ value_name: "Azul" }, { value_name: "P" }], attributes: [{ id: "SELLER_SKU", value_name: "OLD" }, { id: "GTIN", value_name: "7891234567890" }] }] };
  assert.deepEqual(rowsFromItem(item, "Loja A"), [{ conta: "Loja A", mlb: "MLB123456", id_variacao: "987", nome_variacao: "Azul / P", ean_gtin_atual: "7891234567890", sku_atual: "OLD", sku_novo: "" }]);
  assert.equal(item.variations[0].attributes[0].value_name, "OLD");
});

test("jobs panel lists only jobs scoped to the active account and user", async () => {
  const scopes = [];
  const db = { query: async (sql, params) => {
    scopes.push(params);
    if (sql.includes("bulk_sku_exports")) return { rows: [{ id: "e1", account_key: "acct", account_label: "Loja", status: "finished", filter_status: "active", scanned_items: 5100, exported_rows: 5100, created_at: new Date() }] };
    return { rows: [{ id: "c1", account_key: "acct", account_label: "Loja", status: "preview", previewed_rows: 5100, total_rows: 5100, created_at: new Date() }] };
  } };
  const jobs = await listJobs({ accountKey: "acct", sellerId: 9, accessToken: "token", requestedBy: "person" }, db);
  assert.equal(jobs.length, 2);
  assert.ok(scopes.slice(0, 2).every((scope) => scope[0] === "acct" && scope[1] === "person"));
  assert.match(jobs.find((job) => job.kind === "sku_export").review_action.url, /download\.xlsx$/);
  assert.equal(jobs.find((job) => job.kind === "sku_change").total, 5100);
});

test("application panel separates applied, unchanged and failed rows", async () => {
  const db = { query: async (sql) => {
    if (sql.includes("bulk_sku_exports")) return { rows: [] };
    if (sql.includes("bulk_sku_job_rows")) return { rows: [
      { job_id: "c1", state: "applied", count: 3 },
      { job_id: "c1", state: "unchanged", count: 1 },
      { job_id: "c1", state: "stale", count: 1 },
      { job_id: "c1", state: "error", count: 2 },
      { job_id: "c1", state: "invalid", count: 1 },
    ] };
    return { rows: [{ id: "c1", account_key: "acct", status: "finished", total_rows: 7, processed_rows: 7, created_at: new Date() }] };
  } };
  const jobs = await listJobs({ accountKey: "acct", sellerId: 9, accessToken: "token", requestedBy: "person" }, db);
  const job = jobs[0];
  assert.equal(job.success, 3);
  assert.equal(job.unchanged, 1);
  assert.equal(job.errors, 4);
  assert.equal(job.state, "partial");
  assert.match(job.review_action.url, /report\.xlsx$/);
});

test("preview with only spreadsheet errors still offers XLSX report", async () => {
  const db = { query: async (sql) => {
    if (sql.includes("bulk_sku_exports")) return { rows: [] };
    if (sql.includes("bulk_sku_job_rows")) return { rows: [{ job_id: "c1", state: "error", count: 2 }] };
    return { rows: [{ id: "c1", account_key: "acct", status: "preview", total_rows: 2, ready_rows: 0, created_at: new Date() }] };
  } };
  const [job] = await listJobs({ accountKey: "acct", sellerId: 9, accessToken: "token", requestedBy: "person" }, db);
  assert.equal(job.errors, 2);
  assert.match(job.review_action.url, /report\.xlsx$/);
});

test("confirmation requires the same account and user and queues only ready rows", async () => {
  const statements = [];
  const db = { withClient: async (fn) => fn({ query: async (sql, params) => {
    statements.push({ sql, params });
    if (/select .* from ml\.bulk_sku_jobs/i.test(sql)) return { rows: params[1] === "12" ? [{ id: "preview-1", status: "preview", account_key: "12", requested_by: "7" }] : [], rowCount: params[1] === "12" ? 1 : 0 };
    if (/count\(\*\)/i.test(sql)) return { rows: [{ count: "1" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  } }) };
  const queued = [];
  const billing = { reserveSkuCredits: async ({ units }) => ({ reserved_credits: 1, operation_quantity: units }), settleSkuCredits: async () => null };
  const job = await confirmPreview("preview-1", { accountKey: "12", sellerId: 99, accessToken: "token", requestedBy: "7", mlCreds: { meli_user_id: 99 } }, db, async (id) => queued.push(id), billing);
  assert.equal(job.id, "preview-1");
  assert.deepEqual(queued, ["preview-1"]);
  assert.ok(statements.some((entry) => /status = 'queued'/i.test(entry.sql)));
  assert.ok(statements.some((entry) => /credit_reservation/i.test(entry.sql)));
  await assert.rejects(confirmPreview("preview-1", { accountKey: "13", sellerId: 99, accessToken: "token", requestedBy: "7" }, db, async () => {}, billing), /nao encontrada/);
});

test("SKU quote usa somente linhas prontas da previa autorizada", async () => {
  const { quotePreview } = require("../services/bulkSkuService");
  let units = 0;
  const db = { query: async () => ({ rows: [{ status: "preview", ready: 2 }] }) };
  const result = await quotePreview("job-1", { accountKey: "12", sellerId: 99, accessToken: "token", requestedBy: "7", mlCreds: { meli_user_id: 99 } }, db, {
    quoteSkuCredits: async (input) => { units = input.units; return { quantity: input.units, estimated_credits: 1 }; },
  });
  assert.equal(units, 2);
  assert.equal(result.estimated_credits, 1);
});

test("saldo insuficiente impede enfileirar a alteração de SKUs", async () => {
  let enqueued = false;
  const db = { withClient: async (fn) => fn({ query: async (sql) => {
    if (/select .* from ml\.bulk_sku_jobs/i.test(sql)) return { rows: [{ status: "preview" }] };
    if (/count\(\*\)/i.test(sql)) return { rows: [{ count: 3 }] };
    return { rows: [] };
  } }) };
  await assert.rejects(confirmPreview("job-1", { accountKey: "12", sellerId: 99, accessToken: "token", requestedBy: "7" }, db, async () => { enqueued = true; }, {
    reserveSkuCredits: async () => { throw new Error("Credito insuficiente"); },
    settleSkuCredits: async () => null,
  }), /Credito insuficiente/);
  assert.equal(enqueued, false);
});

test("falha ambígua da fila mantém reserva e job para reenvio idempotente", async () => {
  const statements = [];
  const db = {
    withClient: async (fn) => fn({ query: async (sql) => {
      if (/select .* from ml\.bulk_sku_jobs/i.test(sql)) return { rows: [{ status: "preview" }] };
      if (/count\(\*\)/i.test(sql)) return { rows: [{ count: 3 }] };
      statements.push(sql); return { rows: [] };
    } }),
    query: async (sql) => { statements.push(sql); return { rows: [] }; },
  };
  let released = false;
  const originalError = console.error;
  console.error = () => {};
  let result;
  try { result = await confirmPreview("job-1", { accountKey: "12", sellerId: 99, accessToken: "token", requestedBy: "7" }, db, async () => { throw new Error("Fila indisponivel"); }, {
    reserveSkuCredits: async () => ({ reserved_credits: 1 }),
    settleSkuCredits: async () => { released = true; return { status: "confirmed" }; },
  }); } finally { console.error = originalError; }
  assert.equal(result.enqueue_pending, true);
  assert.equal(released, false);
  assert.ok(statements.some((sql) => /status = 'queued'/i.test(sql)));
});

test("liquidação do job usa somente estados applied e persiste resumo", async () => {
  const { settleJobCredits } = require("../services/bulkSkuService");
  const statements = [];
  const db = { query: async (sql, params) => {
    statements.push({ sql, params });
    if (/select credit_reservation/i.test(sql)) return { rows: [{ credit_reservation: { idempotency_key: "reserve-1", reserved_credits: 2 }, credit_settlement: null }] };
    if (/count\(\*\)/i.test(sql)) return { rows: [{ count: 2 }] };
    return { rows: [] };
  } };
  let applied = 0;
  const result = await settleJobCredits("job-1", db, { settleSkuCredits: async (_reservation, count) => {
    applied = count;
    return { status: "confirmed", spent_credits: 1, released_credits: 1 };
  } });
  assert.equal(applied, 2);
  assert.equal(result.status, "confirmed");
  assert.ok(statements.some(({ sql }) => /credit_settlement =/i.test(sql)));
});

test("preview persists results under the authenticated account and actor", async () => {
  const statements = [];
  const db = { withClient: async (fn) => fn({ query: async (sql, params) => { statements.push({ sql, params }); return { rows: [], rowCount: 0 }; } }) };
  const ml = { get: async () => [{ code: 200, body: { id: "MLB123456", seller_id: 99, attributes: [{ id: "SELLER_SKU", value_name: "OLD" }] } }] };
  const buffer = await exportWorkbook([{ conta: "Loja A", mlb: "MLB123456", id_variacao: "", nome_variacao: "Produto único", ean_gtin_atual: "", sku_atual: "OLD", sku_novo: "NEW" }]);
  const preview = await previewWorkbook(buffer, { accountKey: "12", accountLabel: "Loja A", sellerId: 99, accessToken: "token", requestedBy: "7" }, ml, db);
  assert.equal(preview.rows[0].state, "ready");
  const insert = statements.find((entry) => /insert into ml\.bulk_sku_jobs/i.test(entry.sql));
  assert.equal(insert.params[1], "12");
  assert.equal(insert.params[3], "7");
});

test("export lists the active seller and never includes another account", async () => {
  let pages = 0;
  const ml = { get: async (path) => {
    if (path.includes("/items/search")) return pages++ === 0 ? { results: ["MLB123456"], scroll_id: "next" } : { results: [], scroll_id: "" };
    return [{ code: 200, body: { id: "MLB123456", seller_id: 99, attributes: [{ id: "SELLER_SKU", value_name: "OLD" }] } }];
  } };
  const parsed = await parseWorkbook(await exportRows({ accountKey: "12", accountLabel: "Loja A", sellerId: 99, accessToken: "token" }, ml));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].sku_atual, "OLD");
  assert.equal(pages, 2);
});

test("preview skips untouched spreadsheet rows and checks edited variation against ML", async () => {
  const ml = { get: async () => [{ code: 200, body: { id: "MLB123456", seller_id: 99, variations: [{ id: 987, attributes: [{ id: "SELLER_SKU", value_name: "OLD" }], attribute_combinations: [{ value_name: "Azul" }] }] } }] };
  const rows = [
    { conta: "Loja A", mlb: "MLB123456", id_variacao: "987", nome_variacao: "Azul", ean_gtin_atual: "", sku_atual: "OLD", sku_novo: "NEW" },
    { conta: "Loja A", mlb: "MLB123457", id_variacao: "", nome_variacao: "Produto único", ean_gtin_atual: "", sku_atual: "OTHER", sku_novo: "" },
  ];
  const preview = await buildPreviewRows(await exportWorkbook(rows), { accountKey: "12", accountLabel: "Loja A", sellerId: 99, accessToken: "token" }, ml);
  assert.equal(preview.length, 1);
  assert.equal(preview[0].state, "ready");
  assert.equal(preview[0].id_variacao, "987");
});

test("export scans the active seller and rejects another seller's item", async () => {
  const calls = [];
  const ml = { get: async (path) => {
    calls.push(path);
    if (path.includes("/items/search")) return { results: ["MLB123456"], scroll_id: "next" };
    if (path.startsWith("/items/bulk")) return [{ code: 200, body: { id: "MLB123456", seller_id: 99, attributes: [] } }];
    throw new Error(path);
  } };
  const items = await loadLiveItems({ accountKey: "12", sellerId: 99, accessToken: "token" }, ml, ["MLB123456"]);
  assert.equal(items.length, 1);
  assert.match(calls[0], /items\/bulk/);
  await assert.rejects(loadLiveItems({ accountKey: "12", sellerId: 100, accessToken: "token" }, ml, ["MLB123456"]), /outra conta/);
});

test("SKU replacement retains every other attribute and rejects missing account", () => {
  assert.deepEqual(replaceSku([{ id: "GTIN", value_name: "07891234567890" }, { id: "SELLER_SKU", value_name: "OLD" }], "NEW"), [{ id: "GTIN", value_name: "07891234567890" }, { id: "SELLER_SKU", value_name: "NEW" }]);
  assert.throws(() => assertAccount({ accountKey: "", sellerId: 99 }), /Conta Mercado Livre/);
  assert.doesNotThrow(() => assertAccount({ accountKey: "12", sellerId: 99, accessToken: "token" }));
});
