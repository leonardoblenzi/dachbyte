"use strict";

const db = require("../../../../../db/db");
const { createId } = require("../../id");
const { modules } = require("../../registries/modules");
const { screens } = require("../../registries/screens");
const { segments } = require("../../registries/segments");
const { buildConfiguration } = require("../../templateEngine");
const { getTemplateBySegment } = require("../../templates");
const { getCompanyConfiguration } = require("./configurationService");
const { insertAuditWithClient } = require("./persistenceHelpers");
const { getDashboard } = require("./dashboardService");
const { getCashSummary } = require("./cashService");
const { syncCompanyCommercialProductsWithClient } = require("./commercialService");
const { provisionVoltCoreCompany } = require("../../../auth/hubProvisioningClient");

function isEnabled() {
  return db.isDatabaseEnabled();
}

function getTemplateOrFail(segmentKey) {
  const template = getTemplateBySegment(segmentKey || "general");
  if (!template) {
    const error = new Error("Segmento nao encontrado");
    error.statusCode = 404;
    error.code = "SEGMENT_NOT_FOUND";
    throw error;
  }
  return template;
}

function buildTemplateConfiguration({ companyId, segmentKey, planKey = "starter", requestedBy = "system" }) {
  return buildConfiguration({
    companyId,
    planKey,
    requestedBy,
    template: getTemplateOrFail(segmentKey),
  });
}


async function listCompanies() {
  return db.withRlsBypass(async () => {
    const result = await db.query(`
      select
        c.id,
        c.name,
        c.document,
        c.segment_key as "segmentKey",
        c.plan_key as "planKey",
        c.status,
        coalesce(jsonb_array_length(cfg.modules), 0) as "moduleCount",
        coalesce(jsonb_array_length(cfg.screens), 0) as "screenCount",
        c.updated_at as "updatedAt"
      from volt_core.companies c
      left join volt_core.company_configurations cfg on cfg.company_id = c.id
      order by c.created_at asc;
    `);

    return result.rows;
  });
}

async function applySegmentTemplate({ companyId, tenantGlobalId = null, segmentKey = "general", planKey = "starter", requestedBy = "system", name, document = null, documentType = null, onboarding = null }) {
  const template = getTemplateOrFail(segmentKey);
  const company = {
    id: companyId,
    name: name || template.name,
    tenantGlobalId,
    document,
    documentType,
    segmentKey,
    planKey,
  };

  await db.withClient(async (client) => {
    await client.query("begin");
    try {
      await upsertCompanyWithClient(client, company, requestedBy);
      if (onboarding) {
        await writeSectorOnboardingWithClient(client, companyId, {
          ...onboarding,
          sectorKey: segmentKey,
          actorUserId: requestedBy,
        });
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });

  return getCompanyConfiguration(companyId);
}

async function selectOnboardingSector(companyId, input = {}, actor = {}) {
  const choice = String(input.sectorKey || input.segmentKey || "").trim().toLowerCase();
  if (!["general", "optical", "other"].includes(choice)) {
    throw Object.assign(new Error("Escolha um tipo de negocio valido"), { statusCode: 400, code: "SECTOR_SELECTION_INVALID" });
  }
  const interestLabel = String(input.interestLabel || "").trim();
  if (choice === "other" && !interestLabel) {
    throw Object.assign(new Error("Informe o segmento da empresa"), { statusCode: 400, code: "SECTOR_INTEREST_REQUIRED" });
  }
  const segmentKey = choice === "optical" ? "optical" : "general";

  await db.withClient(async (client) => {
    await client.query("begin");
    try {
      const current = await client.query(`
        select c.name, c.plan_key as "planKey", cfg.settings
          from volt_core.companies c
          join volt_core.company_configurations cfg on cfg.company_id = c.id
         where c.id = $1
         for update of c, cfg`, [companyId]);
      if (!current.rowCount) {
        throw Object.assign(new Error("Empresa nao encontrada"), { statusCode: 404, code: "COMPANY_NOT_FOUND" });
      }
      if (current.rows[0].settings?.onboarding?.sectorConfirmed === true && !actor.isMaster) {
        throw Object.assign(new Error("O setor da empresa ja foi confirmado"), { statusCode: 409, code: "SECTOR_ALREADY_CONFIRMED" });
      }

      if (!actor.isMaster) {
        const firstAdmin = await client.query(`
          select user_id
            from volt_core.user_companies
           where company_id = $1
             and lower(role) in ('admin', 'administrador', 'owner', 'dono')
           order by created_at asc, user_id asc
           limit 1`, [companyId]);
        if (!firstAdmin.rowCount || String(firstAdmin.rows[0].user_id) !== String(actor.userId || "")) {
          throw Object.assign(new Error("Somente o primeiro admin da empresa pode definir o setor"), { statusCode: 403, code: "SECTOR_ADMIN_REQUIRED" });
        }
      }

      await upsertCompanyWithClient(client, {
        id: companyId,
        name: current.rows[0].name,
        segmentKey,
        planKey: current.rows[0].planKey || "starter",
      }, actor.userId || "onboarding");
      await writeSectorOnboardingWithClient(client, companyId, {
        confirmed: true,
        source: choice === "other" ? "customer_other" : "customer_onboarding",
        sectorKey: segmentKey,
        requestedSector: choice === "other" ? interestLabel : null,
        actorUserId: actor.userId,
      });
      await insertAuditWithClient(
        client,
        companyId,
        actor.userId,
        "company.sector.selected",
        "company",
        companyId,
        { segmentKey: current.rows[0].settings?.onboarding?.sectorKey || null },
        { segmentKey, choice, requestedSector: choice === "other" ? interestLabel : null },
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });

  return getCompanyConfiguration(companyId);
}

async function completeCompanyProfile(companyId, input = {}, actor = {}) {
  const name = String(input.name || "").trim();
  const document = String(input.document || input.documentNumber || "").trim() || null;
  const documentType = String(input.documentType || "").trim().toLowerCase()
    || (document?.replace(/\D/g, "").length === 14 ? "cnpj" : document ? "cpf" : null);
  if (!name) {
    throw Object.assign(new Error("Informe o nome da empresa"), { statusCode: 400, code: "COMPANY_NAME_REQUIRED" });
  }

  await db.withClient(async (client) => {
    await client.query("begin");
    try {
      const current = await client.query(`
        select c.name, c.document, c.document_number as "documentNumber", cfg.settings
          from volt_core.companies c
          join volt_core.company_configurations cfg on cfg.company_id = c.id
         where c.id = $1
         for update of c, cfg`, [companyId]);
      if (!current.rowCount) {
        throw Object.assign(new Error("Empresa nao encontrada"), { statusCode: 404, code: "COMPANY_NOT_FOUND" });
      }

      if (!actor.isMaster) {
        const firstAdmin = await client.query(`
          select user_id
            from volt_core.user_companies
           where company_id = $1
             and lower(role) in ('admin', 'administrador', 'owner', 'dono')
           order by created_at asc, user_id asc
           limit 1`, [companyId]);
        if (!firstAdmin.rowCount || String(firstAdmin.rows[0].user_id) !== String(actor.userId || "")) {
          throw Object.assign(new Error("Somente o primeiro admin pode confirmar os dados da empresa"), { statusCode: 403, code: "COMPANY_PROFILE_ADMIN_REQUIRED" });
        }
      }

      await client.query(`
        update volt_core.companies
           set name = $2,
               document = coalesce($3, document),
               document_number = coalesce($3, document_number),
               document_type = coalesce($4, document_type),
               updated_at = now()
         where id = $1`, [companyId, name, document, documentType]);
      const companyProfile = {
        source: "first_admin",
        status: "confirmed",
        missingFields: document ? [] : ["document"],
        documentDeferred: !document,
        confirmedAt: new Date().toISOString(),
        confirmedBy: actor.userId || null,
      };
      await client.query(`
        update volt_core.company_configurations
           set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{companyProfile}', $2::jsonb, true),
               updated_by = $3,
               updated_at = now()
         where company_id = $1`, [companyId, JSON.stringify(companyProfile), actor.userId || null]);
      await insertAuditWithClient(
        client,
        companyId,
        actor.userId,
        "company.profile.confirmed",
        "company",
        companyId,
        current.rows[0],
        { name, document, documentType },
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });

  return getWorkspace(companyId);
}

async function getWorkspace(companyId) {
  const [companyResult, configuration] = await Promise.all([
    db.query(`
      select c.id,c.name,c.document,c.segment_key as "segmentKey",c.plan_key as "planKey",c.status,c.updated_at as "updatedAt"
      from volt_core.companies c
      where c.id=$1`, [companyId]),
    getCompanyConfiguration(companyId),
  ]);
  const companies = companyResult.rows;
  const enabled = new Set(configuration.modules || []);
  const [cashSummary, dashboard] = await Promise.all([
    enabled.has("cash_register") ? getCashSummary(companyId) : Promise.resolve({}),
    getDashboard(companyId, configuration),
  ]);

  // Workspace V2 is intentionally a bootstrap payload. Large operational
  // collections are loaded per screen through /data/:resource.
  return {
    companies,
    configuration,
    modules,
    screens,
    segments,
    cashSummary,
    dashboard,
    workspaceVersion: 2,
  };
}


async function createCompany(input = {}, requestedBy) {
  if (!String(input.name || "").trim()) {
    throw Object.assign(new Error("Nome da empresa e obrigatorio"), { statusCode: 400, code: "COMPANY_NAME_REQUIRED" });
  }
  const segmentAliases = { Core: "general", Otica: "optical", Varejo: "general", Assistencia: "general" };
  const segmentKey = segmentAliases[input.segment] || input.segmentKey || "general";
  const document = String(input.documentNumber || input.document || "").trim() || null;
  const documentType = String(input.documentType || "").trim().toLowerCase()
    || (document?.replace(/\D/g, "").length === 14 ? "cnpj" : document ? "cpf" : null);
  const hubCompany = await provisionVoltCoreCompany({
    idempotencyKey: String(input.idempotencyKey || createId("hub_company")).trim(),
    companyName: String(input.name).trim(),
    documentType,
    documentNumber: document,
  });
  const companyId = hubCompany.tenantId;
  return db.withTenantContext(companyId, async () => {
    await applySegmentTemplate({
      companyId,
      tenantGlobalId: hubCompany.tenantId,
      segmentKey,
      planKey: String(input.planKey || input.plan || "starter").toLowerCase(),
      requestedBy: requestedBy || input.actorUserId || null,
      name: String(input.name).trim(),
      document,
      documentType,
      onboarding: {
        confirmed: true,
        source: "master_company_creation",
      },
    });
    return getCompanyConfiguration(companyId);
  });
}















async function listAuditLogs(companyId) {
  const result = await db.query(`select id, actor_user_id as "actorUserId", action, entity_type as "entityType",
      entity_id as "entityId", before_payload as before, after_payload as after, metadata, created_at as "createdAt"
    from volt_core.audit_logs where company_id = $1 order by created_at desc limit 100;`, [companyId]);
  return result.rows;
}


async function upsertCompanyWithClient(client, company, requestedBy = "system") {
  const segmentKey = company.segmentKey || "general";
  const planKey = company.planKey || "starter";
  const configuration = buildTemplateConfiguration({
    companyId: company.id,
    segmentKey,
    planKey,
    requestedBy,
  });

  await client.query(`
    insert into volt_core.companies (id, name, tenant_global_id, document, document_type, document_number, segment_key, plan_key, updated_at)
    values ($1, $2, $3, $4, $5, $4, $6, $7, now())
    on conflict (id) do update set
      name = excluded.name,
      tenant_global_id = coalesce(volt_core.companies.tenant_global_id, excluded.tenant_global_id),
      document = coalesce(excluded.document, volt_core.companies.document),
      document_type = coalesce(excluded.document_type, volt_core.companies.document_type),
      document_number = coalesce(excluded.document_number, volt_core.companies.document_number),
      segment_key = excluded.segment_key,
      plan_key = excluded.plan_key,
      updated_at = now();
  `, [
    company.id,
    company.name || configuration.name || company.id,
    company.tenantGlobalId || company.id,
    company.document || null,
    company.documentType || null,
    segmentKey,
    planKey,
  ]);

  await client.query(`
    insert into volt_core.company_configurations (
      company_id, segment_key, plan_key, modules, screens, settings, overrides, updated_by, updated_at
    )
    values ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8, now())
    on conflict (company_id) do update set
      segment_key = excluded.segment_key,
      plan_key = excluded.plan_key,
      modules = excluded.modules,
      screens = excluded.screens,
      settings = (volt_core.company_configurations.settings - 'categories' - 'statuses' - 'fields') || excluded.settings,
      overrides = volt_core.company_configurations.overrides,
      updated_by = excluded.updated_by,
      updated_at = now();
  `, [
    company.id,
    configuration.segmentKey,
    configuration.planKey,
    JSON.stringify(configuration.modules),
    JSON.stringify(configuration.screens),
    JSON.stringify(configuration.settings),
    JSON.stringify(configuration.overrides),
    requestedBy,
  ]);

  await syncCompanyCommercialProductsWithClient(client, company.id, {
    segmentKey,
    planKey,
    actorUserId: requestedBy,
  });

  return configuration;
}

async function writeSectorOnboardingWithClient(client, companyId, input = {}) {
  const onboarding = {
    sectorConfirmed: input.confirmed !== false,
    sectorConfirmedAt: new Date().toISOString(),
    sectorConfirmedBy: input.actorUserId || null,
    sectorSource: input.source || "master",
    sectorKey: input.sectorKey || "general",
  };
  if (input.requestedSector) onboarding.requestedSector = input.requestedSector;

  await client.query(`
    update volt_core.company_configurations
       set settings = jsonb_set(
             coalesce(settings, '{}'::jsonb),
             '{onboarding}',
             $2::jsonb,
             true
           ),
           updated_by = $3,
           updated_at = now()
     where company_id = $1`,
  [companyId, JSON.stringify(onboarding), input.actorUserId || null]);
}




module.exports = {
  applySegmentTemplate,
  completeCompanyProfile,
  createCompany,
  getWorkspace,
  isEnabled,
  listAuditLogs,
  listCompanies,
  selectOnboardingSector,
};
