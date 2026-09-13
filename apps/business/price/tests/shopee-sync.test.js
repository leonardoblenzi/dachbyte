"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createShopeeOrderSync } = require("../src/orders/shopeeSync");
const { normalizeShopeeOrder } = require("../src/orders/shopeeNormalization");

const auth = { tenantId: "tenant-1", userId: "user-1" };

function detail(orderSn, overrides = {}) {
  return {
    order_sn: orderSn, order_status: "READY_TO_SHIP", create_time: 1723204800, update_time: 1723291200,
    total_amount: 159.9, item_list: [{ item_name: "Mesa", model_quantity_purchased: 1 }], ...overrides,
  };
}

function harness({ pages, details = null, initialCheckpoint = null } = {}) {
  const queries = [];
  const calls = [];
  let checkpoint = initialCheckpoint;
  const connection = { id: "shop-a", channel: "shopee", status: "active", external_account_id: "42" };
  const client = {
    query: async (sql, values = []) => {
      queries.push({ sql, values });
      if (sql.includes("SELECT cursor,last_success_at")) return { rows: checkpoint ? [checkpoint] : [] };
      if (sql.includes("INSERT INTO volt_price.sync_runs")) return { rows: [{ id: "run-1", started_at: new Date() }] };
      if (sql.includes("INSERT INTO volt_price.sync_checkpoints")) { checkpoint = { cursor: JSON.parse(values[3]) }; return { rows: [] }; }
      return { rows: [] };
    },
  };
  const sync = createShopeeOrderSync({
    getConnection: async (_auth, channel, connectionId) => {
      calls.push({ kind: "connection", channel, connectionId });
      return connectionId === connection.id ? connection : null;
    },
    withTenant: async (_tenant, _user, work) => work(client),
    listOrders: async (_auth, options) => {
      calls.push({ kind: "list", ...options });
      return pages.shift() || { response: { order_list: [], more: false, next_cursor: "" } };
    },
    orderDetail: async (_auth, orderSns, connectionId) => {
      calls.push({ kind: "detail", orderSns, connectionId });
      return { response: { order_list: details ? details(orderSns) : orderSns.map((orderSn) => detail(orderSn, { access_token: "must-redact" })) } };
    },
    audit: async () => {},
  });
  return { sync, queries, calls, get checkpoint() { return checkpoint; } };
}

test("normaliza detalhe Shopee com conta, origem e itens", () => {
  const value = normalizeShopeeOrder(detail("ORDER-1"), "42");
  assert.equal(value.sourceOrderId, "ORDER-1");
  assert.equal(value.marketplace, "shopee");
  assert.equal(value.marketplaceAccountId, "42");
  assert.equal(value.marketplaceAccountSource, "shopee_sync");
  assert.equal(value.totalAmount, 159.9);
  assert.deepEqual(value.normalizedData.items, [{ name: "Mesa", quantity: 1, sku: null }]);
});

test("sincroniza por connectionId, busca detalhes em lotes, persiste redigido e cria checkpoint somente ao concluir", async () => {
  const env = harness({ pages: [{ response: {
    order_list: [{ order_sn: "ORDER-1" }, { order_sn: "ORDER-2" }, { order_sn: "ORDER-3" }], more: false, next_cursor: "cursor-final",
  } }] });
  const result = await env.sync.syncShopeeOrders(auth, { connectionId: "shop-a", pageSize: 50, detailBatchSize: 2 });

  assert.equal(result.success, true);
  assert.deepEqual(env.calls.filter((call) => call.kind === "detail").map(({ orderSns, connectionId }) => ({ orderSns, connectionId })), [
    { orderSns: ["ORDER-1", "ORDER-2"], connectionId: "shop-a" }, { orderSns: ["ORDER-3"], connectionId: "shop-a" },
  ]);
  const inserts = env.queries.filter(({ sql }) => sql.includes("INSERT INTO volt_price.orders"));
  assert.equal(inserts.length, 3);
  assert.doesNotMatch(inserts[0].values[10], /access_token|must-redact/i);
  assert.equal(Object.hasOwn(env.checkpoint.cursor, "cursor"), false);
  assert.equal(env.checkpoint.cursor.maxModifiedAt, "2024-08-10T12:00:00.000Z");
});

test("recusa cursor repetido, conserva checkpoint anterior e registra falha segura", async () => {
  const env = harness({ pages: [
    { response: { order_list: [{ order_sn: "ORDER-1" }], more: true, next_cursor: "same" } },
    { response: { order_list: [{ order_sn: "ORDER-2" }], more: true, next_cursor: "same" } },
  ] });
  await assert.rejects(() => env.sync.syncShopeeOrders(auth, { connectionId: "shop-a" }), { code: "shopee_pagination_guard" });
  assert.equal(env.checkpoint, null);
  const failed = env.queries.find(({ sql }) => sql.includes("status='failed'"));
  assert.equal(failed.values[1], "shopee_pagination_guard");
  assert.doesNotMatch(failed.values[2], /ORDER-\d|token|secret/i);
});

test("nao permite sync sem connectionId ou com uma loja inativa", async () => {
  const env = harness({ pages: [] });
  await assert.rejects(() => env.sync.syncShopeeOrders(auth, {}), { code: "shopee_connection_required", statusCode: 400 });
  await assert.rejects(() => env.sync.syncShopeeOrders(auth, { connectionId: "shop-b" }), { code: "shopee_not_connected", statusCode: 409 });
  assert.equal(env.calls.filter((call) => call.kind === "list").length, 0);
});

test("novo sync ignora next_cursor salvo e usa update_time no incremental", async () => {
  const env = harness({
    initialCheckpoint: { cursor: { cursor: "provider-cursor-antigo", maxModifiedAt: "2024-08-10T12:00:00.000Z" } },
    pages: [{ response: { order_list: [], more: false, next_cursor: "provider-cursor-novo" } }],
  });
  await env.sync.syncShopeeOrders(auth, { connectionId: "shop-a" });
  const list = env.calls.find((call) => call.kind === "list");
  assert.equal(list.cursor, "");
  assert.equal(list.timeRangeField, "update_time");
  assert.equal(Object.hasOwn(env.checkpoint.cursor, "cursor"), false);
});

test("divide janela manual acima de 15 dias em slices independentes", async () => {
  const env = harness({ pages: [
    { response: { order_list: [], more: false, next_cursor: "cursor-1" } },
    { response: { order_list: [], more: false, next_cursor: "cursor-2" } },
  ] });
  await env.sync.syncShopeeOrders(auth, { connectionId: "shop-a", from: "2024-08-01", to: "2024-08-20" });
  assert.deepEqual(env.calls.filter((call) => call.kind === "list").map(({ from, to, cursor, timeRangeField }) => ({ from, to, cursor, timeRangeField })), [
    { from: "2024-08-01", to: "2024-08-15", cursor: "", timeRangeField: "update_time" },
    { from: "2024-08-16", to: "2024-08-20", cursor: "", timeRangeField: "update_time" },
  ]);
});

test("historico usa create_time e nenhum dado pessoal Shopee vai para raw_data", async () => {
  const sensitive = detail("ORDER-PII", {
    buyer_user_id: 123, buyer_username: "cliente", invoice_data: { number: "NF-1" },
    recipient_address: { full_address: "Rua secreta" }, nested: { buyer_username: "outro", phone: "11999999999" },
  });
  const normalized = normalizeShopeeOrder(sensitive, "42");
  assert.doesNotMatch(JSON.stringify(normalized.raw), /cliente|NF-1|Rua secreta|11999999999|buyer_user_id|buyer_username|invoice_data|recipient_address/i);

  const env = harness({ pages: [{ response: { order_list: [], more: false, next_cursor: "" } }] });
  await env.sync.syncShopeeOrders(auth, { connectionId: "shop-a" });
  assert.equal(env.calls.find((call) => call.kind === "list").timeRangeField, "create_time");
});
