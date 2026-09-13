const { segments } = require("./registries/segments");
const { modules } = require("./registries/modules");
const { screens } = require("./registries/screens");
const { getTemplateBySegment } = require("./templates");
const repository = require("./repositories/inMemoryCompanyConfigRepository");
const { buildConfiguration } = require("./templateEngine");
const { normalizeOverrides, withEffectiveConfiguration } = require("./capabilities/capabilityResolver");

function listSegments() {
  return segments;
}

function listModules() {
  return modules;
}

function listScreens() {
  return screens;
}

function getSegmentTemplate(segmentKey) {
  return getSegmentByOrFail(segmentKey);
}

function applySegmentTemplate({ companyId, segmentKey, planKey, requestedBy }) {
  const template = getSegmentByOrFail(segmentKey);
  const configuration = buildConfiguration({
    companyId,
    planKey,
    requestedBy,
    template,
  });

  return repository.save(configuration);
}

function getCompanyConfiguration(companyId) {
  const configuration = repository.findByCompanyId(companyId);

  if (!configuration) {
    const err = new Error("Configuracao da empresa nao encontrada");
    err.statusCode = 404;
    err.code = "COMPANY_CONFIGURATION_NOT_FOUND";
    throw err;
  }

  return withEffectiveConfiguration(configuration);
}

function updateCompanyOverrides({ companyId, overrides, requestedBy }) {
  const current = getCompanyConfiguration(companyId);
  const next = {
    ...current,
    overrides: normalizeOverrides(overrides),
    updatedBy: requestedBy,
    updatedAt: new Date().toISOString(),
  };

  repository.save(next);
  return withEffectiveConfiguration(next);
}

function getSegmentByOrFail(segmentKey) {
  const template = getTemplateBySegment(segmentKey);

  if (!template) {
    const err = new Error("Segmento nao encontrado");
    err.statusCode = 404;
    err.code = "SEGMENT_NOT_FOUND";
    throw err;
  }

  return template;
}


module.exports = {
  listSegments,
  listModules,
  listScreens,
  getSegmentTemplate,
  applySegmentTemplate,
  getCompanyConfiguration,
  updateCompanyOverrides,
};
