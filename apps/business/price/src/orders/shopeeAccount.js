"use strict";

const { withTenant } = require("../db");
const { getConnectionByExternalAccount } = require("../integrations/tokenStore");

function conflict(message, code) {
  return Object.assign(new Error(message), { statusCode: 409, code });
}

async function resolveShopeeConnectionForOrder(auth, orderId, dependencies = {}) {
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

  if (!order || order.marketplace !== "shopee" || !order.marketplace_order_id) {
    throw conflict("Pedido Shopee nao vinculado.", "shopee_order_not_linked");
  }
  if (!order.marketplace_account_id) {
    throw conflict("Loja Shopee do pedido nao identificada.", "shopee_order_account_missing");
  }

  const shopId = String(order.marketplace_account_id);
  const connection = await getConnectionByExternalAccountFn(auth, "shopee", shopId);
  if (
    !connection
    || String(connection.external_account_id) !== shopId
    || String(connection.status || "").toLowerCase() !== "active"
  ) {
    throw conflict("Conecte a loja Shopee indicada no pedido.", "shopee_order_account_not_connected");
  }

  return { order, connection };
}

module.exports = { resolveShopeeConnectionForOrder };
