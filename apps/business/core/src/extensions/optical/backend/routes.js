"use strict";

const { db } = require("../../../platform/extensions/coreContracts");
const resources = require("./runtimeResources");
const optical = require("./opticalService");

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

function registerOpticalRoutes({ router, asyncHandler, requireRuntimeCapability, requireRuntimePermission }) {
  const base = "/runtime/companies/:companyId";
  const dataRoute = (path, resource, capability, permission) => {
    router.get(`${base}/data/${path}`, requireRuntimeCapability(capability), requireRuntimePermission(permission), asyncHandler(async (req, res) => {
      if (!db.isDatabaseEnabled()) return databaseDisabledResponse(res);
      const payload = await resources[resource].loader(req.params.companyId, req.query || {});
      return res.json({ resource, ...payload });
    }));
  };

  dataRoute("prescriptions", "prescriptions", "optical.prescriptions", "optical_prescriptions:read");
  dataRoute("optical-orders", "optical_orders", "optical.orders", "service_orders:read");
  dataRoute("optical-laboratories", "optical_laboratories", "optical.laboratories", "optical_prescriptions:read");

  router.post(`${base}/prescriptions`, requireRuntimeCapability("optical.prescriptions"), requireRuntimePermission("optical_prescriptions:write"), asyncHandler(async (req, res) => {
    if (!db.isDatabaseEnabled()) return databaseDisabledResponse(res);
    return res.status(201).json({ prescription: await optical.createPrescription(req.params.companyId, inputWithActor(req)) });
  }));
  router.patch(`${base}/prescriptions/:prescriptionId`, requireRuntimeCapability("optical.prescriptions"), requireRuntimePermission("optical_prescriptions:write"), asyncHandler(async (req, res) => {
    if (!db.isDatabaseEnabled()) return databaseDisabledResponse(res);
    return res.json({ prescription: await optical.updatePrescription(req.params.companyId, req.params.prescriptionId, inputWithActor(req)) });
  }));
  router.post(`${base}/optical-laboratories`, requireRuntimeCapability("optical.laboratories"), requireRuntimePermission("optical_prescriptions:write"), asyncHandler(async (req, res) => {
    if (!db.isDatabaseEnabled()) return databaseDisabledResponse(res);
    return res.status(201).json({ laboratory: await optical.saveOpticalLaboratory(req.params.companyId, inputWithActor(req)) });
  }));
  router.patch(`${base}/optical-orders/:opticalOrderId/status`, requireRuntimeCapability("optical.orders"), requireRuntimePermission("service_orders:write"), asyncHandler(async (req, res) => {
    if (!db.isDatabaseEnabled()) return databaseDisabledResponse(res);
    return res.json({ opticalOrder: await optical.updateOpticalOrderStatus(req.params.companyId, req.params.opticalOrderId, inputWithActor(req)) });
  }));
  router.post(`${base}/optical-orders/:opticalOrderId/mark-ready`, requireRuntimeCapability("optical.orders"), requireRuntimePermission("service_orders:write"), asyncHandler(async (req, res) => {
    if (!db.isDatabaseEnabled()) return databaseDisabledResponse(res);
    return res.json({ opticalOrder: await optical.markOpticalOrderReady(req.params.companyId, req.params.opticalOrderId, inputWithActor(req)) });
  }));
}

module.exports = { registerOpticalRoutes };
