"use strict";

const db = require("../../db/db");
const { setRequestContext } = require("../observability/requestContext");

function tenantContext(req, _res, next) {
  const companyId = String(req.params.companyId || "").trim();
  if (!companyId) return next();
  setRequestContext({ companyId });
  return db.withTenantContext(companyId, () => next());
}

module.exports = tenantContext;
