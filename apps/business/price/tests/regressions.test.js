"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

function read(relative) {
  return fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

test("bootstrap master e create-only e nao sobrescreve senha de usuario existente", () => {
  const auth = read("src/auth.js");
  assert.match(auth, /ON CONFLICT \(email\) DO NOTHING/i);
  assert.doesNotMatch(
    auth,
    /ON CONFLICT \(email\) DO UPDATE SET[^;`]*password_hash\s*=\s*EXCLUDED\.password_hash/i,
  );
});

test("orders expoe uma unica rota para cada operacao de sincronizacao e conciliacao", () => {
  const orders = read("src/routes/orders.routes.js");
  assert.equal(count(orders, 'router.post("/sync/tray"'), 1);
  assert.equal(count(orders, 'router.post("/:id/hydrate-tray"'), 1);
  assert.equal(count(orders, 'router.patch("/:id/link-marketplace"'), 1);
});

test("fees de pedido pertencem ao finance router e nao sao duplicadas no orders router", () => {
  const orders = read("src/routes/orders.routes.js");
  const finance = read("src/routes/finance.routes.js");
  assert.equal(count(orders, 'router.post("/fees/'), 0);
  assert.equal(count(orders, 'router.get("/fees/history/'), 0);
  assert.equal(count(finance, 'router.post("/orders/fees/meli/:orderId"'), 1);
  assert.equal(count(finance, 'router.post("/orders/fees/shopee/:orderId"'), 1);
  assert.equal(count(finance, 'router.get("/orders/fees/history/:channel/:orderId"'), 1);
});

test("domain router nao redefine endpoints que possuem routers especializados", () => {
  const domain = read("src/routes/domain.routes.js");
  const shadowed = [
    'router.get("/profit"',
    'router.post("/profit/order/:orderId/calculate"',
    'router.get("/pricing"',
    'router.post("/pricing/simulate"',
    'router.get("/market"',
    'router.get("/ads"',
    'router.get("/cash"',
    'router.post("/cash"',
  ];
  for (const signature of shadowed) {
    assert.equal(count(domain, signature), 0, `rota legada ainda presente: ${signature}`);
  }
});

test("migration de contas marketplace protege links OAuth e vinculos de pedido", () => {
  const migration = read("db/011_multi_account_marketplace_connections.sql");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS volt_price\.integration_authorization_links/i);
  assert.match(migration, /token_hash text NOT NULL UNIQUE/i);
  assert.match(migration, /tenant_id uuid NOT NULL REFERENCES volt_price\.tenants/i);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS marketplace_connection_id uuid\s+REFERENCES volt_price\.integration_connections/i);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/i);
});

test("vinculos manuais persistem a conta e fees resolvem a conta estrita do pedido", () => {
  const orders = read("src/routes/orders.routes.js");
  const finance = read("src/routes/finance.routes.js");
  const service = read("src/finance/service.js");

  assert.match(orders, /marketplace_connection_id=\$4/);
  assert.match(orders, /marketplace_connection_id=NULL/);
  assert.match(orders, /JOIN volt_price\.integration_connections connection/);
  assert.match(finance, /resolveMeliConnectionForOrder/);
  assert.match(finance, /resolveShopeeConnectionForOrder/);
  assert.match(finance, /externalOrderId/);
  assert.match(finance, /const connectionId = resolved\.connection\.id/);
  assert.match(finance, /shopee_order_id_invalid/);
  assert.match(service, /raw_data->>'connectionId'=\$3::text/);
});
