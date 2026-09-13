"use strict";

async function beforeDeleteCanceledSale({ client, companyId, saleId }) {
  await client.query("delete from volt_core.fiscal_documents where company_id = $1 and sale_id = $2", [companyId, saleId]);
  return null;
}

module.exports = { beforeDeleteCanceledSale };
