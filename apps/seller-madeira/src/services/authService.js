"use strict";

const bcrypt = require("bcryptjs");
const { Pool } = require("pg");
const env = require("../config/env");
const { isHubSyncConfigured, syncHubIdentity } = require("../../../../lib/hubIdentitySync");
const HUB_DISABLED_VALUES = new Set([
  "",
  "0",
  "false",
  "null",
  "undefined",
  "off",
  "none",
  "disabled",
  "(not set)",
]);

function normalizeHubConfigValue(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  if (HUB_DISABLED_VALUES.has(value.toLowerCase())) {
    return "";
  }
  return value;
}

let pool;

function getPool() {
  if (!env.databaseUrl) {
    return null;
  }

  if (!pool) {
    pool = new Pool({
      connectionString: env.databaseUrl,
      ssl: {
        rejectUnauthorized: false,
      },
      max: 2,
    });
  }

  return pool;
}

function isHubLoginFallbackEnabled() {
  const mode = String(process.env.HUB_LOGIN_MODE || "fallback").trim().toLowerCase();
  return mode === "fallback" || mode === "mirror";
}

async function verifyHubGlobalLogin({ email, password, module }) {
  if (!isHubLoginFallbackEnabled()) return { allow: false, reason: "hub_login_disabled" };
  const hubBaseUrl = normalizeHubConfigValue(process.env.HUB_BASE_URL).replace(/\/+$/, "");
  const hubToken = normalizeHubConfigValue(process.env.HUB_INTERNAL_TOKEN);
  if (!hubBaseUrl || !hubToken) return { allow: false, reason: "hub_not_configured" };

  try {
    const response = await fetch(`${hubBaseUrl}/v1/internal/auth/verify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${hubToken}`,
      },
      body: JSON.stringify({ email, password, module }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return { allow: false, reason: payload?.reason || payload?.error || `hub_auth_${response.status}` };
    return payload?.allow ? { allow: true, payload } : { allow: false, reason: payload?.reason || "hub_denied" };
  } catch (error) {
    return { allow: false, reason: error?.message || "hub_unreachable" };
  }
}
function makeLocalId(prefix) {
  return prefix + "_" + crypto.randomUUID().replace(/-/g, "");
}

function makeSlug(value, tenantGlobalId) {
  const base = String(value || "davantti").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 42) || "davantti";
  return base + "-" + tenantGlobalId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
}

async function provisionMadeiraUserFromHubLogin(currentPool, { email, hubLogin }) {
  const payload = hubLogin?.payload || {};
  const tenantGlobalId = String(payload?.tenant_id || "").trim();
  const userGlobalId = String(payload?.user_id || "").trim();
  if (!tenantGlobalId || !userGlobalId) return null;
  const companyName = String(payload?.company_name || "Davantti MadeiraMadeira").trim() || "Davantti MadeiraMadeira";
  const userName = String(payload?.name || payload?.full_name || email || "Usuario Madeira").trim();
  const passwordHash = await bcrypt.hash(crypto.randomUUID(), 10);
  const client = await currentPool.connect();
  try {
    await client.query("begin");
    let workspace = (await client.query('select "id", "sellerName", "tenantGlobalId" from "MadWorkspace" where "tenantGlobalId" = $1 limit 1', [tenantGlobalId])).rows[0] || null;
    if (!workspace) {
      workspace = (await client.query('insert into "MadWorkspace" ("id", "slug", "sellerName", "sellerCode", "status", "tenantGlobalId", "createdAt", "updatedAt") values ($1, $2, $3, $4, \'draft\', $5, now(), now()) returning "id", "sellerName", "tenantGlobalId"', [makeLocalId("madws"), makeSlug(companyName, tenantGlobalId), companyName, null, tenantGlobalId])).rows[0] || null;
    }
    let user = (await client.query('select u."id", u."workspaceId", u."name", u."email", u."passwordHash", u."userGlobalId", u."role", u."status", u."isMaster", w."id" as "hubWorkspaceId", w."sellerName" as "hubSellerName", w."tenantGlobalId" as "hubTenantGlobalId" from "MadUser" u left join "MadWorkspace" w on w."id" = u."workspaceId" where lower(u."email") = $1 limit 1', [email])).rows[0] || null;
    if (!user) {
      user = (await client.query('insert into "MadUser" ("id", "workspaceId", "name", "email", "passwordHash", "role", "status", "isMaster", "userGlobalId", "createdAt", "updatedAt") values ($1, $2, $3, $4, $5, \'viewer\', \'active\', false, $6, now(), now()) returning "id", "workspaceId", "name", "email", "passwordHash", "userGlobalId", "role", "status", "isMaster"', [makeLocalId("madusr"), workspace?.id || null, userName, email, passwordHash, userGlobalId])).rows[0] || null;
    } else {
      await client.query('update "MadUser" set "userGlobalId" = coalesce("userGlobalId", $2), "workspaceId" = coalesce("workspaceId", $3), "updatedAt" = now() where "id" = $1', [user.id, userGlobalId, workspace?.id || null]);
    }
    await client.query("commit");
    return user ? { ...user, hubWorkspaceId: workspace?.id || user.hubWorkspaceId || null, hubSellerName: workspace?.sellerName || user.hubSellerName || companyName, hubTenantGlobalId: workspace?.tenantGlobalId || user.hubTenantGlobalId || tenantGlobalId } : null;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function isHubConfigured() {
  return isHubSyncConfigured();
}

async function checkHubModuleAccess(identity) {
  if (!isHubConfigured()) {
    return { allow: true, reason: "hub_not_configured" };
  }

  const syncResult = await syncHubIdentity(identity).catch(() => null);

  const tenantGlobalId = String(
    syncResult?.payload?.tenant_id || identity?.tenantGlobalId || identity?.tenant_id || "",
  ).trim();
  const userGlobalId = String(
    syncResult?.payload?.user_id || identity?.userGlobalId || identity?.user_id || "",
  ).trim();

  if (!tenantGlobalId || !userGlobalId) {
    return { allow: false, reason: "billing_identity_missing" };
  }

  try {
    const hubBaseUrl = normalizeHubConfigValue(process.env.HUB_BASE_URL).replace(/\/+$/, "");
    const hubToken = normalizeHubConfigValue(process.env.HUB_INTERNAL_TOKEN);

    const response = await fetch(
      `${hubBaseUrl}/v1/access/check`,
      {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${hubToken}`,
      },
      body: JSON.stringify({
        tenant_id: tenantGlobalId,
        user_id: userGlobalId,
        module: "madeira",
        action: "LOGIN",
      }),
      },
    );

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return { allow: true, reason: "hub_auth_invalid_bypass" };
      }
      return { allow: false, reason: "hub_access_check_failed" };
    }

    if (!payload?.allow) {
      return {
        allow: false,
        reason: "subscription_inactive_or_module_not_allowed",
        status: payload?.status || null,
      };
    }

    return { allow: true, payload };
  } catch (error) {
    return { allow: false, reason: error?.message || "hub_access_check_failed" };
  }
}

async function authenticateUser(credentials) {
  const email = String(credentials?.email || "")
    .trim()
    .toLowerCase();
  const password = String(credentials?.password || "");

  if (!email || !password) {
    return {
      ok: false,
      status: 400,
      error: "Informe e-mail e senha.",
    };
  }

  if (!env.databaseUrl) {
    return {
      ok: false,
      status: 503,
      error: "Banco do modulo nao configurado.",
    };
  }

  const currentPool = getPool();
  const result = await currentPool.query(
    `
      select
        u."id",
        u."workspaceId",
        u."name",
        u."email",
        u."passwordHash",
        u."userGlobalId",
        u."role",
        u."status",
        u."isMaster",
        w."id" as "hubWorkspaceId",
        w."sellerName" as "hubSellerName",
        w."tenantGlobalId" as "hubTenantGlobalId",
        w."documentType" as "hubDocumentType",
        w."documentNumber" as "hubDocumentNumber"
      from "MadUser" u
      left join "MadWorkspace" w
        on w."id" = u."workspaceId"
      where lower(u."email") = $1
      limit 1
    `,
    [email],
  );

  let user = result.rows[0];
  let hubLogin = null;

  if (!user) {
    hubLogin = await verifyHubGlobalLogin({ email, password, module: "madeira" });
    if (hubLogin.allow) {
      user = await provisionMadeiraUserFromHubLogin(currentPool, { email, hubLogin });
    }
  }

  if (!user) {
    return {
      ok: false,
      status: 401,
      error: "Credenciais invalidas.",
      reason: hubLogin?.reason || "user_not_found",
    };
  }

  if (user.status !== "active") {
    return {
      ok: false,
      status: 403,
      error:
        user.status === "invited"
          ? "Sua conta ainda nao foi ativada. Use o link de convite enviado por email."
          : "Usuario sem acesso ativo.",
    };
  }

  let passwordMatches = Boolean(hubLogin?.allow) || await bcrypt.compare(password, user.passwordHash);
  if (!passwordMatches) {
    hubLogin = await verifyHubGlobalLogin({ email, password, module: "madeira" });
    passwordMatches = Boolean(hubLogin.allow);
  }

  if (!passwordMatches) {
    return {
      ok: false,
      status: 401,
      error: "Credenciais invalidas.",
      reason: hubLogin?.reason || "bad_password",
    };
  }

  await currentPool.query(
    `
      update "MadUser"
      set
        "lastLoginAt" = now(),
        "updatedAt" = now()
      where "id" = $1
    `,
    [user.id],
  );

  const workspaceResult = await currentPool.query(
    `
      select
        "sellerName",
        "tenantGlobalId"
      from "MadWorkspace"
      where "id" = $1
      limit 1
    `,
    [user.workspaceId],
  );

  const tenantGlobalId = String(
    workspaceResult.rows?.[0]?.tenantGlobalId || "",
  ).trim() || null;
  const companyName = String(
    workspaceResult.rows?.[0]?.sellerName || "",
  ).trim() || "Davantti MadeiraMadeira";
  const userGlobalId = String(user.userGlobalId || "").trim() || null;

  const billing = await checkHubModuleAccess({
    tenantGlobalId,
    userGlobalId,
    tenant_id: tenantGlobalId,
    company_name: companyName,
    user_id: userGlobalId,
    full_name: String(user.name || user.email || "Usuario Madeira").trim(),
    email: String(user.email || "").trim().toLowerCase(),
    role: Boolean(user.isMaster) ? "owner" : "operator",
  });
  if (!billing.allow) {
    return {
      ok: false,
      status: 402,
      error: "Assinatura inativa para este modulo.",
      reason: billing.reason || null,
    };
  }

  return {
    ok: true,
    user: {
      id: user.id,
      workspaceId: user.workspaceId,
      name: user.name,
      email: user.email,
      userGlobalId,
      tenantGlobalId,
      role: user.role,
      status: user.status,
      isMaster: Boolean(user.isMaster),
    },
    hubIdentity: {
      workspace: user.hubWorkspaceId
        ? {
            id: user.hubWorkspaceId,
            name: user.hubSellerName || null,
            sellerName: user.hubSellerName || null,
            tenantGlobalId: user.hubTenantGlobalId || null,
            documentType: user.hubDocumentType || null,
            documentNumber: user.hubDocumentNumber || null,
          }
        : null,
    },
  };
}

module.exports = {
  authenticateUser,
};
