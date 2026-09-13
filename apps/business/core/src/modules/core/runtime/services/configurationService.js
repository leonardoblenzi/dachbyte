"use strict";

const db = require("../../../../../db/db");
const { createId } = require("../../id");
const { hasCapability, withEffectiveConfiguration } = require("../../capabilities/capabilityResolver");
const { normalizeCompanyOverrides } = require("../../configuration/configurationEngine");
const { normalizeDefinition: normalizeCustomFieldDefinition } = require("../../configuration/customFields");
const { validateWorkflowDefinition } = require("../../workflows/workflowEngine");
const { getCommercialSnapshotWithClient } = require("./commercialService");

async function getCompanyConfigurationWithClient(client, companyId) {
  const result = await client.query(`
    select c.id as "companyId", c.name, c.document, c.phone, c.address,
      c.segment_key as "segmentKey", c.plan_key as "planKey",
      cfg.modules, cfg.screens, cfg.settings, cfg.overrides,
      cfg.updated_by as "updatedBy", cfg.updated_at as "updatedAt"
    from volt_core.companies c
    join volt_core.company_configurations cfg on cfg.company_id = c.id
    where c.id = $1`, [companyId]);
  if (!result.rowCount) throw Object.assign(new Error("Configuracao da empresa nao encontrada"), { statusCode: 404, code: "COMPANY_CONFIGURATION_NOT_FOUND" });
  const row = result.rows[0];
  const commercial = await getCommercialSnapshotWithClient(client, companyId, {
    segmentKey: row.segmentKey,
    corePlanKey: row.planKey,
  });
  return withEffectiveConfiguration({ ...row, commercial });
}

function getCompanyConfiguration(companyId) { return getCompanyConfigurationWithClient(db, companyId); }

async function checkCapability(companyId, capabilityKey, client = db) {
  if (!capabilityKey) return { enabled: true, reason: "capability_not_required" };
  if (!db.isDatabaseEnabled()) return { enabled: true, reason: "database_disabled" };
  const configuration = await getCompanyConfigurationWithClient(client, companyId);
  return { enabled: hasCapability(configuration, capabilityKey), capability: capabilityKey, modules: configuration.modules };
}

async function assertCompanyCapability(companyId, capabilityKey, client = db) {
  const result = await checkCapability(companyId, capabilityKey, client);
  if (result.enabled) return result;
  throw Object.assign(new Error("Recurso nao habilitado para esta empresa"), { statusCode: 403, code: "CAPABILITY_DISABLED", capability: capabilityKey });
}

async function updateCompanySettings(companyId, input = {}) {
  const settings = {
    companyName: input.companyName, legalName: input.legalName, email: input.email, receiptMessage: input.receiptMessage,
    requireOpenCashSession: input.requireOpenCashSession, allowAnonymousCustomer: input.allowAnonymousCustomer,
    requireInventoryAdjustmentReason: input.requireInventoryAdjustmentReason,
  };
  Object.keys(settings).forEach((key) => settings[key] === undefined && delete settings[key]);
  const result = await db.query(`update volt_core.companies set name=coalesce($2,name), document=coalesce($3,document),
      phone=coalesce($4,phone), address=coalesce($5,address), updated_at=now() where id=$1
      returning id as "companyId", name, document, phone, address, segment_key as "segmentKey", plan_key as "planKey"`,
  [companyId, input.companyName || null, input.document || null, input.phone || null, input.address || null]);
  if (!result.rowCount) throw Object.assign(new Error("Empresa nao encontrada"), { statusCode: 404, code: "COMPANY_NOT_FOUND" });
  await db.query(`update volt_core.company_configurations set settings=settings || $2::jsonb, updated_by=$3, updated_at=now() where company_id=$1`,
    [companyId, JSON.stringify(settings), input.actorUserId || null]);
  await db.query(`insert into volt_core.events(company_id,type,payload) values($1,'company.settings.updated',$2::jsonb)`, [companyId, JSON.stringify({ companyId })]);
  return getCompanyConfiguration(companyId);
}

async function updateCompanyOverrides(companyId, input = {}) {
  const current = await getCompanyConfiguration(companyId);
  const merged = normalizeCompanyOverrides(current.overrides, input);
  await db.query(`update volt_core.company_configurations set overrides=$2::jsonb, updated_by=$3, updated_at=now() where company_id=$1`,
    [companyId, JSON.stringify(merged), input.actorUserId || null]);
  await db.query(`insert into volt_core.audit_logs(company_id,actor_user_id,action,entity_type,entity_id,before_payload,after_payload)
    values($1,$2,'company.overrides.updated','company',$1,$3::jsonb,$4::jsonb)`,
    [companyId, input.actorUserId || null, JSON.stringify(current.overrides || {}), JSON.stringify(merged)]);
  return getCompanyConfiguration(companyId);
}

async function saveConfigurationItem(companyId, listKey, input = {}) {
  const allowed = new Set(["customFields", "workflows", "modulePlans", "genericConfigs"]);
  if (!allowed.has(listKey)) throw Object.assign(new Error("Lista de configuracao invalida"), { statusCode: 400, code: "CONFIG_LIST_INVALID" });
  const configuration = await getCompanyConfiguration(companyId);
  const current = Array.isArray(configuration.settings?.[listKey]) ? configuration.settings[listKey] : [];
  const id = input.id || createId(listKey === "workflows" ? "wfl" : "cfg");
  let item = { ...input, id };
  if (listKey === "customFields") item = normalizeCustomFieldDefinition(input, id);
  else if (listKey === "workflows") item = { ...validateWorkflowDefinition({ ...input, key: input.key || input.entity || id }), id };
  const match = (entry) => listKey === "workflows"
    ? String(entry.id || "") === String(item.id || "") || String(entry.key || "") === String(item.key || "")
    : entry.id === id;
  const next = current.some(match) ? current.map((entry) => match(entry) ? item : entry) : [item, ...current];
  await db.query(`update volt_core.company_configurations set settings=jsonb_set(settings,$2::text[],$3::jsonb,true), updated_by=$4, updated_at=now() where company_id=$1`,
    [companyId, `{${listKey}}`, JSON.stringify(next), input.actorUserId || null]);
  await db.query(`insert into volt_core.audit_logs(company_id,actor_user_id,action,entity_type,entity_id,after_payload)
    values($1,$2,'configuration.updated','configuration',$3,$4::jsonb)`,
    [companyId, input.actorUserId || null, item.id, JSON.stringify({ listKey, item })]);
  return item;
}

async function deleteConfigurationItem(companyId, listKey, itemId, input = {}) {
  const allowed = new Set(["customFields", "workflows", "modulePlans", "genericConfigs"]);
  if (!allowed.has(listKey)) throw Object.assign(new Error("Lista de configuracao invalida"), { statusCode: 400, code: "CONFIG_LIST_INVALID" });
  const configuration = await getCompanyConfiguration(companyId);
  const current = Array.isArray(configuration.settings?.[listKey]) ? configuration.settings[listKey] : [];
  const target = current.find((entry) => String(entry.id || "") === String(itemId) || (listKey === "workflows" && String(entry.key || "") === String(itemId)));
  if (!target) throw Object.assign(new Error("Configuracao nao encontrada"), { statusCode: 404, code: "CONFIG_ITEM_NOT_FOUND" });
  const next = current.filter((entry) => entry !== target);
  await db.query(`update volt_core.company_configurations set settings=jsonb_set(settings,$2::text[],$3::jsonb,true), updated_by=$4, updated_at=now() where company_id=$1`,
    [companyId, `{${listKey}}`, JSON.stringify(next), input.actorUserId || null]);
  await db.query(`insert into volt_core.audit_logs(company_id,actor_user_id,action,entity_type,entity_id,before_payload,metadata)
    values($1,$2,'configuration.deleted','configuration',$3,$4::jsonb,$5::jsonb)`,
    [companyId, input.actorUserId || null, target.id || target.key || itemId, JSON.stringify(target), JSON.stringify({ listKey, reason: input.reason || null })]);
  return target;
}

module.exports = { assertCompanyCapability, checkCapability, deleteConfigurationItem, getCompanyConfiguration, getCompanyConfigurationWithClient, saveConfigurationItem, updateCompanyOverrides, updateCompanySettings };
