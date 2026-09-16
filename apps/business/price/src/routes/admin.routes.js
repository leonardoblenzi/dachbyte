"use strict";

const express = require("express");
const bcrypt = require("bcryptjs");
const auth = require("../auth");
const { withPlatformAdmin, withClient } = require("../db");
const { audit } = require("../audit");
const { config, baseUrl, publicPath } = require("../config");
const { createAuthorizationLink } = require("../integrations/authorizationLink");

const PROVISIONABLE_ROLES = new Set(["admin", "finance", "pricing", "marketing", "analyst", "viewer"]);

function platformAdminOnly(req, _res, next) {
  if (req.vpAuth?.isPlatformAdmin) return next();
  return next(Object.assign(new Error("Admin Master necessario."), { statusCode: 403, code: "platform_admin_required" }));
}

function invalid(message, code = "validation") {
  return Object.assign(new Error(message), { statusCode: 400, code });
}

function createProvisionUserHandler({
  withPlatformAdmin: runAsPlatformAdmin = withPlatformAdmin,
  audit: writeAudit = audit,
  hashPassword = (password) => bcrypt.hash(password, 12),
} = {}) {
  return async (req, res, next) => {
    try {
      const tenantId = String(req.params?.tenantId || "").trim();
      const email = auth.validateEmail(req.body?.email);
      const fullName = String(req.body?.fullName || "").trim();
      const role = String(req.body?.role || "").trim();
      const temporaryPassword = auth.validatePassword(req.body?.temporaryPassword);
      if (!tenantId) throw invalid("Empresa obrigatoria.");
      if (!fullName) throw invalid("Nome completo obrigatorio.");
      if (!PROVISIONABLE_ROLES.has(role)) throw invalid("Perfil invalido.", "invalid_role");

      const passwordHash = await hashPassword(temporaryPassword);
      const result = await runAsPlatformAdmin(req.vpAuth.userId, async (client) => {
        const tenant = (await client.query("SELECT id FROM volt_price.tenants WHERE id=$1", [tenantId])).rows[0];
        if (!tenant) throw Object.assign(new Error("Empresa nao encontrada."), { statusCode: 404, code: "tenant_not_found" });

        const user = (await client.query(
          `INSERT INTO volt_price.users (email,full_name,password_hash,status,must_change_password)
           VALUES ($1,$2,$3,'active',true)
           ON CONFLICT(email) DO UPDATE SET full_name=EXCLUDED.full_name,password_hash=EXCLUDED.password_hash,status='active',must_change_password=true,updated_at=now()
           RETURNING id,email,full_name,status,must_change_password`,
          [email, fullName, passwordHash],
        )).rows[0];
        const otherMembership = (await client.query(
          `SELECT tenant_id FROM volt_price.memberships
           WHERE user_id=$1 AND status='active' AND tenant_id<>$2
           FOR UPDATE`,
          [user.id, tenantId],
        )).rows[0];
        if (otherMembership) {
          throw Object.assign(new Error("Usuario ja possui acesso ativo a outra empresa."), { statusCode: 409, code: "active_membership_other_tenant" });
        }
        await client.query(
          `INSERT INTO volt_price.memberships (tenant_id,user_id,role,status)
           VALUES ($1,$2,$3,'active')
           ON CONFLICT(tenant_id,user_id) DO UPDATE SET role=EXCLUDED.role,status='active',updated_at=now()`,
          [tenantId, user.id, role],
        );
        await client.query("DELETE FROM volt_price.sessions WHERE user_id=$1", [user.id]);
        await writeAudit(client, {
          tenantId,
          actorUserId: req.vpAuth.userId,
          actorType: "platform_admin",
          action: "platform.user.provisioned",
          resourceType: "user",
          resourceId: user.id,
          metadata: { role },
          ip: req.ip,
          userAgent: req.get("user-agent"),
        });
        return user;
      });

      return res.status(201).json({
        user: { id: result.id, email: result.email, fullName: result.full_name, role, status: result.status },
        mustChangePassword: true,
      });
    } catch (error) { return next(error); }
  };
}

function createTenantUsersHandler({
  withPlatformAdmin: runAsPlatformAdmin = withPlatformAdmin,
} = {}) {
  return async (req, res, next) => {
    try {
      const tenantId = String(req.params?.tenantId || "").trim();
      if (!tenantId) throw invalid("Empresa obrigatoria.");

      const result = await runAsPlatformAdmin(req.vpAuth.userId, async (client) => {
        const tenant = (await client.query(
          "SELECT id,name,slug,status FROM volt_price.tenants WHERE id=$1",
          [tenantId],
        )).rows[0];
        if (!tenant) throw Object.assign(new Error("Empresa nao encontrada."), { statusCode: 404, code: "tenant_not_found" });

        const users = (await client.query(
          `SELECT u.id,u.full_name,u.email,m.role,m.status,u.must_change_password,u.created_at,u.updated_at
           FROM volt_price.memberships m JOIN volt_price.users u ON u.id=m.user_id
           WHERE m.tenant_id=$1
           ORDER BY u.full_name ASC,u.email ASC`,
          [tenant.id],
        )).rows;
        return { tenant, users };
      });

      return res.json({
        tenant: result.tenant,
        users: result.users.map((user) => ({
          id: user.id,
          fullName: user.full_name,
          email: user.email,
          role: user.role,
          status: user.status,
          mustChangePassword: Boolean(user.must_change_password),
          createdAt: user.created_at,
          updatedAt: user.updated_at,
        })),
      });
    } catch (error) { return next(error); }
  };
}

function createTenantHandler({
  withPlatformAdmin: runAsPlatformAdmin = withPlatformAdmin,
  audit: writeAudit = audit,
  hashPassword = (password) => bcrypt.hash(password, 12),
} = {}) {
  return async (req, res, next) => {
    try {
      const body = req.body || {};
      const email = auth.validateEmail(body.ownerEmail);
      const ownerPassword = auth.validatePassword(body.ownerPassword);
      const name = String(body.name || "").trim();
      if (!name) throw invalid("Nome, email e senha do owner sao obrigatorios.");
      const slug = String(body.slug || name).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
      const passwordHash = await hashPassword(ownerPassword);
      const result = await runAsPlatformAdmin(req.vpAuth.userId, async (client) => {
        const tenant = (await client.query(
          "INSERT INTO volt_price.tenants (name,slug,status,timezone,currency) VALUES ($1,$2,'active',$3,'BRL') RETURNING *",
          [name, slug, body.timezone || "America/Sao_Paulo"],
        )).rows[0];
        const owner = (await client.query(
          `INSERT INTO volt_price.users (email,full_name,password_hash,status,must_change_password)
           VALUES ($1,$2,$3,'active',$4)
           ON CONFLICT(email) DO UPDATE SET full_name=EXCLUDED.full_name,password_hash=EXCLUDED.password_hash,status='active',must_change_password=true,updated_at=now()
           RETURNING *`,
          [email, body.ownerName || email, passwordHash, true],
        )).rows[0];
        const otherMembership = (await client.query(
          "SELECT tenant_id FROM volt_price.memberships WHERE user_id=$1 AND status='active' FOR UPDATE",
          [owner.id],
        )).rows[0];
        if (otherMembership) throw Object.assign(new Error("Usuario ja possui acesso ativo a outra empresa."), { statusCode: 409, code: "active_membership_other_tenant" });
        await client.query(
          `INSERT INTO volt_price.memberships (tenant_id,user_id,role,status)
           VALUES ($1,$2,'owner','active')
           ON CONFLICT(tenant_id,user_id) DO UPDATE SET role='owner',status='active'`,
          [tenant.id, owner.id],
        );
        await client.query("DELETE FROM volt_price.sessions WHERE user_id=$1", [owner.id]);
        await writeAudit(client, { tenantId: tenant.id, actorUserId: req.vpAuth.userId, actorType: "platform_admin", action: "tenant.create", resourceType: "tenant", resourceId: tenant.id, metadata: { name: tenant.name, ownerEmail: email }, ip: req.ip, userAgent: req.get("user-agent") });
        return { tenant, owner: { id: owner.id, email: owner.email, fullName: owner.full_name } };
      });
      return res.status(201).json(result);
    } catch (error) { return next(error); }
  };
}

function createIntegrationLinkHandler({
  withPlatformAdmin: runAsPlatformAdmin = withPlatformAdmin,
  createAuthorizationLink: createLink = createAuthorizationLink,
  audit: writeAudit = audit,
  baseUrl: getBaseUrl = baseUrl,
} = {}) {
  return async (req, res, next) => {
    try {
      const tenantId = String(req.params?.tenantId || "").trim();
      const channel = String(req.body?.channel || "").trim().toLowerCase();
      const reason = String(req.body?.reason || "").trim();
      if (!tenantId) throw invalid("Empresa obrigatoria.");
      if (!["meli", "shopee"].includes(channel)) throw invalid("Canal invalido.", "invalid_channel");
      if (reason.length < 5) throw invalid("Informe o motivo da geração do link.", "support_reason_required");
      const created = await runAsPlatformAdmin(req.vpAuth.userId, async (client) => {
        const tenant = (await client.query("SELECT id,name,status FROM volt_price.tenants WHERE id=$1", [tenantId])).rows[0];
        if (!tenant) throw Object.assign(new Error("Empresa nao encontrada."), { statusCode: 404, code: "tenant_not_found" });
        if (tenant.status !== "active") throw Object.assign(new Error("Empresa indisponivel."), { statusCode: 409, code: "tenant_unavailable" });
        const result = await createLink(client, { tenantId: tenant.id, channel, userId: req.vpAuth.userId, supportReason: reason });
        await writeAudit(client, {
          tenantId: tenant.id,
          actorUserId: req.vpAuth.userId,
          actorType: "platform_admin",
          action: "integration.link.create",
          resourceType: "integration_authorization_link",
          resourceId: result.link.id,
          metadata: { channel, reason },
          ip: req.ip,
          userAgent: req.get("user-agent"),
        });
        return result;
      });
      return res.status(201).json({ authorizationUrl: `${getBaseUrl(req)}${publicPath(`/api/integrations/link/${created.token}`)}`, expiresAt: created.link.expires_at });
    } catch (error) { return next(error); }
  };
}

function createAdminRouter({
  authenticate = auth.authenticate,
  requirePasswordChangeComplete = auth.requirePasswordChangeComplete,
  requireCsrf = auth.requireCsrf,
} = {}) {
  const router = express.Router();
  router.use(authenticate, requirePasswordChangeComplete, platformAdminOnly);

  router.get("/tenants", async (req, res, next) => { try { const rows = await withPlatformAdmin(req.vpAuth.userId, async (client) => (await client.query("SELECT t.*,count(m.user_id)::int users_count FROM volt_price.tenants t LEFT JOIN volt_price.memberships m ON m.tenant_id=t.id AND m.status='active' GROUP BY t.id ORDER BY t.created_at DESC")).rows); res.json({ tenants: rows }); } catch (error) { next(error); } });
  router.get("/tenants/:tenantId/users", createTenantUsersHandler());
  router.post("/tenants", requireCsrf, createTenantHandler());
  router.post("/tenants/:tenantId/users", requireCsrf, createProvisionUserHandler());
  router.post("/tenants/:tenantId/integration-links", requireCsrf, createIntegrationLinkHandler());
  router.patch("/tenants/:id", requireCsrf, async (req, res, next) => { try { const status = String(req.body?.status || ""); if (!["active", "suspended", "offboarding"].includes(status)) throw invalid("Status invalido."); const tenant = await withPlatformAdmin(req.vpAuth.userId, async (client) => { const before = (await client.query("SELECT * FROM volt_price.tenants WHERE id=$1", [req.params.id])).rows[0]; if (!before) throw Object.assign(new Error("Tenant nao encontrado."), { statusCode: 404 }); const after = (await client.query("UPDATE volt_price.tenants SET status=$2,updated_at=now() WHERE id=$1 RETURNING *", [req.params.id, status])).rows[0]; await audit(client, { tenantId: after.id, actorUserId: req.vpAuth.userId, actorType: "platform_admin", action: "tenant.status_change", resourceType: "tenant", resourceId: after.id, metadata: { before: before.status, after: status } }); return after; }); res.json({ tenant }); } catch (error) { next(error); } });
  router.get("/audit", async (req, res, next) => { try { const limit = Math.min(200, Number(req.query.limit) || 100); const rows = await withPlatformAdmin(req.vpAuth.userId, async (client) => (await client.query("SELECT a.*,u.email actor_email,t.name tenant_name FROM volt_price.audit_logs a LEFT JOIN volt_price.users u ON u.id=a.actor_user_id LEFT JOIN volt_price.tenants t ON t.id=a.tenant_id ORDER BY a.created_at DESC LIMIT $1", [limit])).rows); res.json({ logs: rows }); } catch (error) { next(error); } });
  router.post("/tenants/:id/support-session", requireCsrf, async (req, res, next) => { try { const reason = String(req.body?.reason || "").trim(); if (reason.length < 5) throw invalid("Informe o motivo do acesso assistido."); const created = await withClient(async (client) => { await client.query("BEGIN"); try { const tenant = (await client.query("SELECT id,name,status FROM volt_price.tenants WHERE id=$1", [req.params.id])).rows[0]; if (!tenant || tenant.status !== "active") throw Object.assign(new Error("Tenant indisponivel."), { statusCode: 409 }); await client.query("UPDATE volt_price.sessions SET revoked_at=now() WHERE id=$1", [req.vpAuth.sessionId]); const session = await auth.createSession(client, { userId: req.vpAuth.userId, tenantId: tenant.id, ip: req.ip, userAgent: req.get("user-agent"), supportReason: reason }); await audit(client, { tenantId: tenant.id, actorUserId: req.vpAuth.userId, actorType: "platform_admin", action: "support_session.start", resourceType: "tenant", resourceId: tenant.id, metadata: { reason }, ip: req.ip, userAgent: req.get("user-agent") }); await client.query("COMMIT"); return { session, tenant }; } catch (error) { await client.query("ROLLBACK"); throw error; } }); res.cookie(config.sessionCookie, created.session.token, auth.cookieOptions(req)); res.json({ success: true, csrfToken: created.session.csrf, tenant: created.tenant }); } catch (error) { next(error); } });
  router.post("/exit-support", requireCsrf, async (req, res, next) => { try { const created = await withClient(async (client) => { await client.query("BEGIN"); try { await client.query("UPDATE volt_price.sessions SET revoked_at=now() WHERE id=$1", [req.vpAuth.sessionId]); const session = await auth.createSession(client, { userId: req.vpAuth.userId, tenantId: null, ip: req.ip, userAgent: req.get("user-agent") }); await audit(client, { tenantId: req.vpAuth.tenantId, actorUserId: req.vpAuth.userId, actorType: "platform_admin", action: "support_session.end", resourceType: "tenant", resourceId: req.vpAuth.tenantId }); await client.query("COMMIT"); return session; } catch (error) { await client.query("ROLLBACK"); throw error; } }); res.cookie(config.sessionCookie, created.token, auth.cookieOptions(req)); res.json({ success: true, csrfToken: created.csrf }); } catch (error) { next(error); } });
  return router;
}

const adminRouter = createAdminRouter();

module.exports = { adminRouter, createAdminRouter, createProvisionUserHandler, createTenantUsersHandler, createTenantHandler, createIntegrationLinkHandler, PROVISIONABLE_ROLES };
