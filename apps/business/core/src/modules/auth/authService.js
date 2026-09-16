"use strict";

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { isDatabaseEnabled, query, withClient, withRlsBypass, withTenantContext } = require("../../../db/db");
const runtimeAccess = require("../core/runtimeAccess");
const { buildConfiguration } = require("../core/templateEngine");
const { getTemplateBySegment } = require("../core/templates");

const MODULE_KEY = "volt_core";
const AUTH_TTL_MS = 24 * 60 * 60 * 1000;
const HUB_DISABLED_VALUES = new Set(["", "0", "false", "null", "undefined", "off", "none", "disabled", "(not set)"]);
const isProd = String(process.env.NODE_ENV || "").toLowerCase() === "production";

function jwtSecret() {
  const secret = process.env.VOLT_CORE_JWT_SECRET || process.env.JWT_SECRET;
  if (secret) return secret;
  if (isProd) {
    throw new Error("VOLT_CORE_JWT_SECRET ou JWT_SECRET nao definido.");
  }
  return "volt-core-dev-secret";
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: isProd,
    maxAge: AUTH_TTL_MS,
    path: "/",
  };
}

function clearCookieOptions() {
  return { path: "/" };
}

function createId(prefix) {
  return `${prefix}_${crypto.randomBytes(10).toString("hex")}`;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeRole(value) {
  const role = String(value || "operator").trim().toLowerCase();
  if (["admin_master", "master"].includes(role)) return "admin_master";
  if (["owner", "admin", "administrador"].includes(role)) return "admin";
  return "operator";
}

function normalizeModuleKey(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function moduleKeysFromPayload(payload = {}) {
  const collections = [payload.modules, payload.allowed_modules, payload.visible_modules];
  return collections
    .filter(Array.isArray)
    .flatMap((items) => items)
    .map((item) => normalizeModuleKey(
      typeof item === "object" && item !== null
        ? item.id || item.key || item.module || item.slug
        : item,
    ))
    .filter(Boolean);
}

function hasVoltCoreHubAccess(payload = {}) {
  if (payload.allow !== true) return false;
  const moduleKeys = moduleKeysFromPayload(payload);
  // The verify endpoint is scoped by module. Lists are optional, but when the
  // Hub sends one it must agree with the module-specific authorization.
  return moduleKeys.length === 0 || moduleKeys.includes(MODULE_KEY);
}

function companyRoleForLazyProvision(existingRole, membershipCount) {
  if (String(existingRole || "").trim()) return String(existingRole).trim().toLowerCase();
  return Number(membershipCount || 0) === 0 ? "admin" : "operator";
}

function isMaster(user) {
  return normalizeRole(user?.role || user?.nivel) === "admin_master" || user?.is_master === true;
}

function normalizeHubConfigValue(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  return HUB_DISABLED_VALUES.has(value.toLowerCase()) ? "" : value;
}

function hubBaseUrl() {
  return normalizeHubConfigValue(process.env.HUB_BASE_URL).replace(/\/+$/, "");
}

function hubToken() {
  return normalizeHubConfigValue(process.env.HUB_INTERNAL_TOKEN);
}

function hubLoginMode() {
  return String(process.env.HUB_LOGIN_MODE || "fallback").trim().toLowerCase();
}

function isHubLoginEnabled() {
  const mode = hubLoginMode();
  return mode === "fallback" || mode === "mirror" || mode === "strict";
}

async function postHubJson(path, payload) {
  const baseUrl = hubBaseUrl();
  const token = hubToken();
  if (!baseUrl || !token || typeof fetch !== "function") {
    return { ok: false, status: 0, data: {}, reason: "hub_not_configured" };
  }

  const timeoutMs = Math.max(1_000, Number(process.env.HUB_REQUEST_TIMEOUT_MS || 8_000));
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  return {
    ok: response.ok,
    status: response.status,
    data,
    reason: data?.reason || data?.error || `hub_${response.status}`,
  };
}

async function verifyHubGlobalLogin(email, password) {
  if (!isHubLoginEnabled()) return { allow: false, reason: "hub_login_disabled" };
  try {
    const result = await postHubJson("/v1/internal/auth/verify", { email, password, module: MODULE_KEY });
    if (!result.ok) return { allow: false, reason: result.reason, status: result.status };
    if (!hasVoltCoreHubAccess(result.data)) {
      return {
        allow: false,
        reason: result.data?.allow ? "volt_core_module_not_allowed" : result.reason || "hub_denied",
        status: result.status,
      };
    }
    return { allow: true, payload: result.data, reason: result.data?.reason || "hub_module_allowed" };
  } catch (error) {
    return { allow: false, reason: error?.message || "hub_unreachable" };
  }
}

async function ensureMasterUser() {
  if (!isDatabaseEnabled()) return { ok: true, skipped: true, reason: "db_disabled" };
  const enabled = ["1", "true"].includes(String(process.env.VOLT_CORE_BOOTSTRAP_MASTER_ENABLED || "").toLowerCase());
  if (!enabled) return { ok: true, skipped: true };

  const email = normalizeEmail(process.env.VOLT_CORE_BOOTSTRAP_MASTER_EMAIL);
  const name = String(process.env.VOLT_CORE_BOOTSTRAP_MASTER_NAME || process.env.VOLT_CORE_BOOTSTRAP_MASTER_NOME || "Admin Master").trim();
  const password = process.env.VOLT_CORE_BOOTSTRAP_MASTER_PASSWORD;
  let passwordHash = process.env.VOLT_CORE_BOOTSTRAP_MASTER_PASSWORD_HASH;
  if (!email) throw new Error("VOLT_CORE_BOOTSTRAP_MASTER_EMAIL nao definido.");
  if (!passwordHash) {
    if (!password) throw new Error("Defina VOLT_CORE_BOOTSTRAP_MASTER_PASSWORD ou VOLT_CORE_BOOTSTRAP_MASTER_PASSWORD_HASH.");
    passwordHash = await bcrypt.hash(password, 12);
  }

  const result = await query(
    `insert into volt_core.users (id, name, email, password_hash, role, status, user_global_id)
     values ($1, $2, $3, $4, 'admin_master', 'active', $5)
     on conflict (email) do nothing
     returning id, name, email, role, status, user_global_id`,
    [createId("usr"), name, email, passwordHash, `volt_core_master_${email}`],
  );

  if (result.rows[0]) return { ok: true, created: true, user: result.rows[0] };

  const existing = await query(
    `select id, name, email, role, status, user_global_id
       from volt_core.users
      where email = $1
      limit 1`,
    [email],
  );
  return { ok: true, created: false, skipped: true, reason: "already_exists", user: existing.rows[0] || null };
}

async function findUserByEmail(email) {
  const result = await query(
    `select id, name, email, password_hash, role, status, user_global_id
       from volt_core.users
      where email = $1
      limit 1`,
    [email],
  );
  return result.rows[0] || null;
}

async function listCompaniesForUser(user) {
  return withRlsBypass(async () => {
    if (isMaster(user)) {
      const result = await query(
        `select id, name, tenant_global_id, document, document_type, document_number, status
           from volt_core.companies
          order by created_at asc
          limit 50`,
      );
      return result.rows;
    }
    const result = await query(
      `select c.id, c.name, c.tenant_global_id, c.document, c.document_type, c.document_number, c.status,
              uc.role as access_role, uc.permissions, uc.screens
         from volt_core.user_companies uc
         join volt_core.companies c on c.id = uc.company_id
        where uc.user_id = $1
        order by uc.created_at asc`,
      [user.id],
    );
    return result.rows;
  });
}

async function getMasterOverview() {
  if (!isDatabaseEnabled()) {
    return {
      companies: [],
      users: [],
      totals: { companies: 0, users: 0, activeCompanies: 0, activeUsers: 0 },
      auditEvents: [],
      segmentDistribution: [],
      companyActivity: [],
      system: { database: "unavailable", migrations: 0, latestMigration: null, pendingJobs: 0 },
    };
  }

  return withRlsBypass(async () => {
    const [companiesResult, usersResult, auditResult, segmentsResult, activityResult, systemResult] = await Promise.all([
    query(
      `select
         c.id,
         c.name,
         c.segment_key as "segmentKey",
         c.plan_key as "planKey",
         c.status,
         coalesce(jsonb_array_length(cfg.modules), 0) as "moduleCount",
         coalesce(cfg.screens, '[]'::jsonb) as screens,
         cfg.settings->'onboarding'->>'requestedSector' as "requestedSector",
         count(uc.user_id)::int as "userCount"
       from volt_core.companies c
       left join volt_core.company_configurations cfg on cfg.company_id = c.id
       left join volt_core.user_companies uc on uc.company_id = c.id
       group by c.id, cfg.modules, cfg.screens, cfg.settings
       order by c.created_at asc`,
    ),
    query(
      `select
         u.id,
         u.name,
         u.email,
         u.role,
         u.status,
         u.last_login_at as "lastLoginAt",
         c.id as "companyId",
         c.name as "companyName",
         uc.role as "companyRole",
         uc.permissions,
         uc.screens
       from volt_core.users u
       left join volt_core.user_companies uc on uc.user_id = u.id
       left join volt_core.companies c on c.id = uc.company_id
       order by u.created_at asc, c.created_at asc`,
    ),
    query(
      `select
         al.id,
         al.action,
         al.entity_type as "entityType",
         al.entity_id as "entityId",
         al.metadata,
         al.created_at as "createdAt",
         c.id as "companyId",
         c.name as "companyName",
         u.name as "actorName",
         u.email as "actorEmail"
       from volt_core.audit_logs al
       join volt_core.companies c on c.id = al.company_id
       left join volt_core.users u on u.id = al.actor_user_id
       order by al.created_at desc
       limit 200`,
    ),
    query(
      `select segment_key as segment, count(*)::int as companies
         from volt_core.companies
        group by segment_key
        order by companies desc, segment_key asc`,
    ),
    query(
      `select
         c.id,
         c.name,
         c.status,
         count(al.id)::int as "events30d",
         max(al.created_at) as "lastActivityAt"
       from volt_core.companies c
       left join volt_core.audit_logs al
         on al.company_id = c.id
        and al.created_at >= now() - interval '30 days'
       group by c.id
       order by "events30d" desc, c.name asc
       limit 20`,
    ),
    query(
      `select
         (select count(*)::int from volt_core.migrations) as migrations,
         (select filename from volt_core.migrations order by applied_at desc limit 1) as "latestMigration",
         ((select count(*)::int from volt_core.data_exchange_jobs where status in ('queued', 'processing'))
          + (select count(*)::int from volt_core.integration_jobs where status in ('queued','retrying','processing'))
          + (select count(*)::int from volt_core.integration_outbox_events where status in ('pending','retrying','processing'))) as "pendingJobs"`,
    ),
  ]);

  const companies = companiesResult.rows.map((company) => ({
    id: company.id,
    name: company.name,
    segment: company.segmentKey || "Core",
    plan: company.planKey || "Core",
    modules: String(company.moduleCount || 0),
    screens: company.screens || [],
    requestedSector: company.requestedSector || null,
    users: Number(company.userCount || 0),
    status: company.status === "active" ? "Ativo" : company.status || "Pendente",
  }));
  const users = usersResult.rows.map((user) => ({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    companyId: user.companyId,
    companyName: user.companyName || (isMaster(user) ? "Todas" : "-"),
    companyRole: user.companyRole || user.role,
    permissions: user.permissions || [],
    screens: user.screens || [],
    lastAccess: user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString("pt-BR") : "Nunca",
    status: user.status === "active" ? "Ativo" : user.status || "Pendente",
  }));
  const uniqueUsers = new Map();
  users.forEach((user) => {
    if (!uniqueUsers.has(user.id)) uniqueUsers.set(user.id, user);
  });

  return {
    companies,
    users,
    auditEvents: auditResult.rows.map((event) => ({
      ...event,
      actor: event.actorName || event.actorEmail || "Sistema",
      status: /cancel|error|fail/i.test(event.action) ? "warn" : "success",
    })),
    segmentDistribution: segmentsResult.rows,
    companyActivity: activityResult.rows,
    system: {
      database: "connected",
      migrations: Number(systemResult.rows[0]?.migrations || 0),
      latestMigration: systemResult.rows[0]?.latestMigration || null,
      pendingJobs: Number(systemResult.rows[0]?.pendingJobs || 0),
    },
    totals: {
      companies: companies.length,
      users: uniqueUsers.size,
      activeCompanies: companies.filter((company) => company.status === "Ativo").length,
      activeUsers: [...uniqueUsers.values()].filter((user) => user.status === "Ativo").length,
    },
  };
  });
}

async function provisionFromHub(email, hubLogin) {
  const payload = hubLogin?.payload || {};
  const tenantGlobalId = String(payload?.tenant_id || "").trim();
  const userGlobalId = String(payload?.user_id || "").trim();
  if (!hasVoltCoreHubAccess(payload) || !tenantGlobalId || !userGlobalId) return null;

  const hubCompanyName = String(payload?.company_name || payload?.trade_name || "").trim();
  const documentNumber = String(payload?.document_number || payload?.cnpj || payload?.cpf || payload?.document || "").trim() || null;
  const documentType = String(payload?.document_type || (payload?.cnpj ? "cnpj" : payload?.cpf ? "cpf" : "")).trim().toLowerCase() || null;
  const companyPhone = String(payload?.company_phone || payload?.phone || "").trim() || null;
  const companyAddress = typeof payload?.company_address === "string"
    ? payload.company_address.trim() || null
    : typeof payload?.address === "string"
      ? payload.address.trim() || null
      : null;
  const missingProfileFields = [];
  if (!hubCompanyName) missingProfileFields.push("name");
  if (!documentNumber) missingProfileFields.push("document");
  const companyProfile = {
    source: "hub_login",
    status: missingProfileFields.length ? "incomplete" : "complete",
    missingFields: missingProfileFields,
    syncedAt: new Date().toISOString(),
  };

  return withTenantContext(tenantGlobalId, () => withClient(async (client) => {
    await client.query("begin");
    try {
      const companyId = tenantGlobalId;
      await client.query(
        `insert into volt_core.companies (
           id, name, tenant_global_id, segment_key, status, document, document_type,
           document_number, phone, address
         )
         values ($1, $2, $3, 'general', 'active', $4, $5, $4, $6, $7)
         on conflict (id) do update
         set name = case when $8 then excluded.name else volt_core.companies.name end,
             tenant_global_id = excluded.tenant_global_id,
             document = coalesce(excluded.document, volt_core.companies.document),
             document_type = coalesce(excluded.document_type, volt_core.companies.document_type),
             document_number = coalesce(excluded.document_number, volt_core.companies.document_number),
             phone = coalesce(excluded.phone, volt_core.companies.phone),
             address = coalesce(excluded.address, volt_core.companies.address),
             updated_at = now()`,
        [
          companyId,
          hubCompanyName || "Empresa a completar",
          tenantGlobalId,
          documentNumber,
          documentType,
          companyPhone,
          companyAddress,
          Boolean(hubCompanyName),
        ],
      );
      const initialConfiguration = buildConfiguration({
        companyId,
        planKey: "starter",
        requestedBy: userGlobalId,
        template: getTemplateBySegment("general"),
      });
      initialConfiguration.settings.onboarding = {
        sectorConfirmed: false,
        sectorSource: "hub_first_access",
        status: "pending",
      };
      initialConfiguration.settings.companyProfile = companyProfile;
      await client.query(`
        insert into volt_core.company_configurations (
          company_id, segment_key, plan_key, modules, screens, settings, overrides, updated_by
        ) values ($1, 'general', 'starter', $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, $6)
        on conflict (company_id) do nothing`, [
        companyId,
        JSON.stringify(initialConfiguration.modules),
        JSON.stringify(initialConfiguration.screens),
        JSON.stringify(initialConfiguration.settings),
        JSON.stringify(initialConfiguration.overrides),
        userGlobalId,
      ]);
      await client.query(`
        update volt_core.company_configurations
           set settings = jsonb_set(
                 coalesce(settings, '{}'::jsonb),
                 '{companyProfile}',
                 coalesce(settings->'companyProfile', '{}'::jsonb) || $2::jsonb,
                 true
               ),
               updated_at = now()
         where company_id = $1`,
      [companyId, JSON.stringify({
        source: "hub_login",
        hubMissingFields: missingProfileFields,
        syncedAt: companyProfile.syncedAt,
        ...(missingProfileFields.length === 0 ? { status: "complete", missingFields: [] } : {}),
      })]);

      await client.query("select pg_advisory_xact_lock(hashtext($1))", [`volt_core:first_admin:${companyId}`]);
      const userId = createId("usr");
      const passwordHash = await bcrypt.hash(crypto.randomBytes(24).toString("base64url"), 10);
      const userResult = await client.query(
        `insert into volt_core.users (id, name, email, password_hash, role, status, user_global_id)
         values ($1, $2, $3, $4, 'operator', 'active', $5)
         on conflict (email) do update
         set name = excluded.name,
             user_global_id = excluded.user_global_id,
             updated_at = now()
         returning id, name, email, password_hash, role, status, user_global_id`,
        [userId, payload?.name || payload?.full_name || email, email, passwordHash, userGlobalId],
      );
      const user = userResult.rows[0];
      const existingMembership = await client.query(
        "select role, permissions, screens from volt_core.user_companies where user_id = $1 and company_id = $2",
        [user.id, companyId],
      );
      let companyRole = existingMembership.rows[0]?.role || null;
      if (!companyRole) {
        const membershipCount = await client.query(
          "select count(*)::int as count from volt_core.user_companies where company_id = $1",
          [companyId],
        );
        companyRole = companyRoleForLazyProvision(null, membershipCount.rows[0]?.count);
      }
      await client.query(
        `insert into volt_core.user_companies (user_id, company_id, role, permissions, screens)
         values ($1, $2, $3, $4, $5)
         on conflict (user_id, company_id) do nothing`,
        [
          user.id,
          companyId,
          companyRole,
          JSON.stringify(runtimeAccess.permissionsForRole(companyRole)),
          JSON.stringify(runtimeAccess.screensForRole(companyRole)),
        ],
      );
      if (companyRole === "admin") {
        await client.query(
          `update volt_core.users
              set role = case when role = 'admin_master' then role else 'admin' end,
                  updated_at = now()
            where id = $1`,
          [user.id],
        );
        user.role = user.role === "admin_master" ? user.role : "admin";
      }
      await client.query("commit");
      return user;
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  }));
}

function signSession(user, companies, selectedCompanyId, hubAccess) {
  return jwt.sign({
    uid: user.id,
    email: user.email,
    nome: user.name,
    name: user.name,
    role: user.role,
    nivel: user.role,
    is_master: isMaster(user),
    companies: companies.map((company) => ({
      id: company.id,
      name: company.name,
      role: company.access_role || user.role,
      permissions: runtimeAccess.permissionsForRole(company.access_role || user.role, company.permissions),
      screens: runtimeAccess.screensForRole(company.access_role || user.role, company.screens),
    })),
    selectedCompanyId,
    hub_access: {
      module: MODULE_KEY,
      checked_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + AUTH_TTL_MS).toISOString(),
      reason: hubAccess?.reason || "ok",
    },
  }, jwtSecret(), { expiresIn: "24h" });
}

async function login(input = {}) {
  const email = normalizeEmail(input.email || input.username || input.usuario);
  const password = String(input.password || input.senha || "");
  if (!email || !password) {
    const error = new Error("Informe email e senha.");
    error.status = 400;
    throw error;
  }

  if (!isDatabaseEnabled()) {
    const error = new Error("Banco de autenticacao nao configurado.");
    error.status = 503;
    throw error;
  }

  let user = await findUserByEmail(email);
  let hubLogin = null;

  if (isMaster(user)) {
    const validMasterPassword = await bcrypt.compare(password, user.password_hash || "");
    if (!validMasterPassword) {
      const error = new Error("Credenciais invalidas.");
      error.status = 401;
      throw error;
    }
  } else if (isHubLoginEnabled()) {
    hubLogin = await verifyHubGlobalLogin(email, password);
    if (!hubLogin.allow) {
      const unavailable = !hubLogin.status || Number(hubLogin.status) >= 500;
      const moduleDenied = [
        "subscription_inactive_or_module_not_allowed",
        "volt_core_module_not_allowed",
      ].includes(String(hubLogin.reason || "").toLowerCase());
      const error = new Error(
        unavailable
          ? "Hub indisponivel para validar o acesso ao Volt Core."
          : moduleDenied
            ? "Seu usuario nao possui acesso ao Volt Core."
            : "Credenciais invalidas.",
      );
      error.status = unavailable ? 503 : moduleDenied ? 403 : 401;
      error.reason = hubLogin.reason || "hub_denied";
      throw error;
    }

    user = await provisionFromHub(email, hubLogin);
    if (!user) {
      const error = new Error("O Hub autorizou o acesso, mas nao enviou a identidade completa da empresa e do usuario.");
      error.status = 503;
      error.reason = "hub_identity_incomplete";
      throw error;
    }
  } else {
    const validLocalPassword = user && await bcrypt.compare(password, user.password_hash || "");
    if (!validLocalPassword) {
      const error = new Error("Credenciais invalidas.");
      error.status = 401;
      throw error;
    }
  }

  if (!user) {
    const error = new Error("Credenciais invalidas.");
    error.status = 401;
    throw error;
  }

  if (String(user.status || "").toLowerCase() !== "active") {
    const error = new Error("Usuario inativo no Volt Core.");
    error.status = 403;
    throw error;
  }

  const companies = await listCompaniesForUser(user);
  const hubTenantId = String(hubLogin?.payload?.tenant_id || "").trim();
  const selectedCompany = companies.find((company) => (
    String(company.tenant_global_id || company.id || "").trim() === hubTenantId
  )) || companies[0] || null;
  const hubAccess = {
    allow: true,
    reason: isMaster(user)
      ? "master_local_access"
      : hubLogin?.allow
        ? "hub_module_allowed"
        : "local_login_mode",
  };

  await query("update volt_core.users set last_login_at = now() where id = $1", [user.id]);
  const selectedCompanyId = selectedCompany?.id || null;
  const token = signSession(user, companies, selectedCompanyId, hubAccess);

  return {
    user: publicUser(user),
    companies,
    selectedCompanyId,
    token,
  };
}

function verifyToken(token) {
  return jwt.verify(token, jwtSecret());
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    fullName: user.name,
    email: user.email,
    role: user.role,
    nivel: user.role,
    isMaster: isMaster(user),
  };
}

module.exports = {
  AUTH_TTL_MS,
  clearCookieOptions,
  cookieOptions,
  ensureMasterUser,
  getMasterOverview,
  isMaster,
  login,
  publicUser,
  verifyToken,
  __test: {
    companyRoleForLazyProvision,
    hasVoltCoreHubAccess,
    moduleKeysFromPayload,
  },
};
