const coreService = require("../modules/core/coreService");

async function listSegments(req, res) {
  res.json({ segments: coreService.listSegments() });
}

async function listModules(req, res) {
  res.json({ modules: coreService.listModules() });
}

async function listScreens(req, res) {
  res.json({ screens: coreService.listScreens() });
}

async function getSegmentTemplate(req, res) {
  res.json({
    template: coreService.getSegmentTemplate(req.params.segmentKey),
  });
}

async function applyTemplate(req, res) {
  const configuration = coreService.applySegmentTemplate({
    companyId: req.params.companyId,
    segmentKey: req.body.segmentKey || "general",
    planKey: req.body.planKey || "starter",
    requestedBy: req.body.requestedBy || "master",
  });

  res.status(201).json({ configuration });
}

async function getCompanyConfiguration(req, res) {
  res.json({
    configuration: coreService.getCompanyConfiguration(req.params.companyId),
  });
}

async function updateCompanyOverrides(req, res) {
  res.json({
    configuration: coreService.updateCompanyOverrides({
      companyId: req.params.companyId,
      overrides: req.body,
      requestedBy: req.body.requestedBy || "master",
    }),
  });
}

module.exports = {
  listSegments,
  listModules,
  listScreens,
  getSegmentTemplate,
  applyTemplate,
  getCompanyConfiguration,
  updateCompanyOverrides,
};
