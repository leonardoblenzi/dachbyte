"use strict";

// Conectores na E3: pedidos, notificações, escrita e releitura de estoque (com fetch falso).
const test = require("node:test");
const assert = require("node:assert/strict");
const { MercadoLivreConnector } = require("../src/connectors/mercadolivre/MercadoLivreConnector");
const { MagaluConnector } = require("../src/connectors/magalu/MagaluConnector");
const { ShopeeConnector } = require("../src/connectors/shopee/ShopeeConnector");
const { hmacSha256Hex } = require("../src/platform/crypto");
const { classifyWriteError } = require("../src/connectors/writeResult");

/** fetch falso: handler(url, init) → { status, body }. */
function routeFetch(handler) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u, init, body: init.body ? JSON.parse(init.body) : null });
    const { status = 200, body = {} } = handler(u, init) || { status: 404, body: { message: "not found" } };
    return { ok: status < 400, status, text: async () => JSON.stringify(body) };
  };
  return { impl, calls };
}
const raw = (obj) => Buffer.from(JSON.stringify(obj));

test("classificação de erro de escrita: 429 tenta depois, 5xx/sem resposta é incerto, 4xx falha", () => {
  assert.deepEqual([classifyWriteError({ status: 429 }).retryable, classifyWriteError({ status: 429 }).uncertain], [true, false]);
  assert.equal(classifyWriteError({ status: 503 }).uncertain, true);
  assert.equal(classifyWriteError(new Error("rede")).uncertain, true);
  assert.deepEqual([classifyWriteError({ status: 400, message: "x" }).retryable, classifyWriteError({ status: 400 }).uncertain], [false, false]);
});

test("ML webhook: só pedidos do nosso app; outros tópicos são ignorados", () => {
  const ml = new MercadoLivreConnector({ clientId: "123", clientSecret: "s" });
  const { events } = ml.parseWebhook({ rawBody: raw({ _id: "abc", topic: "orders_v2", resource: "/orders/2000001", user_id: 55, application_id: 123 }) });
  assert.deepEqual(events.map((e) => [e.externalAccountId, e.topic, e.resourceId, e.dedupeKey]), [["55", "order", "2000001", "mercadolivre:abc"]]);
  assert.deepEqual(ml.parseWebhook({ rawBody: raw({ topic: "items", resource: "/items/MLB1", user_id: 55, application_id: 123 }) }).events, []);
  assert.throws(() => ml.parseWebhook({ rawBody: raw({ topic: "orders_v2", resource: "/orders/1", user_id: 55, application_id: 999 }) }), (e) => e.status === 401);
  assert.throws(() => ml.parseWebhook({ rawBody: raw({ topic: "orders_v2", resource: "/orders/1", user_id: "x" }) }), (e) => e.status === 401);
});

test("ML pedido: cancelado, variação e itens repetidos somados", async () => {
  const order = { id: 2000001, status: "paid", date_created: "2026-11-06T10:00:00Z", total_amount: 300,
    order_items: [{ item: { id: "MLB1", variation_id: 77, seller_sku: "SOFA-1", title: "Sofá" }, quantity: 1, unit_price: 150 }, { item: { id: "MLB1", variation_id: 77 }, quantity: 1, unit_price: 150 }] };
  const { impl } = routeFetch((u) => (u.pathname === "/orders/2000001" ? { body: order } : u.pathname === "/orders/9" ? { body: { ...order, id: 9, status: "cancelled" } } : null));
  const ml = new MercadoLivreConnector({ clientId: "1", clientSecret: "s", fetchImpl: impl });
  const mapped = await ml.getOrder({ accessToken: "T" }, "2000001");
  assert.deepEqual([mapped.status, mapped.lines.length, mapped.lines[0].quantity, mapped.lines[0].variationId, mapped.lines[0].channelSku], ["open", 1, 2, "77", "SOFA-1"]);
  assert.equal((await ml.getOrder({ accessToken: "T" }, "9")).status, "cancelled");
  assert.equal(await ml.getOrder({ accessToken: "T" }, "404"), null);
});

test("ML escrita: só variações que mudam; Full e multi-origem bloqueados; 429 e 5xx classificados", async () => {
  const items = {
    MLB1: { id: "MLB1", status: "active", seller_id: 55, shipping: { logistic_type: "xd_drop_off" }, variations: [{ id: 77 }, { id: 78 }] },
    MLB2: { id: "MLB2", status: "active", seller_id: 55, shipping: { logistic_type: "fulfillment" } },
    MLB3: { id: "MLB3", status: "closed", seller_id: 55, shipping: {} },
    MLB4: { id: "MLB4", status: "active", seller_id: 55, shipping: {} },
    MLB5: { id: "MLB5", status: "paused", seller_id: 55, shipping: {} },
  };
  const { impl, calls } = routeFetch((u, init) => {
    if (u.pathname === "/users/55") return { body: { id: 55, tags: ["normal"] } };
    const id = u.pathname.split("/")[2];
    if (init.method === "PUT") return id === "MLB4" ? { status: 429, body: { message: "too many" } } : id === "MLB5" ? { status: 500, body: {} } : { body: {} };
    return items[id] ? { body: items[id] } : null;
  });
  const ml = new MercadoLivreConnector({ clientId: "1", clientSecret: "s", fetchImpl: impl });
  const res = await ml.writeStock({ accessToken: "T", externalAccountId: "55" }, [
    { ref: 1, listingId: "MLB1", variationId: "77", quantity: 4 }, { ref: 2, listingId: "MLB2", variationId: "", quantity: 1 },
    { ref: 3, listingId: "MLB3", variationId: "", quantity: 1 }, { ref: 4, listingId: "MLB4", variationId: "", quantity: 1 }, { ref: 5, listingId: "MLB5", variationId: "", quantity: 2 },
  ]);
  const by = Object.fromEntries(res.map((r) => [r.ref, r]));
  assert.equal(by[1].ok, true);
  assert.match(by[2].error, /Full/);
  assert.match(by[3].error, /closed/);
  assert.equal(by[4].retryable, true);
  assert.equal(by[5].uncertain, true);
  const put = calls.find((c) => c.init.method === "PUT" && c.url.pathname === "/items/MLB1");
  assert.deepEqual(put.body, { variations: [{ id: 77, available_quantity: 4 }] });

  const multi = routeFetch((u) => (u.pathname === "/users/55" ? { body: { tags: ["warehouse_management"] } } : null));
  const blocked = await new MercadoLivreConnector({ clientId: "1", clientSecret: "s", fetchImpl: multi.impl }).writeStock({ accessToken: "T", externalAccountId: "55" }, [{ ref: 1, listingId: "MLB1", variationId: "", quantity: 1 }]);
  assert.match(blocked[0].error, /multi-origem/);
  assert.ok(!multi.calls.some((c) => c.init.method === "PUT"));
});

test("ML releitura: estoque do anúncio ou da variação", async () => {
  const { impl } = routeFetch((u) => (u.pathname === "/items" ? { body: [{ code: 200, body: { id: "MLB1", available_quantity: 9, variations: [{ id: 77, available_quantity: 4 }] } }] } : null));
  const ml = new MercadoLivreConnector({ clientId: "1", clientSecret: "s", fetchImpl: impl });
  const reads = await ml.readStock({ accessToken: "T" }, [{ ref: 1, listingId: "MLB1", variationId: "77" }, { ref: 2, listingId: "MLB1", variationId: "" }, { ref: 3, listingId: "MLB9", variationId: "" }]);
  assert.deepEqual(reads, [{ ref: 1, stock: 4 }, { ref: 2, stock: 9 }, { ref: 3, stock: null }]);
});

test("Magalu webhook: segredo da conta, duas assinaturas na troca, expiração; conta sem segredo é ignorada", () => {
  const now = 1_790_000_000_000;
  const magalu = new MagaluConnector({ clientId: "c", clientSecret: "s", now: () => now });
  const body = raw({ tenant_id: "ten-1", topic: "orders_order", data: { resource: "/seller/v1/orders/LU-1", params: { id: "LU-1" } } });
  assert.equal(magalu.webhookAccountId(body), "ten-1");
  assert.equal(magalu.webhookAccountId(Buffer.from("x")), null);
  const ts = String(Math.floor(now / 1000));
  const sig = (secret) => hmacSha256Hex(secret, `${ts}.${body.toString("utf8")}`);
  const { events } = magalu.parseWebhook({ headers: { "x-timestamp": ts, "x-signature-256": `sha256=${sig("whsec_a")}` }, rawBody: body, secrets: ["whsec_a"] });
  assert.deepEqual(events.map((e) => [e.externalAccountId, e.resourceId]), [["ten-1", "LU-1"]]);
  const rotating = `sha256=${sig("whsec_novo")},sha256=${sig("whsec_a")}`;
  assert.equal(magalu.parseWebhook({ headers: { "x-timestamp": ts, "x-signature-256": rotating }, rawBody: body, secrets: ["whsec_a"] }).events.length, 1, "período de troca: vale a assinatura do segredo antigo");
  assert.throws(() => magalu.parseWebhook({ headers: { "x-timestamp": ts, "x-signature-256": `sha256=${sig("outro")}` }, rawBody: body, secrets: ["whsec_a"] }), (e) => e.status === 401, "segredo de outra conta não vale");
  assert.throws(() => magalu.parseWebhook({ headers: { "x-timestamp": String(Number(ts) - 900), "x-signature-256": sig("whsec_a") }, rawBody: body, secrets: ["whsec_a"] }), /expirada/);
  assert.deepEqual(magalu.parseWebhook({ headers: {}, rawBody: body, secrets: [] }).events, [], "conta desconhecida ou sem assinatura: ignora (a leitura periódica cobre)");
});

test("Magalu: assina os avisos de pedido com o token do seller e devolve o segredo", async () => {
  const { impl, calls } = routeFetch((u, init) => (u.pathname === "/v1/onboarding/signup" && init.method === "PUT"
    ? { status: 201, body: { subscriptions: [{ id: "sub-1", topic: "orders_order", parameters: { url: "https://dachbyte.tech/hub/webhooks/magalu", secret: "whsec_123" } }] } } : null));
  const magalu = new MagaluConnector({ clientId: "c", clientSecret: "s", fetchImpl: impl });
  const out = await magalu.subscribeWebhooks({ accessToken: "T" }, { url: "https://dachbyte.tech/hub/webhooks/magalu" });
  assert.deepEqual(out, { secrets: ["whsec_123"], topics: ["orders_order"] });
  assert.deepEqual(calls[0].body, { topic_id: "orders_order", webhook: "https://dachbyte.tech/hub/webhooks/magalu", filter_by: {} });
  assert.equal(calls[0].init.headers.authorization, "Bearer T");
  const { impl: failing } = routeFetch(() => ({ status: 201, body: { subscriptions: [{ topic: "orders_order", message: "topic not allowed" }] } }));
  await assert.rejects(() => new MagaluConnector({ clientId: "c", clientSecret: "s", fetchImpl: failing }).subscribeWebhooks({ accessToken: "T" }, { url: "https://x" }), /topic not allowed/);
});

test("Magalu pedido e escrita: itens das entregas, valor com normalizer, PATCH ou POST conforme existe", async () => {
  const order = { code: "LU-1", status: "approved", purchased_at: "2026-11-06T10:00:00Z", amounts: { total: { value: 39980, normalizer: 100 } },
    deliveries: [{ items: [{ sku: "SOFA-1", quantity: 2, unit_price: { value: 19990, normalizer: 100 } }], shipping: { provider: { extras: { is_fulfillment: false } } } }] };
  const { impl, calls } = routeFetch((u, init) => {
    if (u.pathname === "/seller/v1/orders/LU-1") return { body: order };
    if (u.pathname === "/seller/v1/portfolios/stocks/NOVO" && (init.method || "GET") === "GET") return { status: 404, body: {} };
    if (u.pathname.startsWith("/seller/v1/portfolios/stocks/")) return (init.method || "GET") === "GET" ? { body: { results: [{ type: "AVAILABLE", quantity: 3 }] } } : { body: {} };
    return null;
  });
  const magalu = new MagaluConnector({ clientId: "c", clientSecret: "s", fetchImpl: impl });
  const mapped = await magalu.getOrder({ accessToken: "T" }, "LU-1");
  assert.deepEqual([mapped.orderId, mapped.total, mapped.lines[0].listingId, mapped.lines[0].quantity, mapped.lines[0].unitPrice], ["LU-1", 399.8, "SOFA-1", 2, 199.9]);
  const res = await magalu.writeStock({ accessToken: "T" }, [{ ref: 1, listingId: "SOFA-1", variationId: "", quantity: 5 }, { ref: 2, listingId: "NOVO", variationId: "", quantity: 1 }]);
  assert.deepEqual(res.map((r) => r.ok), [true, true]);
  const writes = calls.filter((c) => ["PATCH", "POST"].includes(c.init.method));
  assert.deepEqual(writes.map((c) => [c.init.method, c.url.pathname, c.body.quantity, c.init.headers["x-request-id"]]), [
    ["PATCH", "/seller/v1/portfolios/stocks/SOFA-1", 5, "dach-hub-push-1"], ["POST", "/seller/v1/portfolios/stocks/NOVO", 1, "dach-hub-push-2"]]);
  assert.deepEqual(await magalu.readStock({ accessToken: "T" }, [{ ref: 1, listingId: "SOFA-1", variationId: "" }]), [{ ref: 1, stock: 3 }]);
});

test("Shopee push: assinatura oficial (url|corpo com a partner key); só código 3 vira pedido", () => {
  const shopee = new ShopeeConnector({ partnerId: "999", partnerKey: "key" });
  const url = "https://dachbyte.tech/hub/webhooks/shopee";
  const body = raw({ code: 3, shop_id: 555, timestamp: 1, data: { ordersn: "2611ABC", status: "READY_TO_SHIP", update_time: 10 } });
  const auth = hmacSha256Hex("key", `${url}|${body.toString("utf8")}`);
  const { events } = shopee.parseWebhook({ headers: { authorization: auth }, rawBody: body, url });
  assert.deepEqual(events.map((e) => [e.externalAccountId, e.resourceId]), [["555", "2611ABC"]]);
  assert.throws(() => shopee.parseWebhook({ headers: { authorization: auth }, rawBody: body, url: "https://outro/hub/webhooks/shopee" }), (e) => e.status === 401);
  const price = raw({ code: 22, shop_id: 555, data: {} });
  assert.deepEqual(shopee.parseWebhook({ headers: { authorization: hmacSha256Hex("key", `${url}|${price.toString("utf8")}`) }, rawBody: price, url }).events, []);
});

test("Shopee escrita e releitura: seller_stock, failure_list e janela de pedidos de até 14 dias", async () => {
  const now = 1_790_000_000;
  const { impl, calls } = routeFetch((u, init) => {
    if (u.pathname === "/api/v2/product/update_stock") return { body: { error: "", response: { failure_list: [{ model_id: 2, failed_reason: "modelo inativo" }] } } };
    if (u.pathname === "/api/v2/product/get_model_list") return { body: { response: { model: [{ model_id: 1, stock_info_v2: { seller_stock: [{ stock: 6 }], summary_info: { total_available_stock: 4 } } }] } } };
    if (u.pathname === "/api/v2/product/get_item_base_info") return { body: { response: { item_list: [{ item_id: 20, stock_info_v2: { summary_info: { total_available_stock: 8 } } }] } } };
    if (u.pathname === "/api/v2/order/get_order_list") return { body: { response: { order_list: [{ order_sn: "A1" }], more: true, next_cursor: "c2" } } };
    if (u.pathname === "/api/v2/order/get_order_detail") return { body: { response: { order_list: [{ order_sn: "A1", order_status: "CANCELLED", item_list: [{ item_id: 10, model_id: 1, model_sku: "CAD-P", model_quantity_purchased: 2 }] }] } } };
    return null;
  });
  const shopee = new ShopeeConnector({ partnerId: "999", partnerKey: "key", fetchImpl: impl, now: () => now });
  const account = { accessToken: "AT", externalAccountId: "555" };
  const res = await shopee.writeStock(account, [{ ref: 1, listingId: "10", variationId: "1", quantity: 6 }, { ref: 2, listingId: "10", variationId: "2", quantity: 3 }]);
  assert.deepEqual(res.map((r) => [r.ref, r.ok, r.error || null]), [[1, true, null], [2, false, "modelo inativo"]]);
  const write = calls.find((c) => c.url.pathname === "/api/v2/product/update_stock");
  assert.deepEqual(write.body, { item_id: 10, stock_list: [{ model_id: 1, seller_stock: [{ stock: 6 }] }, { model_id: 2, seller_stock: [{ stock: 3 }] }] });
  assert.equal(write.url.searchParams.get("sign"), hmacSha256Hex("key", `999/api/v2/product/update_stock${now}AT555`));
  const reads = await shopee.readStock(account, [{ ref: 1, listingId: "10", variationId: "1" }, { ref: 2, listingId: "20", variationId: "" }]);
  assert.deepEqual(reads, [{ ref: 1, stock: 6 }, { ref: 2, stock: 8 }], "lê o estoque do vendedor (o que o Hub grava)");
  const page = await shopee.listOrders(account, { updatedFrom: new Date((now - 40 * 86400) * 1000) });
  const list = calls.find((c) => c.url.pathname === "/api/v2/order/get_order_list").url.searchParams;
  assert.equal(Number(list.get("time_to")) - Number(list.get("time_from")), 14 * 86400, "janela limitada a 14 dias");
  assert.equal(page.orders[0].status, "cancelled");
  assert.equal(JSON.parse(page.nextCursor).c, "c2");
});
