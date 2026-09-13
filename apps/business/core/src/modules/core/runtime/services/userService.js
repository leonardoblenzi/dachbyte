"use strict";

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const db = require("../../../../../db/db");
const { createId } = require("../../id");
const runtimeAccess = require("../../runtimeAccess");
const { insertAuditWithClient } = require("./persistenceHelpers");
const { getCompanyConfigurationWithClient } = require("./configurationService");
const { effectiveLimit } = require("../../configuration/configurationEngine");
const { provisionVoltCoreUser } = require("../../../auth/hubProvisioningClient");

function defaultRolePermissions() {
  return {
    owner: runtimeAccess.permissionsForRole("owner"),
    manager: runtimeAccess.permissionsForRole("manager"),
    operator: runtimeAccess.permissionsForRole("operator"),
    stock: runtimeAccess.permissionsForRole("stock"),
    finance: runtimeAccess.permissionsForRole("finance"),
  };
}

function isEnabled() { return db.isDatabaseEnabled(); }
function normalizeCompanyRole(value) { return runtimeAccess.normalizeRole(value); }

async function listCompanyUsers(companyId) {
  const result = await db.query(`select u.id, u.name, u.email, uc.role, uc.permissions, uc.screens, u.status, u.last_login_at as "lastLoginAt"
    from volt_core.user_companies uc join volt_core.users u on u.id = uc.user_id
    where uc.company_id = $1 order by u.name asc;`, [companyId]);
  return result.rows;
}

async function listRoles(companyId = null) {
  if (!isEnabled()) {
    return Object.entries(defaultRolePermissions()).map(([key, permissions]) => ({
      id: key,
      key,
      name: key === "owner" ? "Owner" : key === "manager" ? "Gerente" : key === "operator" ? "Operador" : key,
      permissions,
    }));
  }
  const result = await db.query(`
    select r.id, coalesce(r.system_key, r.id) as key, r.name, r.description,
      coalesce(jsonb_agg(rp.permission_key order by rp.permission_key) filter (where rp.allowed is true), '[]'::jsonb) as permissions
    from volt_core.roles r
    left join volt_core.role_permissions rp on rp.role_id = r.id
    where r.company_id is null or r.company_id = $1
    group by r.id
    order by case coalesce(r.system_key, r.id)
      when 'owner' then 1 when 'manager' then 2 when 'operator' then 3 else 9 end, r.name;
  `, [companyId]);
  return result.rows;
}

function listPermissions() { return runtimeAccess.permissionDefinitions(); }

function normalizePositiveLimit(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : null;
}

async function assertUserLimitWithClient(client, companyId, email) {
  const existingMembership = await client.query(`select uc.user_id
    from volt_core.users u join volt_core.user_companies uc on uc.user_id = u.id
    where uc.company_id = $1 and lower(u.email) = lower($2) limit 1`, [companyId, email]);
  if (existingMembership.rowCount) return;
  const configuration = await getCompanyConfigurationWithClient(client, companyId);
  const limit = normalizePositiveLimit(effectiveLimit(configuration, "users", null));
  if (!limit) return;
  const count = await client.query("select count(*)::int as total from volt_core.user_companies where company_id = $1", [companyId]);
  if (Number(count.rows[0]?.total || 0) >= limit) {
    throw Object.assign(new Error(`Limite de ${limit} usuarios atingido para esta empresa`), {
      statusCode: 409, code: "USER_LIMIT_REACHED", limit,
    });
  }
}

async function createCompanyUser(companyId, input = {}) {
  const email = String(input.email || "").trim().toLowerCase();
  if (!email || !String(input.name || "").trim()) throw Object.assign(new Error("Nome e email sao obrigatorios"), { statusCode: 400, code: "USER_FIELDS_REQUIRED" });
  const role = normalizeCompanyRole(input.role);
  const permissions = runtimeAccess.permissionsForRole(role, input.permissions);
  const requestedScreens = runtimeAccess.screensForRole(role, input.screens);
  const company = await db.query(`select id, name, tenant_global_id as "tenantGlobalId", document_type as "documentType", document_number as "documentNumber"
    from volt_core.companies where id = $1 limit 1`, [companyId]);
  const companyRow = company.rows[0];
  if (!companyRow?.tenantGlobalId) {
    throw Object.assign(new Error("Esta empresa ainda nao esta vinculada ao Hub. Atualize a empresa antes de criar usuarios."), {
      statusCode: 409, code: "HUB_COMPANY_REQUIRED",
    });
  }
  const localUserId = createId("usr");
  const hubUser = await provisionVoltCoreUser({
    tenantId: companyRow.tenantGlobalId,
    companyName: companyRow.name,
    documentType: companyRow.documentType,
    documentNumber: companyRow.documentNumber,
    userId: localUserId,
    fullName: String(input.name).trim(),
    email,
    role,
  });
  return db.withClient(async (client) => {
    await client.query("begin");
    try {
      await assertUserLimitWithClient(client, companyId, email);
      const passwordHash = await bcrypt.hash(crypto.randomBytes(24).toString("base64url"), 10);
      const result = await client.query(`insert into volt_core.users (id, name, email, password_hash, role, status, user_global_id)
        values ($1,$2,$3,$4,$5,'active',$6) on conflict (email) do update set
          name = excluded.name, user_global_id = excluded.user_global_id, updated_at = now()
        returning id, name, email, status, user_global_id as "userGlobalId";`,
      [localUserId, String(input.name).trim(), email, passwordHash, role, hubUser.userId]);
      const configuration = await client.query("select screens from volt_core.company_configurations where company_id = $1", [companyId]);
      const configuredScreens = new Set(configuration.rows[0]?.screens || []);
      const userScreens = requestedScreens.includes("*") ? ["*"] : requestedScreens.filter((screen) => configuredScreens.has(screen));
      await client.query(`insert into volt_core.user_companies (user_id, company_id, role, permissions, screens) values ($1,$2,$3,$4,$5)
        on conflict (user_id, company_id) do update set role = excluded.role, permissions = excluded.permissions, screens = excluded.screens, updated_at = now();`,
      [result.rows[0].id, companyId, role, JSON.stringify(permissions), JSON.stringify(userScreens)]);
      await insertAuditWithClient(client, companyId, input.actorUserId, "user.access.created", "user", result.rows[0].id, null,
        { ...result.rows[0], role, permissions, screens: userScreens });
      await client.query("commit");
      return { ...result.rows[0], role, permissions, screens: userScreens, inviteUrl: hubUser.inviteUrl };
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });
}

async function updateCompanyUser(companyId, userId, input = {}) {
  const role = input.role ? normalizeCompanyRole(input.role) : null;
  const permissions = input.permissions === undefined ? null : runtimeAccess.normalizeAccessList(input.permissions);
  const requestedScreens = input.screens === undefined ? null : runtimeAccess.normalizeAccessList(input.screens);
  return db.withClient(async (client) => {
    await client.query("begin");
    try {
      const user = await client.query(`update volt_core.users set name = coalesce($3,name), status = coalesce($4,status), updated_at = now()
        where id = $1 and exists (select 1 from volt_core.user_companies where user_id = $1 and company_id = $2)
        returning id, name, email, status;`, [userId, companyId, input.name || null, input.status || null]);
      if (!user.rowCount) throw Object.assign(new Error("Usuario nao encontrado"), { statusCode: 404, code: "USER_NOT_FOUND" });
      const current = await client.query("select role, permissions, screens from volt_core.user_companies where user_id = $1 and company_id = $2", [userId, companyId]);
      const nextRole = role || current.rows[0]?.role || input.currentRole || "operator";
      const nextPermissions = permissions || (role ? runtimeAccess.permissionsForRole(nextRole) : current.rows[0]?.permissions || []);
      const configuration = await client.query("select screens from volt_core.company_configurations where company_id = $1", [companyId]);
      const configuredScreens = new Set(configuration.rows[0]?.screens || []);
      const roleScreens = requestedScreens || (role ? runtimeAccess.screensForRole(nextRole) : current.rows[0]?.screens || []);
      const nextScreens = roleScreens.includes("*") ? ["*"] : roleScreens.filter((screen) => configuredScreens.has(screen));
      await client.query(`update volt_core.user_companies
        set role = $3, permissions = $4, screens = $5, updated_at = now()
        where user_id = $1 and company_id = $2`,
      [userId, companyId, nextRole, JSON.stringify(nextPermissions), JSON.stringify(nextScreens)]);
      await insertAuditWithClient(client, companyId, input.actorUserId, "user.access.updated", "user", userId,
        current.rows[0] || null, { ...user.rows[0], role: nextRole, permissions: nextPermissions, screens: nextScreens });
      await client.query("commit");
      return { ...user.rows[0], role: nextRole, permissions: nextPermissions, screens: nextScreens };
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });
}

module.exports = {
  createCompanyUser,
  listCompanyUsers,
  listPermissions,
  listRoles,
  updateCompanyUser,
};
