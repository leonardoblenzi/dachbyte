"use strict";

const { query, queryOne } = require("../config/postgres");

let ensurePromise = null;

function clampInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

async function ensureProcessExecutionLogTable() {
  if (ensurePromise) return ensurePromise;

  ensurePromise = (async () => {
    await query(`
      CREATE TABLE IF NOT EXISTS "ProcessExecutionLog" (
        "id" BIGSERIAL PRIMARY KEY,
        "requestedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "finishedAt" TIMESTAMPTZ NULL,
        "durationMs" INTEGER NULL,
        "method" TEXT NOT NULL,
        "path" TEXT NOT NULL,
        "queryString" TEXT NULL,
        "statusCode" INTEGER NULL,
        "success" BOOLEAN NOT NULL DEFAULT false,
        "errorCode" TEXT NULL,
        "errorMessage" TEXT NULL,
        "requestBody" JSONB NULL,
        "responseBody" JSONB NULL,
        "ip" TEXT NULL,
        "userAgent" TEXT NULL,
        "userId" INTEGER NULL,
        "userEmail" TEXT NULL,
        "userRole" TEXT NULL,
        "accountId" INTEGER NULL
      )
    `);

    await query(
      `CREATE INDEX IF NOT EXISTS "ProcessExecutionLog_requestedAt_idx" ON "ProcessExecutionLog"("requestedAt" DESC)`,
    );
    await query(
      `CREATE INDEX IF NOT EXISTS "ProcessExecutionLog_success_requestedAt_idx" ON "ProcessExecutionLog"("success", "requestedAt" DESC)`,
    );
    await query(
      `CREATE INDEX IF NOT EXISTS "ProcessExecutionLog_method_requestedAt_idx" ON "ProcessExecutionLog"("method", "requestedAt" DESC)`,
    );
    await query(
      `CREATE INDEX IF NOT EXISTS "ProcessExecutionLog_userEmail_requestedAt_idx" ON "ProcessExecutionLog"("userEmail", "requestedAt" DESC)`,
    );
  })().catch((error) => {
    ensurePromise = null;
    throw error;
  });

  return ensurePromise;
}

async function insertProcessExecutionLog({
  requestedAt = new Date(),
  finishedAt = null,
  durationMs = null,
  method,
  path,
  queryString = null,
  statusCode = null,
  success = false,
  errorCode = null,
  errorMessage = null,
  requestBody = null,
  responseBody = null,
  ip = null,
  userAgent = null,
  userId = null,
  userEmail = null,
  userRole = null,
  accountId = null,
}) {
  await ensureProcessExecutionLogTable();
  await query(
    `
      INSERT INTO "ProcessExecutionLog" (
        "requestedAt",
        "finishedAt",
        "durationMs",
        "method",
        "path",
        "queryString",
        "statusCode",
        "success",
        "errorCode",
        "errorMessage",
        "requestBody",
        "responseBody",
        "ip",
        "userAgent",
        "userId",
        "userEmail",
        "userRole",
        "accountId"
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10,
        $11::jsonb,
        $12::jsonb,
        $13,
        $14,
        $15,
        $16,
        $17,
        $18
      )
    `,
    [
      requestedAt,
      finishedAt,
      durationMs == null ? null : clampInt(durationMs, 0, 0, 24 * 60 * 60 * 1000),
      String(method || "").slice(0, 16).toUpperCase(),
      String(path || "").slice(0, 600),
      queryString == null ? null : String(queryString || "").slice(0, 1200),
      statusCode == null ? null : clampInt(statusCode, null, 100, 999),
      Boolean(success),
      errorCode == null ? null : String(errorCode || "").slice(0, 120),
      errorMessage == null ? null : String(errorMessage || "").slice(0, 800),
      requestBody == null ? null : JSON.stringify(requestBody),
      responseBody == null ? null : JSON.stringify(responseBody),
      ip == null ? null : String(ip || "").slice(0, 120),
      userAgent == null ? null : String(userAgent || "").slice(0, 500),
      userId == null ? null : clampInt(userId, null, 0, 2147483647),
      userEmail == null ? null : String(userEmail || "").slice(0, 240),
      userRole == null ? null : String(userRole || "").slice(0, 80),
      accountId == null ? null : clampInt(accountId, null, 0, 2147483647),
    ],
  );
}

function mapProcessExecutionRow(row) {
  const mapped = {
    id: Number(row.id),
    requestedAt: row.requested_at || null,
    finishedAt: row.finished_at || null,
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    method: row.method || null,
    path: row.path || null,
    queryString: row.query_string || null,
    statusCode: row.status_code == null ? null : Number(row.status_code),
    success: Boolean(row.success),
    errorCode: row.error_code || null,
    errorMessage: row.error_message || null,
    requestBody: row.request_body || null,
    responseBody: row.response_body || null,
    ip: row.ip || null,
    userAgent: row.user_agent || null,
    userId: row.user_id == null ? null : Number(row.user_id),
    userEmail: row.user_email || null,
    userRole: row.user_role || null,
    accountId: row.account_id == null ? null : Number(row.account_id),
  };
  mapped.displayName = resolveProcessDisplayNameV2(mapped);
  return mapped;
}

function resolveProcessDisplayName({
  method = "",
  path = "",
  requestBody = null,
} = {}) {
  const normalizedMethod = String(method || "").trim().toUpperCase();
  const rawPath = String(path || "").trim();
  const lowerPath = rawPath.toLowerCase();
  const routePath = lowerPath.includes("#")
    ? lowerPath.slice(0, lowerPath.indexOf("#"))
    : lowerPath;
  const actionTag = lowerPath.includes("#")
    ? lowerPath.slice(lowerPath.indexOf("#") + 1)
    : String(requestBody?.action || "").trim().toLowerCase();

  const actionLabelByTag = {
    "logistics.spx.enable": "Alteração de logística (habilitar Shopee Xpress)",
    "logistics.spx.disable": "Alteração de logística (desabilitar Shopee Xpress)",
    "logistics.seller.enable": "Alteração de logística (habilitar Logística do vendedor)",
    "logistics.seller.disable": "Alteração de logística (desabilitar Logística do vendedor)",
    "logistics.conflicts.keep_spx": "Correção de conflitos de logística (manter Shopee Xpress)",
    "logistics.conflicts.keep_seller": "Correção de conflitos de logística (manter Logística do vendedor)",
    "logistics.mapping.apply": "Mapeamento automático de logística",
    "logistics.configure": "Configuracao guiada de logistica",
    "products.deadline.apply": "Alteração de prazo sob encomenda",
    "products.relaunch.pause": "Pausa de anúncios",
    "products.relaunch.delete": "Exclusão de anúncios",
    "products.status.bulk": "Alteração massiva de status de anúncios",
  };
  if (actionTag && actionLabelByTag[actionTag]) return actionLabelByTag[actionTag];

  const routeMatchers = [
    [/\/shops\/active\/dashboard\/stock-alert\/sync-stock$/, "Sincronismo de loja"],
    [/\/shops\/active\/products\/sync$/, "Sincronismo de produtos"],
    [/\/shops\/active\/orders\/sync$/, "Sincronismo de pedidos"],
    [/\/shops\/active\/logistics\/spx\/enable$/, "Alteração de logística (habilitar Shopee Xpress)"],
    [/\/shops\/active\/logistics\/spx\/disable$/, "Alteração de logística (desabilitar Shopee Xpress)"],
    [/\/shops\/active\/logistics\/seller\/enable$/, "Alteração de logística (habilitar Logística do vendedor)"],
    [/\/shops\/active\/logistics\/seller\/disable$/, "Alteração de logística (desabilitar Logística do vendedor)"],
    [/\/shops\/active\/logistics\/conflicts\/keep-spx$/, "Correção de conflitos de logística (manter Shopee Xpress)"],
    [/\/shops\/active\/logistics\/conflicts\/keep-seller$/, "Correção de conflitos de logística (manter Logística do vendedor)"],
    [/\/shops\/active\/products\/deadline-control\/apply$/, "Alteração de prazo sob encomenda"],
    [/\/shops\/active\/products\/relaunch\/pause$/, "Pausa de anúncios"],
    [/\/shops\/active\/products\/relaunch\/delete$/, "Exclusão de anúncios"],
    [/\/shops\/active\/products\/status\/bulk$/, "Alteração massiva de status de anúncios"],
    [/\/shops\/active\/products\/update-price$/, "Alteração de preço de produto"],
    [/\/shops\/active\/products\/update-stock$/, "Alteração de estoque de produto"],
    [/\/shops\/active\/process-jobs$/, actionLabelByTag[actionTag] || "Processo assíncrono"],
  ];
  for (const [pattern, label] of routeMatchers) {
    if (pattern.test(routePath)) return label;
  }

  if (normalizedMethod === "PATCH" || normalizedMethod === "PUT") return "Alteração de cadastro";
  if (normalizedMethod === "DELETE") return "Remoção de cadastro";
  if (normalizedMethod === "POST") return "Execucao de processo";
  return "Processo";
}

function resolveProcessDisplayNameV2({
  method = "",
  path = "",
  requestBody = null,
} = {}) {
  const normalizedMethod = String(method || "").trim().toUpperCase();
  const rawPath = String(path || "").trim();
  const lowerPath = rawPath.toLowerCase();
  const routePath = lowerPath.includes("#")
    ? lowerPath.slice(0, lowerPath.indexOf("#"))
    : lowerPath;
  const actionTag = lowerPath.includes("#")
    ? lowerPath.slice(lowerPath.indexOf("#") + 1)
    : String(requestBody?.action || "").trim().toLowerCase();

  const actionLabelByTag = {
    "logistics.spx.enable": "Alteracao de logistica (habilitar Shopee Xpress)",
    "logistics.spx.disable": "Alteracao de logistica (desabilitar Shopee Xpress)",
    "logistics.seller.enable": "Alteracao de logistica (habilitar Logistica do vendedor)",
    "logistics.seller.disable": "Alteracao de logistica (desabilitar Logistica do vendedor)",
    "logistics.conflicts.keep_spx": "Correcao de conflitos de logistica (manter Shopee Xpress)",
    "logistics.conflicts.keep_seller": "Correcao de conflitos de logistica (manter Logistica do vendedor)",
    "logistics.mapping.apply": "Mapeamento automatico de logistica",
    "logistics.configure": "Configuracao guiada de logistica",
    "products.deadline.apply": "Alteracao de prazo sob encomenda",
    "products.relaunch.pause": "Pausa de anuncios",
    "products.relaunch.delete": "Exclusao de anuncios",
    "products.status.bulk": "Alteracao massiva de status de anuncios",
  };
  if (actionTag && actionLabelByTag[actionTag]) return actionLabelByTag[actionTag];

  const routeMatchers = [
    [/\/jobs\/logistics\/spx\/enable$/, "Alteracao de logistica (habilitar Shopee Xpress)"],
    [/\/jobs\/logistics\/spx\/disable$/, "Alteracao de logistica (desabilitar Shopee Xpress)"],
    [/\/jobs\/logistics\/seller\/enable$/, "Alteracao de logistica (habilitar Logistica do vendedor)"],
    [/\/jobs\/logistics\/seller\/disable$/, "Alteracao de logistica (desabilitar Logistica do vendedor)"],
    [/\/jobs\/logistics\/conflicts\/keep-spx$/, "Correcao de conflitos de logistica (manter Shopee Xpress)"],
    [/\/jobs\/logistics\/conflicts\/keep-seller$/, "Correcao de conflitos de logistica (manter Logistica do vendedor)"],
    [/\/jobs\/logistics\/mapping\/apply$/, "Mapeamento automatico de logistica"],
    [/\/jobs\/products\/deadline-control\/apply$/, "Alteracao de prazo sob encomenda"],
    [/\/jobs\/products\/relaunch\/pause$/, "Pausa de anuncios"],
    [/\/jobs\/products\/relaunch\/delete$/, "Exclusao de anuncios"],
    [/\/jobs\/products\/status\/bulk$/, "Alteracao massiva de status de anuncios"],
    [/\/shops\/active\/dashboard\/stock-alert\/sync-stock$/, "Sincronismo de loja"],
    [/\/shops\/active\/products\/sync$/, "Sincronismo de produtos"],
    [/\/shops\/active\/orders\/sync$/, "Sincronismo de pedidos"],
    [/\/shops\/active\/products\/update-price$/, "Alteracao de preco de produto"],
    [/\/shops\/active\/products\/update-stock$/, "Alteracao de estoque de produto"],
    [/\/shops\/active\/process-jobs$/, actionLabelByTag[actionTag] || "Processo assincrono nomeado"],
  ];
  for (const [pattern, label] of routeMatchers) {
    if (pattern.test(routePath)) return label;
  }

  const tokenMap = {
    ads: "anuncios",
    async: "assincrono",
    bulk: "em massa",
    clone: "clonagem",
    conflicts: "conflitos",
    dashboard: "dashboard",
    deadline: "prazo",
    delete: "exclusao",
    disable: "desabilitacao",
    enable: "habilitacao",
    export: "exportacao",
    import: "importacao",
    jobs: "jobs",
    logistics: "logistica",
    mapping: "mapeamento",
    orders: "pedidos",
    price: "preco",
    process: "processo",
    products: "produtos",
    relaunch: "relancamento",
    seller: "logistica do vendedor",
    spx: "Shopee Xpress",
    status: "status",
    stock: "estoque",
    sync: "sincronismo",
    update: "atualizacao",
  };
  const humanizeToken = (value) => {
    const normalized = String(value || "").trim().toLowerCase().replace(/_/g, "-");
    return tokenMap[normalized] || normalized.split("-").filter(Boolean).join(" ");
  };
  const titleCase = (value) => String(value || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
  if (actionTag) {
    return titleCase(actionTag.split(".").map(humanizeToken).filter(Boolean).join(" - "));
  }

  const routeSegments = routePath
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .filter((segment) => !["shopee", "shops", "active", "admin-global", "master"].includes(segment))
    .filter((segment) => !/^\d+$/.test(segment))
    .map(humanizeToken)
    .filter(Boolean);
  const routeName = routeSegments.length ? titleCase(routeSegments.join(" - ")) : "";
  if (normalizedMethod === "PATCH" || normalizedMethod === "PUT") {
    return routeName ? `Alteracao: ${routeName}` : "Alteracao de processo";
  }
  if (normalizedMethod === "DELETE") {
    return routeName ? `Remocao: ${routeName}` : "Remocao de processo";
  }
  if (normalizedMethod === "POST" || normalizedMethod === "JOB") {
    return routeName ? `Execucao: ${routeName}` : "Execucao de processo";
  }
  if (normalizedMethod === "GET") {
    return routeName ? `Consulta: ${routeName}` : "Consulta de processo";
  }
  return routeName || "Processo nomeado";
}

function buildProcessExecutionWhere({
  search = "",
  status = "",
  method = "",
  userEmail = "",
  dateFrom = "",
  dateTo = "",
} = {}) {
  const params = [];
  const filters = [];

  const searchTerm = String(search || "").trim().toLowerCase();
  if (searchTerm) {
    params.push(`%${searchTerm}%`);
    const friendlyClauses = [];
    const addFriendlyClause = (sql) => {
      friendlyClauses.push(sql);
    };
    if (searchTerm.includes("sincron") && searchTerm.includes("loja")) {
      addFriendlyClause(`LOWER(COALESCE(p."path", '')) LIKE '%stock-alert/sync-stock%'`);
    }
    if (searchTerm.includes("sincron") && searchTerm.includes("produto")) {
      addFriendlyClause(`LOWER(COALESCE(p."path", '')) LIKE '%products/sync%'`);
    }
    if (searchTerm.includes("sincron") && searchTerm.includes("pedido")) {
      addFriendlyClause(`LOWER(COALESCE(p."path", '')) LIKE '%orders/sync%'`);
    }
    if (searchTerm.includes("logistic") || searchTerm.includes("logística")) {
      addFriendlyClause(`LOWER(COALESCE(p."path", '')) LIKE '%logistics%'`);
      addFriendlyClause(`LOWER(COALESCE(p."requestBody"->>'action', '')) LIKE '%logistics%'`);
    }
    if (searchTerm.includes("mapeamento")) {
      addFriendlyClause(`LOWER(COALESCE(p."requestBody"->>'action', '')) LIKE '%mapping%'`);
    }
    if (searchTerm.includes("prazo")) {
      addFriendlyClause(`LOWER(COALESCE(p."path", '')) LIKE '%deadline%'`);
      addFriendlyClause(`LOWER(COALESCE(p."requestBody"->>'action', '')) LIKE '%deadline%'`);
    }
    if (searchTerm.includes("status") || searchTerm.includes("ativação") || searchTerm.includes("ativacao")) {
      addFriendlyClause(`LOWER(COALESCE(p."path", '')) LIKE '%status%'`);
      addFriendlyClause(`LOWER(COALESCE(p."requestBody"->>'action', '')) LIKE '%status%'`);
    }
    if (searchTerm.includes("pausa")) {
      addFriendlyClause(`LOWER(COALESCE(p."path", '')) LIKE '%pause%'`);
      addFriendlyClause(`LOWER(COALESCE(p."requestBody"->>'action', '')) LIKE '%pause%'`);
    }
    if (searchTerm.includes("exclus")) {
      addFriendlyClause(`LOWER(COALESCE(p."path", '')) LIKE '%delete%'`);
      addFriendlyClause(`LOWER(COALESCE(p."requestBody"->>'action', '')) LIKE '%delete%'`);
    }
    filters.push(
      `(LOWER(COALESCE(p."path", '')) LIKE $${params.length}
        OR LOWER(COALESCE(p."errorMessage", '')) LIKE $${params.length}
        OR LOWER(COALESCE(p."userEmail", '')) LIKE $${params.length}
        OR LOWER(COALESCE(p."requestBody"->>'action', '')) LIKE $${params.length}
        ${friendlyClauses.length ? `OR ${friendlyClauses.join(" OR ")}` : ""})`,
    );
  }

  const normalizedStatus = String(status || "").trim().toLowerCase();
  if (normalizedStatus === "success") {
    filters.push(`p."success" = true`);
  } else if (normalizedStatus === "error") {
    filters.push(`p."success" = false`);
  }

  const normalizedMethod = String(method || "").trim().toUpperCase();
  if (normalizedMethod) {
    params.push(normalizedMethod);
    filters.push(`p."method" = $${params.length}`);
  }

  const normalizedUserEmail = String(userEmail || "").trim().toLowerCase();
  if (normalizedUserEmail) {
    params.push(`%${normalizedUserEmail}%`);
    filters.push(`LOWER(COALESCE(p."userEmail", '')) LIKE $${params.length}`);
  }

  const normalizedDateFrom = String(dateFrom || "").trim();
  if (normalizedDateFrom) {
    params.push(normalizedDateFrom);
    filters.push(`p."requestedAt" >= $${params.length}::timestamptz`);
  }
  const normalizedDateTo = String(dateTo || "").trim();
  if (normalizedDateTo) {
    params.push(normalizedDateTo);
    filters.push(`p."requestedAt" <= $${params.length}::timestamptz`);
  }

  return {
    whereSql: filters.length ? `WHERE ${filters.join(" AND ")}` : "",
    params,
  };
}

async function listProcessExecutionLogs({
  page = 1,
  pageSize = 50,
  search = "",
  status = "",
  method = "",
  userEmail = "",
  dateFrom = "",
  dateTo = "",
} = {}) {
  await ensureProcessExecutionLogTable();

  const safePage = clampInt(page, 1, 1, 1000000);
  const safePageSize = clampInt(pageSize, 50, 1, 200);
  const offset = (safePage - 1) * safePageSize;

  const { whereSql, params } = buildProcessExecutionWhere({
    search,
    status,
    method,
    userEmail,
    dateFrom,
    dateTo,
  });

  const listParams = params.slice();
  listParams.push(safePageSize);
  const limitParam = listParams.length;
  listParams.push(offset);
  const offsetParam = listParams.length;

  const [rowsResult, totalRow, summaryRow, failureRows] = await Promise.all([
    query(
      `
        SELECT
          p.id,
          p."requestedAt" AS requested_at,
          p."finishedAt" AS finished_at,
          p."durationMs" AS duration_ms,
          p."method" AS method,
          p."path" AS path,
          p."queryString" AS query_string,
          p."statusCode" AS status_code,
          p."success" AS success,
          p."errorCode" AS error_code,
          p."errorMessage" AS error_message,
          p."requestBody" AS request_body,
          p."responseBody" AS response_body,
          p."ip" AS ip,
          p."userAgent" AS user_agent,
          p."userId" AS user_id,
          p."userEmail" AS user_email,
          p."userRole" AS user_role,
          p."accountId" AS account_id
        FROM "ProcessExecutionLog" p
        ${whereSql}
        ORDER BY p."requestedAt" DESC, p.id DESC
        LIMIT $${limitParam}
        OFFSET $${offsetParam}
      `,
      listParams,
    ),
    queryOne(
      `
        SELECT COUNT(*)::int AS total
        FROM "ProcessExecutionLog" p
        ${whereSql}
      `,
      params,
    ),
    queryOne(
      `
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE p."success" = true)::int AS success_count,
          COUNT(*) FILTER (WHERE p."success" = false)::int AS error_count,
          COALESCE(
            ROUND(
              (
                COUNT(*) FILTER (WHERE p."success" = true)::numeric
                / NULLIF(COUNT(*)::numeric, 0)
              ) * 100,
              2
            ),
            0
          )::numeric AS success_rate_pct,
          ROUND(AVG(NULLIF(p."durationMs", 0))::numeric, 2) AS avg_duration_ms
        FROM "ProcessExecutionLog" p
        ${whereSql}
      `,
      params,
    ),
    query(
      `
        SELECT
          COALESCE(NULLIF(BTRIM(p."errorMessage"), ''), 'Sem detalhe informado') AS reason,
          COUNT(*)::int AS total
        FROM "ProcessExecutionLog" p
        ${whereSql}
          ${whereSql ? "AND" : "WHERE"} p."success" = false
        GROUP BY 1
        ORDER BY total DESC, reason ASC
        LIMIT 10
      `,
      params,
    ),
  ]);

  return {
    page: safePage,
    pageSize: safePageSize,
    total: Number(totalRow?.total || 0),
    totalPages: Math.max(1, Math.ceil(Number(totalRow?.total || 0) / safePageSize)),
    summary: {
      total: Number(summaryRow?.total || 0),
      successCount: Number(summaryRow?.success_count || 0),
      errorCount: Number(summaryRow?.error_count || 0),
      successRatePct: Number(summaryRow?.success_rate_pct || 0),
      avgDurationMs:
        summaryRow?.avg_duration_ms == null ? null : Number(summaryRow.avg_duration_ms),
    },
    topFailureReasons: failureRows.rows.map((row) => ({
      reason: row.reason || "Sem detalhe informado",
      total: Number(row.total || 0),
    })),
    logs: rowsResult.rows.map(mapProcessExecutionRow),
  };
}

async function listRecentCompletedProcessLogsForUser({
  userId = null,
  userEmail = "",
  lookbackHours = 72,
  limit = 80,
} = {}) {
  await ensureProcessExecutionLogTable();

  const safeLookbackHours = clampInt(lookbackHours, 72, 1, 24 * 30);
  const safeLimit = clampInt(limit, 80, 1, 300);
  const normalizedEmail = String(userEmail || "").trim().toLowerCase();
  const numericUserId =
    userId == null ? null : clampInt(userId, null, 0, 2147483647);

  const params = [safeLookbackHours, safeLimit];
  let whoFilter = "";
  if (numericUserId != null) {
    params.push(numericUserId);
    whoFilter = `AND p."userId" = $${params.length}`;
  } else if (normalizedEmail) {
    params.push(normalizedEmail);
    whoFilter = `AND LOWER(COALESCE(p."userEmail", '')) = $${params.length}`;
  } else {
    return [];
  }

  const result = await query(
    `
      SELECT
        p.id,
        p."requestedAt" AS requested_at,
        p."finishedAt" AS finished_at,
        p."durationMs" AS duration_ms,
        p."method" AS method,
        p."path" AS path,
        p."queryString" AS query_string,
        p."statusCode" AS status_code,
        p."success" AS success,
        p."errorCode" AS error_code,
        p."errorMessage" AS error_message,
        p."requestBody" AS request_body,
        p."responseBody" AS response_body,
        p."ip" AS ip,
        p."userAgent" AS user_agent,
        p."userId" AS user_id,
        p."userEmail" AS user_email,
        p."userRole" AS user_role,
        p."accountId" AS account_id
      FROM "ProcessExecutionLog" p
      WHERE p."requestedAt" >= NOW() - ($1::int || ' hours')::interval
        AND p."finishedAt" IS NOT NULL
        ${whoFilter}
      ORDER BY p."requestedAt" DESC, p.id DESC
      LIMIT $2::int
    `,
    params,
  );

  return result.rows.map(mapProcessExecutionRow);
}

async function getProcessExecutionLogById(processId) {
  await ensureProcessExecutionLogTable();
  const id = clampInt(processId, null, 1, 2147483647);
  if (id == null) return null;
  const row = await queryOne(
    `
      SELECT
        p.id,
        p."requestedAt" AS requested_at,
        p."finishedAt" AS finished_at,
        p."durationMs" AS duration_ms,
        p."method" AS method,
        p."path" AS path,
        p."queryString" AS query_string,
        p."statusCode" AS status_code,
        p."success" AS success,
        p."errorCode" AS error_code,
        p."errorMessage" AS error_message,
        p."requestBody" AS request_body,
        p."responseBody" AS response_body,
        p."ip" AS ip,
        p."userAgent" AS user_agent,
        p."userId" AS user_id,
        p."userEmail" AS user_email,
        p."userRole" AS user_role,
        p."accountId" AS account_id
      FROM "ProcessExecutionLog" p
      WHERE p.id = $1
      LIMIT 1
    `,
    [id],
  );

  return row ? mapProcessExecutionRow(row) : null;
}

module.exports = {
  ensureProcessExecutionLogTable,
  insertProcessExecutionLog,
  listProcessExecutionLogs,
  listRecentCompletedProcessLogsForUser,
  getProcessExecutionLogById,
  resolveProcessDisplayName,
};
