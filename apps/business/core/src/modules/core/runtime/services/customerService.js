"use strict";

const db = require("../../../../../db/db");
const { createId } = require("../../id");
const { validateCustomFields } = require("../../configuration/customFields");
const { getCompanyConfiguration, getCompanyConfigurationWithClient } = require("./configurationService");
const { extensionRegistry } = require("../../../../platform/extensions/extensionRegistry");
const {
  insertAuditWithClient,
  insertEventWithClient,
  nextOperationalNumber,
  recordEvent,
} = require("./persistenceHelpers");

async function listCustomers(companyId) {
  const result = await db.query(`
    select
      id,
      number,
      name,
      phone,
      document,
      email,
      address,
      notes,
      active,
      custom_fields as "customFields",
      (
        select max(s.sold_at)
        from volt_core.sales s
        where s.company_id = customers.company_id
          and s.customer_id = customers.id
          and s.status <> 'canceled'
      ) as "lastPurchaseAt",
      (
        select coalesce(sum(r.amount - r.paid_amount), 0)
        from volt_core.receivables r
        where r.company_id = customers.company_id
          and r.customer_id = customers.id
          and r.status not in ('paid', 'received', 'compensated', 'canceled')
      ) as "openBalance",
      created_at as "createdAt",
      updated_at as "updatedAt"
    from volt_core.customers
    where company_id = $1
    order by number asc;
  `, [companyId]);
  return result.rows;
}

async function createCustomer(companyId, input = {}) {
  if (!input.name || !String(input.name).trim()) {
    throw Object.assign(new Error("Nome do cliente e obrigatorio"), { statusCode: 400, code: "CUSTOMER_NAME_REQUIRED" });
  }

  return db.withClient(async (client) => {
    await client.query("begin");
    try {
      const configuration = await getCompanyConfigurationWithClient(client, companyId);
      const customFields = validateCustomFields(configuration, "customer", input.customFields || {}, { requireAll: true });
      const id = createId("cus");
      const number = await nextOperationalNumber(client, companyId, "customers");
      const result = await client.query(`
        insert into volt_core.customers (
          id, company_id, number, name, phone, document, email, address, notes, custom_fields
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
        returning id, number, name, phone, document, email, address, notes, active,
          custom_fields as "customFields", created_at as "createdAt", updated_at as "updatedAt";
      `, [id, companyId, number, String(input.name).trim(), input.phone || null, input.document || null,
        input.email || null, input.address || null, input.notes || null, JSON.stringify(customFields)]);
      await insertEventWithClient(client, companyId, "customer.created", { customerId: id });
      await insertAuditWithClient(client, companyId, input.actorUserId, "customer.created", "customer", id, null, result.rows[0]);
      await client.query("commit");
      return result.rows[0];
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });
}

async function updateCustomer(companyId, customerId, input = {}) {
  const configuration = await getCompanyConfiguration(companyId);
  const customFields = validateCustomFields(configuration, "customer", input.customFields || {}, { requireAll: false });
  const result = await db.query(`
    update volt_core.customers set
      name = coalesce($3, name), phone = coalesce($4, phone), document = coalesce($5, document),
      email = coalesce($6, email), address = coalesce($7, address), notes = coalesce($8, notes),
      custom_fields = custom_fields || $9::jsonb, updated_at = now()
    where company_id = $1 and id = $2
    returning id, number, name, phone, document, email, address, notes, active,
      custom_fields as "customFields", created_at as "createdAt", updated_at as "updatedAt";
  `, [companyId, customerId, input.name || null, input.phone ?? null, input.document ?? null,
    input.email ?? null, input.address ?? null, input.notes ?? null, JSON.stringify(customFields)]);
  if (!result.rowCount) throw Object.assign(new Error("Cliente nao encontrado"), { statusCode: 404, code: "CUSTOMER_NOT_FOUND" });
  await recordEvent(companyId, "customer.updated", { customerId });
  return result.rows[0];
}

async function setCustomerActive(companyId, customerId, active) {
  const result = await db.query(`
    update volt_core.customers set active = $3, updated_at = now()
    where company_id = $1 and id = $2 returning id, name, active;
  `, [companyId, customerId, Boolean(active)]);
  if (!result.rowCount) throw Object.assign(new Error("Cliente nao encontrado"), { statusCode: 404, code: "CUSTOMER_NOT_FOUND" });
  await recordEvent(companyId, active ? "customer.activated" : "customer.deactivated", { customerId });
  return result.rows[0];
}

async function deleteCustomer(companyId, customerId) {
  return db.withClient(async (client) => {
    await client.query("begin");
    try {
      const current = await client.query(
        "select id, name, active from volt_core.customers where company_id = $1 and id = $2 for update",
        [companyId, customerId],
      );
      if (!current.rowCount) throw Object.assign(new Error("Cliente nao encontrado"), { statusCode: 404, code: "CUSTOMER_NOT_FOUND" });
      if (current.rows[0].active) throw Object.assign(new Error("Desative o cliente antes de excluir."), { statusCode: 400, code: "CUSTOMER_MUST_BE_INACTIVE" });

      const configuration = await getCompanyConfigurationWithClient(client, companyId);
      const dependencies = await client.query(`
        select
          (select count(*) from volt_core.sales where company_id = $1 and customer_id = $2) +
          (select count(*) from volt_core.receivables where company_id = $1 and customer_id = $2) +
          (select count(*) from volt_core.service_orders where company_id = $1 and customer_id = $2) as total;
      `, [companyId, customerId]);
      const extensionDependencies = await extensionRegistry.runHook("customer.dependencies", { client, companyId, entityId: customerId }, configuration);
      const extensionCount = extensionDependencies.reduce((sum, entry) => sum + Number(entry.value?.count || 0), 0);
      if (Number(dependencies.rows[0]?.total || 0) + extensionCount > 0) {
        throw Object.assign(new Error("Cliente possui historico vinculado e nao pode ser excluido."), { statusCode: 400, code: "CUSTOMER_HAS_HISTORY" });
      }

      await client.query("delete from volt_core.customers where company_id = $1 and id = $2", [companyId, customerId]);
      await insertEventWithClient(client, companyId, "customer.deleted", { customerId });
      await insertAuditWithClient(client, companyId, null, "customer.deleted", "customer", customerId, current.rows[0], null);
      await client.query("commit");
      return current.rows[0];
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });
}

module.exports = {
  createCustomer,
  deleteCustomer,
  listCustomers,
  setCustomerActive,
  updateCustomer,
};
