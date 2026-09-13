"use strict";

const {
  normalizePageQuery,
  normalizedFilter,
  rowsAndCount,
} = require("../../../platform/extensions/coreContracts");

async function listFiscalDocumentsPage(companyId, input = {}) {
  const query = normalizePageQuery(input, { defaultPageSize: 25 });
  const filter = normalizedFilter(query.filter);
  const params = [companyId, query.search, filter];
  const where = `f.company_id=$1
    and ($2='' or lower(concat_ws(' ',c.name,f.model,f.status,f.metadata::text)) like '%'||lower($2)||'%')
    and (
      $3='' or $3='todos'
      or ($3='pendente' and f.status='pending')
      or ($3='emitido' and f.status='issued')
      or ($3='autorizado' and f.status='authorized')
      or ($3='rejeitado' and f.status='rejected')
      or ($3='cancelado' and f.status='canceled')
    )`;
  const fields = `f.id,f.sale_id as "saleId",f.customer_id as "customerId",c.name as "customerName",f.model,f.status,f.metadata,f.created_at as "createdAt",f.updated_at as "updatedAt"`;
  const joins = `from volt_core.fiscal_documents f left join volt_core.customers c on c.id=f.customer_id and c.company_id=f.company_id`;
  const result = await rowsAndCount(
    `select ${fields} ${joins} where ${where} order by f.created_at desc limit $4 offset $5`,
    `select count(*)::int as total ${joins} where ${where}`,
    params,
    query,
  );
  return { data: { fiscalDocuments: result.rows }, pagination: result.pagination };
}

module.exports = {
  fiscal_documents: { capability: "fiscal.documents", loader: listFiscalDocumentsPage },
};
