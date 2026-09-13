"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { resolveShopeeConnectionForOrder } = require("../src/orders/shopeeAccount");

const auth = { tenantId: "tenant-1", userId: "user-1" };

function dependencies(order, connection) {
  return {
    withTenant: async (_tenantId, _userId, work) => work({
      query: async () => ({ rows: order ? [order] : [] }),
    }),
    getConnectionByExternalAccount: async (_auth, channel, accountId) => connection && {
      ...connection,
      channel,
      external_account_id: connection.external_account_id ?? accountId,
    },
  };
}

test("resolve somente a loja Shopee persistida no pedido", async () => {
  const requested = [];
  const result = await resolveShopeeConnectionForOrder(auth, "order-1", {
    ...dependencies({
      id: "order-1", marketplace: "shopee", marketplace_order_id: "ORDER-A", marketplace_account_id: "42",
    }, { id: "connection-42", status: "active" }),
    getConnectionByExternalAccount: async (_auth, channel, accountId) => {
      requested.push({ channel, accountId });
      return { id: "connection-42", channel, status: "active", external_account_id: accountId };
    },
  });

  assert.equal(result.order.marketplace_order_id, "ORDER-A");
  assert.equal(result.connection.id, "connection-42");
  assert.deepEqual(requested, [{ channel: "shopee", accountId: "42" }]);
});

test("pedido Shopee sem loja nao seleciona conexao padrao", async () => {
  await assert.rejects(
    () => resolveShopeeConnectionForOrder(auth, "order-2", dependencies({
      id: "order-2", marketplace: "shopee", marketplace_order_id: "ORDER-B", marketplace_account_id: null,
    }, { id: "default-connection", status: "active" })),
    { code: "shopee_order_account_missing", statusCode: 409 },
  );
});

test("recusa conexao Shopee desconectada ou de outra loja", async () => {
  await assert.rejects(
    () => resolveShopeeConnectionForOrder(auth, "order-3", dependencies({
      id: "order-3", marketplace: "shopee", marketplace_order_id: "ORDER-C", marketplace_account_id: "42",
    }, { id: "connection-99", status: "disconnected", external_account_id: "99" })),
    { code: "shopee_order_account_not_connected", statusCode: 409 },
  );
});
