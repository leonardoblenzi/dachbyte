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

function normalizeEan(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits || null;
}

function toQuantity(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function productEanDuplicateError() {
  return Object.assign(new Error("Este EAN ja esta cadastrado em outro produto desta empresa."), {
    statusCode: 409,
    code: "PRODUCT_EAN_DUPLICATE",
  });
}

async function assertProductEanAvailable(companyId, ean, productId = null, client = db) {
  if (!ean) return;
  const result = await client.query(`
    select id
    from volt_core.products
    where company_id = $1 and ean = $2 and ($3::text is null or id <> $3)
    limit 1;
  `, [companyId, ean, productId]);
  if (result.rowCount) throw productEanDuplicateError();
}

async function listProductCategories(companyId) {
  const result = await db.query(`
    select id, name, description, active, created_at as "createdAt", updated_at as "updatedAt"
    from volt_core.product_categories
    where company_id = $1
    order by active desc, lower(name) asc;
  `, [companyId]);
  return result.rows;
}

async function createProductCategory(companyId, input = {}) {
  const name = String(input.name || "").trim();
  if (!name) throw Object.assign(new Error("Nome da categoria e obrigatorio"), { statusCode: 400, code: "PRODUCT_CATEGORY_NAME_REQUIRED" });
  const result = await db.query(`
    insert into volt_core.product_categories (id, company_id, name, description)
    values ($1, $2, $3, $4)
    returning id, name, description, active, created_at as "createdAt", updated_at as "updatedAt";
  `, [createId("cat"), companyId, name, input.description || null]);
  await recordEvent(companyId, "product_category.created", { categoryId: result.rows[0].id });
  return result.rows[0];
}

async function updateProductCategory(companyId, categoryId, input = {}) {
  const result = await db.query(`
    update volt_core.product_categories set
      name = coalesce(nullif(trim($3), ''), name),
      description = coalesce($4, description),
      updated_at = now()
    where company_id = $1 and id = $2
    returning id, name, description, active, created_at as "createdAt", updated_at as "updatedAt";
  `, [companyId, categoryId, input.name ?? null, input.description ?? null]);
  if (!result.rowCount) throw Object.assign(new Error("Categoria nao encontrada"), { statusCode: 404, code: "PRODUCT_CATEGORY_NOT_FOUND" });
  await recordEvent(companyId, "product_category.updated", { categoryId });
  return result.rows[0];
}

async function setProductCategoryActive(companyId, categoryId, active) {
  const result = await db.query(`
    update volt_core.product_categories set active = $3, updated_at = now()
    where company_id = $1 and id = $2
    returning id, name, description, active, created_at as "createdAt", updated_at as "updatedAt";
  `, [companyId, categoryId, Boolean(active)]);
  if (!result.rowCount) throw Object.assign(new Error("Categoria nao encontrada"), { statusCode: 404, code: "PRODUCT_CATEGORY_NOT_FOUND" });
  await recordEvent(companyId, active ? "product_category.activated" : "product_category.deactivated", { categoryId });
  return result.rows[0];
}

async function listProductBrands(companyId) {
  const result = await db.query(`
    select id, name, description, active, created_at as "createdAt", updated_at as "updatedAt"
    from volt_core.product_brands
    where company_id = $1
    order by active desc, lower(name) asc;
  `, [companyId]);
  return result.rows;
}

async function createProductBrand(companyId, input = {}) {
  const name = String(input.name || "").trim();
  if (!name) throw Object.assign(new Error("Nome da marca e obrigatorio"), { statusCode: 400, code: "PRODUCT_BRAND_NAME_REQUIRED" });
  const result = await db.query(`
    insert into volt_core.product_brands (id, company_id, name, description)
    values ($1, $2, $3, $4)
    returning id, name, description, active, created_at as "createdAt", updated_at as "updatedAt";
  `, [createId("brd"), companyId, name, input.description || null]);
  await recordEvent(companyId, "product_brand.created", { brandId: result.rows[0].id });
  return result.rows[0];
}

async function updateProductBrand(companyId, brandId, input = {}) {
  const result = await db.query(`
    update volt_core.product_brands set
      name = coalesce(nullif(trim($3), ''), name),
      description = coalesce($4, description),
      updated_at = now()
    where company_id = $1 and id = $2
    returning id, name, description, active, created_at as "createdAt", updated_at as "updatedAt";
  `, [companyId, brandId, input.name ?? null, input.description ?? null]);
  if (!result.rowCount) throw Object.assign(new Error("Marca nao encontrada"), { statusCode: 404, code: "PRODUCT_BRAND_NOT_FOUND" });
  await recordEvent(companyId, "product_brand.updated", { brandId });
  return result.rows[0];
}

async function setProductBrandActive(companyId, brandId, active) {
  const result = await db.query(`
    update volt_core.product_brands set active = $3, updated_at = now()
    where company_id = $1 and id = $2
    returning id, name, description, active, created_at as "createdAt", updated_at as "updatedAt";
  `, [companyId, brandId, Boolean(active)]);
  if (!result.rowCount) throw Object.assign(new Error("Marca nao encontrada"), { statusCode: 404, code: "PRODUCT_BRAND_NOT_FOUND" });
  await recordEvent(companyId, active ? "product_brand.activated" : "product_brand.deactivated", { brandId });
  return result.rows[0];
}

async function decorateProducts(companyId, rows, configuration, client = db) {
  await extensionRegistry.runHook("product.decorateRows", { client, companyId, rows }, configuration);
  return rows;
}

async function listProducts(companyId) {
  const [configuration, result] = await Promise.all([
    getCompanyConfiguration(companyId),
    db.query(`
      select id, number, sku, ean, name, category, category_id as "categoryId", brand, brand_id as "brandId", type,
        sale_price as "salePrice", cost_price as "costPrice", minimum_stock as "minimumStock", track_stock as "trackStock",
        active, custom_fields as "customFields", created_at as "createdAt", updated_at as "updatedAt"
      from volt_core.products
      where company_id = $1
      order by number asc;
    `, [companyId]),
  ]);
  return decorateProducts(companyId, result.rows, configuration);
}

async function createProduct(companyId, input = {}) {
  if (!input.name || !String(input.name).trim()) {
    throw Object.assign(new Error("Nome do produto e obrigatorio"), { statusCode: 400, code: "PRODUCT_NAME_REQUIRED" });
  }
  return db.withClient(async (client) => {
    await client.query("begin");
    try {
      const configuration = await getCompanyConfigurationWithClient(client, companyId);
      const extensionPayloads = extensionRegistry.inputPayloads("product", input, configuration);
      const customFields = validateCustomFields(configuration, "product", input.customFields || {}, { requireAll: true });
      const id = createId("prd");
      const number = await nextOperationalNumber(client, companyId, "products");
      const ean = normalizeEan(input.ean);
      await assertProductEanAvailable(companyId, ean, null, client);
      const result = await client.query(`
        insert into volt_core.products (
          id, company_id, number, sku, ean, name, category, category_id, brand, brand_id, type, sale_price, cost_price,
          minimum_stock, track_stock, custom_fields
        ) values ($1,$2,$3,$4,$5,$6,$7,
          (select id from volt_core.product_categories where company_id = $2 and lower(name) = lower($7) and active = true limit 1),
          $8,
          (select id from volt_core.product_brands where company_id = $2 and lower(name) = lower($8) and active = true limit 1),
          $9,$10,$11,$12,$13,$14::jsonb)
        returning id, number, sku, ean, name, category, category_id as "categoryId", brand, brand_id as "brandId", type,
          sale_price as "salePrice", cost_price as "costPrice", minimum_stock as "minimumStock", track_stock as "trackStock",
          active, custom_fields as "customFields", created_at as "createdAt", updated_at as "updatedAt";
      `, [id, companyId, number, input.sku || null, ean, String(input.name).trim(), input.category || "Produtos",
        input.brand || null, input.type || "product", Number(input.salePrice || 0), Number(input.costPrice || 0),
        Number(input.minimumStock || 0), input.trackStock !== false, JSON.stringify(customFields)]);
      const product = result.rows[0];
      await extensionRegistry.runHook("product.afterPersisted", { client, companyId, product, input, extensionPayloads }, configuration);
      await extensionRegistry.runHook("product.decorateRows", { client, companyId, rows: [product] }, configuration);
      const initialStock = Math.max(0, toQuantity(input.initialStock || 0));
      if (input.trackStock !== false && initialStock > 0) {
        await client.query(`insert into volt_core.inventory_movements
          (id, company_id, product_id, type, quantity, reason, source_type, actor_user_id)
          values ($1,$2,$3,'entry',$4,'Estoque inicial','product_create',$5);`,
        [createId("inv"), companyId, id, initialStock, input.actorUserId || null]);
      }
      await insertEventWithClient(client, companyId, "product.created", { productId: id, extensions: Object.keys(extensionPayloads) });
      await insertAuditWithClient(client, companyId, input.actorUserId, "product.created", "product", id, null, product);
      await client.query("commit");
      return product;
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });
}

async function updateProduct(companyId, productId, input = {}) {
  return db.withClient(async (client) => {
    await client.query("begin");
    try {
      const configuration = await getCompanyConfigurationWithClient(client, companyId);
      const extensionPayloads = extensionRegistry.inputPayloads("product", input, configuration);
      const customFields = validateCustomFields(configuration, "product", input.customFields || {}, { requireAll: false });
      const hasEan = Object.prototype.hasOwnProperty.call(input, "ean");
      const hasBrand = Object.prototype.hasOwnProperty.call(input, "brand");
      const ean = normalizeEan(input.ean);
      if (hasEan) await assertProductEanAvailable(companyId, ean, productId, client);
      const result = await client.query(`
        update volt_core.products set
          sku = coalesce($3, sku), ean = case when $14 then $4 else ean end, name = coalesce($5, name), category = coalesce($6, category),
          category_id = case when $6 is null then category_id else (
            select id from volt_core.product_categories where company_id = $1 and lower(name) = lower($6) and active = true limit 1
          ) end,
          brand = case when $15 then $7 else brand end,
          brand_id = case when not $15 then brand_id when $7 is null then null else (
            select id from volt_core.product_brands where company_id = $1 and lower(name) = lower($7) and active = true limit 1
          ) end,
          type = coalesce($8, type), sale_price = coalesce($9, sale_price), cost_price = coalesce($10, cost_price),
          minimum_stock = coalesce($11, minimum_stock), track_stock = coalesce($12, track_stock),
          custom_fields = custom_fields || $13::jsonb, updated_at = now()
        where company_id = $1 and id = $2
        returning id, number, sku, ean, name, category, category_id as "categoryId", brand, brand_id as "brandId", type,
          sale_price as "salePrice", cost_price as "costPrice", minimum_stock as "minimumStock", track_stock as "trackStock", active,
          custom_fields as "customFields", created_at as "createdAt", updated_at as "updatedAt";
      `, [companyId, productId, input.sku ?? null, ean, input.name || null, input.category || null, input.brand || null, input.type || null,
        input.salePrice ?? null, input.costPrice ?? null, input.minimumStock ?? null,
        input.trackStock === undefined ? null : Boolean(input.trackStock), JSON.stringify(customFields), hasEan, hasBrand]);
      if (!result.rowCount) throw Object.assign(new Error("Produto nao encontrado"), { statusCode: 404, code: "PRODUCT_NOT_FOUND" });
      const product = result.rows[0];
      await extensionRegistry.runHook("product.afterPersisted", { client, companyId, product, input, extensionPayloads }, configuration);
      await extensionRegistry.runHook("product.decorateRows", { client, companyId, rows: [product] }, configuration);
      await insertEventWithClient(client, companyId, "product.updated", { productId, extensions: Object.keys(extensionPayloads) });
      await insertAuditWithClient(client, companyId, input.actorUserId, "product.updated", "product", productId, null, product);
      await client.query("commit");
      return product;
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });
}

async function setProductActive(companyId, productId, active) {
  const result = await db.query(`
    update volt_core.products set active = $3, updated_at = now()
    where company_id = $1 and id = $2 returning id, name, active;
  `, [companyId, productId, Boolean(active)]);
  if (!result.rowCount) throw Object.assign(new Error("Produto nao encontrado"), { statusCode: 404, code: "PRODUCT_NOT_FOUND" });
  await recordEvent(companyId, active ? "product.activated" : "product.deactivated", { productId });
  return result.rows[0];
}

async function deleteProduct(companyId, productId) {
  return db.withClient(async (client) => {
    await client.query("begin");
    try {
      const current = await client.query("select id, name, active from volt_core.products where company_id = $1 and id = $2 for update", [companyId, productId]);
      if (!current.rowCount) throw Object.assign(new Error("Produto nao encontrado"), { statusCode: 404, code: "PRODUCT_NOT_FOUND" });
      if (current.rows[0].active) throw Object.assign(new Error("Desative o produto antes de excluir."), { statusCode: 400, code: "PRODUCT_MUST_BE_INACTIVE" });
      const configuration = await getCompanyConfigurationWithClient(client, companyId);
      const dependencies = await client.query(`
        select
          (select count(*) from volt_core.sale_items si join volt_core.sales s on s.id = si.sale_id and s.company_id = si.company_id where s.company_id = $1 and si.product_id = $2) +
          (select count(*) from volt_core.inventory_movements where company_id = $1 and product_id = $2) as total;
      `, [companyId, productId]);
      const extensionDependencies = await extensionRegistry.runHook("product.dependencies", { client, companyId, entityId: productId }, configuration);
      const extensionCount = extensionDependencies.reduce((sum, entry) => sum + Number(entry.value?.count || 0), 0);
      if (Number(dependencies.rows[0]?.total || 0) + extensionCount > 0) {
        throw Object.assign(new Error("Produto possui historico vinculado e nao pode ser excluido."), { statusCode: 400, code: "PRODUCT_HAS_HISTORY" });
      }
      await extensionRegistry.runHook("product.beforeDeleted", { client, companyId, entityId: productId }, configuration);
      await client.query("delete from volt_core.products where company_id = $1 and id = $2", [companyId, productId]);
      await insertEventWithClient(client, companyId, "product.deleted", { productId });
      await insertAuditWithClient(client, companyId, null, "product.deleted", "product", productId, current.rows[0], null);
      await client.query("commit");
      return current.rows[0];
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });
}

module.exports = {
  createProduct,
  createProductBrand,
  createProductCategory,
  deleteProduct,
  listProductBrands,
  listProductCategories,
  listProducts,
  setProductActive,
  setProductBrandActive,
  setProductCategoryActive,
  updateProduct,
  updateProductBrand,
  updateProductCategory,
};
