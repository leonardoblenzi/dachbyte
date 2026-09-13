"use strict";

const express = require("express");
const { authenticate, requirePasswordChangeComplete, requireCsrf } = require("../auth");
const { requirePermission } = require("../permissions");
const { withTenant } = require("../db");
const { audit } = require("../audit");

const VALID_ROLES = new Set(["owner", "admin", "finance", "pricing", "marketing", "analyst", "viewer"]);
const VALID_STATUSES = new Set(["active", "disabled"]);

const router = express.Router();
router.use(authenticate, requirePasswordChangeComplete);

router.patch("/:id", requireCsrf, requirePermission("users.manage"), async (req, res, next) => {
  try {
    if (Object.hasOwn(req.body || {}, "tenantId") || Object.hasOwn(req.body || {}, "mustChangePassword") || Object.hasOwn(req.body || {}, "must_change_password")) {
      throw Object.assign(new Error("Empresa e politica de primeira senha nao podem ser alteradas nesta rota."), { statusCode: 400, code: "tenant_assignment_forbidden" });
    }
    const userId = String(req.params.id || "");
    const requestedRole = req.body?.role === undefined ? null : String(req.body.role);
    const requestedStatus = req.body?.status === undefined ? null : String(req.body.status);
    if (!requestedRole && !requestedStatus) {
      throw Object.assign(new Error("Informe role ou status."), { statusCode: 400, code: "validation" });
    }
    if (requestedRole && !VALID_ROLES.has(requestedRole)) {
      throw Object.assign(new Error("Perfil invalido."), { statusCode: 400, code: "invalid_role" });
    }
    if (requestedStatus && !VALID_STATUSES.has(requestedStatus)) {
      throw Object.assign(new Error("Status invalido."), { statusCode: 400, code: "invalid_status" });
    }

    const membership = await withTenant(req.vpAuth.tenantId, req.vpAuth.userId, async (client) => {
      const before = (await client.query(
        `SELECT tenant_id,user_id,role,status
         FROM volt_price.memberships
         WHERE tenant_id=$1 AND user_id=$2
         FOR UPDATE`,
        [req.vpAuth.tenantId, userId],
      )).rows[0];
      if (!before) {
        throw Object.assign(new Error("Usuario nao pertence a esta empresa."), { statusCode: 404, code: "membership_not_found" });
      }

      const removesOwner = before.role === "owner"
        && ((requestedRole && requestedRole !== "owner") || requestedStatus === "disabled");
      if (removesOwner) {
        const remainingOwners = Number((await client.query(
          `SELECT count(*)::int AS total
           FROM volt_price.memberships
           WHERE tenant_id=$1 AND role='owner' AND status='active' AND user_id<>$2`,
          [req.vpAuth.tenantId, userId],
        )).rows[0]?.total || 0);
        if (!remainingOwners) {
          throw Object.assign(new Error("A empresa precisa manter pelo menos um Owner ativo."), { statusCode: 409, code: "last_owner" });
        }
      }

      const after = (await client.query(
        `UPDATE volt_price.memberships
         SET role=COALESCE($3,role), status=COALESCE($4,status), updated_at=now()
         WHERE tenant_id=$1 AND user_id=$2
         RETURNING tenant_id,user_id,role,status,updated_at`,
        [req.vpAuth.tenantId, userId, requestedRole, requestedStatus],
      )).rows[0];

      if (after.status === "disabled") {
        await client.query(
          `UPDATE volt_price.sessions SET revoked_at=now()
           WHERE tenant_id=$1 AND user_id=$2 AND revoked_at IS NULL`,
          [req.vpAuth.tenantId, userId],
        );
      }
      await audit(client, {
        tenantId: req.vpAuth.tenantId,
        actorUserId: req.vpAuth.userId,
        action: "user.membership_update",
        resourceType: "user",
        resourceId: userId,
        metadata: { before: { role: before.role, status: before.status }, after: { role: after.role, status: after.status } },
        ip: req.ip,
        userAgent: req.get("user-agent"),
      });
      return after;
    });

    res.json({ membership });
  } catch (error) {
    next(error);
  }
});

module.exports = { usersRouter: router, VALID_ROLES, VALID_STATUSES };
