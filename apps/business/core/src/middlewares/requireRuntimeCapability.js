"use strict";

const persistent = require("../modules/core/runtime");

function requireRuntimeCapability(capability) {
  return async function runtimeCapabilityMiddleware(req, res, next) {
    if (!persistent.isEnabled()) return next();
    try {
      const result = await persistent.checkCapability(req.params.companyId, capability);
      if (result.enabled) return next();
      return res.status(403).json({
        error: {
          message: "Recurso nao habilitado para esta empresa.",
          code: "CAPABILITY_DISABLED",
          capability,
        },
      });
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = requireRuntimeCapability;
