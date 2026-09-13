const operations = require("../modules/core/coreOperationsService");
const persistent = require("../modules/core/persistentCoreService");

function requirePermission(permission) {
  return async function permissionMiddleware(req, res, next) {
    const role = req.user?.role || req.user?.nivel;
    if (req.user?.is_master || req.user?.isMaster || role === "admin_master") {
      return next();
    }

    const userId = req.user?.uid || req.user?.id;
    if (!userId) {
      return res.status(401).json({
        error: {
          message: "Sessao obrigatoria para validar permissao.",
          code: "AUTH_REQUIRED",
        },
      });
    }

    const companyId = req.params.companyId;
    if (!companyId) {
      return next();
    }

    let result;
    try {
      result = persistent.isEnabled()
        ? await persistent.checkPermission(companyId, userId, permission)
        : operations.checkPermission(companyId, userId, permission);
    } catch (error) {
      return next(error);
    }
    if (!result.allowed) {
      return res.status(403).json({
        error: {
          message: "Usuario sem permissao para esta acao",
          code: "PERMISSION_DENIED",
        },
      });
    }

    req.actorUserId = userId;
    return next();
  };
}

module.exports = requirePermission;
