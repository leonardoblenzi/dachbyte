"use strict";

const db = require("../../../../../db/db");
const { createId } = require("../../id");
const { insertAuditWithClient } = require("./persistenceHelpers");
const {
  SUBSCRIPTION_STATUSES,
  getCommercialPlan,
  getCommercialProduct,
} = require("../../commercial/productCatalog");
const {
  buildCommercialSnapshot,
  currentPeriod,
} = require("../../commercial/commercialResolver");

function badRequest(message, code) {
  return Object.assign(new Error(message), { statusCode: 400, code });
}

function conflict(message, code) {
  return Object.assign(new Error(message), { statusCode: 409, code });
}

function notFound(message, code) {
  return Object.assign(new Error(message), { statusCode: 404, code });
}

function normalizeProductOrFail(productKey) {
  const product = getCommercialProduct(productKey);
  if (!product) throw notFound("Produto comercial nao encontrado", "COMMERCIAL_PRODUCT_NOT_FOUND");
  return product;
}

function normalizePlanOrFail(product, planKey) {
  if (!(product.plans || []).length) return null;
  const plan = getCommercialPlan(product, planKey || product.defaultPlanKey);
  if (!plan) throw badRequest("Plano comercial invalido para este produto", "COMMERCIAL_PLAN_INVALID");
  return plan;
}

async function getCompanyIdentityWithClient(client, companyId) {
  const result = await client.query(`
    select segment_key as "segmentKey", plan_key as "planKey"
      from volt_core.companies
     where id = $1`, [companyId]);
  if (!result.rowCount) throw notFound("Empresa nao encontrada", "COMPANY_NOT_FOUND");
  return result.rows[0];
}

async function listSubscriptionRowsWithClient(client, companyId) {
  const result = await client.query(`
    select id,
           product_key as "productKey",
           plan_key as "planKey",
           status,
           contracted_at as "contractedAt",
           activated_at as "activatedAt",
           suspended_at as "suspendedAt",
           metadata,
           updated_at as "updatedAt"
      from volt_core.company_product_subscriptions
     where company_id = $1
     order by created_at asc`, [companyId]);
  return result.rows;
}

async function listCurrentUsageRowsWithClient(client, companyId, now = new Date()) {
  const period = currentPeriod(now);
  const result = await client.query(`
    select product_key as "productKey",
           metric_key as "metricKey",
           used_count as "usedCount",
           period_start as "periodStart"
      from volt_core.service_usage_counters
     where company_id = $1
       and period_start = $2::date`, [companyId, period.start]);
  return result.rows;
}

async function getCommercialSnapshotWithClient(client, companyId, context = {}) {
  const identity = context.segmentKey && context.corePlanKey
    ? { segmentKey: context.segmentKey, planKey: context.corePlanKey }
    : await getCompanyIdentityWithClient(client, companyId);
  const [subscriptions, usageRows] = await Promise.all([
    listSubscriptionRowsWithClient(client, companyId),
    listCurrentUsageRowsWithClient(client, companyId, context.now),
  ]);
  return buildCommercialSnapshot({
    segmentKey: identity.segmentKey,
    corePlanKey: identity.planKey,
    subscriptions,
    usageRows,
    now: context.now || new Date(),
  });
}

async function getCompanyCommercialSnapshot(companyId) {
  return getCommercialSnapshotWithClient(db, companyId);
}

async function syncCompanyCommercialProductsWithClient(client, companyId, input = {}) {
  const segmentKey = String(input.segmentKey || "general").toLowerCase();
  const planKey = String(input.planKey || "starter").toLowerCase();
  const actorUserId = input.actorUserId || null;

  await client.query(`
    insert into volt_core.company_product_subscriptions (
      id, company_id, product_key, plan_key, status, contracted_at, activated_at, metadata, updated_by, updated_at
    ) values ($1,$2,'core',$3,'active',now(),now(),$4::jsonb,$5,now())
    on conflict (company_id, product_key) do update set
      plan_key = excluded.plan_key,
      status = 'active',
      activated_at = coalesce(volt_core.company_product_subscriptions.activated_at, now()),
      suspended_at = null,
      metadata = volt_core.company_product_subscriptions.metadata || excluded.metadata,
      updated_by = excluded.updated_by,
      updated_at = now()`,
  [createId("sub"), companyId, planKey, JSON.stringify({ source: "core" }), actorUserId]);

  if (segmentKey === "optical") {
    await client.query(`
      insert into volt_core.company_product_subscriptions (
        id, company_id, product_key, plan_key, status, contracted_at, activated_at, metadata, updated_by, updated_at
      ) values ($1,$2,'vertical.optical','standard','active',now(),now(),$3::jsonb,$4,now())
      on conflict (company_id, product_key) do update set
        plan_key = 'standard',
        status = 'active',
        contracted_at = coalesce(volt_core.company_product_subscriptions.contracted_at, now()),
        activated_at = coalesce(volt_core.company_product_subscriptions.activated_at, now()),
        suspended_at = null,
        metadata = volt_core.company_product_subscriptions.metadata || excluded.metadata,
        updated_by = excluded.updated_by,
        updated_at = now()`,
    [createId("sub"), companyId, JSON.stringify({ source: "segment_template" }), actorUserId]);
  } else {
    await client.query(`
      update volt_core.company_product_subscriptions
         set status = 'suspended',
             suspended_at = now(),
             updated_by = $2,
             updated_at = now()
       where company_id = $1
         and product_key = 'vertical.optical'
         and status <> 'suspended'
         and coalesce(metadata->>'source','') in ('segment_template','legacy_segment')`,
    [companyId, actorUserId]);
  }
}

async function requestCommercialProduct(companyId, productKey, input = {}) {
  const product = normalizeProductOrFail(productKey);
  if (product.alwaysActive) throw conflict("Volt Core ja faz parte de todas as empresas", "COMMERCIAL_PRODUCT_ALWAYS_ACTIVE");
  if (product.comingSoon) throw conflict("Este produto ainda nao esta disponivel para contratacao", "COMMERCIAL_PRODUCT_COMING_SOON");
  const plan = normalizePlanOrFail(product, input.planKey);

  return db.withClient(async (client) => {
    await client.query("begin");
    try {
      const current = await client.query(`
        select id,status,plan_key as "planKey"
          from volt_core.company_product_subscriptions
         where company_id=$1 and product_key=$2
         for update`, [companyId, product.key]);
      if (current.rows[0]?.status === "active") {
        throw conflict("Produto ja esta ativo; alteracoes devem ser feitas pelo Master", "COMMERCIAL_PRODUCT_ALREADY_ACTIVE");
      }
      const id = current.rows[0]?.id || createId("sub");
      await client.query(`
        insert into volt_core.company_product_subscriptions (
          id,company_id,product_key,plan_key,status,contracted_at,metadata,updated_by,updated_at
        ) values ($1,$2,$3,$4,'contracted',now(),$5::jsonb,$6,now())
        on conflict (company_id, product_key) do update set
          plan_key=excluded.plan_key,
          status='contracted',
          contracted_at=coalesce(volt_core.company_product_subscriptions.contracted_at,now()),
          suspended_at=null,
          metadata=volt_core.company_product_subscriptions.metadata || excluded.metadata,
          updated_by=excluded.updated_by,
          updated_at=now()`,
      [id, companyId, product.key, plan?.key || null, JSON.stringify({ requestedAt: new Date().toISOString(), requestedBy: input.actorUserId || null }), input.actorUserId || null]);
      await insertAuditWithClient(client, companyId, input.actorUserId, "commercial.product.requested", "commercial_product", product.key,
        current.rows[0] || null, { productKey: product.key, planKey: plan?.key || null, status: "contracted" });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
    return getCompanyCommercialSnapshot(companyId);
  });
}

async function setCommercialProduct(companyId, productKey, input = {}) {
  const product = normalizeProductOrFail(productKey);
  if (product.alwaysActive) throw conflict("Volt Core nao pode ser suspenso ou removido", "COMMERCIAL_PRODUCT_ALWAYS_ACTIVE");
  if (product.comingSoon) throw conflict("Este produto ainda esta marcado como Em breve", "COMMERCIAL_PRODUCT_COMING_SOON");
  const status = String(input.status || "").trim().toLowerCase();
  if (!SUBSCRIPTION_STATUSES.includes(status)) {
    throw badRequest("Status comercial invalido", "COMMERCIAL_STATUS_INVALID");
  }
  const plan = normalizePlanOrFail(product, input.planKey);

  return db.withClient(async (client) => {
    await client.query("begin");
    try {
      const current = await client.query(`
        select id,product_key as "productKey",plan_key as "planKey",status,contracted_at as "contractedAt",
               activated_at as "activatedAt",suspended_at as "suspendedAt",metadata
          from volt_core.company_product_subscriptions
         where company_id=$1 and product_key=$2
         for update`, [companyId, product.key]);
      const id = current.rows[0]?.id || createId("sub");
      await client.query(`
        insert into volt_core.company_product_subscriptions (
          id,company_id,product_key,plan_key,status,contracted_at,activated_at,suspended_at,metadata,updated_by,updated_at
        ) values (
          $1,$2,$3,$4,$5,
          case when $5 in ('contracted','configuring','active') then now() else null end,
          case when $5='active' then now() else null end,
          case when $5='suspended' then now() else null end,
          $6::jsonb,$7,now()
        )
        on conflict (company_id, product_key) do update set
          plan_key=excluded.plan_key,
          status=excluded.status,
          contracted_at=case when excluded.status in ('contracted','configuring','active') then coalesce(volt_core.company_product_subscriptions.contracted_at,now()) else volt_core.company_product_subscriptions.contracted_at end,
          activated_at=case when excluded.status='active' then coalesce(volt_core.company_product_subscriptions.activated_at,now()) else volt_core.company_product_subscriptions.activated_at end,
          suspended_at=case when excluded.status='suspended' then now() else null end,
          metadata=volt_core.company_product_subscriptions.metadata || excluded.metadata,
          updated_by=excluded.updated_by,
          updated_at=now()`,
      [id, companyId, product.key, plan?.key || null, status, JSON.stringify({ managedBy: input.actorUserId || null }), input.actorUserId || null]);
      await insertAuditWithClient(client, companyId, input.actorUserId, "commercial.product.updated", "commercial_product", product.key,
        current.rows[0] || null, { productKey: product.key, planKey: plan?.key || null, status });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
    return getCompanyCommercialSnapshot(companyId);
  });
}

async function consumeCommercialUsageWithClient(client, companyId, productKey, metricKey, amount = 1, now = new Date()) {
  const product = normalizeProductOrFail(productKey);
  const increment = Number(amount);
  if (!Number.isInteger(increment) || increment <= 0) throw badRequest("Consumo deve ser um inteiro positivo", "COMMERCIAL_USAGE_INVALID");
  if (!product.usageMetricKey || product.usageMetricKey !== metricKey) {
    throw badRequest("Metrica de consumo invalida para este produto", "COMMERCIAL_USAGE_METRIC_INVALID");
  }

  const subscriptionResult = await client.query(`
    select plan_key as "planKey",status
      from volt_core.company_product_subscriptions
     where company_id=$1 and product_key=$2
     for update`, [companyId, product.key]);
  const subscription = subscriptionResult.rows[0];
  if (!subscription || subscription.status !== "active") {
    throw conflict("Servico nao esta ativo para consumo", "COMMERCIAL_PRODUCT_NOT_ACTIVE");
  }
  const plan = normalizePlanOrFail(product, subscription.planKey);
  const limit = plan?.limits?.[product.usageLimitKey] ?? null;
  const period = currentPeriod(now);

  await client.query(`
    insert into volt_core.service_usage_counters (company_id,product_key,metric_key,period_start,used_count,updated_at)
    values ($1,$2,$3,$4::date,0,now())
    on conflict (company_id,product_key,metric_key,period_start) do nothing`,
  [companyId, product.key, metricKey, period.start]);
  const current = await client.query(`
    select used_count as "usedCount"
      from volt_core.service_usage_counters
     where company_id=$1 and product_key=$2 and metric_key=$3 and period_start=$4::date
     for update`, [companyId, product.key, metricKey, period.start]);
  const used = Number(current.rows[0]?.usedCount || 0);
  const next = used + increment;
  if (limit !== null && next > Number(limit)) {
    throw conflict("Limite mensal do servico atingido", "COMMERCIAL_USAGE_LIMIT_REACHED");
  }
  await client.query(`
    update volt_core.service_usage_counters
       set used_count=$5,updated_at=now()
     where company_id=$1 and product_key=$2 and metric_key=$3 and period_start=$4::date`,
  [companyId, product.key, metricKey, period.start, next]);
  return {
    productKey: product.key,
    metricKey,
    used: next,
    limit,
    remaining: limit === null ? null : Math.max(0, Number(limit) - next),
    periodStart: period.start,
    periodEnd: period.end,
  };
}

module.exports = {
  consumeCommercialUsageWithClient,
  getCommercialSnapshotWithClient,
  getCompanyCommercialSnapshot,
  listCurrentUsageRowsWithClient,
  listSubscriptionRowsWithClient,
  requestCommercialProduct,
  setCommercialProduct,
  syncCompanyCommercialProductsWithClient,
};
