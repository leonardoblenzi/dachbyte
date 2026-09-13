"use strict";

const { db } = require("../../../platform/extensions/coreContracts");
const resources = require("./runtimeResources");
const fiscal = require("./fiscalService");

function inputWithActor(req) {
  return { ...(req.body || {}), actorUserId: req.user?.uid || req.user?.id || null };
}

function databaseDisabledResponse(res) {
  return res.status(503).json({
    error: {
      code: "VOLT_CORE_DATABASE_DISABLED",
      message: "VOLT_CORE_APP_DATABASE_URL nao configurada para o runtime persistido.",
    },
  });
}

function registerFiscalRoutes({ router, asyncHandler, requireRuntimeCapability, requireRuntimePermission }) {
  const base = "/runtime/companies/:companyId";
  router.get(`${base}/data/fiscal-documents`, requireRuntimeCapability("fiscal.documents"), requireRuntimePermission("fiscal:read"), asyncHandler(async (req, res) => {
    if (!db.isDatabaseEnabled()) return databaseDisabledResponse(res);
    const payload = await resources.fiscal_documents.loader(req.params.companyId, req.query || {});
    return res.json({ resource: "fiscal_documents", ...payload });
  }));
  router.post(`${base}/fiscal-documents`, requireRuntimeCapability("service.fiscal.active"), requireRuntimePermission("fiscal:write"), asyncHandler(async (req, res) => {
    if (!db.isDatabaseEnabled()) return databaseDisabledResponse(res);
    return res.status(201).json({ fiscalDocument: await fiscal.createFiscalDocument(req.params.companyId, inputWithActor(req)) });
  }));
  router.patch(`${base}/fiscal-documents/:fiscalDocumentId`, requireRuntimeCapability("service.fiscal.active"), requireRuntimePermission("fiscal:write"), asyncHandler(async (req, res) => {
    if (!db.isDatabaseEnabled()) return databaseDisabledResponse(res);
    return res.json({ fiscalDocument: await fiscal.updateFiscalDocument(req.params.companyId, req.params.fiscalDocumentId, inputWithActor(req)) });
  }));
}

module.exports = { registerFiscalRoutes };
