"use strict";

const path = require("path");
const bcrypt = require("bcryptjs");

try {
  require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
} catch (_error) {
  // dotenv is optional in deployed environments.
}

const db = require("../db/db");
const runtime = require("../src/modules/core/persistentCoreService");
const runtimeAccess = require("../src/modules/core/runtimeAccess");

const COMPANY_ID = process.env.VOLT_CORE_QA_COMPANY_ID || "volt-core-qa";
const USER_ID = process.env.VOLT_CORE_QA_USER_ID || "volt-core-qa-admin";
const EMAIL = process.env.VOLT_CORE_QA_EMAIL || "qa@voltcore.local";
const PASSWORD = process.env.VOLT_CORE_QA_PASSWORD || "VoltCoreQa@12345";

async function findOne(sql, params) {
  const result = await db.query(sql, params);
  return result.rows[0] || null;
}

async function ensureQaUser() {
  const passwordHash = await bcrypt.hash(PASSWORD, 12);
  await db.query(`
    insert into volt_core.users (id, name, email, password_hash, role, status, user_global_id)
    values ($1, 'QA Volt Core', $2, $3, 'operator', 'active', $4)
    on conflict (email) do update
       set name = excluded.name,
           password_hash = excluded.password_hash,
           status = 'active',
           updated_at = now();
  `, [USER_ID, EMAIL, passwordHash, USER_ID]);

  await db.query(`
    insert into volt_core.user_companies (user_id, company_id, role, permissions, screens)
    values ($1, $2, 'admin', $3::jsonb, $4::jsonb)
    on conflict (user_id, company_id) do update
       set role = 'admin',
           permissions = excluded.permissions,
           screens = excluded.screens,
           updated_at = now();
  `, [
    USER_ID,
    COMPANY_ID,
    JSON.stringify(runtimeAccess.permissionsForRole("admin")),
    JSON.stringify(runtimeAccess.screensForRole("admin")),
  ]);
}

async function seed() {
  if (!runtime.isEnabled()) {
    throw new Error("Configure VOLT_CORE_APP_DATABASE_URL antes de rodar o seed QA.");
  }

  await runtime.createCompany({
    id: COMPANY_ID,
    name: "Empresa QA Volt Core",
    segmentKey: "general",
    planKey: "starter",
    actorUserId: USER_ID,
  }, USER_ID);

  await db.withTenantContext(COMPANY_ID, async () => {
    await ensureQaUser();

    let customer = await findOne(
    "select id from volt_core.customers where company_id = $1 and lower(name) = lower($2) limit 1",
    [COMPANY_ID, "Cliente QA Balcao"],
  );
  if (!customer) {
    customer = await runtime.createCustomer(COMPANY_ID, {
      name: "Cliente QA Balcao",
      document: "000.000.000-00",
      phone: "(11) 99999-0000",
      email: "cliente.qa@example.com",
      actorUserId: USER_ID,
    });
  }

  let product = await findOne(
    "select id from volt_core.products where company_id = $1 and sku = $2 limit 1",
    [COMPANY_ID, "QA-CORE-001"],
  );
  if (!product) {
    product = await runtime.createProduct(COMPANY_ID, {
      name: "Produto QA Core",
      sku: "QA-CORE-001",
      category: "Produtos",
      salePrice: 120,
      costPrice: 55,
      minimumStock: 3,
      initialStock: 0,
      actorUserId: USER_ID,
    });
  }

  const stock = await findOne(`
    select coalesce(sum(quantity), 0)::numeric as quantity
      from volt_core.inventory_movements
     where company_id = $1 and product_id = $2
  `, [COMPANY_ID, product.id]);
  if (Number(stock?.quantity || 0) < 10) {
    await runtime.createInventoryMovement(COMPANY_ID, {
      productId: product.id,
      quantity: 10 - Number(stock?.quantity || 0),
      reason: "Seed QA",
      actorUserId: USER_ID,
    });
  }

  const openSession = await findOne(
    "select id from volt_core.cash_sessions where company_id = $1 and status = 'open' limit 1",
    [COMPANY_ID],
  );
  if (!openSession) {
    await runtime.openCashSession(COMPANY_ID, { openingAmount: 100, notes: "Seed QA", actorUserId: USER_ID });
  }

  const existingSale = await findOne(
    "select id from volt_core.sales where company_id = $1 limit 1",
    [COMPANY_ID],
  );
  if (!existingSale) {
    await runtime.createSale(COMPANY_ID, {
      customerId: customer.id,
      items: [{ productId: product.id, quantity: 1 }],
      payments: [{ method: "pix", amount: 120 }],
      actorUserId: USER_ID,
    });
  }

  const manualReceivable = await findOne(
    "select id from volt_core.receivables where company_id = $1 and description = $2 limit 1",
    [COMPANY_ID, "Recebivel manual QA"],
  );
  if (!manualReceivable) {
    await runtime.createReceivable(COMPANY_ID, {
      customerId: customer.id,
      amount: 240,
      dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      method: "store_credit",
      description: "Recebivel manual QA",
      actorUserId: USER_ID,
    });
  }

    console.log("[Volt Core][QA] Seed concluido.");
    console.log(`[Volt Core][QA] Empresa: ${COMPANY_ID}`);
    console.log(`[Volt Core][QA] Login: ${EMAIL}`);
    console.log(`[Volt Core][QA] Senha: ${PASSWORD}`);
  });
}

seed()
  .catch((error) => {
    console.error("[Volt Core][QA] Falha no seed:", error.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.pool?.end().catch(() => {});
  });
