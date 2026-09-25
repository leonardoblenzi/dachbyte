"use strict";

const { checkHubAccess } = require("../services/hubAccessService");

const MASTER_REASONS = new Set(["platform_admin", "platform_module_master"]);

function normalizeReason(access) {
  return String(access?.payload?.reason || access?.reason || "").trim().toLowerCase();
}

function resolveMasterScope(access) {
  const reason = normalizeReason(access);
  if (!access?.allow || !MASTER_REASONS.has(reason)) return null;
  return {
    reason,
    role: reason === "platform_admin" ? "platform_admin" : "module_master",
    canDestroy: reason === "platform_admin",
  };
}

async function requireMagaluMaster(req, res, next) {
  try {
    const identity = req.magaluIdentity;
    if (!identity?.dachUserId) {
      return res.status(401).json({ ok: false, error: "master_identity_missing" });
    }

    // O Hub atual reconhece platform_admin/module_master por módulo. O campo
    // action é obrigatório no contrato, porém ainda não implementa capabilities
    // ADMIN/ADMIN_WRITE distintas; por isso usamos somente a action já suportada.
    const access = await checkHubAccess(identity, { action: "ACCESS magalu", force: true });
    const scope = resolveMasterScope(access);
    if (!scope) {
      return res.status(403).json({
        ok: false,
        error: "magalu_master_denied",
        message: "O Hub não confirmou escopo Master para o módulo Magalu.",
      });
    }

    req.magaluMaster = {
      ...scope,
      userId: identity.dachUserId,
      email: identity.email || null,
      hubReason: scope.reason,
    };
    res.locals.magaluMaster = req.magaluMaster;
    return next();
  } catch (error) {
    return next(error);
  }
}

function requireMagaluMasterDestructive(req, res, next) {
  if (req.magaluMaster?.canDestroy === true) return next();
  return res.status(403).json({
    ok: false,
    error: "magalu_master_destructive_denied",
    message: "Ações destrutivas estão restritas a platform_admin enquanto o Hub não expõe uma capability administrativa de escrita separada.",
  });
}

module.exports = {
  requireMagaluMaster,
  requireMagaluMasterDestructive,
  _test: { normalizeReason, resolveMasterScope, MASTER_REASONS },
};
