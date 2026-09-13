"use strict";

const { hasPermission } = require("../modules/core/runtimeAccess");
const runtime = require("../modules/core/runtime");
const { isPermissionEnabled } = require("../modules/core/capabilities/capabilityResolver");

function moduleDisabledResponse(res, permission) {
  return res.status(403).json({
    error: {
      message: "Modulo nao habilitado para esta empresa.",
      code: "MODULE_DISABLED",
      permission,
    },
  });
}

function requireRuntimePermission(permission) {
  return async function runtimePermissionMiddleware(req, res, next) {
    const role = req.user?.role || req.user?.nivel;
    const isMaster = Boolean(req.user?.is_master || req.user?.isMaster || role === "admin_master");
    const userId = req.user?.uid || req.user?.id;

    try {
      // Module composition is a tenant entitlement, not a user permission. Even
      // a master cannot accidentally operate a feature disabled for the tenant.
      if (runtime.isEnabled()) {
        if (isMaster) {
          const configuration = await runtime.getCompanyConfiguration(req.params.companyId);
          if (!isPermissionEnabled(configuration, permission)) return moduleDisabledResponse(res, permission);
          return next();
        }

        if (userId) {
          const result = await runtime.checkPermission(req.params.companyId, userId, permission);
          if (result.allowed) return next();
          if (result.reason === "module_disabled") return moduleDisabledResponse(res, permission);
          return res.status(403).json({
            error: {
              message: "Usuario sem permissao para esta acao.",
              code: "PERMISSION_DENIED",
              permission,
            },
          });
        }
      }

      if (isMaster) return next();
      if (hasPermission(req.user, req.params.companyId, permission)) return next();
      return res.status(403).json({
        error: {
          message: "Usuario sem permissao para esta acao.",
          code: "PERMISSION_DENIED",
          permission,
        },
      });
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = requireRuntimePermission;
