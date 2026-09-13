"use strict";

const READ_ONLY_PERMISSIONS = [
  "dashboard.read","orders.read","fees.read","commissions.read","integrations.read","users.read","products.read","profit.read","pricing.read","market.read","ads.read","cash.read","audit.read","actions.read","reports.read",
];

const ROLE_PERMISSIONS = {
  owner: ["*"],
  admin: ["dashboard.read","orders.read","orders.sync","fees.read","commissions.read","commissions.manage","integrations.read","integrations.manage","users.read","users.manage","products.read","products.manage","profit.read","profit.manage","pricing.read","pricing.simulate","pricing.manage","market.read","market.manage","ads.read","ads.manage","cash.read","cash.manage","audit.read","audit.manage","actions.read","actions.manage","reports.read"],
  finance: ["dashboard.read","orders.read","fees.read","commissions.read","profit.read","profit.manage","cash.read","cash.manage","audit.read","audit.manage","reports.read"],
  pricing: ["dashboard.read","orders.read","fees.read","commissions.read","products.read","products.manage","profit.read","profit.manage","pricing.read","pricing.simulate","pricing.manage","market.read","market.manage","actions.read","actions.manage","reports.read"],
  marketing: ["dashboard.read","commissions.read","market.read","market.manage","ads.read","ads.manage","reports.read"],
  analyst: [...READ_ONLY_PERMISSIONS,"pricing.simulate"],
  viewer: [...READ_ONLY_PERMISSIONS],
};

function hasPermission(auth, permission) {
  if (auth?.isPlatformAdmin) return true;
  const permissions = ROLE_PERMISSIONS[String(auth?.role || "viewer")] || [];
  return permissions.includes("*") || permissions.includes(permission);
}

function requirePermission(permission) {
  return (req, _res, next) => {
    if (!req.vpAuth) return next(Object.assign(new Error("Nao autenticado."), { statusCode: 401, code: "unauthenticated" }));
    if (!hasPermission(req.vpAuth, permission)) return next(Object.assign(new Error("Sem permissao para esta operacao."), { statusCode: 403, code: "forbidden" }));
    next();
  };
}

module.exports = { ROLE_PERMISSIONS, hasPermission, requirePermission };
