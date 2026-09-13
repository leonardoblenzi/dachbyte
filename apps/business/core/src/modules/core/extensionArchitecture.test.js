"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ExtensionRegistry, extensionRegistry } = require("../../platform/extensions/extensionRegistry");
const { registerBuiltInExtensions } = require("../../extensions/registerBuiltIns");

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", "..", "..", relativePath), "utf8");
}

test("extension foundation resolves activation from capabilities instead of segment keys", () => {
  const registry = new ExtensionRegistry();
  registry.register({
    key: "vertical.fake",
    kind: "vertical",
    activationCapability: "vertical.fake",
    contributions: { runtimeResources: ["fake_records"] },
  });

  assert.equal(registry.enabled({ segmentKey: "fake", capabilities: [] }).length, 0);
  assert.deepEqual(registry.enabled({ segmentKey: "general", capabilities: ["vertical.fake"] }).map((item) => item.key), ["vertical.fake"]);
  assert.deepEqual(registry.contributions("runtimeResources", { capabilities: ["vertical.fake"] }), [{ extensionKey: "vertical.fake", kind: "vertical", value: "fake_records" }]);
});

test("built-in extensions are registered once at the application composition root", () => {
  registerBuiltInExtensions();
  registerBuiltInExtensions();
  const keys = extensionRegistry.list().map((item) => item.key);
  assert.equal(keys.filter((key) => key === "vertical.optical").length, 1);
  assert.equal(keys.filter((key) => key === "service.fiscal").length, 1);

  const app = source("src/app.js");
  assert.match(app, /registerBuiltInExtensions\(\)/);
  const registrySource = source("src/platform/extensions/extensionRegistry.js");
  assert.doesNotMatch(registrySource, /optical|fiscal|mercado[_-]?livre|shopee/i);
});

test("client runtime resources are capability-driven and optional paths live in extension manifests", () => {
  const runtimeData = source("src/client/runtime/runtimeData.js");
  const registry = source("src/client/extensions/registry.js");
  const opticalManifest = source("src/client/extensions/optical/manifest.js");
  const fiscalManifest = source("src/client/extensions/fiscal/manifest.js");
  const main = source("src/client/main.jsx");

  assert.match(runtimeData, /resolveRuntimeResource\(resource, configuration\)/);
  assert.doesNotMatch(runtimeData, /prescriptions:\s*["']prescriptions["']/);
  assert.doesNotMatch(runtimeData, /fiscalDocuments:\s*["']fiscal-documents["']/);
  assert.match(opticalManifest, /activationCapability:\s*["']vertical\.optical["']/);
  assert.match(opticalManifest, /capability:\s*["']optical\.prescriptions["']/);
  assert.match(fiscalManifest, /activationCapability:\s*["']service\.fiscal["']/);
  assert.doesNotMatch(registry, /activationCapability:\s*["']vertical\.optical["']/);
  assert.match(main, /resolvePageRuntimeResources\(pageId, workspace\?\.configuration\)/);
  assert.match(main, /isRuntimeResourceAvailable\(resource, workspace\?\.configuration\)/);
});

test("Core sales lazy resources do not request optical data unless the optical extension contributes it", () => {
  const registry = source("src/client/extensions/registry.js");
  const opticalManifest = source("src/client/extensions/optical/manifest.js");
  const coreSales = registry.match(/sales:\s*Object\.freeze\(\[([^\]]+)\]\)/)?.[1] || "";
  assert.match(coreSales, /"sales"/);
  assert.match(coreSales, /"products"/);
  assert.match(coreSales, /"customers"/);
  assert.doesNotMatch(coreSales, /prescriptions/);
  assert.match(opticalManifest, /sales:\s*Object\.freeze\(\["prescriptions"\]\)/);
});

test("frontend capability checks no longer infer optional modules from segmentKey", () => {
  const access = source("src/client/core/access.js");
  const capabilityBlock = access.slice(access.indexOf("function hasCompanyCapability"), access.indexOf("export {"));
  assert.match(capabilityBlock, /capabilities\.includes\(capability\)/);
  assert.doesNotMatch(capabilityBlock, /segmentKey/);
  assert.doesNotMatch(capabilityBlock, /startsWith\(["']optical\./);
});

test("operational Core services do not import or branch on optional products", () => {
  const coreFiles = [
    "src/modules/core/runtime/services/salesService.js",
    "src/modules/core/runtime/services/catalogService.js",
    "src/modules/core/runtime/services/customerService.js",
    "src/modules/core/runtime/services/dashboardService.js",
    "src/modules/core/runtime/services/dataQueryService.js",
    "src/modules/core/runtime/services/serviceOrderService.js",
    "src/modules/core/persistentCoreService.js",
  ];
  for (const file of coreFiles) {
    const text = source(file);
    assert.doesNotMatch(text, /opticalService|fiscalService|vertical\.optical|service\.fiscal|optical_prescriptions|fiscal_documents/i, `${file} leaked an optional extension`);
  }
});

test("optional HTTP routes belong to extension adapters instead of Core routes", () => {
  const routes = source("src/routes/core.routes.js");
  const opticalRoutes = source("src/extensions/optical/backend/routes.js");
  const fiscalRoutes = source("src/extensions/fiscal/backend/routes.js");
  assert.doesNotMatch(routes, /\/prescriptions|\/optical-orders|\/optical-laboratories|\/fiscal-documents/);
  assert.match(routes, /mountExtensionRoutes/);
  assert.match(opticalRoutes, /\/prescriptions/);
  assert.match(opticalRoutes, /\/optical-orders/);
  assert.match(fiscalRoutes, /\/fiscal-documents/);
});

test("optional frontend screens and handlers are lazy extension contributions", () => {
  const main = source("src/client/main.jsx");
  const submit = source("src/client/actions/submitAction.js");
  const opticalManifest = source("src/client/extensions/optical/manifest.js");
  const fiscalManifest = source("src/client/extensions/fiscal/manifest.js");
  assert.doesNotMatch(main, /import\s+.*OpticalSalesPdv|import\s+.*OpticalPrescriptionsPage|import\s+.*FiscalPage/);
  assert.doesNotMatch(submit, /handlers\/optical|handlers\/fiscal/);
  assert.match(opticalManifest, /import\("\.\/OpticalSalesPdv\.jsx"\)/);
  assert.match(opticalManifest, /import\("\.\/OpticalPrescriptionsPage\.jsx"\)/);
  assert.match(fiscalManifest, /import\("\.\/FiscalPage\.jsx"\)/);
  assert.match(opticalManifest, /import\("\.\/handlers\.js"\)/);
  assert.match(fiscalManifest, /import\("\.\/handlers\.js"\)/);
});

test("Core modal and workspace mapping contain no optional field schema", () => {
  const modal = source("src/client/modals/config.js");
  const modalState = source("src/client/modals/actionModalState.js");
  const mapper = source("src/client/workspace/mapWorkspaceToAppData.js");
  const opticalModal = source("src/client/extensions/optical/modalConfig.js");
  assert.doesNotMatch(modal, /opticalSize|rightSpherical|opticalTreatment|fiscalDocument/);
  assert.doesNotMatch(modalState, /opticalType|lens_stock|lens_order|Armacoes/);
  assert.doesNotMatch(mapper, /opticalType|opticalSpecs|opticalOrders|fiscalDocuments/);
  assert.match(opticalModal, /opticalSize/);
  assert.match(opticalModal, /rightSpherical/);
  assert.match(modalState, /changedField\?\.valuePresets/);
});

test("extension payload contract omits empty values and rejects disabled meaningful data", () => {
  const registry = new ExtensionRegistry();
  registry.register({
    key: "vertical.fake",
    activationCapability: "vertical.fake",
    input: { product: { capability: "fake.catalog", legacyKeys: ["fake"] } },
  });
  assert.deepEqual(registry.inputPayloads("product", { extensions: { "vertical.fake": {} } }, { capabilities: [] }), {});
  assert.throws(
    () => registry.inputPayloads("product", { extensions: { "vertical.fake": { value: "x" } } }, { capabilities: [] }),
    (error) => error.code === "CAPABILITY_DISABLED" && error.extensionKey === "vertical.fake",
  );
  assert.deepEqual(
    registry.inputPayloads("product", { extensions: { "vertical.fake": { value: "x" } } }, { capabilities: ["vertical.fake", "fake.catalog"] }),
    { "vertical.fake": { value: "x" } },
  );
});

test("cleanup hooks may run after an extension is suspended while normal hooks stay gated", async () => {
  const registry = new ExtensionRegistry();
  const calls = [];
  registry.register({
    key: "vertical.fake",
    activationCapability: "vertical.fake",
    backend: {
      hooks: {
        "entity.decorate": async () => calls.push("decorate"),
        "entity.cleanup": { handler: async () => calls.push("cleanup"), runWhenDisabled: true },
      },
    },
  });
  await registry.runHook("entity.decorate", {}, { capabilities: [] });
  await registry.runHook("entity.cleanup", {}, { capabilities: [] });
  assert.deepEqual(calls, ["cleanup"]);
});

test("extension entity data migration is generic, tenant isolated and preserves optical catalog metadata", () => {
  const migration = source("db/018_extension_entity_data.sql");
  const dbSource = source("db/db.js");
  assert.match(migration, /create table if not exists volt_core\.entity_extension_data/i);
  assert.match(migration, /extension_key text not null/i);
  assert.match(migration, /data jsonb not null/i);
  assert.match(migration, /vertical\.optical/i);
  assert.match(migration, /catalogType/);
  assert.match(migration, /force row level security/i);
  assert.match(migration, /create policy tenant_isolation/i);
  assert.match(dbSource, /entity_extension_data/);
  assert.match(dbSource, /protected_count \|\| 0\) < 11/);
});

test("service order Core stays generic while the optical extension contributes its production workflow", () => {
  const query = source("src/modules/core/runtime/services/dataQueryService.js");
  const mapper = source("src/client/workspace/mapWorkspaceToAppData.js");
  const main = source("src/client/main.jsx");
  const opticalManifest = source("src/client/extensions/optical/manifest.js");
  assert.doesNotMatch(query, /awaiting_prescription|awaiting_lab|sent_to_lab|quality_check/);
  assert.doesNotMatch(mapper, /awaiting_prescription|awaiting_lab|sent_to_lab|quality_check/);
  assert.doesNotMatch(main, /Conferir receita, medidas|Aguardando laboratorio|Enviado ao laboratorio/);
  assert.match(opticalManifest, /service_orders\.production/);
  assert.match(opticalManifest, /ServiceOrderProductionExtension/);
});


test("extension runtime status records hook activity and failures without vertical-specific metrics code", async () => {
  const registry = new ExtensionRegistry();
  registry.register({
    key: "service.fake",
    backend: { hooks: {
      ok: async () => ({ ok: true }),
      fail: async () => { throw Object.assign(new Error("boom"), { code: "FAKE_FAILURE" }); },
    } },
  });
  await registry.runHook("ok", {}, {});
  await assert.rejects(() => registry.runHook("fail", {}, {}), /boom/);
  const status = registry.runtimeStatus()[0];
  assert.equal(status.hookCalls, 2);
  assert.equal(status.hookErrors, 1);
  assert.equal(status.lastHook, "fail");
  assert.equal(status.lastError.code, "FAKE_FAILURE");
  assert.ok(status.lastRunAt);
});

test("observability exposes registered extensions without coupling the metrics layer to a vertical", () => {
  const observability = source("src/modules/integrations/observabilityService.js");
  assert.match(observability, /extensionRegistry\.runtimeStatus\(\)/);
  assert.match(source("src/platform/extensions/extensionRegistry.js"), /activationCapability/);
  assert.doesNotMatch(observability, /vertical\.optical|service\.fiscal/);
});


test("optional permissions and role grants belong to extension manifests", () => {
  const coreClientAccess = source("src/client/core/access.js");
  const corePermissions = source("src/modules/core/registries/permissions.js");
  const runtimeAccess = source("src/modules/core/runtimeAccess.js");
  const opticalBackend = source("src/extensions/optical/manifest.js");
  const fiscalBackend = source("src/extensions/fiscal/manifest.js");
  const opticalClient = source("src/client/extensions/optical/manifest.js");
  const fiscalClient = source("src/client/extensions/fiscal/manifest.js");

  assert.doesNotMatch(coreClientAccess, /optical_prescriptions|fiscal:read|fiscal:write/);
  assert.doesNotMatch(corePermissions, /optical_prescriptions|fiscal:read|fiscal:write/);
  assert.match(runtimeAccess, /extensionRegistry\.roleAccess/);
  assert.match(runtimeAccess, /extensionRegistry\.permissionDefinitions/);
  assert.match(opticalBackend, /optical_prescriptions:read/);
  assert.match(fiscalBackend, /fiscal:read/);
  assert.match(opticalClient, /rolePermissions/);
  assert.match(fiscalClient, /rolePermissions/);
});

test("paged service order overview is remapped through active extension workspace adapters", () => {
  const main = source("src/client/main.jsx");
  assert.match(main, /mapWorkspaceToAppData\(\{ configuration: workspace\?\.configuration, serviceOrders: summary\.queueRows \}/);
  const opticalProduction = source("src/client/extensions/optical/ServiceOrderProductionExtension.jsx");
  assert.match(opticalProduction, /editRecordPayload\(order\)/);
  assert.match(opticalProduction, /<EmptyContent icon=\{Glasses\}/);
});

test("extension SDK invariants are documented with namespaced payloads and async boundaries", () => {
  const docs = source("docs/EXTENSION_ARCHITECTURE.md");
  assert.match(docs, /Core nao importa implementacoes de uma extensao concreta/);
  assert.match(docs, /extensions\[extensionKey\]/);
  assert.match(docs, /domain event -> outbox -> worker/);
  assert.match(docs, /RLS \+ FORCE RLS/);
});

test("optical PDV search uses a stable runtime loader and renders returned product rows", () => {
  const main = source("src/client/main.jsx");
  const pdv = source("src/client/extensions/optical/OpticalSalesPdv.jsx");
  const view = source("src/client/extensions/optical/OpticalSalesPdvView.jsx");

  assert.match(main, /useCallback/);
  assert.match(main, /const loadRuntimeResource = useCallback\(async \(resource, query = \{\}, options = \{\}\) =>/);
  assert.match(main, /runtimeRequestSequence\.current\[resource\] !== requestId/);
  assert.match(main, /const runtimeData = useMemo\(\(\) => \(\{/);
  assert.match(main, /loadResource: loadRuntimeResource/);
  assert.match(main, /runtimeData=\{runtimeData\}/);

  assert.match(pdv, /const loadResource = runtimeData\?\.loadResource/);
  assert.match(pdv, /loadResource\("products", \{ page: 1, pageSize: 20, search: productQuery, filter: saleFilter \}/);
  assert.match(pdv, /\[productQuery, saleFilter, loadResource\]/);
  assert.doesNotMatch(pdv, /\[productQuery, saleFilter, runtimeData\]/);
  assert.doesNotMatch(pdv, /\[customerQuery, runtimeData\]/);

  assert.match(view, /const visibleResults = !selectedProduct && productQuery\.trim\(\) \? visibleProducts\.slice\(0, 8\) : \[\]/);
  assert.match(view, /visibleResults\.map\(\(item\) =>/);
  assert.match(view, /<strong>\{item\.name\}<\/strong>/);
});
