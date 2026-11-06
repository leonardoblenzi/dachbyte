"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const controller = require("../controllers/DashboardController");
const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const { parseStatuses, slimOrder, fetchMonthOrdersCached, ORDERS_CACHE } = controller._test;

test("filtro de status: padrao continua so pagos e rejeita valores invalidos", () => {
  assert.deepEqual(parseStatuses(""), ["paid"]);
  assert.deepEqual(parseStatuses("paid,confirmed,paid"), ["paid", "confirmed"]);
  assert.throws(() => parseStatuses("paid;drop"), /Status inválido/);
});

test("cache: filtro e mes anterior reaproveitam os pedidos sem chamar a API", async () => {
  const orders = [slimOrder({ status: "paid", date_created: "2026-11-02T10:00:00.000-03:00", paid_amount: 100, order_items: [{ quantity: 2, item: { id: "x" } }], buyer: { id: 9 } })];
  assert.deepEqual(Object.keys(orders[0]).sort(), ["date_closed", "date_created", "order_items", "paid_amount", "payments", "status", "total_amount"], "guarda so o necessario");
  ORDERS_CACHE.set("123:a:b", { orders, fetchedAt: "2026-11-06T10:00:00Z", expiresAt: Date.now() + 60000 });
  const hit = await fetchMonthOrdersCached("token", 123, "a", "b");
  assert.equal(hit.cached, true);
  assert.equal(hit.orders, orders);
  ORDERS_CACHE.delete("123:a:b");
});

test("resumo busca todos os status e acompanha cancelados a parte", () => {
  const source = read("controllers/DashboardController.js");
  const fetchAll = source.slice(source.indexOf("async function fetchAllOrders"), source.indexOf("async function fetchAllPaidOrders"));
  assert.doesNotMatch(fetchAll, /order\.status=/, "busca sem filtro de status");
  assert.match(source, /cancelled_daily: cancelledDaily/);
  assert.match(source, /fresh: String\(req\.query\.fresh \|\| ""\) === "1"/);
});

test("tela: filtro com atalhos em pt-BR, cancelados e mesmo filtro no mes anterior", () => {
  const html = read("views/projecao-mensal.html");
  assert.match(html, /id="projection-status-options"/);
  assert.match(html, /id="projection-cancelled"/);
  assert.match(html, /id="projection-show-cancelled"/);
  const js = read("public/js/projecao-mensal.js");
  assert.match(js, /label: "Somente pagos"/);
  assert.match(js, /label: "Todos exceto cancelados e inválidos"/);
  assert.match(js, /cancelled: "Cancelado"/);
  assert.match(js, /period=\$\{encodeURIComponent\(previousPeriod\)\}\$\{statusParam \? `&statuses=/, "mes anterior usa o mesmo filtro");
  assert.match(js, /carregarProjecaoMensal\(\{ fresh: true \}\)/);
});
