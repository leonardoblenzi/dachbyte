"use strict";

// Conexão única do Mercado Livre: em quais produtos cada conta está ativa.
// O módulo ML enxerga só as contas ativas em 'ml'; o DACH Hub, só as ativas em 'dach_hub'.

const PRODUCTS = Object.freeze(["ml", "dach_hub"]);

function isProduct(value) {
  return PRODUCTS.includes(String(value || ""));
}

/** Trecho SQL: a conta `alias` está ativa no produto (padrão: módulo ML). */
function activeInProductSql(alias = "mc", product = "ml") {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias) || !isProduct(product)) throw new Error("invalid_product_filter");
  return `exists (select 1 from ml.meli_conta_produtos mcp_${alias} where mcp_${alias}.meli_conta_id = ${alias}.id and mcp_${alias}.produto = '${product}')`;
}

async function activateProduct(client, accountId, product, actor = null) {
  if (!isProduct(product)) throw new Error("invalid_product");
  await client.query(
    `insert into ml.meli_conta_produtos (meli_conta_id, produto, ativado_por)
     values ($1, $2, $3)
     on conflict (meli_conta_id, produto) do nothing`,
    [accountId, product, actor],
  );
}

async function deactivateProduct(client, accountId, product) {
  if (!isProduct(product)) throw new Error("invalid_product");
  await client.query(
    `delete from ml.meli_conta_produtos where meli_conta_id = $1 and produto = $2`,
    [accountId, product],
  );
}

async function productsForAccount(client, accountId) {
  const { rows } = await client.query(
    `select produto from ml.meli_conta_produtos where meli_conta_id = $1 order by produto`,
    [accountId],
  );
  return rows.map((row) => row.produto);
}

module.exports = { PRODUCTS, isProduct, activeInProductSql, activateProduct, deactivateProduct, productsForAccount };
