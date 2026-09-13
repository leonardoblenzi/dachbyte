"use strict";

const express = require("express");
const { authenticate, requirePasswordChangeComplete } = require("../auth");
const { requirePermission } = require("../permissions");
const { withTenant } = require("../db");

const moduleMap = {
  products: "products.read", profit: "profit.read", pricing: "pricing.read", market: "market.read",
  ads: "ads.read", cash: "cash.read", audit: "audit.read", actions: "actions.read", reports: "reports.read",
};

function createAppDataRouter({
  authenticate: authenticateRequest = authenticate,
  requirePasswordChangeComplete: requirePasswordChange = requirePasswordChangeComplete,
  requirePermission: checkPermission = requirePermission,
  withTenant: runInTenant = withTenant,
} = {}) {
  const router = express.Router();
  router.use(authenticateRequest, requirePasswordChange);

  for (const [name, permission] of Object.entries(moduleMap)) {
    router.get(`/${name}`, checkPermission(permission), async (req, res, next) => {
      try {
        const state = await runInTenant(req.vpAuth.tenantId, req.vpAuth.userId, async (client) => (
          (await client.query("SELECT payload,updated_at FROM volt_price.module_state WHERE module_key=$1", [name])).rows[0] || { payload: {}, updated_at: null }
        ));
        res.json({ module: name, state });
      } catch (error) { next(error); }
    });
  }

  router.get("/users", checkPermission("users.read"), async (req, res, next) => {
    try {
      const rows = await runInTenant(req.vpAuth.tenantId, req.vpAuth.userId, async (client) => (
        await client.query(
          "SELECT u.id,u.email,u.full_name,u.status,m.role,m.created_at FROM volt_price.memberships m JOIN volt_price.users u ON u.id=m.user_id WHERE m.tenant_id=$1 ORDER BY u.full_name,u.email",
          [req.vpAuth.tenantId],
        )
      ).rows);
      res.json({ users: rows });
    } catch (error) { next(error); }
  });

  return router;
}

const appDataRouter = createAppDataRouter();

module.exports = { appDataRouter, createAppDataRouter };
