"use strict";

async function customerDependencies({ client, companyId, entityId }) {
  const result = await client.query(
    "select count(*)::int as total from volt_core.fiscal_documents where company_id=$1 and customer_id=$2",
    [companyId, entityId],
  );
  return { count: Number(result.rows[0]?.total || 0) };
}

module.exports = { customerDependencies };
