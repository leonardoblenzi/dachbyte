"use strict";

const authService = require("../modules/auth/authService");
const persistent = require("../modules/core/runtime");
const { setRequestContext } = require("../observability/requestContext");

function readToken(req) {
  const header = String(req.headers.authorization || "");
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return req.cookies?.auth_token || "";
}

function appRedirect(path = "") {
  const base = String(process.env.VOLT_CORE_APP_BASE_PATH || "/core/app")
    .trim()
    .replace(/\/+$/, "");
  const suffix = String(path || "").startsWith("/") ? path : `/${path}`;
  return `${base || ""}${suffix}`;
}

function ensureAuth(req, res, next) {
  try {
    const token = readToken(req);
    if (!token) {
      return res.status(401).json({
        error: {
          message: "Sessao nao encontrada.",
          code: "AUTH_REQUIRED",
          redirect: appRedirect("/login"),
        },
      });
    }

    req.user = authService.verifyToken(token);
    setRequestContext({ userId: req.user?.uid || req.user?.id || null });
    res.locals.user = req.user;
    return next();
  } catch (_error) {
    res.clearCookie("auth_token", authService.clearCookieOptions());
    return res.status(401).json({
      error: {
        message: "Sessao invalida ou expirada.",
        code: "AUTH_INVALID",
        redirect: appRedirect("/login"),
      },
    });
  }
}

function requireMaster(req, res, next) {
  if (authService.isMaster(req.user)) return next();
  return res.status(403).json({
    error: {
      message: "Acesso restrito ao admin master.",
      code: "MASTER_REQUIRED",
    },
  });
}

async function requireCompanyAccess(req, res, next) {
  if (authService.isMaster(req.user)) return next();

  const companyId = String(req.params.companyId || "").trim();
  const allowed = new Set(
    (req.user?.companies || [])
      .map((company) => String(company?.id || "").trim())
      .filter(Boolean),
  );

  if (!companyId || !allowed.has(companyId)) {
    return res.status(403).json({
      error: {
        message: "Usuario sem acesso a esta empresa.",
        code: "COMPANY_ACCESS_DENIED",
      },
    });
  }

  // The JWT is a fast first barrier. In database mode we also validate the live
  // membership, so removing a user from a company takes effect before token expiry.
  if (persistent.isEnabled()) {
    try {
      const userId = req.user?.uid || req.user?.id;
      if (!userId || !(await persistent.hasCompanyAccess(companyId, userId))) {
        return res.status(403).json({
          error: {
            message: "Usuario sem acesso ativo a esta empresa.",
            code: "COMPANY_ACCESS_REVOKED",
          },
        });
      }
    } catch (error) {
      return next(error);
    }
  }

  return next();
}

module.exports = {
  ensureAuth,
  requireCompanyAccess,
  requireMaster,
};
