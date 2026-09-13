"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const db = require("../../../db/db");
const { buildConfiguration } = require("./templateEngine");
const { getTemplateBySegment } = require("./templates");
const { withEffectiveConfiguration } = require("./capabilities/capabilityResolver");
const { normalizeCompanyOverrides, effectiveLimit } = require("./configuration/configurationEngine");
const { normalizeDefinition, validateCustomFields } = require("./configuration/customFields");
const { assertTransition, resolveWorkflow, validateWorkflowDefinition } = require("./workflows/workflowEngine");

function config(segment = "optical", overrides = {}) {
  const base = buildConfiguration({
    companyId: "company-phase2",
    planKey: "starter",
    requestedBy: "test",
    template: getTemplateBySegment(segment),
  });
  return withEffectiveConfiguration({ ...base, overrides: { ...base.overrides, ...overrides } });
}

test("capability overrides and commercial limits are resolved centrally", () => {
  const overrides = normalizeCompanyOverrides({}, {
    enabledCapabilities: ["custom.feature"],
    disabledCapabilities: ["fiscal.issue"],
    limits: { users: 7, integrations: 2 },
  });
  const resolved = config("general", overrides);
  assert.ok(resolved.capabilities.includes("custom.feature"));
  assert.ok(!resolved.capabilities.includes("fiscal.issue"));
  assert.equal(effectiveLimit(resolved, "users"), 7);
  assert.equal(effectiveLimit(resolved, "integrations"), 2);
});

test("custom fields normalize type metadata and validate multiple operational entities", () => {
  const numberField = normalizeDefinition({
    id: "field-grade",
    name: "Indice interno",
    module: "Vendas",
    fieldType: "Numero",
    min: -10,
    max: 10,
    step: 0.25,
    required: "Sim",
  }, "field-grade");
  const textarea = normalizeDefinition({ name: "Detalhes", module: "OS", fieldType: "Textarea" }, "field-details");
  assert.equal(numberField.entity, "sale");
  assert.equal(numberField.type, "number");
  assert.equal(textarea.fieldType, "Textarea");

  const configuration = { settings: { customFields: [numberField] } };
  assert.deepEqual(validateCustomFields(configuration, "sale", { "field-grade": "-1,25" }, { requireAll: true }), { "field-grade": -1.25 });
  assert.throws(
    () => validateCustomFields(configuration, "sale", {}, { requireAll: true }),
    (error) => error.code === "CUSTOM_FIELD_REQUIRED",
  );
});

test("finance custom fields apply to receivables and expenses", () => {
  const field = normalizeDefinition({ name: "Centro de custo", module: "Financeiro", fieldType: "Texto" }, "field-cost-center");
  const configuration = { settings: { customFields: [field] } };
  assert.deepEqual(validateCustomFields(configuration, "receivable", { "field-cost-center": "Loja" }), { "field-cost-center": "Loja" });
  assert.deepEqual(validateCustomFields(configuration, "expense", { "field-cost-center": "Administrativo" }), { "field-cost-center": "Administrativo" });
});

test("workflow engine keeps optical defaults and rejects skipped stages", () => {
  const configuration = config("optical");
  const workflow = resolveWorkflow(configuration, "optical_order");
  assert.equal(workflow.initial, "awaiting_lab");
  assert.doesNotThrow(() => assertTransition(configuration, "optical_order", "ready_for_production", "sent_to_lab"));
  assert.throws(
    () => assertTransition(configuration, "optical_order", "ready_for_production", "delivered"),
    (error) => error.code === "WORKFLOW_TRANSITION_INVALID",
  );
});

test("custom workflow validates initial state and drives transitions", () => {
  assert.throws(
    () => validateWorkflowDefinition({ key: "repair", initial: "missing", states: ["open", "done"], transitions: { open: ["done"] } }),
    (error) => error.code === "WORKFLOW_INITIAL_INVALID",
  );
  const custom = validateWorkflowDefinition({
    key: "service_order",
    name: "Assistencia",
    initial: "received",
    states: ["received", "diagnosis", "done"],
    transitions: { received: ["diagnosis"], diagnosis: ["done"], done: [] },
  });
  const configuration = { settings: { workflows: [custom] } };
  assert.doesNotThrow(() => assertTransition(configuration, "service_order", "received", "diagnosis"));
  assert.throws(
    () => assertTransition(configuration, "service_order", "received", "done"),
    (error) => error.code === "WORKFLOW_TRANSITION_INVALID",
  );
});

test("tenant context is isolated by AsyncLocalStorage and database access is fail-closed by default", async () => {
  assert.equal(db.currentTenantContext(), null);
  assert.deepEqual(db.resolveRlsContext(), { companyId: "", bypassRls: false });
  await db.withTenantContext("company-a", async () => {
    assert.deepEqual(db.currentTenantContext(), { companyId: "company-a", bypassRls: false });
    assert.deepEqual(db.resolveRlsContext(), { companyId: "company-a", bypassRls: false });
    await Promise.resolve();
    assert.equal(db.currentTenantContext().companyId, "company-a");
  });
  assert.equal(db.currentTenantContext(), null);
  await db.withRlsBypass(async () => {
    assert.equal(db.currentTenantContext().bypassRls, true);
    assert.deepEqual(db.resolveRlsContext(), { companyId: "", bypassRls: true });
  });
  assert.throws(() => db.withTenantContext("", () => {}), (error) => error.code === "TENANT_CONTEXT_REQUIRED");
});

test("RLS migration is fail-closed for tenant tables and expands reusable platform data", () => {
  const migration = fs.readFileSync(path.join(__dirname, "..", "..", "..", "db", "014_platform_engine_rls.sql"), "utf8");
  assert.match(migration, /force row level security/i);
  assert.match(migration, /create policy tenant_isolation/i);
  assert.match(migration, /workflow_events/i);
  assert.match(migration, /sales add column if not exists custom_fields/i);
  assert.match(migration, /service_orders add column if not exists custom_fields/i);
  assert.match(migration, /optical_prescriptions add column if not exists custom_fields/i);
});

test("application database role is separated from migrations and cannot bypass RLS", () => {
  const dbSource = fs.readFileSync(path.join(__dirname, "..", "..", "..", "db", "db.js"), "utf8");
  const migrateSource = fs.readFileSync(path.join(__dirname, "..", "..", "..", "db", "migrate.js"), "utf8");
  const routesSource = fs.readFileSync(path.join(__dirname, "..", "..", "routes", "core.routes.js"), "utf8");
  assert.match(dbSource, /VOLT_CORE_APP_DATABASE_URL/);
  assert.doesNotMatch(dbSource, /bypassRls\s*=.*\|\|\s*!companyId/);
  assert.match(dbSource, /APP_DATABASE_ROLE_BYPASSES_RLS/);
  assert.match(migrateSource, /NOBYPASSRLS/);
  assert.doesNotMatch(
    migrateSource,
    /ALTER ROLE \$\{roleName\}[^`]*(?:NOSUPERUSER|NOBYPASSRLS)/i,
    "existing roles must verify privileged attributes instead of asking a non-superuser migration owner to change them",
  );
  assert.match(migrateSource, /REVOKE neon_superuser FROM/);
  assert.match(dbSource, /neon_superuser_member/);
  assert.match(migrateSource, /VOLT_CORE_DIRECT_DATABASE_URL/);
  assert.match(migrateSource, /GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES/);
  assert.ok(routesSource.indexOf('tenantContext);') < routesSource.indexOf('requireCompanyAccess);'), "tenant context must be established before live membership lookup");
});

test("runtime domains are physically separated from the compatibility facade", () => {
  const coreDir = __dirname;
  const facade = fs.readFileSync(path.join(coreDir, "persistentCoreService.js"), "utf8");
  const serviceDir = path.join(coreDir, "runtime", "services");
  const domainFiles = [
    "customerService.js", "catalogService.js", "inventoryService.js", "salesService.js",
    "cashService.js", "financeService.js", "fiscalService.js", "opticalService.js", "userService.js",
  ];
  assert.ok(facade.split("\n").length < 80, "persistentCoreService must remain a small compatibility facade");
  for (const file of domainFiles) {
    const source = fs.readFileSync(path.join(serviceDir, file), "utf8");
    assert.doesNotMatch(source, /persistentCoreService/, `${file} must not depend on the legacy facade`);
  }
});

test("optical workflow synchronization keeps one canonical OP event while linked OS status follows without a mirrored event", () => {
  const source = fs.readFileSync(path.join(__dirname, "runtime", "services", "opticalService.js"), "utf8");
  assert.doesNotMatch(source, /forceWorkflow/);
  assert.match(source, /update volt_core\.service_orders set status=\$3/);
  assert.match(source, /insertWorkflowEventWithClient\(client, companyId, "optical_order", "optical_order"/);
  assert.doesNotMatch(source, /insertWorkflowEventWithClient\(client, companyId, "optical_order", "service_order"/);
});

test("company user creation enforces the configured entitlement limit", () => {
  const source = fs.readFileSync(path.join(__dirname, "runtime", "services", "userService.js"), "utf8");
  assert.match(source, /effectiveLimit\(configuration,\s*"users"/);
  assert.match(source, /USER_LIMIT_REACHED/);
  assert.match(source, /assertUserLimitWithClient\(client, companyId, email\)/);
});
