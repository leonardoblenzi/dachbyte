"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { buildConfiguration } = require("./templateEngine");
const { getTemplateBySegment } = require("./templates");
const { withEffectiveConfiguration } = require("./capabilities/capabilityResolver");
const { buildCommercialSnapshot } = require("./commercial/commercialResolver");
const { getCommercialProduct } = require("./commercial/productCatalog");
const { consumeCommercialUsageWithClient } = require("./runtime/services/commercialService");

function generalConfigurationWithFiscal(status = "available", planKey = "free") {
  const base = buildConfiguration({
    companyId: "company-commercial",
    planKey: "starter",
    requestedBy: "test",
    template: getTemplateBySegment("general"),
  });
  const commercial = buildCommercialSnapshot({
    segmentKey: "general",
    corePlanKey: "starter",
    subscriptions: [
      { productKey: "core", planKey: "starter", status: "active" },
      ...(status === "available" ? [] : [{ productKey: "service.fiscal", planKey, status }]),
    ],
  });
  return withEffectiveConfiguration({ ...base, commercial });
}

test("phase E catalog separates Core, verticals, services and channels", () => {
  const config = generalConfigurationWithFiscal();
  const products = config.commercial.products;
  assert.equal(products.find((item) => item.key === "core").status, "active");
  assert.equal(products.find((item) => item.key === "vertical.optical").status, "available");
  assert.equal(products.find((item) => item.key === "service.fiscal").status, "available");
  assert.equal(products.find((item) => item.key === "channel.mercado_livre").status, "coming_soon");
  assert.ok(config.screens.includes("services"));
  assert.ok(!config.screens.includes("fiscal"));
});

test("phase E shared Core copy stays generic for companies without the optical vertical", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "..", "client", "main.jsx"), "utf8");
  assert.match(main, /products:\s*\["Produtos e servicos",\s*"Produtos, servicos, precos e estoque\."\]/);
  assert.match(main, /label:\s*"Informe o estoque dos produtos"/);
  assert.doesNotMatch(main, /Armacoes, lentes, acessorios, servicos, precos e estoque\./);
  assert.doesNotMatch(main, /Informe o estoque das armacoes/);
});

test("phase E fiscal plans match the agreed monthly franchise ladder", () => {
  const fiscal = getCommercialProduct("service.fiscal");
  assert.deepEqual(
    fiscal.plans.map((plan) => [plan.key, plan.monthlyPriceCents, plan.limits.fiscalDocumentsPerMonth]),
    [
      ["free", 0, 5],
      ["start", 1990, 50],
      ["accelerate", 4990, 500],
      ["grow", 9990, 2000],
      ["scale", 19990, 5000],
    ],
  );
});

test("phase E contracted services expose onboarding but active capability only after activation", () => {
  const contracted = generalConfigurationWithFiscal("contracted", "accelerate");
  assert.ok(contracted.modules.includes("fiscal"));
  assert.ok(contracted.screens.includes("fiscal"));
  assert.ok(contracted.capabilities.includes("service.fiscal"));
  assert.ok(!contracted.capabilities.includes("service.fiscal.active"));
  assert.equal(contracted.entitlements.limits.fiscalDocumentsPerMonth, 500);

  const active = generalConfigurationWithFiscal("active", "accelerate");
  assert.ok(active.capabilities.includes("service.fiscal.active"));
  assert.equal(active.entitlements.limits.fiscalDocumentsPerMonth, 500);

  const suspended = generalConfigurationWithFiscal("suspended", "accelerate");
  assert.ok(!suspended.modules.includes("fiscal"));
  assert.ok(!suspended.screens.includes("fiscal"));
  assert.ok(!suspended.capabilities.includes("service.fiscal"));
});

test("phase E allows an optional vertical on a general Core company without changing the base segment", () => {
  const base = buildConfiguration({
    companyId: "company-general-optical",
    planKey: "starter",
    requestedBy: "test",
    template: getTemplateBySegment("general"),
  });
  const commercial = buildCommercialSnapshot({
    segmentKey: "general",
    corePlanKey: "starter",
    subscriptions: [
      { productKey: "core", planKey: "starter", status: "active" },
      { productKey: "vertical.optical", planKey: "standard", status: "active" },
    ],
  });
  const resolved = withEffectiveConfiguration({ ...base, commercial });
  assert.equal(resolved.segmentKey, "general");
  assert.ok(resolved.modules.includes("service_orders"));
  assert.ok(resolved.modules.includes("optical_prescriptions"));
  assert.ok(resolved.capabilities.includes("vertical.optical.active"));
  assert.ok(resolved.capabilities.includes("optical.orders"));
});

test("phase E usage counter enforces the active service plan limit transactionally", async () => {
  let updatedTo = null;
  const client = {
    async query(sql, params) {
      if (/company_product_subscriptions/i.test(sql)) return { rowCount: 1, rows: [{ planKey: "free", status: "active" }] };
      if (/insert into volt_core\.service_usage_counters/i.test(sql)) return { rowCount: 1, rows: [] };
      if (/select used_count/i.test(sql)) return { rowCount: 1, rows: [{ usedCount: 4 }] };
      if (/update volt_core\.service_usage_counters/i.test(sql)) {
        updatedTo = params[4];
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`SQL inesperado: ${sql}`);
    },
  };
  const usage = await consumeCommercialUsageWithClient(client, "company-a", "service.fiscal", "fiscal_documents", 1, new Date("2026-08-12T12:00:00Z"));
  assert.equal(updatedTo, 5);
  assert.equal(usage.used, 5);
  assert.equal(usage.remaining, 0);

  await assert.rejects(
    () => consumeCommercialUsageWithClient(client, "company-a", "service.fiscal", "fiscal_documents", 2, new Date("2026-08-12T12:00:00Z")),
    (error) => error.code === "COMMERCIAL_USAGE_LIMIT_REACHED",
  );
});

test("phase E migration is tenant isolated and backfills Core plus the existing optical vertical", () => {
  const migration = fs.readFileSync(path.join(__dirname, "..", "..", "..", "db", "017_commercial_products.sql"), "utf8");
  assert.match(migration, /company_product_subscriptions/i);
  assert.match(migration, /service_usage_counters/i);
  assert.match(migration, /force row level security/i);
  assert.match(migration, /create policy tenant_isolation/i);
  assert.match(migration, /'core'/i);
  assert.match(migration, /'vertical\.optical'/i);
  const database = fs.readFileSync(path.join(__dirname, "..", "..", "..", "db", "db.js"), "utf8");
  assert.match(database, /company_product_subscriptions/);
  assert.match(database, /service_usage_counters/);
  assert.match(database, /protected_count \|\| 0\) < 11/);
});

test("phase E HTTP and UI contracts keep activation with Master and requests with the company", () => {
  const routes = fs.readFileSync(path.join(__dirname, "..", "..", "routes", "core.routes.js"), "utf8");
  const client = fs.readFileSync(path.join(__dirname, "..", "..", "client", "main.jsx"), "utf8");
  const modal = fs.readFileSync(path.join(__dirname, "..", "..", "client", "modals", "config.js"), "utf8");
  assert.match(routes, /commercial\/products\/:productKey\/request/);
  assert.match(routes, /commercial\/products\/:productKey", requireMaster/);
  const fiscalRoutes = fs.readFileSync(path.join(__dirname, "..", "..", "extensions", "fiscal", "backend", "routes.js"), "utf8");
  assert.doesNotMatch(routes, /service\.fiscal\.active/);
  assert.match(fiscalRoutes, /service\.fiscal\.active/);
  assert.match(client, /Servicos Volt/);
  assert.match(client, /Verticais/);
  assert.match(client, /Canais/);
  assert.match(modal, /Solicitar ativacao/);
  assert.match(modal, /Gerenciar produto Volt/);
});

test("phase E general Core products omit empty extension payloads and protect real optional data", () => {
  const { ExtensionRegistry } = require("../../platform/extensions/extensionRegistry");
  const productHooks = require("../../extensions/optical/backend/productHooks");
  const registry = new ExtensionRegistry();
  registry.register({
    key: "vertical.optical",
    kind: "vertical",
    activationCapability: "vertical.optical",
    input: { product: { capability: "optical.catalog", legacyKeys: ["opticalSpecs"] } },
  });
  assert.equal(productHooks.hasPayload({ opticalSpecs: {} }), false);
  assert.equal(productHooks.hasPayload({ opticalSpecs: { size: "", color: "", material: "", refractiveIndex: "", treatment: "" } }), false);
  assert.equal(productHooks.hasPayload({ opticalType: "frame", opticalSpecs: {} }), true);
  assert.equal(productHooks.hasPayload({ opticalSpecs: { material: "acetato" } }), true);
  assert.equal(productHooks.hasPayload({ catalogType: "Acessorio" }), true);
  assert.deepEqual(registry.inputPayloads("product", { opticalSpecs: {} }, { capabilities: [] }), {});
  assert.throws(
    () => registry.inputPayloads("product", { opticalSpecs: { material: "acetato" } }, { capabilities: [] }),
    (error) => error.code === "CAPABILITY_DISABLED",
  );

  const handler = fs.readFileSync(path.join(__dirname, "..", "..", "client", "actions", "handlers", "catalog.js"), "utf8");
  assert.match(handler, /buildExtensionPayloads\("product"/);
  assert.match(handler, /\.\.\.\(extensionPayloads \? \{ extensions: extensionPayloads \} : \{\}\)/);
  assert.doesNotMatch(handler, /opticalSpecs:\s*\{\}/);
});

test("phase E receivable date fields normalize postgres timestamps for native date inputs", () => {
  const mapper = fs.readFileSync(path.join(__dirname, "..", "..", "client", "workspace", "mapWorkspaceToAppData.js"), "utf8");
  const modal = fs.readFileSync(path.join(__dirname, "..", "..", "client", "modals", "config.js"), "utf8");
  assert.match(mapper, /function dateInputValue\(value\)/);
  assert.match(mapper, /dueDate: dateInputValue\(receivable\.dueDate\)/);
  assert.match(mapper, /originalDueDate: dateInputValue\(/);
  assert.match(modal, /dueDate: payload\.dueDate \? String\(payload\.dueDate\)\.slice\(0, 10\) : saleDefaultDueDate\(\)/);
  assert.match(modal, /dueDate: payload\.dueDate \? String\(payload\.dueDate\)\.slice\(0, 10\) : ""/);
});

test("phase E optical prescription dates survive reopen for editing and format only for display", async () => {
  const { createServer } = await import("vite");
  const { default: React } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const vite = await createServer({
    root: path.join(__dirname, "..", "..", ".."),
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
  });

  try {
    const { mapOpticalWorkspace } = await vite.ssrLoadModule("/src/client/extensions/optical/workspaceMapper.js");
    const { contributeOpticalModalConfig } = await vite.ssrLoadModule("/src/client/extensions/optical/modalConfig.js");
    const { default: OpticalPrescriptionsPage } = await vite.ssrLoadModule("/src/client/extensions/optical/OpticalPrescriptionsPage.jsx");
    const mapped = mapOpticalWorkspace({
      prescriptions: [{
        id: "pre-qa-fe",
        customerId: "customer-qa-fe",
        customerName: "QA-FE Cliente Optica",
        doctor: "Dr QA FE Datas",
        examDate: "2026-08-14T00:00:00.000Z",
        validUntil: "2027-08-14T00:00:00.000Z",
        status: "active",
      }],
    }, { prescriptions: [] });
    const reopened = mapped.prescriptions[0];

    assert.equal(reopened.examDate, "2026-08-14");
    assert.equal(reopened.validUntil, "2027-08-14");

    const modal = contributeOpticalModalConfig("prescription", null, {
      data: { customers: [{ id: "customer-qa-fe", name: "QA-FE Cliente Optica" }], customFields: [] },
      payload: reopened,
      editing: true,
      editMeta: { mode: "edit", editKey: reopened.id },
      customerOptions: [],
      buildDynamicFields: () => [],
      workflowStatusOptions: () => [],
      buildDynamicDefaults: () => ({}),
      productModalCategoryOptions: [],
    });
    assert.equal(modal.defaults.examDate, "2026-08-14");
    assert.equal(modal.defaults.validUntil, "2027-08-14");

    const markup = renderToStaticMarkup(React.createElement(OpticalPrescriptionsPage, {
      data: { prescriptions: [reopened], opticalOrders: [], opticalLaboratories: [] },
      onAction: () => {},
      runtimeData: {},
      ui: {
        ModulePage: ({ tabs }) => tabs[0].content,
        Toolbar: () => React.createElement("div"),
      },
    }));
    assert.match(markup, /14\/08\/2027/);
    assert.doesNotMatch(markup, />2027-08-14</);
  } finally {
    await vite.close();
  }
});

test("phase E persisted payment methods update the current UI without depending on workspace bootstrap", () => {
  const finance = fs.readFileSync(path.join(__dirname, "..", "..", "client", "actions", "handlers", "finance.js"), "utf8");
  const paymentMethodBlock = finance.slice(finance.indexOf("async paymentMethod(values)"), finance.indexOf("async expense(values)"));
  assert.match(paymentMethodBlock, /const payload = await apiFetch/);
  assert.match(paymentMethodBlock, /payload\.paymentMethod/);
  assert.match(paymentMethodBlock, /setAppData\(\(current\) =>/);
  assert.match(paymentMethodBlock, /paymentMethods: isEditing/);
  assert.doesNotMatch(paymentMethodBlock, /refreshRuntimeWorkspace\(\)/);
});

test("phase E optical prescription searches every customer through a server-side lookup", () => {
  const modal = fs.readFileSync(path.join(__dirname, "..", "..", "client", "extensions", "optical", "modalConfig.js"), "utf8");
  const fields = fs.readFileSync(path.join(__dirname, "..", "..", "client", "modals", "ActionModalSections.jsx"), "utf8");
  const state = fs.readFileSync(path.join(__dirname, "..", "..", "client", "modals", "actionModalState.js"), "utf8");
  const client = fs.readFileSync(path.join(__dirname, "..", "..", "client", "main.jsx"), "utf8");
  const prescriptionBlock = modal.slice(modal.indexOf('if (type === "prescription")'), modal.indexOf('if (type === "opticalLab")'));
  assert.match(prescriptionBlock, /type:\s*"customer_lookup"/);
  assert.match(prescriptionBlock, /idField:\s*"customerId"/);
  assert.doesNotMatch(prescriptionBlock, /type:\s*"select",\s*options:\s*customerOptions/);
  assert.match(fields, /field\.type === "customer_lookup"/);
  assert.match(fields, /onLookup\(field\.resource \|\| \(field\.type === "product_lookup" \? "products" : "customers"\)/);
  assert.match(fields, /onValueChange\(field\.idField, option\.id\)/);
  assert.match(state, /\["customer_lookup", "product_lookup"\]\.includes\(field\.type\)/);
  assert.match(state, /values\[field\.idField\]/);
  assert.match(client, /const searchRuntimeResource = useCallback\(async \(resource, query = \{\}\) =>/);
  assert.match(client, /onLookup=\{searchRuntimeResource\}/);
});

test("phase E service order decorator falls back to the Core database client", async () => {
  const coreContracts = require("../../platform/extensions/coreContracts");
  const opticalEntityHooks = require("../../extensions/optical/backend/entityHooks");
  const originalQuery = coreContracts.db.query;
  coreContracts.db.query = async () => ({ rows: [{ id: "order-41", opticalOrderId: "optical-41" }] });
  try {
    const rows = [{ id: "order-41" }];
    await opticalEntityHooks.decorateServiceOrders({ companyId: "company-a", rows });
    assert.equal(rows[0].opticalOrderId, "optical-41");
  } finally {
    coreContracts.db.query = originalQuery;
  }
});

test("phase E optical date normalization rejects impossible calendar values consistently", () => {
  const extensionService = require("../../extensions/optical/backend/opticalService");
  const compatibilityService = require("./runtime/services/opticalService");
  for (const service of [extensionService, compatibilityService]) {
    assert.equal(service.normalizeDateInput("2026-08-14"), "2026-08-14");
    assert.equal(service.normalizeDateInput("14/08/2026"), "2026-08-14");
    assert.equal(service.normalizeDateInput(""), null);
    assert.throws(
      () => service.normalizeDateInput("2026-02-31"),
      (error) => error.statusCode === 400 && error.code === "OPTICAL_DATE_INVALID",
    );
  }
});

test("phase E optical sale and cancellation refresh OP and OS instead of keeping stale lazy pages", () => {
  const catalog = fs.readFileSync(path.join(__dirname, "..", "..", "client", "actions", "handlers", "catalog.js"), "utf8");
  const shared = fs.readFileSync(path.join(__dirname, "..", "..", "client", "actions", "handlers", "shared.js"), "utf8");
  const client = fs.readFileSync(path.join(__dirname, "..", "..", "client", "main.jsx"), "utf8");
  const saleBlock = catalog.slice(catalog.indexOf("async sale(values)"));
  assert.match(saleBlock, /values\.extensions\?\.\["vertical\.optical"\]/);
  assert.match(saleBlock, /refreshRuntimeWorkspace\(\{\s*resources:\s*opticalSale \? \["serviceOrders",\s*"opticalOrders"\] : \[\],?\s*\}\)/);
  assert.match(shared, /applyConfirmedSaleCancellation/);
  assert.match(shared, /resources:\s*values\.collection === "sales" \? SALE_MUTATION_REFRESH_RESOURCES : \[\]/);
  assert.match(client, /async function refreshRuntimeWorkspace\(\{ resources = \[\] \} = \{\}\)/);
  assert.match(client, /loadRuntimeResource\(resource, query, \{ silent: true \}\)/);
});

test("phase E confirmed sale cancellation updates only its row and refreshes every related collection", async () => {
  const stateUrl = pathToFileURL(path.join(__dirname, "..", "..", "client", "runtime", "runtimeListState.mjs")).href;
  const { applyConfirmedSaleCancellation, SALE_MUTATION_REFRESH_RESOURCES } = await import(stateUrl);
  const current = {
    sales: [
      { recordId: "sale-50", number: 50, status: "Finalizada" },
      { recordId: "sale-49", number: 49, status: "Finalizada" },
    ],
  };
  const next = applyConfirmedSaleCancellation(current, "sale-50", { id: "sale-50", status: "canceled" });
  assert.deepEqual(SALE_MUTATION_REFRESH_RESOURCES, [
    "sales",
    "receivables",
    "cashMovements",
    "receipts",
    "serviceOrders",
    "opticalOrders",
  ]);
  assert.equal(next.sales[0].status, "Cancelada");
  assert.equal(next.sales[1], current.sales[1]);
  assert.notEqual(next.sales, current.sales);
  assert.equal(current.sales[0].status, "Finalizada");
});

test("phase E marks a failed lazy refresh as stale so navigation retries it", async () => {
  const stateUrl = pathToFileURL(path.join(__dirname, "..", "..", "client", "runtime", "runtimeListState.mjs")).href;
  const { markRuntimeResourceFailed } = await import(stateUrl);
  const current = { serviceOrders: { loaded: true, loading: true, companyId: "company-a", error: "" } };
  const next = markRuntimeResourceFailed(current, "serviceOrders", "Falha temporaria");
  assert.equal(next.serviceOrders.loaded, false);
  assert.equal(next.serviceOrders.loading, false);
  assert.equal(next.serviceOrders.companyId, "company-a");
  assert.equal(next.serviceOrders.error, "Falha temporaria");
});

test("phase E prescription editing validates and persists the selected customer id", async () => {
  const contractsPath = require.resolve("../../platform/extensions/coreContracts");
  const servicePath = require.resolve("../../extensions/optical/backend/opticalService");
  const originalContracts = require(contractsPath);
  const queries = [];
  let event = null;
  const client = {
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, " ").trim();
      queries.push({ text, params });
      if (["begin", "commit", "rollback"].includes(text)) return { rowCount: 0, rows: [] };
      if (text.includes("from volt_core.customers")) {
        if (/\bor\s+\$3::text is not null/i.test(text)) {
          return { rowCount: 1, rows: [{ id: "cus-older", name: "Cliente Dois" }] };
        }
        if (params[1] === "cus-missing") return { rowCount: 0, rows: [] };
        return { rowCount: 1, rows: [{ id: "cus-2", name: "Cliente Dois" }] };
      }
      if (text.startsWith("update volt_core.optical_prescriptions")) {
        return { rowCount: 1, rows: [{ id: "pre-1", customerId: params[32], customFields: {} }] };
      }
      throw new Error(`SQL inesperado no teste: ${text}`);
    },
  };
  const fakeDb = {
    query: client.query.bind(client),
    withClient: async (callback) => callback(client),
  };
  require.cache[contractsPath].exports = {
    ...originalContracts,
    assertCompanyCapability: async () => ({ enabled: true }),
    db: fakeDb,
    getCompanyConfiguration: async () => ({}),
    getCompanyConfigurationWithClient: async () => ({}),
    insertEventWithClient: async (_client, companyId, type, payload) => { event = { companyId, type, payload }; },
    recordEvent: async () => {},
    validateCustomFields: (_configuration, _moduleName, values) => values,
  };
  delete require.cache[servicePath];
  try {
    const { updatePrescription } = require(servicePath);
    const updated = await updatePrescription("company-a", "pre-1", {
      customerId: "cus-2",
      customer: "Cliente Dois",
      doctor: "Dra. QA",
    });
    const lookup = queries.find((entry) => entry.text.includes("from volt_core.customers"));
    const update = queries.find((entry) => entry.text.startsWith("update volt_core.optical_prescriptions"));
    assert.deepEqual(lookup.params, ["company-a", "cus-2"]);
    assert.match(update.text, /customer_id = coalesce\(\$33,customer_id\)/);
    assert.equal(update.params[32], "cus-2");
    assert.equal(updated.customerId, "cus-2");
    assert.deepEqual(event, { companyId: "company-a", type: "prescription.updated", payload: { prescriptionId: "pre-1" } });
    await assert.rejects(
      () => updatePrescription("company-a", "pre-1", { customerId: "cus-missing", customer: "Cliente Dois" }),
      (error) => error.code === "PRESCRIPTION_CUSTOMER_REQUIRED",
    );
  } finally {
    delete require.cache[servicePath];
    require.cache[contractsPath].exports = originalContracts;
  }
});
