"use strict";

const bcrypt = require("bcrypt");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const { requireAuth } = require("../middlewares/sessionAuth");
const { revokeHubModuleAccess, syncHubIdentity } = require("../../../../lib/hubIdentitySync");
const {
  activationExpiryDate,
  buildActivationLink,
  createActivationToken,
  createTemporaryPassword,
  hashToken,
} = require("./authLocal.routes");
const { sendInviteEmail } = require("../services/inviteEmailService");
const {
  countAdminsByAccountId,
  createInvitedUser,
  deleteSessionsByUserId,
  deleteUserById,
  findUserByEmail,
  listAccountsWithUsersAndShops,
  updateUserInvite,
  updateUserProfile,
  updateUserRole,
} = require("../repositories/authSqlRepository");
const {
  cleanupOAuthStates,
  deleteOAuthState,
  listOAuthStates,
} = require("../repositories/oauthStateSqlRepository");
const {
  getProcessExecutionLogById,
  listProcessExecutionLogs,
  resolveProcessDisplayName,
} = require("../repositories/processExecutionSqlRepository");
const { query, queryOne, withClient } = require("../config/postgres");

const router = express.Router();
router.use(requireAuth);
const { isMasterAdminAuth } = require("../config/masterAdmin");

const MIGRATION_HISTORY_TABLE = "_davantti_sql_migrations";
const SHOPEE_MIGRATIONS_DIR = path.join(
  __dirname,
  "..",
  "..",
  "db",
  "migrations",
);
const AUDIT_RETENTION_DEFAULT_EVENT = "*DEFAULT*";

function isMasterAdmin(auth) {
  return isMasterAdminAuth(auth);
}

function requireMasterAdmin(req, res, next) {
  if (!isMasterAdmin(req.auth)) {
    return res.status(403).json({
      error: "forbidden",
      message: "Acesso restrito ao admin master.",
    });
  }
  return next();
}

async function sendInviteEmailSafe({ email, name, link, expiresAt }) {
  try {
    return await sendInviteEmail({
      toEmail: email,
      toName: name,
      activationLink: link,
      expiresAt,
    });
  } catch (error) {
    return {
      sent: false,
      skipped: false,
      error: error?.message || "Falha no envio do convite por email.",
    };
  }
}

function toSafeInt(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.trunc(parsed);
}

function normalizeSearch(value) {
  return String(value || "").trim().toLowerCase();
}

function mapAuthAuditEventArea(eventName) {
  const event = String(eventName || "").trim().toLowerCase();
  if (event === "tab_accessed") return "Abas acessadas";
  if (!event) return "Outros";
  if (event.startsWith("login_")) return "Autenticacao";
  if (event.startsWith("password_reset_")) return "Recuperacao de senha";
  if (event.startsWith("invite_")) return "Convites";
  return "Outros";
}

function humanizeTabId(tabId) {
  const normalized = String(tabId || "").trim();
  const labelByTab = {
    "control-panel": "Painel de controle",
    dashboard: "Dashboard",
    "stock-alert": "Risco de ruptura",
    "price-increase": "Aumento de preço",
    "shopee-notices": "Avisos Shopee",
    "latest-updates": "Últimas atualizações",
    ads: "Ads",
    boost: "Impulsionamento",
    metrics: "Métricas",
    seo: "SEO",
    margin: "Margem",
    products: "Produtos",
    "listing-status": "Status de anúncios",
    "listing-clone": "Clone de anúncios",
    "curve-abc": "Curva ABC",
    relaunch: "Relançamento",
    launches: "Lançamentos",
    "sales-control": "Controle de vendas",
    "sales-share": "Participação nas vendas",
    promotions: "Central de promoções",
    "flash-sale": "Flash Sale",
    logistics: "Central logística",
    "catalog-quality": "Qualidade de catálogo",
    orders: "Pedidos",
    "deadline-control": "Controle de prazo",
    "bulk-specs": "Preenchimento massivo",
    "intelligent-pricing": "Precificação inteligente",
    admin: "Admin",
  };
  if (labelByTab[normalized]) return labelByTab[normalized];
  return normalized
    .replace(/^tab-/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase()) || "Aba não identificada";
}

function maskToken(value) {
  const token = String(value || "");
  if (!token) return null;
  if (token.length <= 10) return `${token.slice(0, 2)}***${token.slice(-2)}`;
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

function escapeCsvValue(value) {
  const text = String(value == null ? "" : value);
  if (!text.includes(",") && !text.includes('"') && !text.includes("\n")) {
    return text;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

function buildProcessLogsCsv(logs = []) {
  const header = [
    "id",
    "displayName",
    "requestedAt",
    "finishedAt",
    "durationMs",
    "status",
    "statusCode",
    "method",
    "path",
    "userEmail",
    "userRole",
    "accountId",
    "ip",
    "errorCode",
    "errorMessage",
    "queryString",
  ];

  const lines = [header.join(",")];
  for (const row of Array.isArray(logs) ? logs : []) {
    const status = row?.success ? "SUCCESS" : "ERROR";
    const values = [
      row?.id,
      row?.displayName || resolveProcessDisplayName(row),
      row?.requestedAt,
      row?.finishedAt,
      row?.durationMs,
      status,
      row?.statusCode,
      row?.method,
      row?.path,
      row?.userEmail,
      row?.userRole,
      row?.accountId,
      row?.ip,
      row?.errorCode,
      row?.errorMessage,
      row?.queryString,
    ];
    lines.push(values.map(escapeCsvValue).join(","));
  }

  return lines.join("\n");
}

function buildMasterProcessLogText(entry = {}) {
  const responseBody = entry?.responseBody || null;
  const requestBody = entry?.requestBody || null;
  const lines = [];
  lines.push(`Processo #${entry?.id || "-"}`);
  lines.push(`Nome: ${entry?.displayName || resolveProcessDisplayName(entry)}`);
  lines.push(`Status: ${entry?.success ? "SUCCESS" : "ERROR"}`);
  lines.push(`Método: ${entry?.method || "-"}`);
  lines.push(`Rota: ${entry?.path || "-"}`);
  lines.push(`Solicitado em: ${entry?.requestedAt || "-"}`);
  lines.push(`Finalizado em: ${entry?.finishedAt || "-"}`);
  lines.push(`Duração (ms): ${entry?.durationMs ?? "-"}`);
  lines.push(`HTTP: ${entry?.statusCode ?? "-"}`);
  lines.push(`Usuário: ${entry?.userEmail || "-"}`);
  lines.push(`Conta: ${entry?.accountId ?? "-"}`);
  if (entry?.errorCode || entry?.errorMessage) {
    lines.push("");
    lines.push(`Erro: ${entry?.errorCode || "-"}`);
    lines.push(String(entry?.errorMessage || "-"));
  }
  if (requestBody) {
    lines.push("");
    lines.push("RequestBody:");
    lines.push(JSON.stringify(requestBody, null, 2));
  }
  if (responseBody) {
    lines.push("");
    lines.push("ResponseBody:");
    lines.push(JSON.stringify(responseBody, null, 2));
  }
  return lines.join("\n");
}

function mapUserRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    name: row.name || null,
    email: row.email || null,
    role: row.role || null,
    status: row.status || null,
    accountId: row.account_id == null ? null : Number(row.account_id),
    accountName: row.account_name || null,
    tenantGlobalId: row.tenant_global_id || null,
    userGlobalId: row.user_global_id || null,
    activationExpiresAt: row.activation_expires_at || null,
    createdAt: row.created_at || null,
    lastLoginAt: row.last_login_at || null,
  };
}

async function findUserByIdGlobal(userId) {
  const row = await queryOne(
    `
      SELECT
        u.id,
        u.name,
        u.email,
        u.role,
        u.status,
        u."accountId" AS account_id,
        a.name AS account_name,
        a."tenantGlobalId" AS tenant_global_id,
        u."userGlobalId" AS user_global_id,
        u."activationExpiresAt" AS activation_expires_at,
        u."createdAt" AS created_at,
        (
          SELECT MAX(s."createdAt")
          FROM "Session" s
          WHERE s."userId"::text = u.id::text
        ) AS last_login_at
      FROM "User" u
      LEFT JOIN "Account" a ON a.id = u."accountId"
      WHERE u.id::text = $1::text
      LIMIT 1
    `,
    [userId],
  );

  return mapUserRow(row);
}

async function findAccountByIdGlobal(accountId) {
  const row = await queryOne(
    `
      SELECT
        id,
        name,
        "tenantGlobalId" AS tenant_global_id,
        "documentType" AS document_type,
        "documentNumber" AS document_number
      FROM "Account"
      WHERE id = $1
      LIMIT 1
    `,
    [Number(accountId)],
  );
  return row
    ? {
        id: Number(row.id),
        name: row.name || null,
        tenantGlobalId: row.tenant_global_id || null,
        documentType: row.document_type || null,
        documentNumber: row.document_number || null,
      }
    : null;
}

async function syncMasterShopeeUserToHub(account, user, explicit = false) {
  if (!account?.tenantGlobalId || !user?.userGlobalId || !user?.email) {
    return { ok: false, skipped: true, reason: "identity_not_ready" };
  }
  return syncHubIdentity({
    tenant_id: account.tenantGlobalId,
    company_name: account.name || "Davantti Shopee",
    document_type: account.documentType || null,
    document_number: account.documentNumber || null,
    user_id: user.userGlobalId,
    full_name: user.name || user.email,
    email: user.email,
    role: String(user.role || "VIEWER").toUpperCase() === "ADMIN" ? "admin" : "operator",
    module: "shopee",
    modules: ["shopee"],
    access_policy: explicit ? "explicit" : null,
  }).catch((error) => ({
    ok: false,
    skipped: false,
    reason: error?.message || "hub_identity_sync_failed",
  }));
}

async function revokeMasterShopeeUserFromHub(user) {
  if (!user?.tenantGlobalId || (!user?.userGlobalId && !user?.email)) {
    return { ok: false, skipped: true, reason: "identity_not_ready" };
  }
  return revokeHubModuleAccess({
    tenant_id: user.tenantGlobalId,
    user_id: user.userGlobalId || null,
    email: user.email || null,
    module: "shopee",
    note: "Usuario removido pelo admin master da Shopee",
  }).catch((error) => ({
    ok: false,
    skipped: false,
    reason: error?.message || "hub_module_revoke_failed",
  }));
}

async function tableExists(tableName) {
  const row = await queryOne(
    `
      SELECT to_regclass($1) AS rel
    `,
    [tableName],
  );
  return Boolean(row?.rel);
}

function quoteIdent(value) {
  return `"${String(value || "").replace(/"/g, "\"\"")}"`;
}

function computeChecksum(content) {
  return crypto
    .createHash("sha256")
    .update(String(content || "").replace(/\r\n/g, "\n"))
    .digest("hex");
}

function readSqlMigrationEntries() {
  if (!fs.existsSync(SHOPEE_MIGRATIONS_DIR)) {
    return [];
  }

  const entries = [];
  const files = fs
    .readdirSync(SHOPEE_MIGRATIONS_DIR, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const file of files) {
    if (file.name.startsWith(".")) continue;

    if (file.isDirectory()) {
      const sqlFile = path.join(SHOPEE_MIGRATIONS_DIR, file.name, "migration.sql");
      if (!fs.existsSync(sqlFile)) continue;
      const sql = fs.readFileSync(sqlFile, "utf8");
      entries.push({
        name: file.name,
        filePath: sqlFile,
        sql,
        checksum: computeChecksum(sql),
      });
      continue;
    }

    if (file.isFile() && file.name.toLowerCase().endsWith(".sql")) {
      const sqlFile = path.join(SHOPEE_MIGRATIONS_DIR, file.name);
      const sql = fs.readFileSync(sqlFile, "utf8");
      entries.push({
        name: file.name.replace(/\.sql$/i, ""),
        filePath: sqlFile,
        sql,
        checksum: computeChecksum(sql),
      });
    }
  }

  return entries;
}

async function ensureMigrationHistoryTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${quoteIdent(MIGRATION_HISTORY_TABLE)} (
      name TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'script',
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      execution_ms INTEGER
    )
  `);
}

async function loadAppliedMigrations(client) {
  const result = await client.query(
    `
      SELECT name, checksum, source, applied_at, execution_ms
      FROM ${quoteIdent(MIGRATION_HISTORY_TABLE)}
      ORDER BY applied_at ASC, name ASC
    `,
  );

  return new Map(result.rows.map((row) => [row.name, row]));
}

async function ensureAuthAuditRetentionTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS "AuthAuditRetentionRule" (
      event TEXT NOT NULL,
      description TEXT,
      "retentionDays" INTEGER NOT NULL DEFAULT 90,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT "AuthAuditRetentionRule_pkey" PRIMARY KEY (event)
    )
  `);

  const defaultDays = Math.max(
    1,
    Math.min(3650, toSafeInt(process.env.AUTH_AUDIT_RETENTION_DAYS, 90)),
  );

  await query(
    `
      INSERT INTO "AuthAuditRetentionRule" (event, description, "retentionDays")
      VALUES ($1, $2, $3)
      ON CONFLICT (event)
      DO NOTHING
    `,
    [
      AUDIT_RETENTION_DEFAULT_EVENT,
      "Regra padrao para eventos sem configuracao dedicada.",
      defaultDays,
    ],
  );
}

async function listAuditRetentionRules() {
  await ensureAuthAuditRetentionTable();
  const rows = await query(
    `
      SELECT
        event,
        description,
        "retentionDays" AS retention_days,
        "updatedAt" AS updated_at
      FROM "AuthAuditRetentionRule"
      ORDER BY event ASC
    `,
  );

  let defaultRetentionDays = 90;
  const rules = [];
  for (const row of rows.rows) {
    const rule = {
      event: row.event,
      description: row.description || null,
      retentionDays: Number(row.retention_days || 0),
      updatedAt: row.updated_at || null,
    };
    if (rule.event === AUDIT_RETENTION_DEFAULT_EVENT) {
      defaultRetentionDays = rule.retentionDays || defaultRetentionDays;
    } else {
      rules.push(rule);
    }
  }

  return { defaultRetentionDays, rules };
}

async function upsertAuditRetentionRule({ event, description, retentionDays }) {
  await ensureAuthAuditRetentionTable();
  await query(
    `
      INSERT INTO "AuthAuditRetentionRule" (
        event,
        description,
        "retentionDays",
        "createdAt",
        "updatedAt"
      )
      VALUES ($1, $2, $3, NOW(), NOW())
      ON CONFLICT (event)
      DO UPDATE SET
        description = EXCLUDED.description,
        "retentionDays" = EXCLUDED."retentionDays",
        "updatedAt" = NOW()
    `,
    [event, description, retentionDays],
  );
}

router.get(
  "/admin-global/master/dashboard",
  requireMasterAdmin,
  async (req, res, next) => {
    try {
      const hasSessionTable = await tableExists('public."Session"');
      const hasAuthAuditTable = await tableExists('public."AuthAudit"');
      const hasPriceEventTable = await tableExists('public."ProductPriceUpdateEvent"');
      const hasProcessExecutionTable = await tableExists('public."ProcessExecutionLog"');

      const [
        accountsTotal,
        usersTotal,
        usersActive,
        usersPending,
        usersInactive,
        shopsTotal,
        shopsAuthorized,
        sessions24h,
        lastLogin,
        authEvents24h,
        tokensTotal,
        tokensWithMain,
        tokensWithAds,
      ] = await Promise.all([
        queryOne(`SELECT COUNT(*)::int AS total FROM "Account"`),
        queryOne(`SELECT COUNT(*)::int AS total FROM "User"`),
        queryOne(`SELECT COUNT(*)::int AS total FROM "User" WHERE status = 'ACTIVE'`),
        queryOne(
          `SELECT COUNT(*)::int AS total FROM "User" WHERE status = 'PENDING_ACTIVATION'`,
        ),
        queryOne(`SELECT COUNT(*)::int AS total FROM "User" WHERE status = 'INACTIVE'`),
        queryOne(`SELECT COUNT(*)::int AS total FROM "Shop"`),
        queryOne(`SELECT COUNT(*)::int AS total FROM "Shop" WHERE status = 'AUTHORIZED'`),
        hasSessionTable
          ? queryOne(
              `SELECT COUNT(*)::int AS total FROM "Session" WHERE "createdAt" >= NOW() - INTERVAL '24 hours'`,
            )
          : Promise.resolve({ total: 0 }),
        hasSessionTable
          ? queryOne(`SELECT MAX("createdAt") AS last_login_at FROM "Session"`)
          : Promise.resolve({ last_login_at: null }),
        hasAuthAuditTable
          ? queryOne(
              `SELECT COUNT(*)::int AS total FROM "AuthAudit" WHERE "createdAt" >= NOW() - INTERVAL '24 hours'`,
            )
          : Promise.resolve({ total: 0 }),
        queryOne(`SELECT COUNT(*)::int AS total FROM "OAuthToken"`),
        queryOne(
          `SELECT COUNT(*)::int AS total FROM "OAuthToken" WHERE COALESCE("accessToken", '') <> ''`,
        ),
        queryOne(
          `SELECT COUNT(*)::int AS total FROM "OAuthToken" WHERE COALESCE("adsAccessToken", '') <> ''`,
        ),
      ]);

      let priceIncreaseBlocked = 0;
      let priceIncreaseRecent = 0;
      if (hasPriceEventTable) {
        const [blocked, recent] = await Promise.all([
          queryOne(
            `
              SELECT COUNT(DISTINCT "itemId")::int AS total
              FROM "ProductPriceUpdateEvent"
              WHERE "isBlockedForPromotion" = true
                AND "lockUntil" > NOW()
            `,
          ),
          queryOne(
            `
              SELECT COUNT(*)::int AS total
              FROM "ProductPriceUpdateEvent"
              WHERE "updateTime" >= NOW() - INTERVAL '7 days'
            `,
          ),
        ]);
        priceIncreaseBlocked = Number(blocked?.total || 0);
        priceIncreaseRecent = Number(recent?.total || 0);
      }

      const dayRows = await query(
        `
          SELECT
            TO_CHAR(gs::date, 'YYYY-MM-DD') AS day_key,
            TO_CHAR(gs::date, 'DD/MM') AS day_label
          FROM generate_series(
            date_trunc('day', NOW() AT TIME ZONE 'America/Sao_Paulo') - INTERVAL '6 days',
            date_trunc('day', NOW() AT TIME ZONE 'America/Sao_Paulo'),
            INTERVAL '1 day'
          ) gs
          ORDER BY gs ASC
        `,
      );
      const dayDimension = dayRows.rows.map((row) => ({
        dayKey: row.day_key,
        label: row.day_label,
      }));
      const dayKeys = dayDimension.map((day) => day.dayKey);

      let loginSeries7d = dayDimension.map((day) => ({
        day: day.dayKey,
        label: day.label,
        total: 0,
      }));
      let companyActivity7d = [];

      if (hasSessionTable) {
        const [loginsByDayRows, companyDailyRows, usersByAccountRows, shopsByAccountRows] =
          await Promise.all([
            query(
              `
                SELECT
                  TO_CHAR((s."createdAt" AT TIME ZONE 'America/Sao_Paulo')::date, 'YYYY-MM-DD') AS day_key,
                  COUNT(*)::int AS total
                FROM "Session" s
                WHERE s."createdAt" >= NOW() - INTERVAL '7 days'
                GROUP BY 1
              `,
            ),
            query(
              `
                SELECT
                  COALESCE(a.id::text, '0') AS account_id,
                  COALESCE(NULLIF(BTRIM(a.name), ''), 'Sem empresa') AS account_name,
                  TO_CHAR((s."createdAt" AT TIME ZONE 'America/Sao_Paulo')::date, 'YYYY-MM-DD') AS day_key,
                  COUNT(*)::int AS total,
                  MAX(s."createdAt") AS last_login_at
                FROM "Session" s
                LEFT JOIN "User" u ON u.id::text = s."userId"::text
                LEFT JOIN "Account" a ON a.id::text = u."accountId"::text
                WHERE s."createdAt" >= NOW() - INTERVAL '7 days'
                GROUP BY 1, 2, 3
              `,
            ),
            query(
              `
                SELECT
                  COALESCE("accountId"::text, '0') AS account_id,
                  COUNT(*)::int AS total
                FROM "User"
                GROUP BY 1
              `,
            ),
            query(
              `
                SELECT
                  COALESCE("accountId"::text, '0') AS account_id,
                  COUNT(*)::int AS total
                FROM "Shop"
                GROUP BY 1
              `,
            ),
          ]);

        const loginsByDay = new Map(
          loginsByDayRows.rows.map((row) => [String(row.day_key), Number(row.total || 0)]),
        );
        loginSeries7d = dayDimension.map((day) => ({
          day: day.dayKey,
          label: day.label,
          total: Number(loginsByDay.get(day.dayKey) || 0),
        }));

        const usersByAccount = new Map(
          usersByAccountRows.rows.map((row) => [
            String(row.account_id),
            Number(row.total || 0),
          ]),
        );
        const shopsByAccount = new Map(
          shopsByAccountRows.rows.map((row) => [
            String(row.account_id),
            Number(row.total || 0),
          ]),
        );

        const companyMap = new Map();
        for (const row of companyDailyRows.rows) {
          const accountId = String(row.account_id || "0");
          const dayKey = String(row.day_key || "");
          const total = Number(row.total || 0);
          if (!dayKey) continue;

          if (!companyMap.has(accountId)) {
            companyMap.set(accountId, {
              accountId,
              accountName: row.account_name || "Sem empresa",
              totalLogins: 0,
              lastLoginAt: null,
              dailyTotals: new Map(dayKeys.map((key) => [key, 0])),
            });
          }

          const entry = companyMap.get(accountId);
          entry.totalLogins += total;
          entry.dailyTotals.set(dayKey, total);

          const rowLastLogin = row.last_login_at ? new Date(row.last_login_at) : null;
          const currentLastLogin = entry.lastLoginAt ? new Date(entry.lastLoginAt) : null;
          if (
            rowLastLogin &&
            !Number.isNaN(rowLastLogin.getTime()) &&
            (!currentLastLogin || rowLastLogin > currentLastLogin)
          ) {
            entry.lastLoginAt = row.last_login_at;
          }
        }

        companyActivity7d = Array.from(companyMap.values())
          .map((entry) => ({
            accountId: entry.accountId === "0" ? null : Number(entry.accountId),
            accountName: entry.accountName,
            totalLogins: entry.totalLogins,
            lastLoginAt: entry.lastLoginAt || null,
            usersCount: Number(usersByAccount.get(entry.accountId) || 0),
            shopsCount: Number(shopsByAccount.get(entry.accountId) || 0),
            daily: dayDimension.map((day) => ({
              day: day.dayKey,
              label: day.label,
              total: Number(entry.dailyTotals.get(day.dayKey) || 0),
            })),
          }))
          .sort((a, b) => b.totalLogins - a.totalLogins || a.accountName.localeCompare(b.accountName))
          .slice(0, 8);
      }

      let areasMostUsed7d = [];
      let auditEvents7dTotal = 0;
      let tabsMostAccessed7d = {
        total: 0,
        overall: [],
        byAccount: [],
      };
      if (hasAuthAuditTable) {
        const [areaDailyRows, tabAccessRows] = await Promise.all([
          query(
          `
            SELECT
              a.event,
              TO_CHAR((a."createdAt" AT TIME ZONE 'America/Sao_Paulo')::date, 'YYYY-MM-DD') AS day_key,
              COUNT(*)::int AS total,
              MAX(a."createdAt") AS last_used_at
            FROM "AuthAudit" a
            WHERE a."createdAt" >= NOW() - INTERVAL '7 days'
            GROUP BY a.event, TO_CHAR((a."createdAt" AT TIME ZONE 'America/Sao_Paulo')::date, 'YYYY-MM-DD')
          `,
          ),
          query(
            `
              SELECT
                COALESCE(acc.id::text, '0') AS account_id,
                COALESCE(NULLIF(BTRIM(acc.name), ''), 'Sem empresa') AS account_name,
                COALESCE(
                  NULLIF(BTRIM(a.metadata->>'tab'), ''),
                  NULLIF(BTRIM(a.metadata->>'tabId'), ''),
                  'unknown'
                ) AS tab_id,
                COUNT(*)::int AS total,
                MAX(a."createdAt") AS last_accessed_at
              FROM "AuthAudit" a
              LEFT JOIN "User" u
                ON u.id::text = a."userId"::text
                OR LOWER(COALESCE(u.email, '')) = LOWER(COALESCE(a.email, ''))
              LEFT JOIN "Account" acc ON acc.id::text = u."accountId"::text
              WHERE a."createdAt" >= NOW() - INTERVAL '7 days'
                AND a.event = 'tab_accessed'
              GROUP BY 1, 2, 3
            `,
          ),
        ]);

        const areaMap = new Map();
        for (const row of areaDailyRows.rows) {
          const event = String(row.event || "").trim();
          const dayKey = String(row.day_key || "");
          const total = Number(row.total || 0);
          const areaName = mapAuthAuditEventArea(event);
          if (!dayKey || !areaName) continue;

          if (!areaMap.has(areaName)) {
            areaMap.set(areaName, {
              area: areaName,
              totalEvents: 0,
              lastUsedAt: null,
              dailyTotals: new Map(dayKeys.map((key) => [key, 0])),
              events: new Map(),
            });
          }

          const areaEntry = areaMap.get(areaName);
          areaEntry.totalEvents += total;
          areaEntry.dailyTotals.set(dayKey, Number(areaEntry.dailyTotals.get(dayKey) || 0) + total);
          areaEntry.events.set(event, Number(areaEntry.events.get(event) || 0) + total);

          const rowLastUsed = row.last_used_at ? new Date(row.last_used_at) : null;
          const currentLastUsed = areaEntry.lastUsedAt ? new Date(areaEntry.lastUsedAt) : null;
          if (
            rowLastUsed &&
            !Number.isNaN(rowLastUsed.getTime()) &&
            (!currentLastUsed || rowLastUsed > currentLastUsed)
          ) {
            areaEntry.lastUsedAt = row.last_used_at;
          }
        }

        areasMostUsed7d = Array.from(areaMap.values())
          .map((entry) => {
            const topEvents = Array.from(entry.events.entries())
              .map(([event, total]) => ({ event, total }))
              .sort((a, b) => b.total - a.total || a.event.localeCompare(b.event))
              .slice(0, 3);
            return {
              area: entry.area,
              totalEvents: entry.totalEvents,
              lastUsedAt: entry.lastUsedAt || null,
              daily: dayDimension.map((day) => ({
                day: day.dayKey,
                label: day.label,
                total: Number(entry.dailyTotals.get(day.dayKey) || 0),
              })),
              topEvents,
            };
          })
          .sort((a, b) => b.totalEvents - a.totalEvents || a.area.localeCompare(b.area))
          .slice(0, 8);

        auditEvents7dTotal = areasMostUsed7d.reduce(
          (sum, areaEntry) => sum + Number(areaEntry.totalEvents || 0),
          0,
        );

        const tabOverallMap = new Map();
        const tabAccountMap = new Map();
        for (const row of tabAccessRows.rows) {
          const tabId = String(row.tab_id || "unknown");
          const accountId = String(row.account_id || "0");
          const accountName = row.account_name || "Sem empresa";
          const total = Number(row.total || 0);
          const lastAccessedAt = row.last_accessed_at || null;
          const tabLabel = humanizeTabId(tabId);

          if (!tabOverallMap.has(tabId)) {
            tabOverallMap.set(tabId, {
              tabId,
              tabLabel,
              total: 0,
              lastAccessedAt: null,
            });
          }
          const overall = tabOverallMap.get(tabId);
          overall.total += total;
          if (
            lastAccessedAt &&
            (!overall.lastAccessedAt || new Date(lastAccessedAt) > new Date(overall.lastAccessedAt))
          ) {
            overall.lastAccessedAt = lastAccessedAt;
          }

          if (!tabAccountMap.has(accountId)) {
            tabAccountMap.set(accountId, {
              accountId: accountId === "0" ? null : Number(accountId),
              accountName,
              total: 0,
              tabs: new Map(),
            });
          }
          const accountEntry = tabAccountMap.get(accountId);
          accountEntry.total += total;
          accountEntry.tabs.set(tabId, {
            tabId,
            tabLabel,
            total,
            lastAccessedAt,
          });
        }

        tabsMostAccessed7d = {
          total: Array.from(tabOverallMap.values()).reduce(
            (sum, row) => sum + Number(row.total || 0),
            0,
          ),
          overall: Array.from(tabOverallMap.values())
            .sort((a, b) => b.total - a.total || a.tabLabel.localeCompare(b.tabLabel))
            .slice(0, 30),
          byAccount: Array.from(tabAccountMap.values())
            .map((entry) => ({
              accountId: entry.accountId,
              accountName: entry.accountName,
              total: entry.total,
              tabs: Array.from(entry.tabs.values())
                .sort((a, b) => b.total - a.total || a.tabLabel.localeCompare(b.tabLabel))
                .slice(0, 12),
            }))
            .sort((a, b) => b.total - a.total || a.accountName.localeCompare(b.accountName))
            .slice(0, 12),
        };
      }

      let processesMostUsed30d = {
        total: 0,
        overall: [],
        byAccount: [],
      };
      if (hasProcessExecutionTable) {
        const processRows = await query(
          `
            SELECT
              COALESCE(p."accountId"::text, '0') AS account_id,
              COALESCE(NULLIF(BTRIM(acc.name), ''), 'Sem empresa') AS account_name,
              p.method,
              p.path,
              p."requestBody" AS request_body,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE p.success = true)::int AS success_count,
              COUNT(*) FILTER (WHERE p.success = false)::int AS error_count,
              ROUND(AVG(NULLIF(p."durationMs", 0))::numeric, 2) AS avg_duration_ms,
              MAX(p."requestedAt") AS last_requested_at
            FROM "ProcessExecutionLog" p
            LEFT JOIN "Account" acc ON acc.id = p."accountId"
            WHERE p."requestedAt" >= NOW() - INTERVAL '30 days'
            GROUP BY 1, 2, p.method, p.path, p."requestBody"
          `,
        );

        const processOverallMap = new Map();
        const processAccountMap = new Map();
        for (const row of processRows.rows) {
          const displayName = resolveProcessDisplayName({
            method: row.method,
            path: row.path,
            requestBody: row.request_body,
          });
          const accountId = String(row.account_id || "0");
          const accountName = row.account_name || "Sem empresa";
          const total = Number(row.total || 0);
          const successCount = Number(row.success_count || 0);
          const errorCount = Number(row.error_count || 0);
          const lastRequestedAt = row.last_requested_at || null;
          const key = displayName;

          if (!processOverallMap.has(key)) {
            processOverallMap.set(key, {
              displayName,
              total: 0,
              successCount: 0,
              errorCount: 0,
              lastRequestedAt: null,
            });
          }
          const overall = processOverallMap.get(key);
          overall.total += total;
          overall.successCount += successCount;
          overall.errorCount += errorCount;
          if (
            lastRequestedAt &&
            (!overall.lastRequestedAt || new Date(lastRequestedAt) > new Date(overall.lastRequestedAt))
          ) {
            overall.lastRequestedAt = lastRequestedAt;
          }

          if (!processAccountMap.has(accountId)) {
            processAccountMap.set(accountId, {
              accountId: accountId === "0" ? null : Number(accountId),
              accountName,
              total: 0,
              processes: new Map(),
            });
          }
          const accountEntry = processAccountMap.get(accountId);
          accountEntry.total += total;
          const accountProcess = accountEntry.processes.get(key) || {
            displayName,
            total: 0,
            successCount: 0,
            errorCount: 0,
            lastRequestedAt: null,
          };
          accountProcess.total += total;
          accountProcess.successCount += successCount;
          accountProcess.errorCount += errorCount;
          if (
            lastRequestedAt &&
            (!accountProcess.lastRequestedAt ||
              new Date(lastRequestedAt) > new Date(accountProcess.lastRequestedAt))
          ) {
            accountProcess.lastRequestedAt = lastRequestedAt;
          }
          accountEntry.processes.set(key, accountProcess);
        }

        processesMostUsed30d = {
          total: Array.from(processOverallMap.values()).reduce(
            (sum, row) => sum + Number(row.total || 0),
            0,
          ),
          overall: Array.from(processOverallMap.values())
            .sort((a, b) => b.total - a.total || a.displayName.localeCompare(b.displayName))
            .slice(0, 30),
          byAccount: Array.from(processAccountMap.values())
            .map((entry) => ({
              accountId: entry.accountId,
              accountName: entry.accountName,
              total: entry.total,
              processes: Array.from(entry.processes.values())
                .sort((a, b) => b.total - a.total || a.displayName.localeCompare(b.displayName))
                .slice(0, 12),
            }))
            .sort((a, b) => b.total - a.total || a.accountName.localeCompare(b.accountName))
            .slice(0, 12),
        };
      }

      return res.json({
        ok: true,
        stats: {
          accountsTotal: Number(accountsTotal?.total || 0),
          usersTotal: Number(usersTotal?.total || 0),
          usersActive: Number(usersActive?.total || 0),
          usersPending: Number(usersPending?.total || 0),
          usersInactive: Number(usersInactive?.total || 0),
          shopsTotal: Number(shopsTotal?.total || 0),
          shopsAuthorized: Number(shopsAuthorized?.total || 0),
          sessions24h: Number(sessions24h?.total || 0),
          lastLoginAt: lastLogin?.last_login_at || null,
          authEvents24h: Number(authEvents24h?.total || 0),
          tokensTotal: Number(tokensTotal?.total || 0),
          tokensWithMain: Number(tokensWithMain?.total || 0),
          tokensWithAds: Number(tokensWithAds?.total || 0),
          priceIncreaseBlocked,
          priceIncreaseRecent,
          logins7dTotal: loginSeries7d.reduce(
            (sum, entry) => sum + Number(entry.total || 0),
            0,
          ),
          loginSeries7d,
          companyActivity7d,
          areasMostUsed7d,
          auditEvents7dTotal,
          tabsMostAccessed7d,
          processesMostUsed30d,
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  "/admin-global/master/users",
  requireMasterAdmin,
  async (req, res, next) => {
    try {
      const search = normalizeSearch(req.query?.search);
      const params = [];
      let whereSql = "";

      if (search) {
        params.push(`%${search}%`);
        whereSql = `
          WHERE
            LOWER(COALESCE(u.name, '')) LIKE $1
            OR LOWER(COALESCE(u.email, '')) LIKE $1
            OR LOWER(COALESCE(a.name, '')) LIKE $1
        `;
      }

      const rows = await query(
        `
          SELECT
            u.id,
            u.name,
            u.email,
            u.role,
            u.status,
            u."accountId" AS account_id,
            a.name AS account_name,
            u."activationExpiresAt" AS activation_expires_at,
            u."createdAt" AS created_at,
            MAX(s."createdAt") AS last_login_at
          FROM "User" u
          LEFT JOIN "Account" a ON a.id = u."accountId"
          LEFT JOIN "Session" s ON s."userId"::text = u.id::text
          ${whereSql}
          GROUP BY
            u.id,
            u.name,
            u.email,
            u.role,
            u.status,
            u."accountId",
            a.name,
            u."activationExpiresAt",
            u."createdAt"
          ORDER BY u.id ASC
        `,
        params,
      );

      return res.json({
        ok: true,
        total: rows.rowCount,
        users: rows.rows.map(mapUserRow),
      });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  "/admin-global/master/users",
  requireMasterAdmin,
  async (req, res, next) => {
    try {
      const name = String(req.body?.name || "").trim();
      const email = String(req.body?.email || "")
        .trim()
        .toLowerCase();
      const role = String(req.body?.role || "VIEWER").trim().toUpperCase();
      const accountId = Number(req.body?.accountId);

      if (!name || !email || !Number.isFinite(accountId)) {
        return res.status(400).json({
          error: "bad_request",
          message: "Informe nome, email e accountId valido.",
        });
      }

      if (!["ADMIN", "VIEWER"].includes(role)) {
        return res.status(400).json({
          error: "bad_request",
          message: "Role invalida. Use ADMIN ou VIEWER.",
        });
      }

      const account = await findAccountByIdGlobal(accountId);
      if (!account) {
        return res.status(404).json({
          error: "not_found",
          message: "Conta nao encontrada.",
        });
      }

      const emailExists = await findUserByEmail(email);
      if (emailExists) {
        return res.status(409).json({
          error: "email_in_use",
          message: "Ja existe usuario com este email.",
        });
      }

      const activationToken = createActivationToken();
      const activationExpiresAt = activationExpiryDate();
      const passwordHash = await bcrypt.hash(createTemporaryPassword(), 10);

      const createdUser = await createInvitedUser({
        name,
        email,
        passwordHash,
        role,
        accountId,
        activationTokenHash: hashToken(activationToken),
        activationExpiresAt,
      });

      const activationLink = buildActivationLink(activationToken);
      const emailDelivery = await sendInviteEmailSafe({
        email,
        name,
        link: activationLink,
        expiresAt: activationExpiresAt.toISOString(),
      });
      const hubSync = await syncMasterShopeeUserToHub(account, createdUser, true);

      return res.json({
        ok: true,
        user: createdUser,
        hub_sync: hubSync,
        invite: {
          link: activationLink,
          expiresAt: activationExpiresAt.toISOString(),
        },
        email_delivery: emailDelivery,
      });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  "/admin-global/master/users/:id/invite",
  requireMasterAdmin,
  async (req, res, next) => {
    try {
      const userId = Number(req.params.id);
      if (!Number.isFinite(userId)) {
        return res.status(400).json({
          error: "bad_request",
          message: "ID invalido.",
        });
      }

      const target = await findUserByIdGlobal(userId);
      if (!target) {
        return res.status(404).json({
          error: "not_found",
          message: "Usuario nao encontrado.",
        });
      }

      const activationToken = createActivationToken();
      const activationExpiresAt = activationExpiryDate();
      const updated = await updateUserInvite(
        target.id,
        hashToken(activationToken),
        activationExpiresAt,
      );
      const activationLink = buildActivationLink(activationToken);
      const emailDelivery = await sendInviteEmailSafe({
        email: updated.email,
        name: updated.name,
        link: activationLink,
        expiresAt: activationExpiresAt.toISOString(),
      });

      return res.json({
        ok: true,
        user: updated,
        invite: {
          link: activationLink,
          expiresAt: activationExpiresAt.toISOString(),
        },
        email_delivery: emailDelivery,
      });
    } catch (error) {
      next(error);
    }
  },
);

router.patch(
  "/admin-global/master/users/:id/role",
  requireMasterAdmin,
  async (req, res, next) => {
    try {
      const userId = Number(req.params.id);
      const role = String(req.body?.role || "").trim().toUpperCase();
      if (!Number.isFinite(userId) || !["ADMIN", "VIEWER"].includes(role)) {
        return res.status(400).json({
          error: "bad_request",
          message: "Parametros invalidos.",
        });
      }

      const target = await findUserByIdGlobal(userId);
      if (!target) {
        return res.status(404).json({
          error: "not_found",
          message: "Usuario nao encontrado.",
        });
      }

      if (target.role === "ADMIN" && role === "VIEWER") {
        const adminsCount = await countAdminsByAccountId(target.accountId);
        if (adminsCount <= 1) {
          return res.status(400).json({
            error: "last_admin",
            message: "Nao e possivel remover o ultimo ADMIN desta conta.",
          });
        }
      }

      const updated = await updateUserRole(userId, role);
      return res.json({
        ok: true,
        user: updated,
      });
    } catch (error) {
      next(error);
    }
  },
);

router.patch(
  "/admin-global/master/users/:id",
  requireMasterAdmin,
  async (req, res, next) => {
    try {
      const userId = Number(req.params.id);
      if (!Number.isFinite(userId)) {
        return res.status(400).json({
          error: "bad_request",
          message: "ID invalido.",
        });
      }

      const target = await findUserByIdGlobal(userId);
      if (!target) {
        return res.status(404).json({
          error: "not_found",
          message: "Usuario nao encontrado.",
        });
      }

      const patchData = {};
      if (req.body?.name != null) {
        const name = String(req.body.name).trim();
        if (!name) {
          return res.status(400).json({
            error: "bad_request",
            message: "Nome invalido.",
          });
        }
        patchData.name = name;
      }

      if (req.body?.email != null) {
        const email = String(req.body.email).trim().toLowerCase();
        if (!email || !email.includes("@")) {
          return res.status(400).json({
            error: "bad_request",
            message: "Email invalido.",
          });
        }
        const emailOwner = await findUserByEmail(email);
        if (emailOwner && Number(emailOwner.id) !== userId) {
          return res.status(409).json({
            error: "email_in_use",
            message: "Email ja esta em uso.",
          });
        }
        patchData.email = email;
      }

      if (req.body?.password != null) {
        const password = String(req.body.password);
        if (password.length < 6) {
          return res.status(400).json({
            error: "bad_request",
            message: "Senha deve ter ao menos 6 caracteres.",
          });
        }
        patchData.passwordHash = await bcrypt.hash(password, 10);
      }

      if (Object.keys(patchData).length) {
        await updateUserProfile(userId, patchData);
      }

      if (req.body?.status != null) {
        const status = String(req.body.status).trim().toUpperCase();
        if (!["ACTIVE", "PENDING_ACTIVATION", "INACTIVE"].includes(status)) {
          return res.status(400).json({
            error: "bad_request",
            message: "Status invalido.",
          });
        }
        await query(
          `
            UPDATE "User"
            SET status = $2, "updatedAt" = NOW()
            WHERE id::text = $1::text
          `,
          [userId, status],
        );
      }

      const updated = await findUserByIdGlobal(userId);
      return res.json({
        ok: true,
        user: updated,
      });
    } catch (error) {
      next(error);
    }
  },
);

router.delete(
  "/admin-global/master/users/:id",
  requireMasterAdmin,
  async (req, res, next) => {
    try {
      const userId = Number(req.params.id);
      if (!Number.isFinite(userId)) {
        return res.status(400).json({
          error: "bad_request",
          message: "ID invalido.",
        });
      }

      const target = await findUserByIdGlobal(userId);
      if (!target) {
        return res.status(404).json({
          error: "not_found",
          message: "Usuario nao encontrado.",
        });
      }

      if (target.role === "ADMIN") {
        const adminsCount = await countAdminsByAccountId(target.accountId);
        if (adminsCount <= 1) {
          return res.status(400).json({
            error: "last_admin",
            message: "Nao e possivel excluir o ultimo ADMIN desta conta.",
          });
        }
      }

      const hubSync = await revokeMasterShopeeUserFromHub(target);
      await deleteSessionsByUserId(userId);
      await deleteUserById(userId);
      return res.json({ ok: true, hub_sync: hubSync });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  "/admin-global/master/links/lookups",
  requireMasterAdmin,
  async (req, res, next) => {
    try {
      const [accounts, users] = await Promise.all([
        query(
          `
            SELECT id, name
            FROM "Account"
            ORDER BY name ASC
          `,
        ),
        query(
          `
            SELECT
              id,
              name,
              email,
              role,
              status,
              "accountId" AS account_id
            FROM "User"
            ORDER BY name ASC NULLS LAST, email ASC
          `,
        ),
      ]);

      return res.json({
        ok: true,
        accounts: accounts.rows.map((row) => ({
          id: Number(row.id),
          name: row.name || null,
        })),
        users: users.rows.map((row) => ({
          id: Number(row.id),
          name: row.name || null,
          email: row.email || null,
          role: row.role || null,
          status: row.status || null,
          accountId: row.account_id == null ? null : Number(row.account_id),
        })),
      });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  "/admin-global/master/links",
  requireMasterAdmin,
  async (req, res, next) => {
    try {
      const search = normalizeSearch(req.query?.search);
      const params = [];
      let whereSql = "";

      if (search) {
        params.push(`%${search}%`);
        whereSql = `
          WHERE
            LOWER(COALESCE(u.name, '')) LIKE $1
            OR LOWER(COALESCE(u.email, '')) LIKE $1
            OR LOWER(COALESCE(a.name, '')) LIKE $1
        `;
      }

      const rows = await query(
        `
          SELECT
            u.id AS user_id,
            u.name AS user_name,
            u.email AS user_email,
            u.role,
            u.status,
            u."accountId" AS account_id,
            a.name AS account_name,
            u."createdAt" AS created_at
          FROM "User" u
          LEFT JOIN "Account" a ON a.id = u."accountId"
          ${whereSql}
          ORDER BY a.name ASC NULLS LAST, u.name ASC NULLS LAST, u.email ASC
        `,
        params,
      );

      return res.json({
        ok: true,
        total: rows.rowCount,
        links: rows.rows.map((row) => ({
          accountId: row.account_id == null ? null : Number(row.account_id),
          accountName: row.account_name || null,
          userId: Number(row.user_id),
          userName: row.user_name || null,
          userEmail: row.user_email || null,
          role: row.role || null,
          status: row.status || null,
          createdAt: row.created_at || null,
        })),
      });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  "/admin-global/master/links",
  requireMasterAdmin,
  async (req, res, next) => {
    try {
      const userId = Number(req.body?.userId);
      const accountId = Number(req.body?.accountId);
      const role = req.body?.role == null ? null : String(req.body.role).trim().toUpperCase();

      if (!Number.isFinite(userId) || !Number.isFinite(accountId)) {
        return res.status(400).json({
          error: "bad_request",
          message: "Informe userId e accountId validos.",
        });
      }

      if (role != null && !["ADMIN", "VIEWER"].includes(role)) {
        return res.status(400).json({
          error: "bad_request",
          message: "Role invalida. Use ADMIN ou VIEWER.",
        });
      }

      const [targetUser, targetAccount] = await Promise.all([
        findUserByIdGlobal(userId),
        findAccountByIdGlobal(accountId),
      ]);
      if (!targetUser || !targetAccount) {
        return res.status(404).json({
          error: "not_found",
          message: "Usuario ou conta nao encontrados.",
        });
      }

      await query(
        `
          UPDATE "User"
          SET "accountId" = $2, "updatedAt" = NOW()
          WHERE id::text = $1::text
        `,
        [userId, accountId],
      );

      if (role) {
        await updateUserRole(userId, role);
      }

      const updated = await findUserByIdGlobal(userId);
      return res.json({
        ok: true,
        link: {
          accountId: updated.accountId,
          accountName: updated.accountName,
          userId: updated.id,
          userName: updated.name,
          userEmail: updated.email,
          role: updated.role,
          status: updated.status,
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

router.put(
  "/admin-global/master/links/:accountId/:userId",
  requireMasterAdmin,
  async (req, res, next) => {
    try {
      const oldAccountId = Number(req.params.accountId);
      const userId = Number(req.params.userId);
      const newAccountId = req.body?.accountId == null ? oldAccountId : Number(req.body.accountId);
      const role = req.body?.role == null ? null : String(req.body.role).trim().toUpperCase();

      if (!Number.isFinite(oldAccountId) || !Number.isFinite(userId) || !Number.isFinite(newAccountId)) {
        return res.status(400).json({
          error: "bad_request",
          message: "Parametros invalidos.",
        });
      }

      if (role != null && !["ADMIN", "VIEWER"].includes(role)) {
        return res.status(400).json({
          error: "bad_request",
          message: "Role invalida. Use ADMIN ou VIEWER.",
        });
      }

      const targetUser = await findUserByIdGlobal(userId);
      if (!targetUser || targetUser.accountId !== oldAccountId) {
        return res.status(404).json({
          error: "not_found",
          message: "Vinculo informado nao encontrado.",
        });
      }

      const targetAccount = await findAccountByIdGlobal(newAccountId);
      if (!targetAccount) {
        return res.status(404).json({
          error: "not_found",
          message: "Conta destino nao encontrada.",
        });
      }

      await query(
        `
          UPDATE "User"
          SET "accountId" = $2, "updatedAt" = NOW()
          WHERE id::text = $1::text
        `,
        [userId, newAccountId],
      );
      if (role) {
        await updateUserRole(userId, role);
      }

      const updated = await findUserByIdGlobal(userId);
      return res.json({
        ok: true,
        link: {
          accountId: updated.accountId,
          accountName: updated.accountName,
          userId: updated.id,
          userName: updated.name,
          userEmail: updated.email,
          role: updated.role,
          status: updated.status,
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

router.delete(
  "/admin-global/master/links/:accountId/:userId",
  requireMasterAdmin,
  async (req, res, next) => {
    try {
      const accountId = Number(req.params.accountId);
      const userId = Number(req.params.userId);
      if (!Number.isFinite(accountId) || !Number.isFinite(userId)) {
        return res.status(400).json({
          error: "bad_request",
          message: "Parametros invalidos.",
        });
      }

      const targetUser = await findUserByIdGlobal(userId);
      if (!targetUser || targetUser.accountId !== accountId) {
        return res.status(404).json({
          error: "not_found",
          message: "Vinculo informado nao encontrado.",
        });
      }

      await query(
        `
          UPDATE "User"
          SET status = 'INACTIVE', "updatedAt" = NOW()
          WHERE id::text = $1::text
        `,
        [userId],
      );

      const updated = await findUserByIdGlobal(userId);
      return res.json({
        ok: true,
        link: {
          accountId: updated.accountId,
          accountName: updated.accountName,
          userId: updated.id,
          userName: updated.name,
          userEmail: updated.email,
          role: updated.role,
          status: updated.status,
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  "/admin-global/master/shopee-accounts",
  requireMasterAdmin,
  async (req, res, next) => {
    try {
      const search = normalizeSearch(req.query?.search);
      const params = [];
      let whereSql = "";

      if (search) {
        params.push(`%${search}%`);
        whereSql = `
          WHERE
            CAST(s."shopId" AS TEXT) LIKE $1
            OR LOWER(COALESCE(a.name, '')) LIKE $1
            OR LOWER(COALESCE(s.region, '')) LIKE $1
            OR LOWER(COALESCE(s.status, '')) LIKE $1
        `;
      }

      const rows = await query(
        `
          SELECT
            s.id,
            s."shopId" AS shop_id,
            s.region,
            s.status,
            s."accountId" AS account_id,
            s."createdAt" AS created_at,
            a.name AS account_name,
            COUNT(DISTINCT u.id)::int AS users_count,
            CASE WHEN t.id IS NULL THEN false ELSE true END AS has_any_token,
            CASE WHEN COALESCE(t."accessToken", '') <> '' THEN true ELSE false END AS has_main_token,
            CASE WHEN COALESCE(t."adsAccessToken", '') <> '' THEN true ELSE false END AS has_ads_token
          FROM "Shop" s
          LEFT JOIN "Account" a ON a.id = s."accountId"
          LEFT JOIN "User" u ON u."accountId" = s."accountId"
          LEFT JOIN "OAuthToken" t ON t."shopId" = s.id
          ${whereSql}
          GROUP BY
            s.id,
            s."shopId",
            s.region,
            s.status,
            s."accountId",
            s."createdAt",
            a.name,
            t.id,
            t."accessToken",
            t."adsAccessToken"
          ORDER BY s.id ASC
        `,
        params,
      );

      return res.json({
        ok: true,
        total: rows.rowCount,
        accounts: rows.rows.map((row) => ({
          id: Number(row.id),
          shopId: row.shop_id == null ? null : String(row.shop_id),
          region: row.region || null,
          status: row.status || null,
          accountId: row.account_id == null ? null : Number(row.account_id),
          accountName: row.account_name || null,
          usersCount: Number(row.users_count || 0),
          hasAnyToken: Boolean(row.has_any_token),
          hasMainToken: Boolean(row.has_main_token),
          hasAdsToken: Boolean(row.has_ads_token),
          createdAt: row.created_at || null,
        })),
      });
    } catch (error) {
      next(error);
    }
  },
);

router.patch(
  "/admin-global/master/shopee-accounts/:id",
  requireMasterAdmin,
  async (req, res, next) => {
    try {
      const shopDbId = Number(req.params.id);
      if (!Number.isFinite(shopDbId)) {
        return res.status(400).json({
          error: "bad_request",
          message: "ID da conta Shopee invalido.",
        });
      }

      const target = await queryOne(
        `
          SELECT id, "accountId" AS account_id
          FROM "Shop"
          WHERE id = $1
          LIMIT 1
        `,
        [shopDbId],
      );
      if (!target) {
        return res.status(404).json({
          error: "not_found",
          message: "Conta Shopee nao encontrada.",
        });
      }

      const nextRegion = req.body?.region == null ? null : String(req.body.region).trim();
      const nextStatus = req.body?.status == null ? null : String(req.body.status).trim().toUpperCase();
      const nextAccountId = req.body?.accountId == null ? null : Number(req.body.accountId);

      if (nextAccountId != null && !Number.isFinite(nextAccountId)) {
        return res.status(400).json({
          error: "bad_request",
          message: "accountId invalido.",
        });
      }

      if (nextAccountId != null) {
        const account = await findAccountByIdGlobal(nextAccountId);
        if (!account) {
          return res.status(404).json({
            error: "not_found",
            message: "Conta destino nao encontrada.",
          });
        }
      }

      await query(
        `
          UPDATE "Shop"
          SET
            region = COALESCE($2, region),
            status = COALESCE($3, status),
            "accountId" = COALESCE($4, "accountId"),
            "updatedAt" = NOW()
          WHERE id = $1
        `,
        [shopDbId, nextRegion, nextStatus, nextAccountId],
      );

      const updated = await queryOne(
        `
          SELECT
            s.id,
            s."shopId" AS shop_id,
            s.region,
            s.status,
            s."accountId" AS account_id,
            a.name AS account_name,
            s."createdAt" AS created_at
          FROM "Shop" s
          LEFT JOIN "Account" a ON a.id = s."accountId"
          WHERE s.id = $1
          LIMIT 1
        `,
        [shopDbId],
      );

      return res.json({
        ok: true,
        account: {
          id: Number(updated.id),
          shopId: updated.shop_id == null ? null : String(updated.shop_id),
          region: updated.region || null,
          status: updated.status || null,
          accountId: updated.account_id == null ? null : Number(updated.account_id),
          accountName: updated.account_name || null,
          createdAt: updated.created_at || null,
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

router.delete(
  "/admin-global/master/shopee-accounts/:id",
  requireMasterAdmin,
  async (req, res, next) => {
    try {
      const shopDbId = Number(req.params.id);
      if (!Number.isFinite(shopDbId)) {
        return res.status(400).json({
          error: "bad_request",
          message: "ID da conta Shopee invalido.",
        });
      }

      const deleted = await queryOne(
        `
          DELETE FROM "Shop"
          WHERE id = $1
          RETURNING id, "shopId" AS shop_id
        `,
        [shopDbId],
      );
      if (!deleted) {
        return res.status(404).json({
          error: "not_found",
          message: "Conta Shopee nao encontrada.",
        });
      }

      return res.json({
        ok: true,
        deleted: {
          id: Number(deleted.id),
          shopId: deleted.shop_id == null ? null : String(deleted.shop_id),
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  "/admin-global/master/shopee-tokens",
  requireMasterAdmin,
  async (req, res, next) => {
    try {
      const search = normalizeSearch(req.query?.search);
      const params = [];
      let whereSql = "";

      if (search) {
        params.push(`%${search}%`);
        whereSql = `
          WHERE
            CAST(s."shopId" AS TEXT) LIKE $1
            OR LOWER(COALESCE(a.name, '')) LIKE $1
            OR LOWER(COALESCE(s.region, '')) LIKE $1
        `;
      }

      const rows = await query(
        `
          SELECT
            s.id AS shop_db_id,
            s."shopId" AS shop_id,
            s.region,
            s.status AS shop_status,
            s."accountId" AS account_id,
            a.name AS account_name,
            t.id AS token_id,
            t."accessToken" AS access_token,
            t."accessTokenExpiresAt" AS access_token_expires_at,
            t."refreshToken" AS refresh_token,
            t."refreshTokenExpiresAt" AS refresh_token_expires_at,
            t."adsAccessToken" AS ads_access_token,
            t."adsAccessTokenExpiresAt" AS ads_access_token_expires_at,
            t."adsRefreshToken" AS ads_refresh_token,
            t."adsRefreshTokenExpiresAt" AS ads_refresh_token_expires_at,
            t."updatedAt" AS token_updated_at
          FROM "Shop" s
          LEFT JOIN "Account" a ON a.id = s."accountId"
          LEFT JOIN "OAuthToken" t ON t."shopId" = s.id
          ${whereSql}
          ORDER BY s.id ASC
        `,
        params,
      );

      return res.json({
        ok: true,
        total: rows.rowCount,
        tokens: rows.rows.map((row) => ({
          shopDbId: Number(row.shop_db_id),
          shopId: row.shop_id == null ? null : String(row.shop_id),
          region: row.region || null,
          shopStatus: row.shop_status || null,
          accountId: row.account_id == null ? null : Number(row.account_id),
          accountName: row.account_name || null,
          tokenId: row.token_id == null ? null : Number(row.token_id),
          hasMainToken: Boolean(row.access_token),
          hasAdsToken: Boolean(row.ads_access_token),
          accessTokenMasked: maskToken(row.access_token),
          refreshTokenMasked: maskToken(row.refresh_token),
          adsAccessTokenMasked: maskToken(row.ads_access_token),
          adsRefreshTokenMasked: maskToken(row.ads_refresh_token),
          accessTokenExpiresAt: row.access_token_expires_at || null,
          refreshTokenExpiresAt: row.refresh_token_expires_at || null,
          adsAccessTokenExpiresAt: row.ads_access_token_expires_at || null,
          adsRefreshTokenExpiresAt: row.ads_refresh_token_expires_at || null,
          tokenUpdatedAt: row.token_updated_at || null,
        })),
      });
    } catch (error) {
      next(error);
    }
  },
);

router.delete(
  "/admin-global/master/shopee-tokens/:shopDbId",
  requireMasterAdmin,
  async (req, res, next) => {
    try {
      const shopDbId = Number(req.params.shopDbId);
      if (!Number.isFinite(shopDbId)) {
        return res.status(400).json({
          error: "bad_request",
          message: "shopDbId invalido.",
        });
      }

      const deleted = await queryOne(
        `
          DELETE FROM "OAuthToken"
          WHERE "shopId" = $1
          RETURNING id
        `,
        [shopDbId],
      );

      return res.json({
        ok: true,
        deleted: Boolean(deleted),
      });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  "/admin-global/master/shopee-tokens/:shopDbId/revoke-account",
  requireMasterAdmin,
  async (req, res, next) => {
    try {
      const shopDbId = Number(req.params.shopDbId);
      if (!Number.isFinite(shopDbId)) {
        return res.status(400).json({
          error: "bad_request",
          message: "shopDbId invalido.",
        });
      }

      await query(
        `
          DELETE FROM "OAuthToken"
          WHERE "shopId" = $1
        `,
        [shopDbId],
      );
      await query(
        `
          UPDATE "Shop"
          SET status = 'INACTIVE', "updatedAt" = NOW()
          WHERE id = $1
        `,
        [shopDbId],
      );

      return res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  "/admin-global/master/oauth-states",
  requireMasterAdmin,
  async (req, res, next) => {
    try {
      const page = Math.max(1, toSafeInt(req.query?.page, 1));
      const pageSize = Math.max(1, Math.min(200, toSafeInt(req.query?.pageSize, 50)));
      const search = String(req.query?.search || "");
      const data = await listOAuthStates({
        search,
        page,
        limit: pageSize,
      });
      return res.json({ ok: true, ...data });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  "/admin-global/master/oauth-states/cleanup",
  requireMasterAdmin,
  async (req, res, next) => {
    try {
      const olderThanDays = Math.max(1, Math.min(365, toSafeInt(req.body?.olderThanDays, 7)));
      const result = await cleanupOAuthStates({ olderThanDays });
      return res.json({
        ok: true,
        ...result,
      });
    } catch (error) {
      next(error);
    }
  },
);

router.delete(
  "/admin-global/master/oauth-states/:state",
  requireMasterAdmin,
  async (req, res, next) => {
    try {
      const state = String(req.params.state || "").trim();
      if (!state) {
        return res.status(400).json({
          error: "bad_request",
          message: "State invalido.",
        });
      }
      const deleted = await deleteOAuthState(state);
      return res.json({
        ok: true,
        deleted: Boolean(deleted),
      });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  "/admin-global/master/migrations/status",
  requireMasterAdmin,
  async (req, res, next) => {
    try {
      const entries = readSqlMigrationEntries();
      const status = await withClient(async (client) => {
        await ensureMigrationHistoryTable(client);
        const appliedMap = await loadAppliedMigrations(client);

        const files = entries.map((entry) => {
          const applied = appliedMap.get(entry.name) || null;
          return {
            name: entry.name,
            filePath: path.relative(path.join(__dirname, "..", ".."), entry.filePath),
            checksum: entry.checksum,
            applied: Boolean(applied),
            appliedAt: applied?.applied_at || null,
            source: applied?.source || null,
            executionMs: applied?.execution_ms || null,
          };
        });

        const appliedOnly = Array.from(appliedMap.values())
          .filter((row) => !entries.some((entry) => entry.name === row.name))
          .map((row) => ({
            name: row.name,
            checksum: row.checksum,
            applied: true,
            appliedAt: row.applied_at,
            source: row.source,
            executionMs: row.execution_ms || null,
            missingFile: true,
          }));

        return {
          files,
          appliedOnly,
          totals: {
            files: files.length,
            applied: files.filter((item) => item.applied).length,
            pending: files.filter((item) => !item.applied).length,
            appliedOnly: appliedOnly.length,
          },
        };
      });

      return res.json({
        ok: true,
        ...status,
      });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  "/admin-global/master/migrations/file",
  requireMasterAdmin,
  async (req, res, next) => {
    try {
      const name = String(req.query?.name || "").trim();
      if (!name) {
        return res.status(400).json({
          error: "bad_request",
          message: "Informe o nome da migration.",
        });
      }

      const entry = readSqlMigrationEntries().find((item) => item.name === name);
      if (!entry) {
        return res.status(404).json({
          error: "not_found",
          message: "Migration nao encontrada.",
        });
      }

      return res.json({
        ok: true,
        name: entry.name,
        filePath: path.relative(path.join(__dirname, "..", ".."), entry.filePath),
        sql: entry.sql,
        checksum: entry.checksum,
      });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  "/admin-global/master/migrations/run",
  requireMasterAdmin,
  async (req, res, next) => {
    try {
      const selectedNames = Array.isArray(req.body?.names)
        ? Array.from(new Set(req.body.names.map((item) => String(item || "").trim()).filter(Boolean)))
        : null;
      const entries = readSqlMigrationEntries();

      const execution = await withClient(async (client) => {
        await ensureMigrationHistoryTable(client);
        const appliedMap = await loadAppliedMigrations(client);
        const pendingEntries = entries.filter((entry) => !appliedMap.has(entry.name));
        const runList = selectedNames
          ? pendingEntries.filter((entry) => selectedNames.includes(entry.name))
          : pendingEntries;

        const appliedNow = [];
        for (const entry of runList) {
          const startedAt = Date.now();
          await client.query(entry.sql);
          await client.query(
            `
              INSERT INTO ${quoteIdent(MIGRATION_HISTORY_TABLE)} (name, checksum, source, execution_ms)
              VALUES ($1, $2, 'script', $3)
            `,
            [entry.name, entry.checksum, Date.now() - startedAt],
          );
          appliedNow.push(entry.name);
        }

        return {
          requested: selectedNames ? selectedNames.length : pendingEntries.length,
          appliedNow,
          remaining: pendingEntries.length - appliedNow.length,
        };
      });

      return res.json({
        ok: true,
        ...execution,
      });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  "/admin-global/master/audit/events",
  requireMasterAdmin,
  async (req, res, next) => {
    try {
      if (!(await tableExists('public."AuthAudit"'))) {
        return res.json({
          ok: true,
          total: 0,
          page: 1,
          pageSize: 50,
          events: [],
        });
      }

      const page = Math.max(1, toSafeInt(req.query?.page, 1));
      const pageSize = Math.max(1, Math.min(200, toSafeInt(req.query?.pageSize, 50)));
      const search = normalizeSearch(req.query?.search);
      const event = String(req.query?.event || "").trim();
      const status = String(req.query?.status || "").trim();
      const dateFrom = String(req.query?.dateFrom || "").trim();
      const dateTo = String(req.query?.dateTo || "").trim();

      const params = [];
      const filters = [];

      if (search) {
        params.push(`%${search}%`);
        filters.push(
          `(LOWER(COALESCE(a.email, '')) LIKE $${params.length} OR LOWER(COALESCE(a.event, '')) LIKE $${params.length} OR LOWER(COALESCE(u.name, '')) LIKE $${params.length})`,
        );
      }
      if (event) {
        params.push(event);
        filters.push(`a.event = $${params.length}`);
      }
      if (status) {
        params.push(status);
        filters.push(`a.status = $${params.length}`);
      }
      if (dateFrom) {
        params.push(dateFrom);
        filters.push(`a."createdAt" >= $${params.length}::timestamptz`);
      }
      if (dateTo) {
        params.push(dateTo);
        filters.push(`a."createdAt" <= $${params.length}::timestamptz`);
      }

      const whereSql = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
      params.push(pageSize);
      const limitParam = params.length;
      params.push((page - 1) * pageSize);
      const offsetParam = params.length;

      const rows = await query(
        `
          SELECT
            a.id,
            a.email,
            a.event,
            a.status,
            a.ip,
            a."userAgent" AS user_agent,
            a.metadata,
            a."createdAt" AS created_at,
            u.name AS user_name
          FROM "AuthAudit" a
          LEFT JOIN "User" u ON u.id::text = a."userId"::text
          ${whereSql}
          ORDER BY a."createdAt" DESC, a.id DESC
          LIMIT $${limitParam}
          OFFSET $${offsetParam}
        `,
        params,
      );

      const countParams = params.slice(0, params.length - 2);
      const totalRow = await queryOne(
        `
          SELECT COUNT(*)::int AS total
          FROM "AuthAudit" a
          LEFT JOIN "User" u ON u.id::text = a."userId"::text
          ${whereSql}
        `,
        countParams,
      );

      return res.json({
        ok: true,
        total: Number(totalRow?.total || 0),
        page,
        pageSize,
        events: rows.rows.map((row) => ({
          id: Number(row.id),
          email: row.email || null,
          userName: row.user_name || null,
          event: row.event || null,
          status: row.status || null,
          ip: row.ip || null,
          userAgent: row.user_agent || null,
          metadata: row.metadata || null,
          createdAt: row.created_at || null,
        })),
      });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  "/admin-global/master/audit/retention",
  requireMasterAdmin,
  async (req, res, next) => {
    try {
      const data = await listAuditRetentionRules();
      return res.json({
        ok: true,
        ...data,
      });
    } catch (error) {
      next(error);
    }
  },
);

router.put(
  "/admin-global/master/audit/retention",
  requireMasterAdmin,
  async (req, res, next) => {
    try {
      const defaultRetentionDays = Math.max(
        1,
        Math.min(3650, toSafeInt(req.body?.defaultRetentionDays, 90)),
      );
      await upsertAuditRetentionRule({
        event: AUDIT_RETENTION_DEFAULT_EVENT,
        description: "Regra padrao para eventos sem configuracao dedicada.",
        retentionDays: defaultRetentionDays,
      });

      const rules = Array.isArray(req.body?.rules) ? req.body.rules : [];
      for (const rawRule of rules) {
        const event = String(rawRule?.event || "").trim();
        if (!event || event === AUDIT_RETENTION_DEFAULT_EVENT) continue;
        const retentionDays = Math.max(
          1,
          Math.min(3650, toSafeInt(rawRule?.retentionDays, defaultRetentionDays)),
        );
        const description =
          rawRule?.description == null ? null : String(rawRule.description).trim();
        // eslint-disable-next-line no-await-in-loop
        await upsertAuditRetentionRule({
          event,
          description,
          retentionDays,
        });
      }

      const data = await listAuditRetentionRules();
      return res.json({
        ok: true,
        ...data,
      });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  "/admin-global/master/audit/cleanup",
  requireMasterAdmin,
  async (req, res, next) => {
    try {
      if (!(await tableExists('public."AuthAudit"'))) {
        return res.json({ ok: true, deletedCount: 0 });
      }

      const retention = await listAuditRetentionRules();
      const fallbackDefault = Math.max(
        1,
        Math.min(
          3650,
          toSafeInt(
            req.body?.defaultRetentionDays,
            retention.defaultRetentionDays || 90,
          ),
        ),
      );

      const deleted = await queryOne(
        `
          WITH deleted AS (
            DELETE FROM "AuthAudit" a
            WHERE a."createdAt" < (
              NOW() - COALESCE(
                (
                  SELECT (r."retentionDays"::text || ' days')::interval
                  FROM "AuthAuditRetentionRule" r
                  WHERE r.event = a.event
                  LIMIT 1
                ),
                ($1::text || ' days')::interval
              )
            )
            RETURNING 1
          )
          SELECT COUNT(*)::int AS deleted_count
          FROM deleted
        `,
        [fallbackDefault],
      );

      return res.json({
        ok: true,
        deletedCount: Number(deleted?.deleted_count || 0),
        defaultRetentionDays: fallbackDefault,
      });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  "/admin-global/master/processes",
  requireMasterAdmin,
  async (req, res, next) => {
    try {
      const page = Math.max(1, toSafeInt(req.query?.page, 1));
      const pageSize = Math.max(1, Math.min(200, toSafeInt(req.query?.pageSize, 80)));
      const data = await listProcessExecutionLogs({
        page,
        pageSize,
        search: String(req.query?.search || ""),
        status: String(req.query?.status || ""),
        method: String(req.query?.method || ""),
        userEmail: String(req.query?.userEmail || ""),
        dateFrom: String(req.query?.dateFrom || ""),
        dateTo: String(req.query?.dateTo || ""),
      });

      return res.json({
        ok: true,
        ...data,
      });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  "/admin-global/master/processes/export",
  requireMasterAdmin,
  async (req, res, next) => {
    try {
      const pageSize = Math.max(1, Math.min(5000, toSafeInt(req.query?.limit, 2000)));
      const data = await listProcessExecutionLogs({
        page: 1,
        pageSize,
        search: String(req.query?.search || ""),
        status: String(req.query?.status || ""),
        method: String(req.query?.method || ""),
        userEmail: String(req.query?.userEmail || ""),
        dateFrom: String(req.query?.dateFrom || ""),
        dateTo: String(req.query?.dateTo || ""),
      });

      const csv = buildProcessLogsCsv(data.logs || []);
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="processos_admin_master_${timestamp}.csv"`,
      );
      return res.status(200).send(`\uFEFF${csv}`);
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  "/admin-global/master/processes/:id/logs.txt",
  requireMasterAdmin,
  async (req, res, next) => {
    try {
      const processId = Math.max(1, toSafeInt(req.params?.id, 0));
      if (!processId) {
        return res.status(400).json({
          error: "invalid_process_id",
          message: "ID do processo inválido.",
        });
      }
      const entry = await getProcessExecutionLogById(processId);
      if (!entry) {
        return res.status(404).json({
          error: "process_not_found",
          message: "Processo não encontrado.",
        });
      }
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="processo_master_${processId}_${timestamp}.txt"`,
      );
      return res.status(200).send(buildMasterProcessLogText(entry));
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  "/admin-global/master/select-accounts",
  requireMasterAdmin,
  async (req, res, next) => {
    try {
      const search = normalizeSearch(req.query?.search);
      const onlyActive = String(req.query?.onlyActive || "").trim().toLowerCase() === "true";
      const accounts = await listAccountsWithUsersAndShops();

      const filtered = accounts
        .filter((account) => {
          if (!search) return true;
          const accountName = String(account?.name || "").toLowerCase();
          const tenant = String(account?.tenantGlobalId || "").toLowerCase();
          const document = String(account?.documentNumber || "").toLowerCase();
          return (
            accountName.includes(search) ||
            tenant.includes(search) ||
            document.includes(search)
          );
        })
        .filter((account) => {
          if (!onlyActive) return true;
          return Array.isArray(account?.shops)
            ? account.shops.some(
                (shop) => String(shop?.status || "").toUpperCase() === "AUTHORIZED",
              )
            : false;
        })
        .sort((a, b) =>
          String(a?.name || "").localeCompare(String(b?.name || ""), "pt-BR", {
            sensitivity: "base",
          }),
        );

      return res.json({
        ok: true,
        total: filtered.length,
        accounts: filtered.map((account) => ({
          id: account.id,
          name: account.name || null,
          tenantGlobalId: account.tenantGlobalId || null,
          documentType: account.documentType || null,
          documentNumber: account.documentNumber || null,
          usersCount: Array.isArray(account.users) ? account.users.length : 0,
          shopsCount: Array.isArray(account.shops) ? account.shops.length : 0,
          shops: Array.isArray(account.shops)
            ? account.shops.map((shop) => ({
                id: shop.id,
                shopId: shop.shopId == null ? null : String(shop.shopId),
                region: shop.region || null,
                status: shop.status || null,
                createdAt: shop.createdAt || null,
              }))
            : [],
        })),
      });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  "/admin-global/master/select-accounts/enter",
  requireMasterAdmin,
  async (req, res, next) => {
    try {
      const accountId = Number(req.body?.accountId);
      const shopDbId = Number(req.body?.shopId);

      if (!Number.isFinite(accountId) || accountId <= 0) {
        return res.status(400).json({
          error: "invalid_account",
          message: "Conta invalida para gerenciamento.",
        });
      }

      if (!Number.isFinite(shopDbId) || shopDbId <= 0) {
        return res.status(400).json({
          error: "invalid_shop",
          message: "Selecione uma loja Shopee vinculada a conta.",
        });
      }

      const account = await queryOne(
        `
          SELECT id, name, "tenantGlobalId" AS tenant_global_id
          FROM "Account"
          WHERE id = $1
          LIMIT 1
        `,
        [accountId],
      );

      if (!account) {
        return res.status(404).json({
          error: "account_not_found",
          message: "Conta nao encontrada.",
        });
      }

      const shop = await queryOne(
        `
          SELECT id, "shopId" AS shop_id, region, status, "accountId" AS account_id
          FROM "Shop"
          WHERE id = $1
            AND "accountId" = $2
          LIMIT 1
        `,
        [shopDbId, accountId],
      );

      if (!shop) {
        return res.status(404).json({
          error: "shop_not_found",
          message: "Loja Shopee nao encontrada para esta conta.",
        });
      }

      await queryOne(
        `
          UPDATE "Session"
          SET
            "activeShopId" = $2,
            "accountContextId" = $3,
            "realUserId" = COALESCE("realUserId", $4),
            impersonating = TRUE
          WHERE id::text = $1::text
          RETURNING id
        `,
        [req.auth.sid, Number(shop.id), accountId, req.auth.userId],
      );

      return res.json({
        ok: true,
        message: "Conta selecionada para gerenciamento.",
        account: {
          id: Number(account.id),
          name: account.name || null,
          tenantGlobalId: account.tenant_global_id || null,
        },
        shop: {
          id: Number(shop.id),
          shopId: shop.shop_id == null ? null : String(shop.shop_id),
          region: shop.region || null,
          status: shop.status || null,
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

module.exports = router;
