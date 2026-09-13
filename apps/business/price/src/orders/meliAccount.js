"use strict";

const { withTenant } = require("../db");
const { getConnectionByExternalAccount } = require("../integrations/tokenStore");

function conflict(message, code) {
  return Object.assign(new Error(message), { statusCode: 409, code });
}

async function resolveMeliConnectionForOrder(auth, orderId, dependencies = {}) {
  const withTenantFn = dependencies.withTenant || dependencies.withTenantFn || withTenant;
  const getConnectionByExternalAccountFn = dependencies.getConnectionByExternalAccount
    || dependencies.getConnectionByExternalAccountFn
    || getConnectionByExternalAccount;
  const order = await withTenantFn(auth.tenantId, auth.userId, async (client) => (
    await client.query(
      "SELECT id,marketplace,marketplace_order_id,marketplace_account_id FROM volt_price.orders WHERE id=$1",
      [orderId],
    )
  ).rows[0]);

  if (!order || order.marketplace !== "meli" || !order.marketplace_order_id) {
    throw conflict("Pedido Mercado Livre nao vinculado.", "meli_order_not_linked");
  }
  if (!order.marketplace_account_id) {
    throw conflict("Conta Mercado Livre do pedido nao identificada.", "meli_order_account_missing");
  }

  const accountId = String(order.marketplace_account_id);
  const connection = await getConnectionByExternalAccountFn(auth, "meli", accountId);
  if (!connection || String(connection.external_account_id) !== accountId) {
    throw conflict("Conecte a conta Mercado Livre indicada no pedido.", "meli_order_account_not_connected");
  }

  return { order, connection };
}

module.exports = { resolveMeliConnectionForOrder };
