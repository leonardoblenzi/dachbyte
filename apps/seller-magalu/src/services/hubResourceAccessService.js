"use strict";

const { checkHubAccess } = require("./hubAccessService");

function resourceKeyForAccount(account) {
  return `magalu:${String(account?.magalu_tenant_id || "").trim()}`;
}

async function checkAccountAccess(identity, account, options = {}) {
  return checkHubAccess(
    { dachTenantId: identity?.dachTenantId, dachUserId: identity?.dachUserId },
    { ...options, resourceKey: resourceKeyForAccount(account) },
  );
}

module.exports = { checkAccountAccess, resourceKeyForAccount };
