"use strict";

const db = require("../../../../../db/db");
const { createId } = require("../../id");
const { validateCustomFields } = require("../../configuration/customFields");
const { assertTransition, resolveWorkflow } = require("../../workflows/workflowEngine");
const { getCompanyConfigurationWithClient, getCompanyConfiguration } = require("./configurationService");
const { extensionRegistry } = require("../../../../platform/extensions/extensionRegistry");
const {
  insertAuditWithClient,
  insertEventWithClient,
  insertWorkflowEventWithClient,
  nextOperationalNumber,
} = require("./persistenceHelpers");

function normalizeDateInput(value) {
  const text = String(value || "").trim();
  if (!text || ["hoje", "agora", "12 meses"].includes(text.toLowerCase())) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const match = text.match(/^(\d{2})\/(\d{2})(?:\/(\d{4}))?$/);
  if (!match) return null;
  return `${match[3] || new Date().getFullYear()}-${match[2]}-${match[1]}`;
}

function normalizeOperationalStatus(value) {
  const aliases = { "Aberta": "open", "Em producao": "in_production", "Aguardando peca": "waiting_part", "Pronto": "ready" };
  return aliases[value] || String(value || "open").trim().toLowerCase().replace(/\s+/g, "_");
}

async function findCustomerWithClient(client, companyId, customerId, customerName) {
  if (!customerId && (!customerName || String(customerName).toLowerCase() === "cliente avulso")) return null;
  const result = await client.query(`
    select id, name, document, phone, email
    from volt_core.customers
    where company_id = $1
      and ($2::text is not null and id = $2
        or $3::text is not null and lower(name) = lower($3))
    order by number asc
    limit 1;
  `, [companyId, customerId || null, customerName || null]);
  return result.rows[0] || null;
}

async function listServiceOrders(companyId) {
  const result = await db.query(`select so.id, so.number, so.service, so.owner_name as owner, so.due_date as "dueDate", so.status, so.notes,
      so.custom_fields as "customFields", so.customer_id as "customerId", c.name as "customerName",
      so.created_at as "createdAt", so.updated_at as "updatedAt"
    from volt_core.service_orders so left join volt_core.customers c on c.id = so.customer_id and c.company_id = so.company_id
    where so.company_id = $1 order by so.number desc;`, [companyId]);
  const configuration = await getCompanyConfiguration(companyId);
  await extensionRegistry.runHook("serviceOrder.decorateRows", { companyId, rows: result.rows }, configuration);
  return result.rows;
}

async function createServiceOrder(companyId, input = {}) {
  return db.withClient(async (client) => {
    await client.query("begin");
    try {
      const configuration = await getCompanyConfigurationWithClient(client, companyId);
      const customFields = validateCustomFields(configuration, "service_order", input.customFields || {}, { requireAll: true });
      const workflow = resolveWorkflow(configuration, "service_order");
      const status = normalizeOperationalStatus(input.status || workflow?.initial || "open");
      assertTransition(configuration, "service_order", null, status);
      const customer = await findCustomerWithClient(client, companyId, input.customerId, input.customer);
      if (!customer) throw Object.assign(new Error("Cliente da OS nao encontrado"), { statusCode: 404, code: "SERVICE_ORDER_CUSTOMER_REQUIRED" });
      const id = createId("ord");
      const number = await nextOperationalNumber(client, companyId, "service_orders");
      const result = await client.query(`insert into volt_core.service_orders
        (id, company_id, number, customer_id, service, owner_name, due_date, status, notes, custom_fields)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
        returning id, number, customer_id as "customerId", service, owner_name as owner, due_date as "dueDate", status, notes, custom_fields as "customFields";`,
      [id, companyId, number, customer.id, input.service || null, input.owner || null,
        normalizeDateInput(input.dueDate || input.due), status, input.notes || null, JSON.stringify(customFields)]);
      await insertWorkflowEventWithClient(client, companyId, "service_order", "service_order", id, null, status, input.actorUserId, { source: "create" });
      await insertEventWithClient(client, companyId, "service_order.created", { serviceOrderId: id });
      await insertAuditWithClient(client, companyId, input.actorUserId, "service_order.created", "service_order", id, null, result.rows[0]);
      await client.query("commit");
      return { ...result.rows[0], customerName: customer.name };
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });
}

async function updateServiceOrder(companyId, serviceOrderId, input = {}) {
  return db.withClient(async (client) => {
    await client.query("begin");
    try {
      const currentResult = await client.query(`select id, status, custom_fields as "customFields"
        from volt_core.service_orders where company_id = $1 and id = $2 for update`, [companyId, serviceOrderId]);
      if (!currentResult.rowCount) throw Object.assign(new Error("Ordem de servico nao encontrada"), { statusCode: 404, code: "SERVICE_ORDER_NOT_FOUND" });
      const current = currentResult.rows[0];
      const configuration = await getCompanyConfigurationWithClient(client, companyId);
      const workflowResults = await extensionRegistry.runHook("serviceOrder.resolveWorkflow", { client, companyId, serviceOrderId, current }, configuration);
      const workflowKey = workflowResults.find((entry) => entry.value?.workflowKey)?.value?.workflowKey || "service_order";
      const nextStatus = input.status ? normalizeOperationalStatus(input.status) : current.status;
      if (input.status) assertTransition(configuration, workflowKey, current.status, nextStatus);
      const customFields = validateCustomFields(configuration, "service_order", input.customFields || {}, { requireAll: false });
      const result = await client.query(`update volt_core.service_orders set service = coalesce($3,service), owner_name = coalesce($4,owner_name),
          due_date = coalesce($5,due_date), status = $6, notes = coalesce($7,notes), custom_fields = custom_fields || $8::jsonb, updated_at = now()
        where company_id = $1 and id = $2 returning id, number, customer_id as "customerId", service, owner_name as owner, due_date as "dueDate", status, notes, custom_fields as "customFields";`,
      [companyId, serviceOrderId, input.service || null, input.owner || null, normalizeDateInput(input.dueDate || input.due),
        nextStatus, input.notes ?? null, JSON.stringify(customFields)]);
      if (current.status !== nextStatus) {
        await insertWorkflowEventWithClient(client, companyId, workflowKey, "service_order", serviceOrderId, current.status, nextStatus, input.actorUserId, { source: "manual" });
      }
      await insertEventWithClient(client, companyId, "service_order.updated", { serviceOrderId, status: nextStatus });
      await insertAuditWithClient(client, companyId, input.actorUserId, "service_order.updated", "service_order", serviceOrderId, current, result.rows[0]);
      await client.query("commit");
      return result.rows[0];
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });
}

module.exports = {
  createServiceOrder,
  listServiceOrders,
  updateServiceOrder,
};
