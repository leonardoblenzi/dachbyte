"use strict";

const { randomUUID } = require("crypto");
const { Pool } = require("pg");
const env = require("../config/env");
const { getCachedCatalogMetrics } = require("./catalogCacheService");

const DEFAULT_WORKSPACE_SLUG = "madeira-davantti";
const DEFAULT_WORKSPACE_NAME = "Davantti MadeiraMadeira";

const trackedTables = {
  workspaces: '"MadWorkspace"',
  categories: '"MadCategory"',
  products: '"MadProduct"',
  orders: '"MadOrder"',
  freightQuotes: '"MadFreightQuote"',
  financialEntries: '"MadFinancialEntry"',
  messageThreads: '"MadMessageThread"',
  messages: '"MadMessage"',
  webhookEvents: '"MadWebhookEvent"',
  syncRuns: '"MadSyncRun"',
  users: '"MadUser"',
};

let pool;

function detectConnectionMode(databaseUrl) {
  const normalized = String(databaseUrl || "").toLowerCase();

  if (!normalized) {
    return "missing";
  }

  if (normalized.includes("-pooler.")) {
    return "pooled";
  }

  return "direct";
}

function createDatabaseError(message, details) {
  const error = new Error(message);
  error.status = 503;
  error.details = details || null;
  return error;
}

function ensureDatabaseConfigured() {
  if (!env.databaseUrl) {
    throw createDatabaseError("Banco do modulo MadeiraMadeira nao configurado.", {
      missing: ["MAD_DATABASE_URL"],
    });
  }
}

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
      max: 4,
    });
  }

  return pool;
}

async function queryRows(sqlText, params = []) {
  ensureDatabaseConfigured();
  const currentPool = getPool();
  const result = await currentPool.query(sqlText, params);
  return result.rows;
}

async function queryOne(sqlText, params = []) {
  const rows = await queryRows(sqlText, params);
  return rows[0] || null;
}

async function withClient(callback) {
  ensureDatabaseConfigured();
  const currentPool = getPool();
  const client = await currentPool.connect();

  try {
    return await callback(client);
  } finally {
    client.release();
  }
}

function toNumber(value) {
  if (value == null || value === "") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toNullableNumber(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  if (["1", "true", "sim", "yes"].includes(normalized)) return true;
  if (["0", "false", "nao", "não", "no"].includes(normalized)) return false;
  return fallback;
}

function normalizeJsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch (_error) {}
  }

  return {};
}

async function queryCount(tableName) {
  const row = await queryOne(`select count(*)::int as count from ${tableName}`);
  return Number(row?.count || 0);
}

async function ensureWorkspaceProductionDefaults(workspace) {
  if (!workspace?.id) return workspace;

  const expectedEnvironment = env.runtimeEnvironment;
  const expectedBaseUrl = env.coreBaseUrl;
  const needsEnvironmentUpdate = workspace.environment !== expectedEnvironment;
  const needsBaseUrlUpdate = workspace.apiBaseUrl !== expectedBaseUrl;

  if (!needsEnvironmentUpdate && !needsBaseUrlUpdate) {
    return workspace;
  }

  return queryOne(
    `
      update "MadWorkspace"
      set
        "environment" = $2::"MadEnvironment",
        "apiBaseUrl" = $3,
        "updatedAt" = now()
      where "id" = $1
      returning
        "id",
        "slug",
        "sellerName",
        "sellerCode",
        "environment",
        "status",
        "apiBaseUrl",
        "messagingBaseUrl",
        "tenantGlobalId",
        "documentType",
        "documentNumber",
        "metadata",
        "isActive",
        "createdAt",
        "updatedAt"
    `,
    [workspace.id, expectedEnvironment, expectedBaseUrl],
  );
}

async function getOrCreateDefaultWorkspace() {
  ensureDatabaseConfigured();

  const existingWorkspace = await queryOne(
    `
      select
        "id",
        "slug",
        "sellerName",
        "sellerCode",
        "environment",
        "status",
        "apiBaseUrl",
        "messagingBaseUrl",
        "tenantGlobalId",
        "documentType",
        "documentNumber",
        "metadata",
        "isActive",
        "createdAt",
        "updatedAt"
      from "MadWorkspace"
      where "isActive" = true
      order by "createdAt" asc
      limit 1
    `,
  );

  if (existingWorkspace) {
    return ensureWorkspaceProductionDefaults(existingWorkspace);
  }

  return queryOne(
    `
      insert into "MadWorkspace" (
        "id",
        "slug",
        "sellerName",
        "sellerCode",
        "environment",
        "status",
        "tenantGlobalId",
        "isActive",
        "metadata",
        "createdAt",
        "updatedAt"
      )
      values ($1, $2, $3, $4, $5::"MadEnvironment", $6::"MadIntegrationStatus", $7, true, $8::jsonb, now(), now())
      on conflict ("slug")
      do update set
        "sellerName" = excluded."sellerName",
        "environment" = excluded."environment",
        "status" = excluded."status",
        "updatedAt" = now()
      returning
        "id",
        "slug",
        "sellerName",
        "sellerCode",
        "environment",
        "status",
        "apiBaseUrl",
        "messagingBaseUrl",
        "tenantGlobalId",
        "documentType",
        "documentNumber",
        "metadata",
        "isActive",
        "createdAt",
        "updatedAt"
      `,
      [
        `madwk_${randomUUID()}`,
        DEFAULT_WORKSPACE_SLUG,
        DEFAULT_WORKSPACE_NAME,
        null,
        env.runtimeEnvironment,
        "active",
        randomUUID(),
        JSON.stringify({
          createdBy: "system",
          source: "bootstrap",
        }),
    ],
  );
}

async function getWorkspaceById(workspaceId) {
  const normalized = String(workspaceId || "").trim();
  if (!normalized) {
    return getOrCreateDefaultWorkspace();
  }

  const workspace = await queryOne(
    `
      select
        "id",
        "slug",
        "sellerName",
        "sellerCode",
        "environment",
        "status",
        "apiBaseUrl",
        "messagingBaseUrl",
        "tenantGlobalId",
        "documentType",
        "documentNumber",
        "metadata",
        "isActive",
        "createdAt",
        "updatedAt"
      from "MadWorkspace"
      where "id" = $1
      limit 1
    `,
    [normalized],
  );

  if (!workspace) {
    return getOrCreateDefaultWorkspace();
  }

  return ensureWorkspaceProductionDefaults(workspace);
}

async function listActiveWorkspaces(limit = 100) {
  ensureDatabaseConfigured();
  const boundedLimit = Math.max(1, Math.min(500, Number.parseInt(String(limit || 100), 10) || 100));
  const rows = await queryRows(
    `
      select
        "id",
        "slug",
        "sellerName",
        "sellerCode",
        "environment",
        "status",
        "apiBaseUrl",
        "tenantGlobalId",
        "documentType",
        "documentNumber",
        "isActive",
        "createdAt",
        "updatedAt"
      from "MadWorkspace"
      where "isActive" = true
      order by "sellerName" asc, "createdAt" asc
      limit $1
    `,
    [boundedLimit],
  );

  return rows;
}

async function getWorkspaceIntegrationConfig(workspaceId, actingUserEmailInput) {
  const workspace = await getWorkspaceById(workspaceId);
  const metadata = normalizeJsonObject(workspace?.metadata);
  const actingUserEmail = String(actingUserEmailInput || "").trim().toLowerCase();
  let userToken = null;
  let userTokenLast4 = null;

  if (actingUserEmail) {
    const user = await queryOne(
      `
        select "metadata"
        from "MadUser"
        where "workspaceId" = $1
          and lower("email") = $2
        limit 1
      `,
      [workspace.id, actingUserEmail],
    );

    const userMetadata = normalizeJsonObject(user?.metadata);
    if (Object.keys(userMetadata).length) {
      userToken = userMetadata.apiToken || null;
      userTokenLast4 = userMetadata.tokenLast4 || null;
    }
  }

  return {
    workspace,
    coreBaseUrl: workspace?.apiBaseUrl || env.coreBaseUrl,
    apiToken: userToken || metadata.apiToken || null,
    tokenConfigured: Boolean(userToken || metadata.apiToken),
    tokenLast4: userTokenLast4 || metadata.tokenLast4 || null,
    configuredAt: metadata.configuredAt || null,
    configuredBy: metadata.configuredBy || null,
  };
}

async function updateWorkspaceIdentity(input = {}) {
  const workspace = await getWorkspaceById(input.workspaceId);

  return queryOne(
    `
      update "MadWorkspace"
      set
        "sellerName" = $2,
        "tenantGlobalId" = $3,
        "documentType" = $4,
        "documentNumber" = $5,
        "updatedAt" = now()
      where "id" = $1
      returning
        "id",
        "slug",
        "sellerName",
        "sellerCode",
        "environment",
        "status",
        "apiBaseUrl",
        "messagingBaseUrl",
        "tenantGlobalId",
        "documentType",
        "documentNumber",
        "metadata",
        "isActive",
        "createdAt",
        "updatedAt"
    `,
    [
      workspace.id,
      input.sellerName || workspace.sellerName,
      input.tenantGlobalId || workspace.tenantGlobalId || randomUUID(),
      input.documentType || null,
      input.documentNumber || null,
    ],
  );
}

async function saveWorkspaceIntegrationConfig(input = {}) {
  const workspace = await getWorkspaceById(input.workspaceId);
  const currentMetadata = normalizeJsonObject(workspace?.metadata);
  const actingUserEmail = String(input.actingUserEmail || "").trim().toLowerCase();

  const nextMetadata = {
    ...currentMetadata,
    apiToken: input.apiToken || currentMetadata.apiToken || null,
    tokenLast4:
      input.apiToken && String(input.apiToken).length >= 4
        ? String(input.apiToken).slice(-4)
        : currentMetadata.tokenLast4 || null,
    configuredAt: new Date().toISOString(),
    configuredBy: input.configuredBy || currentMetadata.configuredBy || "workspace",
  };

  const updated = await queryOne(
    `
      update "MadWorkspace"
      set
        "sellerName" = $2,
        "sellerCode" = $3,
        "environment" = $4::"MadEnvironment",
        "apiBaseUrl" = $5,
        "messagingBaseUrl" = $6,
        "metadata" = $7::jsonb,
        "updatedAt" = now()
      where "id" = $1
      returning
        "id",
        "slug",
        "sellerName",
        "sellerCode",
        "environment",
        "status",
        "apiBaseUrl",
        "messagingBaseUrl",
        "tenantGlobalId",
        "documentType",
        "documentNumber",
        "metadata",
        "isActive",
        "createdAt",
        "updatedAt"
    `,
    [
      workspace.id,
      input.sellerName || workspace.sellerName,
      input.sellerCode || workspace.sellerCode,
      env.runtimeEnvironment,
      input.coreBaseUrl || workspace.apiBaseUrl || env.coreBaseUrl,
      workspace.messagingBaseUrl || null,
      JSON.stringify(nextMetadata),
    ],
  );

  if (actingUserEmail && input.apiToken) {
    await queryRows(
      `
        update "MadUser"
        set
          "metadata" = coalesce("metadata", '{}'::jsonb) || jsonb_build_object(
            'apiToken', $3::text,
            'tokenLast4', $4::text,
            'configuredAt', $5::text,
            'configuredBy', $6::text
          ),
          "updatedAt" = now()
        where "workspaceId" = $1
          and lower("email") = $2
      `,
      [
        workspace.id,
        actingUserEmail,
        input.apiToken,
        String(input.apiToken).slice(-4),
        nextMetadata.configuredAt,
        input.configuredBy || actingUserEmail,
      ],
    );
  }

  return updated;
}

async function getDatabaseStatus(options = {}) {
  const includeCounts = options.includeCounts !== false;
  const configured = Boolean(env.databaseUrl);
  const connectionMode = detectConnectionMode(env.databaseUrl);

  if (!configured) {
    return {
      configured: false,
      connected: false,
      provider: "neon-postgres",
      connectionMode,
      counts: {},
    };
  }

  try {
    const connectionInfo = await queryOne(
      "select current_database()::text as database_name, current_user::text as current_user",
    );
    const status = {
      configured: true,
      connected: true,
      provider: "neon-postgres",
      connectionMode,
      databaseName: connectionInfo?.database_name || null,
      currentUser: connectionInfo?.current_user || null,
      counts: {},
    };

    if (!includeCounts) {
      return status;
    }

    const counts = await Promise.all(
      Object.entries(trackedTables).map(async ([key, tableName]) => [
        key,
        await queryCount(tableName),
      ]),
    );

    status.counts = Object.fromEntries(counts);
    return status;
  } catch (error) {
    return {
      configured: true,
      connected: false,
      provider: "neon-postgres",
      connectionMode,
      counts: {},
      error: error?.message || "Nao foi possivel conectar ao banco.",
    };
  }
}

async function getDashboardOverview(options = {}) {
  const status = await getDatabaseStatus({ includeCounts: true });

  if (!status.connected) {
    return {
      database: status,
      workspace: null,
      metrics: {
        products: 0,
        publishedProducts: 0,
        openOrders: 0,
        openThreads: 0,
        pendingWebhooks: 0,
        successfulSyncRuns: 0,
      },
      latest: {
        syncRun: null,
        webhookEvent: null,
      },
    };
  }

  const workspace =
    options.workspaceId && String(options.workspaceId).trim()
      ? await getWorkspaceById(String(options.workspaceId).trim())
      : await getOrCreateDefaultWorkspace();
  const catalogMetrics = getCachedCatalogMetrics(workspace.id);

  const [
    openOrders,
    openThreads,
    pendingWebhooks,
    successfulSyncRuns,
    latestSyncRun,
    latestWebhookEvent,
  ] = await Promise.all([
    queryOne(
      'select count(*)::int as count from "MadOrder" where "workspaceId" = $1 and "status" = any($2::"MadOrderStatus"[])',
      [workspace.id, ["imported", "awaiting_invoice", "ready_to_ship", "shipped", "on_hold"]],
    ),
    queryOne(
      'select count(*)::int as count from "MadMessageThread" where "workspaceId" = $1 and "status" = any($2::"MadThreadStatus"[])',
      [workspace.id, ["open", "waiting_seller", "waiting_marketplace"]],
    ),
    queryOne(
      'select count(*)::int as count from "MadWebhookEvent" where "workspaceId" = $1 and "status" = any($2::"MadWebhookStatus"[])',
      [workspace.id, ["received", "processing"]],
    ),
    queryOne(
      'select count(*)::int as count from "MadSyncRun" where "workspaceId" = $1 and "status" = any($2::"MadSyncStatus"[])',
      [workspace.id, ["success", "partial"]],
    ),
    queryOne(
      'select "domain", "status", "startedAt" from "MadSyncRun" where "workspaceId" = $1 order by "startedAt" desc limit 1',
      [workspace.id],
    ),
    queryOne(
      'select "topic", "status", "receivedAt" from "MadWebhookEvent" where "workspaceId" = $1 order by "receivedAt" desc limit 1',
      [workspace.id],
    ),
  ]);

  return {
    database: status,
    workspace,
    metrics: {
      products: Number(catalogMetrics.products || 0),
      publishedProducts: Number(catalogMetrics.publishedProducts || 0),
      openOrders: Number(openOrders?.count || 0),
      openThreads: Number(openThreads?.count || 0),
      pendingWebhooks: Number(pendingWebhooks?.count || 0),
      successfulSyncRuns: Number(successfulSyncRuns?.count || 0),
    },
    latest: {
      syncRun: latestSyncRun,
      webhookEvent: latestWebhookEvent,
    },
  };
}

module.exports = {
  DEFAULT_WORKSPACE_NAME,
  DEFAULT_WORKSPACE_SLUG,
  createDatabaseError,
  detectConnectionMode,
  ensureDatabaseConfigured,
  getDatabaseStatus,
  getDashboardOverview,
  getOrCreateDefaultWorkspace,
  getPool,
  listActiveWorkspaces,
  getWorkspaceById,
  getWorkspaceIntegrationConfig,
  queryOne,
  queryRows,
  saveWorkspaceIntegrationConfig,
  updateWorkspaceIdentity,
  toBoolean,
  toNullableNumber,
  toNumber,
  withClient,
};
