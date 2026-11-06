"use strict";

// Etiquetas por canal com fetch falso (sem rede).
const test = require("node:test");
const assert = require("node:assert/strict");
const { MercadoLivreConnector } = require("../src/connectors/mercadolivre/MercadoLivreConnector");
const { MagaluConnector } = require("../src/connectors/magalu/MagaluConnector");
const { ShopeeConnector } = require("../src/connectors/shopee/ShopeeConnector");
const { mapOrder: magaluOrder } = require("../src/connectors/magalu/orders");
const { mapOrder: shopeeOrder } = require("../src/connectors/shopee/orders");
const { hmacSha256Hex } = require("../src/platform/crypto");

const PDF = Buffer.from("%PDF-1.4 etiqueta");

/** fetch falso: handler(url, init) → { status, type, body (Buffer|obj) }. */
function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u, init, body: init.body ? JSON.parse(init.body) : null });
    const r = handler(u, init) || { status: 404, body: { message: "not found" } };
    const buf = Buffer.isBuffer(r.body) ? r.body : Buffer.from(JSON.stringify(r.body ?? {}));
    const type = r.type || (Buffer.isBuffer(r.body) ? "application/pdf" : "application/json");
    const status = r.status || 200;
    return { ok: status < 400, status, headers: { get: (k) => (k.toLowerCase() === "content-type" ? type : null) },
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length), text: async () => buf.toString("utf8") };
  };
  return { impl, calls };
}

test("ML: lote de etiquetas; recusa refaz um a um; pedido sem envio vira falha; ZPL pede zpl2", async () => {
  const { impl, calls } = fakeFetch((u) => {
    if (u.pathname !== "/shipment_labels") return null;
    const ids = u.searchParams.get("shipment_ids").split(",");
    if (ids.includes("999")) return { status: 400, body: { message: "not_printable_status", error: "bad_request" } };
    return u.searchParams.get("response_type") === "zpl2" ? { body: Buffer.from("PK zip"), type: "application/zip" } : { body: PDF };
  });
  const ml = new MercadoLivreConnector({ clientId: "1", clientSecret: "s", fetchImpl: impl });
  const out = await ml.fetchLabels({ accessToken: "T" }, [
    { ref: 1, orderId: "A", shipmentId: "100" }, { ref: 2, orderId: "B", shipmentId: "999" }, { ref: 3, orderId: "C", shipmentId: null },
  ], { format: "pdf" });
  assert.deepEqual(out.results.map((r) => [r.ref, r.ok]), [[3, false], [1, true], [2, false]]);
  assert.match(out.results.find((r) => r.ref === 2).error, /not_printable_status/);
  assert.deepEqual(out.files.map((f) => [f.extension, f.orders]), [["pdf", 1]]);
  assert.equal(calls[0].url.searchParams.get("shipment_ids"), "100,999", "primeiro tenta o lote");
  const zpl = await ml.fetchLabels({ accessToken: "T" }, [{ ref: 1, orderId: "A", shipmentId: "100" }], { format: "zpl" });
  assert.equal(zpl.files[0].extension, "zip");
  assert.equal(calls.at(-1).url.searchParams.get("response_type"), "zpl2");
});

test("Magalu: gera por canal, baixa pelo link temporário e devolve o rastreio", async () => {
  const { impl, calls } = fakeFetch((u, init) => {
    if (u.pathname === "/seller/v1/logistics/shipping-labels") {
      const body = JSON.parse(init.body);
      return { body: { label: { signed_url: "https://files.magalu.com/x.pdf", expires_on: "2026-11-07T00:00:00Z" }, deliveries: body.deliveries.map((d) => ({ id: d.id, tracking: { code: `TR-${d.id}` } })) } };
    }
    if (u.hostname === "files.magalu.com") return { body: PDF };
    return null;
  });
  const magalu = new MagaluConnector({ clientId: "c", clientSecret: "s", fetchImpl: impl });
  const out = await magalu.fetchLabels({ accessToken: "T" }, [
    { ref: 1, orderId: "LU-1", refs: { channelId: "ch-1", deliveryIds: ["d1"] } },
    { ref: 2, orderId: "LU-2", refs: { channelId: "ch-1", deliveryIds: ["d2", "d3"] } },
    { ref: 3, orderId: "LU-3", refs: {} },
  ], { format: "pdf" });
  assert.deepEqual(out.results.map((r) => [r.ref, r.ok, r.trackingCode || null]), [[3, false, null], [1, true, "TR-d1"], [2, true, "TR-d2"]]);
  const post = calls.find((c) => c.url.pathname === "/seller/v1/logistics/shipping-labels");
  assert.deepEqual(post.body, { channel: { id: "ch-1" }, deliveries: [{ id: "d1" }, { id: "d2" }, { id: "d3" }], label: { format: "pdf", type: "full" } });
  assert.equal(post.init.headers.authorization, "Bearer T");
  assert.equal(calls.find((c) => c.url.hostname === "files.magalu.com").init.headers.authorization, undefined, "link temporário sem token");
  assert.ok(new MagaluConnector({ clientId: "c", clientSecret: "s" }).scopes.includes("open:order-logistics-seller:write"), "escopo de logística pedido na conexão");
});

test("Shopee: rastreio, criar documento, aguardar READY e baixar; sem envio programado vira falha", async () => {
  let resultCalls = 0;
  const { impl, calls } = fakeFetch((u) => {
    if (u.pathname === "/api/v2/logistics/get_tracking_number") return { body: { response: { tracking_number: u.searchParams.get("order_sn") === "S2" ? "" : "BR123" } } };
    if (u.pathname === "/api/v2/logistics/create_shipping_document") return { body: { response: { result_list: [{ order_sn: "S1" }] } } };
    if (u.pathname === "/api/v2/logistics/get_shipping_document_result") { resultCalls += 1; return { body: { response: { result_list: [{ order_sn: "S1", status: resultCalls > 1 ? "READY" : "PROCESSING" }] } } }; }
    if (u.pathname === "/api/v2/logistics/download_shipping_document") return { body: PDF };
    return null;
  });
  const shopee = new ShopeeConnector({ partnerId: "999", partnerKey: "key", fetchImpl: impl, now: () => 1_790_000_000 });
  shopee.sleep = async () => {};
  const account = { accessToken: "AT", externalAccountId: "555" };
  const out = await shopee.fetchLabels(account, [
    { ref: 1, orderId: "S1", refs: { packageNumbers: ["PK1"] } }, { ref: 2, orderId: "S2", refs: {} },
  ], { format: "zpl" });
  assert.deepEqual(out.results.map((r) => [r.ref, r.ok, r.trackingCode || null]), [[2, false, null], [1, true, "BR123"]]);
  assert.match(out.results[0].error, /não programado/);
  const create = calls.find((c) => c.url.pathname === "/api/v2/logistics/create_shipping_document");
  assert.deepEqual(create.body, { order_list: [{ order_sn: "S1", package_number: "PK1", tracking_number: "BR123", shipping_document_type: "THERMAL_AIR_WAYBILL" }] });
  const download = calls.find((c) => c.url.pathname === "/api/v2/logistics/download_shipping_document");
  assert.equal(download.url.searchParams.get("sign"), hmacSha256Hex("key", `999/api/v2/logistics/download_shipping_document1790000000AT555`));
  assert.equal(resultCalls, 2, "esperou ficar pronta");
  assert.equal(out.files[0].extension, "pdf");
});

test("referências do canal gravadas no pedido (Magalu: canal e entregas; Shopee: pacotes)", () => {
  assert.deepEqual(magaluOrder({ code: "LU-1", status: "approved", channel: { id: "ch-9" }, deliveries: [{ id: "d1", items: [] }, { id: "d2", items: [] }] }).channelRefs,
    { channelId: "ch-9", deliveryIds: ["d1", "d2"] });
  assert.deepEqual(shopeeOrder({ order_sn: "S1", order_status: "PROCESSED", package_list: [{ package_number: "PK1" }] }).channelRefs, { packageNumbers: ["PK1"] });
});
