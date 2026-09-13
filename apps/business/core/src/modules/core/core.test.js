const test = require("node:test");
const assert = require("node:assert/strict");
const coreService = require("./coreService");
const repository = require("./repositories/inMemoryCompanyConfigRepository");

test("applies optical template with modules, screens and default fields", () => {
  repository.clear();

  const configuration = coreService.applySegmentTemplate({
    companyId: "company-1",
    segmentKey: "optical",
    planKey: "starter",
    requestedBy: "master",
  });

  assert.equal(configuration.segmentKey, "optical");
  assert.ok(configuration.modules.includes("sales"));
  assert.ok(configuration.modules.includes("inventory"));
  assert.ok(configuration.modules.includes("optical_prescriptions"));
  assert.ok(configuration.screens.includes("service_orders"));
  assert.ok(configuration.settings.fields.some((field) => field.key === "right_eye_spherical"));
});

test("applies general template as the standalone core", () => {
  repository.clear();

  const configuration = coreService.applySegmentTemplate({
    companyId: "company-general",
    segmentKey: "general",
    planKey: "starter",
    requestedBy: "master",
  });

  assert.equal(configuration.segmentKey, "general");
  assert.ok(configuration.modules.includes("sales"));
  assert.ok(configuration.modules.includes("inventory"));
  assert.ok(configuration.modules.includes("receivables"));
  assert.ok(configuration.modules.includes("cash_register"));
  assert.ok(!configuration.modules.includes("optical_prescriptions"));
  assert.ok(configuration.screens.includes("receivables"));
  assert.ok(configuration.screens.includes("cash_register"));
});

test("stores master overrides separately from segment template defaults", () => {
  repository.clear();

  coreService.applySegmentTemplate({
    companyId: "company-2",
    segmentKey: "optical",
    planKey: "starter",
    requestedBy: "master",
  });

  const configuration = coreService.updateCompanyOverrides({
    companyId: "company-2",
    requestedBy: "master",
    overrides: {
      disabledModules: ["reports"],
      customStatuses: ["aguardando_laboratorio"],
    },
  });

  assert.ok(!configuration.modules.includes("reports"));
  assert.ok(configuration.baseModules.includes("reports"));
  assert.deepEqual(configuration.overrides.disabledModules, ["reports"]);
  assert.deepEqual(configuration.overrides.customStatuses, ["aguardando_laboratorio"]);
});
