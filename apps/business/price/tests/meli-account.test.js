"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { resolveMeliConnectionForOrder } = require("../src/orders/meliAccount");

const auth = { tenantId: "tenant-1", userId: "user-1" };

function dependencies(order, connection) {
  return {
    withTenant: async (_tenantId, _userId, work) => work({
      query: async () => ({ rows: order ? [order] : [] }),
    }),
    getConnection: async () => null,
    getConnectionByExternalAccount: async (_auth, channel, accountId) => connection && {
      ...connection,
      channel,
      external_account_id: connection.external_account_id ?? accountId,
    },
  };
}

test("resolve somente a conexao da conta persistida no pedido", async () => {
  const requested = [];
  const result = await resolveMeliConnectionForOrder(auth, "order-1", {
    ...dependencies({
      id: "order-1",
      marketplace: "meli",
      marketplace_order_id: "ML-9",
      marketplace_account_id: "987",
    }, { id: "connection-987" }),
    getConnectionByExternalAccount: async (_auth, channel, accountId) => {
      requested.push({ channel, accountId });
      return { id: "connection-987", channel, external_account_id: accountId };
    },
  });

  assert.equal(result.order.marketplace_order_id, "ML-9");
  assert.equal(result.connection.id, "connection-987");
  assert.deepEqual(requested, [{ channel: "meli", accountId: "987" }]);
});

test("pedido ML sem conta nao seleciona conexao padrao", async () => {
  await assert.rejects(
    () => resolveMeliConnectionForOrder(auth, "order-2", dependencies({
      id: "order-2",
      marketplace: "meli",
      marketplace_order_id: "ML-10",
      marketplace_account_id: null,
    }, { id: "default-connection" })),
    { code: "meli_order_account_missing", statusCode: 409 },
  );
});

test("recusa conexao que nao corresponde a conta persistida", async () => {
  await assert.rejects(
    () => resolveMeliConnectionForOrder(auth, "order-3", dependencies({
      id: "order-3",
      marketplace: "meli",
      marketplace_order_id: "ML-11",
      marketplace_account_id: "987",
    }, { id: "connection-123", external_account_id: "123" })),
    { code: "meli_order_account_not_connected", statusCode: 409 },
  );
});
