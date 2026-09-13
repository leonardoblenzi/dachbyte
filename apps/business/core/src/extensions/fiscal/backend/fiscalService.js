"use strict";

const {
  assertCompanyCapability,
  createId,
  db,
  recordEvent,
} = require("../../../platform/extensions/coreContracts");

function normalizeFiscalStatus(value) {
  const aliases = {
    Pendente: "pending",
    Preparado: "prepared",
    Enviado: "sent",
    Emitido: "issued",
    Autorizado: "authorized",
    Rejeitado: "rejected",
    Cancelado: "canceled",
    Inutilizado: "voided",
  };
  const text = String(value || "").trim();
  if (!text) return null;
  return aliases[text] || text.toLowerCase().replace(/\s+/g, "_");
}

async function createFiscalDocument(companyId, input = {}) {
  await assertCompanyCapability(companyId, "service.fiscal.active");
  const customerResult = input.customerId || input.customer
    ? await db.query("select id, name from volt_core.customers where company_id = $1 and (id = $2 or lower(name) = lower($3)) limit 1", [companyId, input.customerId || "", input.customer || ""])
    : { rows: [] };
  const saleNumber = String(input.sale || "").replace(/\D/g, "");
  const saleResult = saleNumber ? await db.query("select id from volt_core.sales where company_id = $1 and number = $2 limit 1", [companyId, Number(saleNumber)]) : { rows: [] };
  const id = createId("fis");
  const metadata = {
    provider: input.provider || input.metadata?.provider || null,
    externalId: input.externalId || input.metadata?.externalId || null,
    accessKey: input.accessKey || input.metadata?.accessKey || null,
    lastMessage: input.lastMessage || input.metadata?.lastMessage || null,
    integrationMode: input.integrationMode || input.metadata?.integrationMode || "manual_control",
    ...input.metadata,
  };
  const result = await db.query(`insert into volt_core.fiscal_documents (id, company_id, sale_id, customer_id, model, status, metadata)
    values ($1,$2,$3,$4,$5,$6,$7::jsonb) returning id, sale_id as "saleId", customer_id as "customerId", model, status, metadata;`,
  [id, companyId, saleResult.rows[0]?.id || null, customerResult.rows[0]?.id || null,
    input.model || "NFC-e futura", normalizeFiscalStatus(input.status) || "pending", JSON.stringify(metadata)]);
  await recordEvent(companyId, "fiscal_document.created", { fiscalDocumentId: id });
  return { ...result.rows[0], customerName: customerResult.rows[0]?.name || input.customer || null };
}

async function updateFiscalDocument(companyId, fiscalDocumentId, input = {}) {
  await assertCompanyCapability(companyId, "service.fiscal.active");
  const metadata = {
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.externalId !== undefined ? { externalId: input.externalId } : {}),
    ...(input.accessKey !== undefined ? { accessKey: input.accessKey } : {}),
    ...(input.lastMessage !== undefined ? { lastMessage: input.lastMessage } : {}),
    ...(input.metadata || {}),
  };
  const result = await db.query(`update volt_core.fiscal_documents set model = coalesce($3,model), status = coalesce($4,status),
      metadata = metadata || $5::jsonb, updated_at = now() where company_id = $1 and id = $2
      returning id, sale_id as "saleId", customer_id as "customerId", model, status, metadata;`,
  [companyId, fiscalDocumentId, input.model || null,
    input.status ? normalizeFiscalStatus(input.status) : null, JSON.stringify(metadata)]);
  if (!result.rowCount) throw Object.assign(new Error("Documento fiscal nao encontrado"), { statusCode: 404, code: "FISCAL_DOCUMENT_NOT_FOUND" });
  await recordEvent(companyId, "fiscal_document.updated", { fiscalDocumentId, status: result.rows[0].status });
  return result.rows[0];
}

module.exports = {
  createFiscalDocument,
  normalizeFiscalStatus,
  updateFiscalDocument,
};
